# Phase 3F — Current Meta-Layer Audit

**Date:** 2026-09-06
**Scope:** `src/meta/` — abstention.py, calibration.py, decision_policy.py, ensemble.py, meta_model.py
**Purpose:** Document exact current state before Phase 3F implementation

---

## Summary

The existing meta layer is a well-structured *orchestration pipeline* for combining 7 base-model signals into a BUY/SELL/WAIT/NO_TRADE decision. However, Phase 3F requires a genuine **meta-label model** — a second-level classifier that learns whether a primary alpha signal actually succeeds — which does not yet exist. The current `fit_meta_layer()` only calibrates individual base-model score→probability mappings; it does not train any secondary model.

Additionally, 11 semantic bugs conflate different score/probability types throughout the pipeline.

---

## Current State

### CURRENT_META_MODEL
`MetaDecisionEngine` is a pipeline orchestrator, not an ML meta-model. It:
1. Calibrates each of 7 base-model raw scores via `CalibrationStore`
2. Feeds calibrated signals into `EnsembleWeighter` (regime-aware, disagreement-penalised)
3. Checks `AbstentionPolicy` (7 conditions)
4. Passes ensemble result through `DecisionPolicy` → `TradeAction`

**There is no secondary ML model trained on base-model predictions.** `fit_meta_layer()` only fits Platt + isotonic calibrators per base model.

### CURRENT_CALIBRATION
- Methods: Platt scaling + isotonic regression per model in `CalibrationStore`
- Auto-selects better calibrator (lower ECE) when both are fitted
- **Fallback bug**: unknown model name → `clip(raw_score, 0.0, 1.0)` returned as "calibrated probability" — this is WRONG for logit-scale inputs
- Platt unfitted fallback: `sigmoid(raw_score)` — uncalibrated transform
- Isotonic unfitted fallback: `clip(raw_score, 0, 1)` — same clip bug
- `eval_is_oos` referenced in docstring but not stored as a field on `CalibrationQuality`

### CURRENT_ABSTENTION
7 conditions in `AbstentionPolicy`:
1. direction_disagreement > 0.40
2. prediction_variance > 0.18
3. data_quality < 0.60
4. n_available_models < 3
5. mean_confidence < 0.52
6. regime_confidence < 0.55
7. prob_stop_hit > 0.70
8. confidence_spread > 0.45
9. |ensemble_score| < 0.15

`prob_stop_hit` is passed **uncalibrated** from `RiskPrediction`. `from_ensemble_and_risk` static helper silently defaults `data_quality=1.0`, suppressing LOW_DATA_QUALITY checks.

### CURRENT_DECISION_POLICY
`DecisionPolicy.build_decision()` inputs: `EnsembleResult`, `data_quality`, `regime_confidence`, `prob_stop_hit`, `time_of_day_minutes`, `iv_regime`, `abstention_kind`

5-component confidence decomposition: signal (30%), agreement (25%), data (15%), regime (20%), execution (10%)

**Bug**: `signal_confidence = abs(weighted_score)` — uses signed-score magnitude, not a probability. A strong directional signal (e.g., 80% bull, 20% bear) with weighted_score ≈ 0.48 becomes signal_confidence = 0.48, systematically underestimating true signal quality.

### CURRENT_ENSEMBLE
`EnsembleWeighter.compute()` produces `weighted_score = Σ(weight × direction × calibrated_confidence)` — correct signed aggregate.

`EnsembleResult.weighted_confidence` (weighted mean of calibrated confidences) is computed but **never consumed downstream** — `meta_model.py` independently computes an unweighted mean instead.

`ModelSignal.confidence` contract ("calibrated probability [0,1]") is not runtime-enforced.

### CURRENT_PROBABILITY_SEMANTICS

