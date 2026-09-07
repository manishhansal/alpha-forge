# PHASE 3S — Mandatory Entry Audit

**Branch:** `refactor/improve-ml-service`
**HEAD at audit:** `405ae93` (PHASE_3R)
**Date:** 2026-09-06
**Working tree:** clean (no uncommitted changes)
**Baseline regression (3A–3R, excluding known dep-absence files):** **1449 passed / 28 skipped** — reconfirmed at entry.

This audit verifies prior phases exist as **executable code** (not phase labels) and maps what Phase 3S reuses. Phase 3S is an **additive** package `ml-service/src/research/`; no prior-phase file is modified.

Excluded from regression (pre-existing dependency absence, unchanged from baseline): `test_validation.py`, `test_talib_perf.py`, `test_technical.py`, `test_portfolio_optimizer.py`, `test_gex.py`, `test_data_pipeline.py` (talib / torch / sklearn / riskfolio / yfinance absent under Python 3.14).

---

## Per-phase verification

### Phase 3M — Model lifecycle / champion-challenger — **IMPLEMENTED**
- **Files:** `src/lifecycle/` — `schemas.py` (LifecycleState machine, `ModelIdentity` frozen, `is_valid_transition`, promotion enums), `champion.py`, `challenger.py` (`ChallengerRegistry`, soak config), `promotion.py` (`PromotionOrchestrator`, fail-closed + `FileLock`), `gates.py` (`PromotionGate`, `PromotionPolicy`), `evidence.py` (`ModelEvidencePackage.freeze/verify_integrity`), `comparison.py`, `registry.py`, `artifact_integrity.py`, `_storage.py` (`atomic_write_json`, `append_jsonl`, `FileLock`).
- **Evidence:** state machine + promotion boundary present and executable; `OOSEvidence.final_oos_used_for_selection` contamination flag blocks promotion.
- **Gaps:** none blocking 3S.

### Phase 3N — Evidence policy / statistical inference — **IMPLEMENTED**
- **Files:** `src/paper/evidence.py` — `EvidencePolicy` (min_observations=30, deterministic seed=12345), `Metric`, `bootstrap_ci` (moving-block), `compute_return_metrics`/`compute_trading_metrics`/`compute_decision_quality`, `conditional_breakdown`, and multiple-testing corrections `benjamini_hochberg` / `bonferroni`. `MetricStatus.INSUFFICIENT_EVIDENCE`.
- **Evidence:** directly reused in Phase 3R; reused again by 3S statistics.
- **Gaps:** no Deflated Sharpe / PBO (referenced only in `combinatorial_cv.py` docstring). 3S implements these NEW.

### Phase 3O — Paper-trading evidence accumulation & go/no-go — **IMPLEMENTED**
- **Files:** `src/paper3o/` — `evidence_store.py` (`EvidenceTier` E0–E5 + `tier_rank`, `EvidenceClass`, `ContaminationReason`, `SessionEvidence`, `MultiSessionStore`, and an append-only `ExperimentRegistry`/`Experiment`/`ExperimentType`/`ExperimentStatus`), `session_lifecycle.py`.
- **Evidence:** append-only experiment/evidence registries executable.
- **Gaps:** existing `ExperimentRegistry` is paper-session-oriented (BASELINE/FULL_SYSTEM/ABLATION/RL_COMPARISON labels + paper_session_ids). 3S needs richer research-experiment identity (hypothesis pre-registration, dataset/feature/label/config hashes, walk-forward/OOS discipline, gates). 3S builds a **new** research package rather than mutating this registry (isolation, §56); the existing one is left intact.

### Phase 3P — Independent quant validation / red-team / evidence certification — **IMPLEMENTED**
- **Files:** `src/validation/evidence_audit/`, `src/lifecycle/evidence.py`, `src/deep/leakage_tests.py` (`future_scaler_probe`, `future_label_probe`, `label_permutation_probe`, `negative_control_probe`, `permutation_importance`, `final_oos_contamination_check`), `src/features/leakage_validator.py` (`run_full_leakage_audit`, mutation tests).
- **Evidence:** leakage/permutation/negative-control probes executable and directly reusable by 3S leakage & placebo/negative-control controls.
- **Gaps:** none blocking 3S.

