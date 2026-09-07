# ML Audit: Phase 3F — Meta-Labeling, Probability Calibration & Abstention

**Phase:** 3F
**Audit scope:** `src/meta/` — all 5 existing files + 5 new files
**Date:** 2026-09-06
**Status:** PASS — 71/76 tests pass (5 skipped: sklearn/lgbm/xgb/scipy absent)

---

## 1. What Changed and Why

### 1.1 The core problem

The existing `MetaDecisionEngine` had a fundamental semantic error: it described its output as "outperformance probability" but its LightGBM config was `objective="regression"` and its inference produced a 0–100 score. The `CalibrationStore` fallback returned `clip(raw_score, 0, 1)` as a "calibrated probability" — this is not calibration.

Phase 3F corrects this by introducing explicit canonical types that cannot be accidentally confused:

```
AlphaScore          ≠   RawProbabilityScore
RawProbabilityScore ≠   CalibratedProbability
CalibratedProbability ≠ ExpectedReturn
ExpectedReturn      ≠   ExpectedValue
ExpectedValue       ≠   Decision
```

### 1.2 What Phase 3F adds

1. **Canonical type system** — `meta/schemas.py` with `ScoreType`, `ProbabilityStatus`, `Decision`, `EVStatus` enums and typed dataclasses
2. **Meta-label engine** — `meta/meta_label.py` with 3 configurable versioned policies (A/B/C) and stacking leakage enforcement
3. **Calibration engine** — `meta/calibration_engine.py` with `CalibratorArtifact` (4 explicit states), `walk_forward_calibrate()`, full calibration diagnostics
4. **Meta ranker models** — `meta/meta_ranker.py` with 4 models from baseline to LightGBM
5. **EV engine** — `meta/ev_engine.py` with asymmetric payoffs, EV leakage protection, cost model

---

## 2. New File Inventory

```
ml-service/src/meta/
├── schemas.py          # Canonical types: AlphaScore, RawProbabilityScore,
│                       # CalibratedProbability, ExpectedValue, Decision, etc.
├── meta_label.py       # MetaEvent, MetaLabelPolicy (A/B/C), build_meta_labels()
├── calibration_engine.py # CalibratorArtifact (4 states), walk_forward_calibrate()
├── meta_ranker.py      # BaseMetaRanker ABC, 4 model classes, compare_meta_models()
├── ev_engine.py        # PayoffDistribution, ExpectedValueCalculator, bucket analysis
│
│ (Existing, modified)
├── calibration.py      # Fix BUG-3F-001/002/003: clip removed, eval_is_oos added
├── decision_policy.py  # Fix BUG-3F-005: signal_confidence = weighted_confidence
├── meta_model.py       # Fix BUG-3F-004/006/007: risk signal, IV None, weighted_conf
```

---

## 3. Bugs Fixed

| Bug | File | Root cause | Fix | Test |
|-----|------|-----------|-----|------|
| BUG-3F-001 | calibration.py | `clip(raw_score)` returned as "calibrated probability" | Returns 0.5 neutral | `test_calibration_store_unknown_model_returns_neutral` |
| BUG-3F-002 | calibration.py | `calibrate_batch()` same clip fallback | Returns 0.5 array | `test_calibration_store_batch_unknown_returns_neutral` |
| BUG-3F-003 | calibration.py | `eval_is_oos` not stored | Added field | `test_legacy_calibration_quality_has_eval_is_oos` |
| BUG-3F-004 | meta_model.py | Risk signal prob-diff calibrated as logit | Pass directly, no calibration | (integration test) |
| BUG-3F-005 | decision_policy.py | `signal_confidence = abs(weighted_score)` | `= er.weighted_confidence` | (meta_engine regression) |
| BUG-3F-006 | meta_model.py | `IVPrediction.confidence = 0.7` fabricated | `Optional[float] = None` | (meta_engine regression) |
| BUG-3F-007 | meta_model.py | Unweighted mean_conf ignores calibration quality | `= ensemble.weighted_confidence` | (meta_engine regression) |
| BUG-3F-008 | calibration_engine.py | Staleness checked before fitted | UNCALIBRATED → MISMATCH → STALE order | `test_unfitted_returns_uncalibrated`, `test_stale_calibrator_returns_stale_status` |

---

## 4. Critical Invariants Verified

### 4.1 No raw-score-as-probability

| Test | Result |
|------|--------|
| `test_unfitted_calibrator_artifact_returns_uncalibrated` | PASS |
| `test_calibration_store_unknown_model_returns_neutral` | PASS |
| `test_calibrated_probability_unavailable_has_none_value` | PASS |

### 4.2 Stacking leakage prevention

| Test | Result |
|------|--------|
| `test_build_meta_labels_rejects_in_sample_predictions` | PASS |
| `test_meta_event_assert_oos_raises_for_in_sample` | PASS |

### 4.3 Calibration temporal order

| Test | Result |
|------|--------|
| `test_walk_forward_temporal_order_invariant` | PASS |
| `test_calibrator_fit_end_before_eval_start` | PASS |

### 4.4 EV leakage protection

| Test | Result |
|------|--------|
| `test_payoff_future_of_prediction_time_raises` | PASS |
| `test_ev_calculator_detects_leakage` | PASS |

### 4.5 CalibratorArtifact states

| Test | Result |
|------|--------|
| `test_unfitted_returns_uncalibrated` | PASS |
| `test_model_mismatch_returns_mismatch_status` | PASS |
| `test_stale_calibrator_returns_stale_status` | PASS |

### 4.6 Outcome feature leakage guard

| Test | Result |
|------|--------|
| `test_gross_return_in_features_raises` | PASS |
| `test_mfe_in_features_raises` | PASS |
| `test_clean_features_pass` | PASS |

---

## 5. Backward Compatibility

| Consumer | Impact | Status |
|----------|--------|--------|
| `MetaDecisionEngine.decide()` | `signal_confidence` now uses weighted_confidence (more correct) | ✅ Behavior improved |
| `CalibrationStore.calibrate()` | Returns 0.5 instead of clip(raw) for unknown models | ✅ More correct |
| `IVPrediction.confidence` | Changed to `Optional[float] = None` | ⚠️ Code calling `iv.confidence` must handle None |
| All prior test suites | 405 pass / 0 fail | ✅ |

---

## 6. Phase 3G Gaps

1. Wire `MetaEvent` events from real Phase 3C label pipeline to meta model training
2. Connect `PayoffDistribution.estimate_payoff_from_outcomes()` to real historical events
3. Run actual walk-forward meta-model OOS evaluation on real NSE data
4. Implement probability drift monitoring
5. Wire `EVConfig.cost_model` from actual NSE cost data (STT, brokerage, etc.)
6. SHAP feature importance for meta-model decision explainability
7. Long vs short conditional calibration (when sample sizes permit)
