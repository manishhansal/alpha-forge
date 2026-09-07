# Phase 3S — Research Factory & Experimentation Governance

**Scope:** A rigorous research factory around the existing AlphaForge ML/quant stack.
**Package:** `ml-service/src/research/` (additive; reuses Phase 3G/3M–3R components).
**This phase is NOT about creating more models.** It makes AlphaForge capable of discovering alpha **without fooling itself**.

> Research failure is a valid result. `NO_INCREMENTAL_ALPHA`, `NO_NET_ALPHA`, `NO_OOS_ALPHA`, and `INSUFFICIENT_EVIDENCE` are all valid, first-class outcomes. Evidence is never upgraded merely because tests pass.

The factory NEVER: enables live trading, places orders, auto-promotes, auto-retrains/recalibrates, optimizes thresholds/weights from paper results, tunes against the final OOS, or mutates historical evidence.

---

## 1. Package layout

| Module | Responsibility |
| --- | --- |
| `hypothesis.py` | Falsifiable hypotheses (§5), types (§6), pre-registration (§7) |
| `manifest.py` | Immutable experiment identity + status machine + experiment hash (§3, §4, §44) |
| `metrics.py` | Canonical metric registry + primary-metric governance (§8, §9) |
| `data_snapshot.py` | Immutable dataset snapshot + PIT universe control (§10, §11) |
| `features.py` | Feature registry + provenance + leakage/normalization guards (§12–§15) |
| `validation.py` | Walk-forward + sealed untouched OOS (§16) |
| `experiment_tiers.py` | Tier A–D classification (§17) |
| `baseline.py` | Baseline-first rule (§18) |
| `ablation.py` | Ablation framework (§19) |
| `incremental.py` | Incremental-alpha test, correlated-signal audit, cross-sectional/time-series diagnostics (§20–§23) |
| `statistics.py` | Bootstrap CIs, multiple-testing (Bonferroni/Holm/BH), Deflated Sharpe, PBO, White's Reality Check (§29, §30, §35) |
| `controls.py` | Placebo, negative controls, multi-seed, degrees-of-freedom, data-snooping lineage, HPO governance (§32–§37, §45, §46) |
| `status.py` | Research states + failure taxonomy (§40, §50) |
| `comparison.py` | Apples-to-apples comparison (§38) |
| `leaderboard.py` | Research leaderboard, not ranked by return alone (§39) |
| `gates.py` | Nine automated research gates (§51) |
| `artifact.py` | Immutable experiment artifact + hashes + reproduction (§42, §43, §44) |
| `factory.py` | Orchestrator: promotion boundary, human review, isolation (§41, §52, §56) |

All modules are import-clean and reuse existing engines (validation, ranking evaluation, paper evidence statistics, leakage probes, data-reliability snapshot/security) rather than reimplementing them.

---

## 2. Research lifecycle

```
HYPOTHESIS → EXPERIMENT SPEC → DATA SNAPSHOT → FEATURE/SIGNAL → TRAINING →
VALIDATION → OOS EVALUATION → COST/EXECUTION → STABILITY → STATISTICAL INFERENCE →
RESEARCH DECISION → EVIDENCE PACKAGE → (OPTIONAL) CHALLENGER RECOMMENDATION
```

No experiment may skip the evidence chain. A research experiment always begins with a pre-registered, falsifiable hypothesis and ends with an immutable, hashed evidence package.

---

## 3. Hypothesis registry & pre-registration

A `Hypothesis` (frozen) must be **falsifiable**: it declares a mechanism, expected direction, target, horizon, universe, regime assumptions, economic rationale, and explicit **success AND failure criteria**. Vague hypotheses ("improve the model") are rejected with `HypothesisError`. One of 13 `HypothesisType` categories (§6) must be declared; types are not mixed.

A `PreRegistration` freezes the experiment design — primary metric (exactly one, §8), secondary metrics, validation windows, expected direction, stopping/exclusion criteria, universe, cost model, statistical test — **before results are visible**. Freezing computes a hash; any change is a NEW experiment (§64), never a mutation. The `HypothesisRegistry` is append-only.

---

## 4. Experiment identity & manifest

`ExperimentManifest` (frozen) carries the full reproducible identity: hypothesis, type, dataset id/hash, universe, feature/label versions, model type/config hash, training/validation/cost/execution/portfolio config hashes, random seed, code commit, environment. `experiment_hash` (§44) is deterministic over these — two experiments with identical inputs produce the same hash. `ResearchExperimentRegistry` is append-only; status changes are new events; terminal experiments are immutable (§64); duplicate ids are rejected; `lineage()` exposes the parent chain for data-snooping control.

Statuses: `CREATED → RUNNING → COMPLETED → PROMOTABLE → PROMOTED_TO_CHALLENGER`, plus `FAILED / INVALIDATED / REJECTED / ABANDONED`.

---

## 5. Data snapshots & universe control

Every experiment uses an immutable `ResearchDataSnapshot` — a `dataset_id` of `latest`/`current`/`live` is rejected (§10). The snapshot wraps the reproducible Phase 3Q `SnapshotIdentity` (deterministic fingerprint over provider/date-range/universe/schema/transformation/corporate-action/feature versions). The `Universe` must be **point-in-time** (§11): a non-PIT universe is rejected as survivorship-biased.

---

## 6. Feature registry, provenance & leakage controls

Every research feature is documented (`ResearchFeature`) with full `FeatureProvenance` (source data, transformation, availability time, version). Undocumented features are rejected (§12).

Leakage controls (§14, §15) reuse the existing probes:
- **Future-feature guard** (`future_label_probe`): every feature time must be ≤ its label entry time.
- **Normalization-leakage guard** (`future_scaler_probe` + `check_normalization_causal`): the scaler must be fit only on training indices — never on OOS, never on the full dataset before the split.

