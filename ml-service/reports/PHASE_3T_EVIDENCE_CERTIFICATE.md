# PHASE 3T — Evidence Certificate

**Repository:** alpha-forge
**Branch:** `refactor/improve-ml-service`
**Commit at certification:** `abbc403` (PHASE_3S HEAD; 3T additive)
**Python:** 3.14.6
**OS:** macOS (darwin)
**Date:** 2026-09-06

---

## Code & configuration versions

- Decision pipeline: `src/decision/pipeline.py` (DecisionPipeline)
- EV engine: `src/meta/ev_engine.py` (EVConfig `ev_config-v1`)
- Cost schedules: `india-equity-2019`, `india-equity-2023`, `india-fno-pre-2023`, `india-fno-2023` (PIT registry)
- Evidence policy: `paper.evidence.EvidencePolicy` `3n-evidence-policy-v1` (seed 12345)
- Research factory: `src/research` (123 exports)
- Feature/label/model versioning via `lifecycle.schemas.ModelIdentity` (identity_hash sha256[:16])
- Dataset identity via `data_reliability.snapshot.SnapshotIdentity.fingerprint()` (sha256[:16])

## Configuration hashes

Configuration and dataset immutability are enforced by content hashes (sha256[:16]) across `ModelIdentity`, `SnapshotIdentity`, `ExperimentManifest.experiment_hash`, and `ExperimentArtifact` section hashes. Changing any config produces a new hash / new version.

## Test results

- Phase 3T certification suite: **44 passed / 0 failed** (`tests/test_phase3t.py`)
- Full regression 3A–3T (excluding 6 dependency-absence files): **1570 passed / 28 skipped / 0 failed**
- Excluded files (pre-existing dependency absence, unchanged from baseline): `test_validation.py`, `test_talib_perf.py`, `test_technical.py`, `test_portfolio_optimizer.py`, `test_gex.py`, `test_data_pipeline.py` (talib / torch / sklearn[cloudpickle] absent under Python 3.14)

## Security results

- Hardcoded secrets in `ml-service/src`: **0** (independent grep)
- `NEXT_PUBLIC_*` secret env vars in frontend: **0**
- Evidence/artifact secret guard: ENFORCED (`contains_secret`, `ArtifactSecretLeak`) — verified by tests
- Frontend credential audit: `reports/phase-3n-security-frontend-audit.md` retained

## Live-order boundary results

- Order-placement primitives in `ml-service/src`: **0** (grep returncode 1; asserted in `TestLiveOrderBoundary`)
- Live-capable broker (TypeScript, outside boundary) gated by `LIVE_TRADING_ENABLED` (default unset = disabled)
- `LIVE_TRADING_STATUS: DISABLED`

## Reproducibility results

- Risk covariance: bit-repeatable across runs (verified)
- Experiment artifact: freeze → verify_integrity OK; tampered section → integrity failure; recompute mismatch → REPRODUCTION_FAILURE (verified)

## Independent calculation results

- EV: independent `P·win + (1-P)·loss - cost_rt` matches implementation to 1e-6 (deterministic + hypothesis property test)
- Rank IC: matches `scipy.stats.spearmanr` to 1e-6
- India cost PIT: F&O STT 0.0001 (pre-2023) vs 0.000125 (2023) confirmed at schedule boundary; stamp duty BUY-only confirmed
- Net-PnL identity `net = gross - costs - slippage` asserted as property

## Failure-injection results

All fail-closed: missing/invalid/future data, missing/revoked model, missing/mismatched/future calibration, risk-engine unavailable, constraint breach, missing simulator, abstention, EV missing-input matrix, FillEngine reject/unavailable. No path produces an executable BUY/SELL from a missing input.

## Limitations

Synthetic/historical-only evidence; no real profitable alpha; deep-learning/RL runtime unexercised (torch absent); sklearn tests skipped; statistical operating points provisional.

## Known risks

See `PHASE_3T_RISK_REGISTER.md`. No Critical risks.

## Certification status

**PHASE_3T_STATUS: PASS**
**ML_SERVICE_READINESS: PRODUCTION_READY_WITH_LIMITATIONS**
**ALPHA_EVIDENCE: INSUFFICIENT_EVIDENCE**
**LIVE_TRADING_STATUS: DISABLED**
