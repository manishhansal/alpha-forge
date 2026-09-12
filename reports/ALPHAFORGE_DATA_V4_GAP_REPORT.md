# ALPHAFORGE — DATA FOUNDATION V4 GAP REPORT (REAL)

From `data_gap`, queried 2026-09-11. Full-universe daily detection run
(`scripts/data-v4-full-universe-gaps.ts --all`).

## 1. Persisted gaps
- **`data_gap` total: 245 rows** (was 0 at V4 baseline).
- Instruments scanned: **175** (all persisted daily instruments).
- Instruments with ≥1 gap: **171**.
- Idempotent: a second full run wrote **0** new rows (unique key
  `[instrumentId,exchange,intervalStr,gapStart]`).

Worst offenders (missing daily bars): M&M 25, several instruments 3.

## 2. Honesty caveats
- **Daily only.** Intraday intervals have 0 persisted rows, so no intraday gaps
  are detectable — reported DATA_INSUFFICIENT, NOT emitted as millions of false
  gaps.
- **Partly an artifact of D-V4-01.** The mixed daily timestamp conventions mean
  some genuine sessions sit at a non-canonical epoch and appear "missing" at the
  canonical 09:15-IST grid the detector expects. After the daily normalization
  migration (D-V4-01..04) is applied, these gaps should be re-computed — some
  will resolve (the session exists, just retimed). The current 245 is therefore
  an UPPER bound on true missing daily sessions.
- **No fabrication:** weekend/holiday/pre-listing bars are never counted as gaps
  (calendar + active-period bounded).

## 3. Recovery
- Recovery pipeline (`gap-recovery.service.ts`) is TEST-VERIFIED (verify-before-
  resolve; DataCorrection on material diff; never resolve on HTTP 200 alone).
- **No gap was recovered this pass** — recovery needs a credentialed provider to
  re-fetch the missing sessions, which is not available here. All 245 gaps remain
  `recoveryStatus = PENDING`. **Recovery: NOT_VERIFIED with real data.**

## 4. Verdict
- Daily gap DETECTION across the full universe: **DB-VERIFIED** (245 real rows).
- Intraday gap detection: **DATA_INSUFFICIENT** (no rows to detect against).
- Gap RECOVERY: **NOT_VERIFIED** (needs credentials).