| Value | What it actually is | Should be |
|-------|---------------------|-----------|
| `ModelSignal.confidence` | Calibrated P(model's direction is correct) | ✅ Correct |
| `signal_confidence` in decomp | `abs(ensemble_weighted_score)` | ❌ Not a probability |
| `prob_stop_hit` in abstention | Raw risk model output | ❌ Should be calibrated |
| `regime_confidence` in abstention | Raw regime classifier output | ⚠️ Passed raw |
| `IVPrediction.confidence` | Hard-coded 0.7 | ❌ Fabricated |
| `CalibrationStore.calibrate()` fallback | `clip(raw, 0, 1)` | ❌ Raw score ≠ probability |
| Risk signal raw | `abs(prob_target - prob_stop)` | ❌ Probability difference calibrated as logit |

### CURRENT_FALLBACKS (all fabricate values)

1. `CalibrationStore.calibrate(unknown_model)` → `clip(raw_score, 0, 1)` as "probability"
2. `PlattCalibrator.predict_proba(unfitted)` → `sigmoid(raw_score)` as "probability"
3. `IsotonicCalibrator.predict_proba(unfitted)` → `clip(raw_score, 0, 1)`
4. `inp.regime == None` → `regime_confidence = 0.5`, regime weights = `_DEFAULT_WEIGHTS`
5. `inp.risk == None` → `prob_stop_hit = 0.5` (neutral; masks missing risk data)
6. `IVPrediction.confidence` default = **0.7** (hard-coded fabrication)
7. `from_ensemble_and_risk` static helper → `data_quality=1.0`, `n_available_models=7` (suppresses checks)

### CURRENT_TRAINING_DATA
`fit_meta_layer(oos_records)` groups `OOSPredictionRecord` by `model_name`, validates binary labels, fits Platt + isotonic calibrators. 

**No secondary meta-label model is trained.** This is the primary gap for Phase 3F.

### CURRENT_OOS_DATA
`OOSPredictionRecord.fold_id` exists but is never validated for disjointness. No runtime OOS enforcement. Docstring warns "never include in-sample predictions" but no code enforces this.

When `eval_scores=None`, model selection (platt vs isotonic via ECE comparison) is done on fitting data — within-fold model-selection leakage.

---

## 11 Semantic Bugs

| # | Severity | Location | Description |
|---|----------|----------|-------------|
| 1 | HIGH | `abstention.py` | `AbstentionInputs.mean_confidence` accepts raw scores from static helper |
| 2 | HIGH | `meta_model.py` | `prob_stop_hit` passed uncalibrated to abstention and execution quality |
| 3 | CRITICAL | `calibration.py` | `CalibrationStore.calibrate()` fallback clips raw score as probability |
| 4 | MEDIUM | `calibration.py` | `eval_is_oos` documented but not stored in `CalibrationQuality` |
| 5 | HIGH | `meta_model.py` | Risk signal `abs(diff)` calibrated as logit-scale raw score — type mismatch |
| 6 | HIGH | `decision_policy.py` | `signal_confidence = abs(weighted_score)` — score magnitude ≠ probability |
| 7 | MEDIUM | `ensemble.py` | `weighted_confidence` computed but never used; `meta_model.py` uses unweighted mean |
| 8 | HIGH | `meta_model.py` | `IVPrediction.confidence = 0.7` hardcoded fabrication |
| 9 | HIGH | `abstention.py` | `from_ensemble_and_risk` defaults `data_quality=1.0`, suppresses checks |
| 10 | MEDIUM | `decision_policy.py` | `abstention_kind` defaults to `"none"` — silently skips abstention for standalone users |
| 11 | MEDIUM | `meta_model.py` | `regime_confidence` passed raw (uncalibrated) to abstention + decomp |

---

## What Must Change for Phase 3F

### New (does not exist)
- `meta/schemas.py` — canonical types: `AlphaScore`, `RawProbabilityScore`, `CalibratedProbability`, `ExpectedReturn`, `ExpectedValue`, `Decision`
- `meta/meta_label.py` — `MetaLabelPolicy` (A/B/C), `MetaEvent`, `build_meta_labels()`
- `meta/calibration_engine.py` — `CalibratorArtifact` with provenance, `walk_forward_calibrate()`
- `meta/meta_ranker.py` — second-level classification model (logistic, LightGBM, XGBoost)
- `meta/ev_engine.py` — `ExpectedValueCalculator`

### Fix (bugs in existing code)
- `calibration.py`: Add `eval_is_oos` to `CalibrationQuality`; fix fallback to not silently clip
- `decision_policy.py`: Replace `abs(weighted_score)` with true meta-label probability as signal_confidence
- `meta_model.py`: Fix risk signal calibration (BUG #5); remove `IVPrediction.confidence=0.7` fabrication
- `ensemble.py`: Use `weighted_confidence` as canonical mean_confidence in `decide()`
- `abstention.py`: Extend `AbstentionInputs` with `meta_label_probability`

### Reuse as-is
- `CalibrationStore` (Platt + isotonic infrastructure)
- `EnsembleWeighter` (regime weights, disagreement penalisation)
- `AbstentionPolicy` + thresholds (after extending inputs)
- `OOSPredictionRecord` (with added fold validation)
- `REGIME_WEIGHTS` table