### Phase 3Q — Production data & Indian-market reliability — **IMPLEMENTED**
- **Files:** `src/data_reliability/` — `snapshot.py` (`SnapshotIdentity.fingerprint`, `compute_snapshot_identity`), `security.py` (`contains_secret`, `redact_mapping`, `redact_headers`, `REDACTED`), `signal_safety.py` (`evaluate_signal_safety`, `NO_FUTURE_INFORMATION` gate), `signal_matrix.py` (`SignalFamily`).
- **Evidence:** reproducible snapshot identity + PIT/no-future gate + secret guards executable; reused by 3S data-snapshot, leakage, and security controls.
- **Gaps:** none blocking 3S.

### Phase 3R — Paper-trading operational reliability — **IMPLEMENTED**
- **Files:** `src/paper_ops/` (10 modules, 79 exports), `tests/test_phase3r.py` (59 passing). Commit `405ae93` on origin.
- **Evidence:** verified in prior phase; 59 tests pass; full regression 1449 passed / 28 skipped.
- **Gaps:** none. 3R is complete; **no minimum-prerequisite fix required** for 3S.

---

## Search results (executable code, not labels)

| Term | Found in executable code |
| --- | --- |
| experiment / registry | `paper3o.evidence_store.ExperimentRegistry`, `lifecycle.registry.ModelRegistry` |
| research / backtest | `ranking.evaluation` diagnostics; `validation.combinatorial_cv` backtest paths; `paper.paper_engine` |
| walk-forward / OOS | `validation.walk_forward.WalkForwardValidator`, `OOSEvidence`, `deep.training.DataSplit` |
| HPO | `deep.training.grid_search_hpo` (train/val only), `rl.agent.grid_search_hpo` |
| feature selection / ablation | `ExperimentType.ABLATION` (label); no dedicated ablation runner (3S adds one) |
| permutation / placebo | `deep.leakage_tests.label_permutation_probe`, `permutation_importance` |
| multiple testing | `paper.evidence.benjamini_hochberg`, `bonferroni` (only correction present) |
| evidence | `lifecycle.evidence.ModelEvidencePackage`, `paper3o.evidence_store` |
| champion / challenger / promotion | `lifecycle.challenger`, `lifecycle.promotion`, `lifecycle.gates` |
| paper session / tracking | `paper_ops`, `paper3o`, `paper` |

---

## Reuse map for Phase 3S (build NEW only where nothing exists)

- **Experiment identity/manifest** → NEW `research/manifest.py` (richer than paper3o's); persist via `lifecycle._storage.atomic_write_json`/`append_jsonl` + `FileLock`.
- **Data snapshot** → reuse `data_reliability.snapshot.SnapshotIdentity` / `compute_snapshot_identity`.
- **Feature/label versioning** → reference `features.registry` / `labels.registry` concepts.
- **Leakage / normalization / placebo / negative control** → reuse `deep.leakage_tests.*`, `features.leakage_validator`, `data_reliability.signal_safety`.
- **Walk-forward / purged / embargo / untouched OOS** → reuse `validation.walk_forward`, `validation.purged_kfold`, `validation.embargo`; OOS discipline via `deep.training.DataSplit.search_indices()` + `final_oos_contamination_check`.
- **Statistics** → reuse `paper.evidence.bootstrap_ci` + `benjamini_hochberg`/`bonferroni`; IC via `ranking.evaluation.compute_rank_ic`/`summarise_ic_series`. **Deflated Sharpe Ratio and PBO are NEW** in `research/statistics.py`.
- **Promotion boundary** → recommend `CHALLENGER_CANDIDATE` only; hand off to `lifecycle.challenger.ChallengerRegistry` / `lifecycle.gates.PromotionGate` / `lifecycle.promotion.PromotionOrchestrator`. Research factory NEVER promotes.

## Blocking issues
**None.** All prior phases implemented and executable. Baseline regression green. Proceeding with additive `src/research/` package.
