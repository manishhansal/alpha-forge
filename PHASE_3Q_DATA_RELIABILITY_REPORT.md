# PHASE 3Q — DATA RELIABILITY REPORT

**Branch:** `refactor/improve-ml-service`
**Date:** 2026-09-06
**Type:** Production Indian-market data-reliability engineering — ADDITIVE only.
No new model / DL / RL / live-broker path / parameter optimization / redesign.

---

## 1. Entry audit

- Entry HEAD: `a4100cc` (PHASE_3P), working tree clean at entry.
- **PREVIOUS_PHASE_STATUS:** Phases 3M / 3N / 3O / 3P all **IMPLEMENTED** in
  executable code (verified from `src/decision`, `src/shadow`, `src/paper`,
  `src/paper3o`, `src/validation/evidence_audit`, and passing `test_phase3m/3n/3p`).
- No outstanding 3P blocker. NSE-in-TS prohibition **SATISFIED**:
  `src/lib/market-data/providers/nse.ts` is a removed/comment-only stub.
- Full entry audit recorded in `ml-service/reports/phase-3q-entry-audit.md`.

## 2. Architecture

One additive package, `ml-service/src/data_reliability/` (27 files incl.
`__init__`, 111 exports), **reusing** the existing foundation rather than
duplicating it: `paper.providers`, `paper.data_quality`, `data.point_in_time`,
`data.instrument_master`, `data.corporate_actions`, `data.historical_universe`,
`data.dataset_version`, `data.lineage`, `execution.market_calendar`,
`lifecycle._storage`, `monitoring`. The layer sits **upstream** of feature → model →
signal and acts as a fail-closed gate.

## 3. Provider matrix

| Priority | Provider | Role |
|----------|----------|------|
| 0 | DataService | primary |
| 1 | AngelOne | fallback |
| 2 | Upstox | fallback |
| 3 | Yahoo | last-resort fallback |

Typed failure taxonomy (`ProviderFailure`): `OK / NO_DATA / PROVIDER_FAILURE /
DATA_INVALID / DATA_STALE / MARKET_CLOSED / SYMBOL_NOT_SUPPORTED / AUTH_FAILURE /
RATE_LIMITED / NETWORK_FAILURE / UNKNOWN_PROVIDER_ERROR`. `NO_DATA` ≠
`PROVIDER_FAILURE`; `NO_DATA` / `MARKET_CLOSED` / `SYMBOL_NOT_SUPPORTED` are **not**
fallback-eligible; unknown → fail-closed to eligible. `AUTH_FAILURE` / `DATA_INVALID`
are **never** retried.

## 4. Data-quality matrix

`DQVerdict` worst-wins order:
`VALID < VALID_WITH_WARNINGS < INSUFFICIENT_EVIDENCE < UNAVAILABLE < INCOMPLETE <
STALE < CONFLICT < INVALID`. Only `VALID` / `VALID_WITH_WARNINGS` are
`safe_to_consume`. Inputs aggregated: OHLCV validity, staleness, completeness,
cross-provider consistency, sanitisation, sufficient-history.

## 5. Calendar validation

`Asia/Kolkata` explicit throughout; naive timestamps rejected. Regular session
09:15–15:30 IST; 15:30 is the close boundary (not inside the open session).
Weekend/holiday → `NON_TRADING_DAY`; uncovered date → `CALENDAR_INSUFFICIENT_EVIDENCE`.
`prev_trading_session` verified (Mon 2025-01-06 → Fri 2025-01-03). Muhurat = explicit
hardcoded set (documented approximation).

## 6. F&O validation

`get_lot_size` returns a 3-tuple `(lot, status, source)`. **P3Q-001** (see §12/§13)
fixed the unpack defect so a wrong historical lot is now detected as
`FNO_LOT_SIZE_MISMATCH`; an unestablishable historical lot → `DATA_INSUFFICIENT`
(never fabricated). Today's lot is never applied to a historical date.

## 7. PIT validation

Replay reconstructs only the state available at `as_of` (reusing
`PointInTimeRecord.is_available_at` + `select_best_revision`). Future bars /
corrections leak nothing (verified deterministic). Historical universe resolved PIT
(survivorship guard). Correction log is append-only (ORIGINAL preserved).

## 8. Chaos results

