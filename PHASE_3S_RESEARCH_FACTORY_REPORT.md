# PHASE 3S — Research Factory & Experimentation Governance Report

**Phase:** 3S — Research factory & experimentation governance
**Service:** `ml-service`
**Branch:** `refactor/improve-ml-service`
**Base commit:** `405ae93` (PHASE_3R)
**Date:** 2026-09-06
**Type:** ADDITIVE — new package `ml-service/src/research/`; no HEAD-tracked file modified (except CHANGES.md)
**This phase is NOT about creating more models. This is NOT a live-trading phase.**

---

## 1. Entry audit

Verified Phase 3M–3R exist as executable code (not labels) before building 3S — full details in `PHASE_3S_ENTRY_AUDIT.md`. HEAD was `405ae93` (PHASE_3R), on origin, working tree clean. Baseline regression reconfirmed at **1449 passed / 28 skipped**. No blocking issue; no minimum-prerequisite fix required. Reuse map established: `validation.walk_forward`, `ranking.evaluation`, `paper.evidence` (bootstrap + BH/Bonferroni), `deep.leakage_tests` (leakage/placebo/negative-control probes), `data_reliability.snapshot`/`security`, `lifecycle` (challenger/gates/promotion, atomic storage). Deflated Sharpe and PBO confirmed absent and built new.

## 2. Architecture

19 modules under `ml-service/src/research/` (123 exports), organized as: identity & governance (`hypothesis`, `manifest`, `metrics`, `status`), data & features (`data_snapshot`, `features`), methodology (`validation`, `experiment_tiers`, `baseline`, `ablation`, `incremental`), statistics & controls (`statistics`, `controls`), decision & evidence (`comparison`, `leaderboard`, `gates`, `artifact`, `factory`). Every module reuses existing engines rather than reimplementing them. Full description in `docs/PHASE_3S_RESEARCH_FACTORY.md`.

## 3. Experiment lifecycle

HYPOTHESIS → EXPERIMENT SPEC → DATA SNAPSHOT → FEATURE/SIGNAL → TRAINING → VALIDATION → OOS → COST/EXECUTION → STABILITY → STATISTICAL INFERENCE → RESEARCH DECISION → EVIDENCE PACKAGE → (optional) CHALLENGER RECOMMENDATION. No experiment skips the evidence chain. Pre-registration freezes the design before results are visible; the experiment produces an immutable, hashed artifact.

## 4. Hypothesis system

Falsifiable `Hypothesis` (mechanism + direction + target + horizon + universe + regime + rationale + explicit success AND failure criteria; vague hypotheses rejected). 13 `HypothesisType` categories. `PreRegistration` freezes exactly one primary metric plus design before results (§7, §8); the append-only `HypothesisRegistry` never overwrites.

## 5. Data governance

Immutable `ResearchDataSnapshot` (rejects `latest`/`current`), reproducible `SnapshotIdentity` fingerprint, and point-in-time `Universe` (survivorship-biased non-PIT universes rejected). Feature registry with full provenance; undocumented features rejected.

## 6. Validation architecture

Chronological / walk-forward / purged / embargo / nested schemes (reusing the existing validators). The final OOS is **sealed**: `SealedOOS.reveal` permits only `final_evaluation`; HPO/feature/model/threshold/iteration reveals are refused and recorded as contamination. HPO governance blocks any run that touched the OOS.

## 7. Baseline framework

Baseline-first rule enforced (`require_baseline`). 11 canonical baselines including random-signal and shuffled-label controls. Direction-aware "beats baseline" via the canonical metric registry.

## 8. Ablation framework

Feature / feature-family / model-component / signal-family / regime / execution / cost ablations, each reporting a direction-aware per-component contribution against the full model and baseline.

## 9. Leakage controls

Future-feature guard (feature time ≤ label entry), normalization-leakage guard (scaler fit only on train, never OOS or full-dataset-before-split), and sealed-OOS access control. Any future dependency → `LeakageInvalidation` (EXPERIMENT_INVALIDATED, fail-closed). Reuses the Phase 3P leakage probes.

## 10. Multiple-testing controls

Bonferroni, Holm (step-down), and Benjamini-Hochberg corrections. `correct_multiple_testing` TRACKS the total number of trials and pads hidden trials with p=1.0 so failed trials cannot soften the correction. Deflated Sharpe Ratio and Probability of Backtest Overfitting (CSCV) and White's Reality Check specifically address selection over many trials/strategies.

## 11. Statistical framework

Deterministic block-bootstrap CIs (reused), effective-sample-size adjustment, Deflated Sharpe (skew/kurtosis/trials-aware), PBO, White's Reality Check, multi-seed evaluation with fragility detection, and degrees-of-freedom surfacing. Sample-size floors mark thin results `INSUFFICIENT_EVIDENCE`.

