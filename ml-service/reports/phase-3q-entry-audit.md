# Phase 3Q — Entry Audit (§1)

**Branch:** `refactor/improve-ml-service` · **HEAD:** `a4100cc` (PHASE_3P, on `origin`)
**Working tree:** clean. Recent commits: a4100cc PHASE_3P → ff31a69 (bytecode cache chore) → 767258e (upstox token) → e706e3c PHASE_3O → 611b4f7 PHASE_3N → b1d2b8b PHASE_3M.

Behavior verified from source + executable tests, NOT from docs/filenames (spec §5–§7).

## PREVIOUS_PHASE_STATUS

| Phase | Status | File-level evidence |
|-------|--------|---------------------|
| 3M | **IMPLEMENTED** | `src/decision/` (DecisionPipeline, provenance, state) + `src/shadow/` (ShadowLedger, ReconciliationEngine); `tests/test_phase3m.py` executable + green. |
| 3N | **IMPLEMENTED** | `src/paper/` = providers.py, data_quality.py, signals.py, paper_engine.py, session.py, evidence.py, readiness.py; `tests/test_phase3n.py` green (part of 126 passed this run). |
| 3O | **IMPLEMENTED** | `src/paper3o/` (7 modules) committed `e706e3c`; `tests/test_phase3o.py` green. |
| 3P | **IMPLEMENTED** | `src/validation/evidence_audit/` + `tests/test_phase3p.py` committed `a4100cc` (on origin); P3P-001 (compatibility) + P3P-002 (promotion atomicity) fixes in `src/lifecycle/promotion.py`. |

Baseline this run: `test_phase3n + test_phase3m` = **126 passed / 0 failed**. No Phase 3P blocker
is outstanding (both HIGH findings were fixed and regression-tested in a4100cc).

## Existing data foundation (reuse, do NOT duplicate — spec §33)

`src/data/`: instrument_master (PIT lot sizes, `get_lot_size→(lot,status,source)`,
never fabricates), fno_eligibility (BanStatus/MWPLState, DATA_UNAVAILABLE default),
historical_universe (5-dim PIT membership, survivorship guard), corporate_actions
(CorporateActionType/AdjustmentStatus, PIT `was_known_at`), point_in_time
(PointInTimeValidator: future/naive/impossible-order rejection), dataset_version
(DatasetSnapshot hash/reproducibility), lineage (MLObservationLineage).

`src/paper/`: providers.py (**ProviderId** DATA_SERVICE→ANGEL_ONE→UPSTOX→YAHOO, no NSE;
**ProviderChain.resolve** fail-closed fallback, never merges; **SourceStatus**
OK/DEGRADED/TIMEOUT/ERROR/UNCONFIGURED/UNAVAILABLE; **ResponseStatus** PRIMARY/FALLBACK/
PARTIAL/STALE/INVALID/UNAVAILABLE; **ConsistencyPolicy** + **cross_provider_compare**);
data_quality.py (validate_ohlcv_bars, validate_fno_metadata, Freshness/FreshnessPolicy,
classify_session, assert_no_lookahead).

`src/execution/market_calendar.py`: NSECalendar (is_trading_day fail-closed
INSUFFICIENT_EVIDENCE for uncovered years, holidays 2020–2026, monthly/weekly expiry).

`src/monitoring/`: alerts (AlertSeverity/AlertCategory), drift_detector, model_registry,
performance_monitor, router (FastAPI).

## NSE-in-TS prohibition (§44): SATISFIED

`src/lib/market-data/providers/nse.ts` is a removed stub documenting the prohibition
(no live nseindia/niftyindices endpoints). Grep for NSE-direct tokens in
`src/lib/market-data/**/*.ts` returns only the prohibition comment.

## GAP ANALYSIS → additive Phase 3Q surface (`src/data_reliability/`)

Already present (REUSE): provider taxonomy + fallback chain, cross-provider consistency
mechanism, per-bar/session OHLCV validators, freshness policy, PIT validator + stores,
NSE calendar, hash/lineage helpers, monitoring alerts.

Genuinely MISSING (BUILD, additive):
- (a) typed failure states RATE_LIMITED / AUTH_FAILURE / NO_DATA / NETWORK_FAILURE / MARKET_CLOSED / SYMBOL_NOT_SUPPORTED (extend, map onto existing SourceStatus).
- (b) frozen-tick + value-regression stale detectors (complement Freshness + validate_ohlcv_bars).
- (c) bar completeness + FORMING_BAR vs CLOSED_BAR (absent entirely).
- (d) named PROVIDER_CONFLICT verdict (wrap existing cross_provider_compare).
- (e) single canonical DataQualityGate 8-verdict aggregator (VALID/VALID_WITH_WARNINGS/STALE/INCOMPLETE/INVALID/CONFLICT/INSUFFICIENT_EVIDENCE/UNAVAILABLE).
- (f) unified feature-availability contract (TRUE_ZERO/MISSING/NOT_APPLICABLE/NOT_YET_AVAILABLE/DATA_INSUFFICIENT).
- (g) live-day replay driver (only DataTag.REPLAY_DATA tag exists today).
- (h) bounded retry/backoff + centralized rate-limit.
- (i) cache-integrity layer (hash helpers exist; no cache store).
- (j) data-health API shape.

## Disposition

Phases 3M–3P verified IMPLEMENTED and green; no blocker. Build one additive package
`src/data_reliability/` that reuses the existing foundation and fills gaps (a)–(j).
No ML-service redesign, no new models, no NSE-in-TS, no live path.