Simulated deterministically (no real providers): Angel timeout→recovery (succeeds,
bounded); Angel rate-limited (retryable but bounded → EXHAUSTED); malformed response
(NOT retried, 1 attempt); all-providers-unavailable → signal `NO_DECISION`
(`PROVIDER_UNACCEPTABLE`); conflicting providers → `PROVIDER_CONFLICT` → DQ `CONFLICT`
→ not safe to consume. All chaos tests green.

## 9. Replay results

`ReplayDriver`: same-day replay returns only the original revision; post-correction
replay returns the corrected revision; pre-availability replay withholds everything
(no leak). `replay(as_of)` is byte-identical on repeat (determinism verified).

## 10. Security audit

CLEAN. Broker credentials (`SMARTAPI_*`, `UPSTOX_*`) are server-side env only, never
sent to the browser; **no `NEXT_PUBLIC_*` broker/secret vars** (the only match is a
comment forbidding them); no hardcoded credential literals. `redact_mapping` /
`redact_headers` / `redact_text` scrub credential-shaped material; `DataHealthReport`
refuses to serialise if a secret is present; observability events redact metadata at
emit time.

## 11. Performance

Correctness prioritised over micro-optimisation. The layer is pure-Python, allocation
-light, and adds negligible latency: the full 97-test 3Q suite runs in **~0.4 s** and
the whole 1390-test regression in **~6.2 s**. Retry backoff performs no real sleep by
default (deterministic schedule). Immutable snapshots are fingerprinted once
(`SnapshotIdentity`) rather than re-validated. No dedicated micro-benchmark harness was
built (qualitative assessment only — documented).

## 12. Test results

- `tests/test_phase3q.py`: **97 passed**.
- 3Q + `test_phase3n`: **159 passed** (P3Q-001 fix caused no phase3n regression).
- Full regression (excluding known pre-existing dep-absence files): **1390 passed,
  28 skipped, 0 failed** = baseline 1293 + 97 new 3Q. **Zero new regressions**, skip
  count unchanged.
- Excluded files fail only on `ModuleNotFoundError` (talib/riskfolio/etc.) at
  collection — pre-existing, unrelated to 3Q.

## 13. Known limitations

1. Muhurat sessions are a hardcoded set — must be extended per year.
2. Retry backoff does no real sleep by default; a production caller must inject one.
3. The current-day harness is paper/shadow only — it never trades and uses synthetic
   fixtures.
4. Real-provider / real-market validation is NOT exercised here (no live broker
   credentials; `talib/torch/sklearn/riskfolio/yfinance` absent).
5. The double-counting audit is document-only (no family removed, no re-weighting).

## 14. Unresolved risks

- The layer is validated on **synthetic** data; behaviour against live Angel/Upstox
  payload quirks (schema drift, partial fills, exchange-specific edge cases) has not
  been observed in this environment.
- Muhurat / holiday calendar completeness depends on manual upkeep.
- Downstream integration wiring (making every consumer route through the DQ gate) is
  provided as APIs; enforcing it at every existing call site is out of 3Q scope.

## 15. Evidence hashes (SHA-256, first 16 hex)

| File | Hash |
|------|------|
| `src/data_reliability/__init__.py` | `d50f46bda25a8951` |
| `src/data_reliability/failure.py` | `be09ab500db39804` |
| `src/data_reliability/quality_gate.py` | `e584e8fe8b82f881` |
| `src/data_reliability/signal_safety.py` | `05d943a505f14715` |
| `src/data_reliability/replay.py` | `49a4b25796c549da` |
| `src/paper/data_quality.py` (P3Q-001 fix) | `70bfa57fda5655ed` |
| `tests/test_phase3q.py` | `a590cda0b96ceb75` |

(Hashes are pre-commit working-tree values; recompute with
`shasum -a 256 <file>`.)

## 16. Final recommendation

The data-reliability machinery is **production-grade and fail-closed** on all
exercisable paths, with comprehensive contract / property-based / negative /
test-the-tests coverage and zero new regressions. Because real-provider and
real-market validation cannot be exercised in this environment (no live credentials,
optional deps absent), the layer is certified **PRODUCTION_READY_WITH_LIMITATIONS**:
ready to gate the pipeline, pending real-market soak validation.

**PHASE_3Q_PASS**
**DATA_RELIABILITY_STATE: PRODUCTION_READY_WITH_LIMITATIONS**