## 12. Experiment comparison

Apples-to-apples check across universe/period/labels/cost/execution/benchmark → `COMPARISON_INVALID` on any mismatch. The leaderboard is not ranked by return alone and visibly separates EXPERIMENTAL / VALIDATED / CHALLENGER rows.

## 13. Reproduction

`reproduce(experiment_id)` regenerates outputs from the immutable artifact and compares section hashes; a mismatch is `REPRODUCTION_FAILURE` and invalidates the experiment. Verified in tests: identical recompute → REPRODUCED; altered metric → REPRODUCTION_FAILURE.

## 14. Artifact integrity

`ExperimentArtifact.freeze` writes 12 sections + manifest + hashes atomically, refuses overwrite (immutability, §64), and blocks credential leakage (`ArtifactSecretLeak`, §55). `verify_integrity` detects on-disk tampering.

## 15. Security

No credentials are written to artifacts — the Phase 3Q `contains_secret` guard rejects secrets in any section or manifest (tested with `api_key` and `access_token`). All research randomness is explicit and seeded; tests use no network and no credentials.

## 16. Tests

`ml-service/tests/test_phase3s.py` — **77 deterministic tests** across 16 classes: Hypothesis(6), Manifest(7), Metrics(3), DataSnapshot(3), Features(5), Validation(5), BaselineAblation(3), Incremental(7), Statistics(5), Controls(6), StatusComparisonLeaderboard(3), Gates(3), Artifact(4), FactoryBoundary(6), TheTests(9, §58), Security(2, §55). Fixed seeds, tmp_path, no network/creds.

## 17. Failures (test-the-tests, §58)

Deliberate failures are caught: future feature → detected; sealed-OOS accessed for feature selection → refused + contamination flagged; changed config/dataset → different experiment hash; altered metric → reproduction failure; tampered artifact on disk → integrity failure; a single p=0.03 that is the best of 1000 trials → 0 significant after correction; duplicate experiment → rejected; overwritten artifact → `ArtifactError`.

## 18. Limitations

- **Synthetic-only.** No real alpha discovered or validated; no real market data processed through the factory.
- **Statistical methods are correctly implemented but unexercised on real ensembles** — DSR/PBO/reality-check thresholds should be recalibrated against real experiment populations before a live research program.
- Correlated-signal residualization uses OLS residuals; near-collinear signals are classified redundant via an explained-variance guard.
- No live path, no promotion, no retrain/recalibrate, no threshold/weight optimization — by design.

## 19. Unresolved risks

- Because no real experiments have run, the *calibration* of gate thresholds and statistical cut-offs against real data is unverified. The machinery is correct; the operating points are provisional.
- The challenger boundary depends on humans honoring the recommend-only contract; the factory enforces it structurally (no promote method, `promoted=True` invariant blocked) but cannot prevent a separate authorized process from promoting.
- Reused statistical primitives inherit their own assumptions (block-bootstrap block size, normal-approx CIs).

## 20. Evidence generated

- `PHASE_3S_ENTRY_AUDIT.md` (entry audit)
- `ml-service/src/research/` (19 modules, 123 exports) — import-clean
- `ml-service/tests/test_phase3s.py` (77 tests, all passing)
- `docs/PHASE_3S_RESEARCH_FACTORY.md` (design doc)
- Full regression 3A–3S: **1526 passed / 28 skipped**, zero new regressions (baseline 1449 + 77 new)

**§62 acceptance gates:**
- Research: immutable experiment identity ✓, pre-registered hypotheses ✓, versioned datasets ✓, PIT enforced ✓, chronological validation ✓, final OOS protected ✓.
- Scientific rigor: baseline required ✓, incremental alpha tested ✓, ablations ✓, placebo/negative controls ✓, multiple testing ✓, uncertainty reported ✓, sample size visible ✓.
- Reproducibility: artifacts immutable ✓, experiment hash ✓, reproduction works ✓, seeds recorded ✓.
- Governance: failed experiments preserved ✓, promotion boundary enforced ✓, human review required ✓, no automatic promotion ✓.
- Security: experiment artifacts secret-guarded ✓, arbitrary overwrite prevented ✓, secrets protected ✓.
- Testing: Phase 3S tests pass ✓, previous regression passes ✓, test-the-tests pass ✓.

**Final status:** `PHASE_3S_PASS`
**RESEARCH_FACTORY_STATE:** `RESEARCH_OPERATIONAL_WITH_LIMITATIONS`
**ALPHA_EVIDENCE_STATE:** `INSUFFICIENT_EVIDENCE`

**Recommended next phase:** Run real (or high-fidelity historical) research experiments through the factory to calibrate gate thresholds and statistical operating points and to accumulate genuine alpha evidence — as a separate, explicitly-authorized phase. No promotion, retraining, or live path without dedicated, separately-gated authorization.
