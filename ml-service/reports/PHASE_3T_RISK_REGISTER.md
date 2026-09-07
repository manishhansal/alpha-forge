# PHASE 3T — Final Risk Register

**Branch:** `refactor/improve-ml-service` · **Commit:** `abbc403` · **Date:** 2026-09-06

Severity: **Critical** (can invalidate trading/research correctness) · **High** (materially damages reliability) · **Medium** (operational/maintainability) · **Low** (non-critical improvement).

---

## Critical

**None.** No confirmed lookahead leakage, survivorship bias in the production research path, future-metadata leakage, unsafe calibration, invalid probability semantics, incorrect EV, unrealistic execution, synthetic-risk-as-evidence, unreconciled ledger, unreproducible evidence, secret exposure, accidental live-order path, unsafe auto-promotion, or corrupted evidence was found.

## High

| ID | Description | Impact | Likelihood | Detection | Mitigation | Component | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| H1 | Alpha evidence is insufficient — machinery is green on synthetic/historical data but no real profitable alpha is established | A user could mistake engineering readiness for validated/profitable alpha | Medium | Research factory verdicts (NO_OOS_ALPHA / INSUFFICIENT_EVIDENCE); evidence tiers | Explicit ALPHA_EVIDENCE: INSUFFICIENT_EVIDENCE; system card states no guaranteed returns; accumulate real evidence in a separate authorized phase | research / evidence | OPEN (documented, by design) |
| H2 | Deep-learning and RL runtime unexercised (torch absent); portfolio-optimizer + several tests skipped (sklearn/cloudpickle, talib) | Certain code paths are UNVERIFIED in this environment | High (env) | Dependency-absence test skips are explicit | Install torch/talib/sklearn in a certified environment and re-run the 6 excluded suites before relying on deep/RL/optimizer paths | deep / rl / portfolio | OPEN (environment) |
| H3 | Statistical operating points (DSR/PBO/reality-check thresholds, gate cut-offs) are provisional, calibrated against synthetic data | Real experiments could be mis-graded until thresholds are recalibrated | Medium | Multiple-testing + tier gates present | Recalibrate against real experiment ensembles before a live research program | research.statistics | OPEN (documented) |

## Medium

| ID | Description | Impact | Likelihood | Detection | Mitigation | Component | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| M1 | No real paper sessions accumulated; paper evidence corpus is synthetic | Aggregate paper metrics are not yet trading-representative | Medium | Evidence classification (OFFICIAL vs SYNTHETIC) | Run real/high-fidelity paper sessions under Phase 3R machinery | paper / paper3o / paper_ops | OPEN |
| M2 | Retry/timing logic in paper-ops uses injected time (no real sleep) | Real-world latency behavior not exercised | Low | Documented in Phase 3R report | Exercise with a real clock in a soak environment | paper_ops | OPEN (documented) |
| M3 | Live-capable broker adapter exists in the repo (TypeScript), gated by an env flag | Misconfiguration outside the ML service could enable live orders elsewhere | Low | `assertLiveTradingEnabled` throws unless flag set | Keep `LIVE_TRADING_ENABLED` unset in all non-live environments; ML service never imports it | services/india (TS) | OPEN (isolated, outside boundary) |

## Low

| ID | Description | Impact | Likelihood | Detection | Mitigation | Component | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| L1 | Pre-existing numpy divide warnings in test_phase3d (constant-feature correlation) | Cosmetic; no correctness impact | Low | Visible in test output | Optionally guard the divide with an explicit zero-variance check | test/features | OPEN (cosmetic) |
| L2 | F&O margin is approximated (no live broker margin feed) | Research margin estimates are approximate | Low | Documented | Integrate a real margin model in a separate phase | paper_ops / execution | OPEN (documented) |

---

**Overall risk posture:** acceptable for a research/paper platform. No Critical risk. High risks are evidence-completeness and environment-coverage gaps, both explicitly documented and non-blocking for engineering certification.
