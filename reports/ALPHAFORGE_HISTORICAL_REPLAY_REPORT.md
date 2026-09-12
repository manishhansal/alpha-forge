# ALPHAFORGE HISTORICAL REPLAY REPORT

**Date:** 2026-09-09. See `HISTORICAL_DATA_AVAILABILITY.md` for the data inspection.

> ## HISTORICAL REPLAY BLOCKED — INSUFFICIENT DATA

Phases 9 (chronological signal replay) and 10 (walk-forward training on replay) cannot
be executed on real data today:

- **No multi-session intraday history** (RCA-001) — the strategies trade 1m/5m/15m, but
  intraday `candle_bar` was never durably persisted across sessions.
- **No option-chain history** — `option_chain_snapshot` is snapshot-cadence only (NSE
  has no history endpoint) and is absent in the current DB.
- **Only one real session** of resolved outcomes exists (the 2026-09-01 ledger).

A faithful replay requires point-in-time features + models available *at each historical
timestamp*. With no intraday history, any replay would either fabricate data or leak
future information — both explicitly forbidden. Therefore no replay-based
Quality→profitability, calibration, or grade-monotonicity numbers are produced.

## Unblock path (non-fabricated)

1. Fix RCA-001: persist intraday `candle_bar` every session.
2. Run the new SHADOW pipeline live so `IndiaPredictionRecord`/`IndiaResolutionRecord`
   accrue immutable prediction+outcome pairs going forward.
3. After ≥ N sessions, run Phase 9/10 replay + walk-forward on the **real** persisted
   data, with per-fold scalers fit only on then-available history.

Until then: **INSUFFICIENT EVIDENCE** for all replay-dependent validations.