Any detected future dependency raises `LeakageInvalidation` → **EXPERIMENT_INVALIDATED** (fail-closed).

---

## 7. Validation & the untouched final OOS

`build_research_split` carves a chronological train/val/OOS split; the final OOS fraction is **sealed**. `SealedOOS.reveal(purpose)` permits only `final_evaluation` — any selection/tuning purpose (`hpo`, `feature_selection`, `model_selection`, `threshold`, `iteration`, …) is refused with `OOSAccessError` and recorded, and `contamination_check()` reflects it (§16). Walk-forward folds reuse the existing `WalkForwardValidator`.

---

## 8. Baseline-first, ablation & incremental alpha

Every experiment must declare a baseline (§18) from `BaselineType` (buy-and-hold, sector/market benchmark, existing champion, momentum, trend, logistic, ridge, random signal, shuffled label, …); comparison is direction-aware via the metric registry. Ablations (§19) report per-component contribution. The incremental-alpha test (§20) returns one of: `INSUFFICIENT_EVIDENCE` (sample too small), `NO_NET_ALPHA` (erased by costs), `NO_OOS_ALPHA` (erased out-of-sample), or `INCREMENTAL_ALPHA`. The correlated-signal audit (§21) residualizes a new signal against existing ones and classifies it `REDUNDANT` or `INCREMENTAL` — correlation alone never rejects a signal.

---

## 9. Statistical inference & multiple testing

Reuses the deterministic block-bootstrap CIs and BH/Bonferroni corrections from `paper.evidence`, and adds:
- **Holm** step-down correction.
- **`correct_multiple_testing`** that TRACKS `n_trials` and pads hidden trials with p=1.0 so failed trials can't soften the correction (§35). p<0.05 is never treated as sufficient after many trials.
- **Deflated Sharpe Ratio** (Bailey & López de Prado): deflates the observed Sharpe for the number of trials, sample length, skew and kurtosis.
- **Probability of Backtest Overfitting** (CSCV): how often the in-sample-best config underperforms out-of-sample.
- **White's Reality Check** (bootstrap): whether the best of many strategies genuinely beats a benchmark after the search.

---

## 10. Placebo & negative controls, multi-seed, degrees of freedom

- **Placebo** (§32): shuffling train labels must collapse OOS skill (reuses `label_permutation_probe`).
- **Negative control** (§33): a deliberately meaningless feature must not receive strong importance.
- **Multi-seed** (§45, §46): mean/median/std/worst/best + CI; a result that exists only under one lucky seed is flagged `single_seed_dependent`.
- **Degrees of freedom** (§37): the 12 researcher choices (universe/timeframe/horizon/features/model/threshold/costs/stop-target/portfolio/rebalance/benchmark/window) are surfaced.
- **Data-snooping lineage** (§36): counts prior experiments reusing the same dataset/universe/features/target.
- **HPO governance** (§34): an HPO run that touched the sealed OOS is invalid (`HPOGovernanceError`).

---

## 11. Experiment comparison, leaderboard & status

Comparisons are apples-to-apples (§38): differing universe/period/labels/cost/execution/benchmark → `COMPARISON_INVALID`. The leaderboard (§39) is **not** ranked by return alone — it exposes primary metric, net return, Sharpe, drawdown, turnover, costs, IC/Rank IC, calibration, statistical confidence, stability, capacity, evidence tier, sample size, and multiple-testing status, and separates `EXPERIMENTAL / VALIDATED / CHALLENGER` rows. Research states (§40) are explicit; there is deliberately **no standalone `SUCCESS`** status.

---

## 12. Evidence package, reproduction & artifact integrity

`ExperimentArtifact.freeze` writes 12 immutable sections + manifest + hashes atomically. It refuses to overwrite (§64) and raises `ArtifactSecretLeak` if any section carries a credential (§55). `verify_integrity` recomputes and compares section hashes (tamper detection). `reproduce(experiment_id)` regenerates the outputs and compares hashes; a mismatch is `REPRODUCTION_FAILURE` and the experiment is invalidated (§43).

---

## 13. Challenger boundary & human review

The `ResearchFactory` may only **RECOMMEND** a `CHALLENGER_CANDIDATE`, and only when all nine research gates pass **and** the earned tier is D. Even then the decision carries `requires_human_review=True` and `promoted=False` — the `promoted=True` state is an enforced invariant that raises `PromotionBoundaryError`. The factory has **no** `promote`/`deploy`/`retrain`/`recalibrate` method. Promotion remains the authoritative lifecycle/human-approval process (§41, §52). `IsolationGuard` verifies that running an experiment leaves champion / challenger / paper session / production config / historical evidence unchanged (§56).

---

## 14. Nine automated research gates (§51)

Data → Methodology → Baseline → OOS → Costs → Stability → Statistics → Reproduction → Evidence. All gates are fail-closed (missing evidence never passes). Only when **all nine** pass is an experiment challenger-eligible — and eligibility is not promotion.

---

## 15. Known limitations & approximations

- **Synthetic-only.** All tests run on deterministic synthetic data. No real alpha has been discovered or validated; no real market data has been processed through the factory.
- **`ALPHA_EVIDENCE_STATE: INSUFFICIENT_EVIDENCE`.** Operational machinery is green; statistical/economic validity of any specific alpha is a separate, unmet gate. Evidence is not upgraded because tests pass (§63).
- **Statistical methods are correctly implemented but unexercised on real hypotheses** — DSR/PBO/reality-check thresholds should be recalibrated against real experiment ensembles before use in a live research program.
- No live path, no promotion, no retrain/recalibrate, no threshold/weight optimization — by design.
