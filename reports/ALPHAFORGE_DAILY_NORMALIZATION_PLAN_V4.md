# ALPHAFORGE — DAILY DATA NORMALIZATION PLAN (V4)

Evidence-based plan for the daily `candle_bar` integrity defect (D-V4-01…04).
Produced from real DB analysis; nothing here is applied automatically.

**Canonical semantic:** a daily candle = one NSE trading session date, keyed at
session-open **09:15 IST (03:45 UTC)**.

---

## 1. Real classification (queried 2026-09-11)

| Convention (IST time-of-day) | rows |
|---|---|
| 09:15 (canonical) | 85,058 |
| 18:30 | 4,414 |
| 00:00 | 175 |
| 09:00 | 163 |
| **Total** | **89,810** |

- Logical trading days (instrument × exchange × IST date): **86,227**
- Weekend daily bars: **1,029**
- Logical duplicate trading-days (>1 epoch key for one day): **3,442**

## 2. Duplicate conflict classification (the key finding)

Comparing the two rows of each duplicate day by OHLC + volume + provenance:

| Class | count |
|---|---|
| EXACT_DUPLICATE | 0 |
| VALUE_MATCH | 0 |
| PROVENANCE_CONFLICT | 0 |
| TIMESTAMP_ONLY_CONFLICT | 0 |
| **VALUE_CONFLICT** | **3,442** |

**Every duplicate is a VALUE_CONFLICT** — the rows disagree on actual price and
volume, not merely on timestamp. Example (ICICIBANK 2026-09-01): 18:30-row
close 1426.5 / vol 8,515,824 vs 09:15-row close 1438 / vol 10,627,608.

Directionality analysis over 3,270 clean pairs:
- canonical (09:15) higher volume: 1,802 · other higher: 1,468 · equal: 0
- avg |close difference|: **1.07%** (max samples 6–8%)
- avg canonical/other volume ratio: 1.374

→ **No consistent evidence** that either convention is the true daily close.
Neither row carries `provider` provenance (both null), so there is no lineage
tiebreaker.

## 3. Per-row disposition rules (deterministic)

| Class | rows (est.) | disposition |
|---|---|---|
| CANONICAL (09:15, weekday, singleton) | ~81.6k | keep as-is |
| RETIME (weekday, non-canonical, no canonical twin) | ~340 | re-stamp `time` → session-open; preserve original epoch in `sourceTimestamp` |
| VALUE_CONFLICT duplicate (canonical twin exists) | 3,411 days | **keep the canonical (09:15) row as operational**; write a `DataCorrection` preserving the conflicting non-canonical value + reason `daily-dup-value-conflict`; delete the non-canonical row ONLY after its value is preserved in the correction; flag for provider re-verification |
| VALUE_CONFLICT with NO canonical twin | 31 days | RETIME the surviving row to canonical; record correction |
| WEEKEND_ORPHAN (weekend IST date) | 1,029 | **quarantine** (do not auto-delete): most are the 18:30-convention rows landing on weekend dates. Record `DataQualityIncident`; require review / provider re-verification before removal |
| INVALID (OHLC violation, non-finite) | 0 found | reject |

**Rationale for choosing canonical as operational:** it is the only rule that is
(a) deterministic, (b) consistent with the established canonical semantic, and
(c) matches the majority ingestion path (85,058 rows). It is NOT claimed to be
"the correct close" — the conflicting value is preserved in `DataCorrection` and
the day is flagged so a credentialed provider can authoritatively resolve it
later. This satisfies §5 (no silent choice; preserve original; record decision).

## 4. Why this is NOT auto-applied

- It mutates ~4,900 rows + writes ~3,442 corrections + ~1,029 incidents on a
  89,810-row production table — a high-risk operation (safety guardrails).
- The authoritative daily close for the 3,442 conflict days genuinely **cannot
  be determined from data in the DB** (no provenance, no directional evidence);
  the honest resolution requires a credentialed provider re-fetch, which is
  **not available** in this environment.
- Therefore the migration is delivered as a **dry-run tool** and this plan;
  operator approval + (ideally) a credentialed provider are prerequisites to
  apply it.

## 5. Two-stage migration (implemented as tooling, not run)

```
DRY RUN → VALIDATION → OPERATOR APPROVAL → TRANSACTIONAL MIGRATION → RECONCILE
```

Guarantees the tool provides: row counts before/after, duplicate/weekend counts
before/after, OHLC/coverage comparison, per-day correction records, transaction
with rollback, and a canonical `sessionDate`-based post-check. Acceptance target
(post-apply): logical duplicate trading-days = 0, canonical-timestamp violations
= 0, invalid weekend bars = 0 (weekend rows quarantined with audit trail).

## 6. Model change (see §8 of the phase / task 3)

Add an additive, nullable `sessionDate` (IST `YYYY-MM-DD`) to `CandleBar`,
backfilled for new writes, with a partial unique index for daily rows
(`instrument, exchange, interval, sessionDate WHERE interval='1d'`) so
trading-day uniqueness is enforced structurally going forward — proposed, with
consumer-impact review, NOT blindly applied.
