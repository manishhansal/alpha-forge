# ALPHAFORGE — DATA GAP REPORT (V3, REAL)

Real gap state from `data_gap` + the V3 gap detector, queried 2026-09-10.

---

## 1. Persisted `DataGap` rows

**Count: 0.** The gap detector (`gap-detection.service.ts`) ran DB-VERIFIED
against RELIANCE daily (2025-01-01 → 2025-03-31): 61 expected bars (NSE-calendar),
0 missing → **0 gap rows written**. This is a TRUE NEGATIVE (the ~complete daily
series genuinely has no missing sessions), not "detector never ran".

## 2. Why intraday gaps are not yet recorded (honest)

Gap detection compares EXPECTED (calendar) vs PERSISTED bars. Intraday
persistence is 0 (no credentialed history provider — see baseline §4), so there
is no persisted intraday series to detect gaps against yet. Recording a gap for
"the entire intraday history is missing" would be meaningless noise; instead the
capability is correctly reported **DATA_INSUFFICIENT** in readiness. Once intraday
bars are persisted, the same detector will populate `data_gap` for genuine holes.

## 3. Gap lifecycle (implemented + tested)

`DETECTED (PENDING) → RECOVERING → RECOVERED | PARTIALLY_RECOVERED | UNRESOLVED
(UNRECOVERABLE)`. Recovery (`gap-recovery.service.ts`) uses capability-aware
failover, **verifies the DB actually holds the bars before resolving** (never on
HTTP 200 alone), and writes a `DataCorrection` when a re-fetched value materially
differs from the persisted row (§19). Gaps are never deleted.

## 4. Guarantees (verified)
- No false gaps outside the instrument active period / trading calendar
  (TEST-VERIFIED: no-gap-before-listing, no-fabrication-on-empty; DB-VERIFIED:
  RELIANCE 0 gaps).
- Idempotent persistence: re-detecting the same gap never clobbers its recovery
  state (unique key `[instrumentId,exchange,intervalStr,gapStart]`).

## 5. Resolved gaps
None (none were detected to resolve). `data_correction = 0` (no conflicting
re-fetch occurred).
