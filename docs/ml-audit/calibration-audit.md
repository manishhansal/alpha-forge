# AlphaForge ML Service — Calibration Audit

**Audit Date:** 2026-09-06  
**Scope:** `meta/calibration.py`, `meta/meta_model.py::fit_meta_layer()`, ensemble weighting

---

## 1. Calibration Architecture

### 1.1 Design

Two calibrators per model, managed by `CalibrationStore`:

| Calibrator | Type | Appropriate When | Min Samples |
|---|---|---|---|
| `PlattCalibrator` | Logistic regression on scores | Monotone score → probability | ~50+ |
| `IsotonicCalibrator` | Isotonic regression | Non-monotone mapping | ~300+ |

The store:
1. Fits both calibrators when `fit_both()` is called
2. Computes ECE, MCE, Brier score for each
3. Selects the one with lower ECE as the `active_kind`
4. Returns calibrated probabilities via `calibrate()` / `calibrate_batch()`

### 1.2 Calibrator Coverage

7 models have calibrators:
```python
MODEL_NAMES = [
    "regime", "ranker", "strategy", "risk",
    "price_forecaster", "iv_classifier", "quant_engine"
]
```

Unfitted calibrators pass the raw score through a sigmoid or clip to [0,1] — safe degradation.

---

## 2. Critical Issue: In-Sample Quality Metrics

### 2.1 The Bug

`CalibrationStore.fit()`:
```python
def fit(self, model_name, scores, labels, kind="platt"):
    entry.platt.fit(scores, labels)           # ← fit on scores
    cal_probs = entry.platt.predict_proba(scores)  # ← evaluate on SAME scores
    ece, mce = _expected_calibration_error(cal_probs, labels)
    brier = _brier_score(cal_probs, labels)
    quality = CalibrationQuality(
        ece=ece, brier_score=brier, is_fitted=True  # ← in-sample metrics
    )
```

The calibration quality metrics (ECE, MCE, Brier) are computed on the **same data that was used to fit the calibrator**. For Platt scaling (logistic regression), in-sample ECE is systematically lower than OOS ECE because the sigmoid parameters are fit to minimise exactly that error on those points.

**Consequence:** The `quality_score` property is:
```python
return float(np.clip(1.0 - self.ece - 0.5 * self.brier_score, 0.0, 1.0))
```
This score is used in `EnsembleWeighter`:
```python
cal_adjusted_w = {
    s.model_name: base_w.get(s.model_name, 0.05) 
                  * self._cal_quality.get(s.model_name, 1.0)
    for s in available
}
```

A model with in-sample ECE = 0.02 gets a quality multiplier of ~0.99 (near-perfect). A model with genuinely poor calibration may appear well-calibrated in-sample. This makes the quality-weighted ensemble unreliable.

### 2.2 The Correct Approach

The docstring in `fit()` says:
> **Never call this with in-sample predictions** — stacking leakage will make the calibrator over-confident.

This warning is correct, but the implementation of quality measurement in the same call contradicts it. The fix is to:
1. Fit on one set of OOS predictions
2. Evaluate quality on a separate held-out OOS set

The `MetaDecisionEngine.fit_meta_layer()` accepts `OOSPredictionRecord` objects — this is the right interface. But `CalibrationStore.fit()` must be modified to accept a separate evaluation set, or evaluation must be triggered separately after fitting on a truly held-out partition.

---

## 3. Calibration Quality Metrics

### 3.1 ECE (Expected Calibration Error)
```python
def _expected_calibration_error(probs, labels, n_bins=10):
    # Bin-based: sum over bins of (bin_fraction × |confidence - accuracy|)
```

Standard implementation. The 10-bin default is reasonable. Edge case: empty bins are skipped (`if mask.sum() == 0: continue`) — correct.

### 3.2 MCE (Maximum Calibration Error)
```python
mce = max(|bin_confidence - bin_accuracy|)
```

Worst-case bin miscalibration. A useful supplement to ECE — a model may have low average ECE but a single pathological bin (e.g., very high confidence predictions that are consistently wrong). MCE catches this.

### 3.3 Brier Score
```python
_brier_score = mean((probs - labels) ** 2)
```

Standard implementation. Penalises both over-confidence and under-confidence quadratically.

**All three metrics are correctly implemented.** The problem is exclusively in when they are applied (in-sample vs OOS).

---

## 4. Isotonic Calibrator Serialization

```python
def to_dict(self):
    model_bytes = pickle.dumps(self._model, protocol=4)
    return {"model_b64": base64.b64encode(model_bytes).decode("ascii")}
```

Uses `pickle` for serialization of the sklearn `IsotonicRegression` object, base64-encoded inside JSON. This approach preserves all internal sklearn attributes (`X_min_`, `X_max_`, `f_`, etc.) that are needed for correct prediction.

**Security note:** Loading pickled data from untrusted sources is a code injection risk. In this context, the data is saved and loaded internally (not from a user-provided file), so the risk is low. However, if `calibration_store.json` is ever exposed to external write access, this is a vulnerability.

**Verdict:** Acceptable for internal use; flag for production hardening.

---

## 5. Ensemble Weight Dependency on Calibration Quality

The `EnsembleWeighter` adjusts base regime weights by calibration quality:
```python
cal_adjusted_w[model_name] = base_w * cal_quality_score
```

With calibration unfitted (quality_score = 0.5 for all models), this is equivalent to halving all weights equally — no differential adjustment. This is a safe default.

With in-sample calibration fitted (quality_score ≈ 0.9-0.99 for all models), the multiplier barely differentiates between models. The regime weights dominate.

**Result:** The calibration quality weighting has minimal practical effect in either case (unfitted or in-sample-fitted). Only correctly OOS-calibrated quality scores would meaningfully differentiate model weights.

---

## 6. Probability Calibration for Multi-Class Models

Regime and Strategy models output multi-class probabilities (6 and 8 classes respectively). The current calibration infrastructure only handles **binary** calibration:

- `PlattCalibrator.fit()` uses `LogisticRegression` — binary only
- `IsotonicCalibrator.fit()` uses `IsotonicRegression` — binary only
- `CalibrationStore.fit()` passes binary `labels {0, 1}` and single `scores`

The meta-engine extracts a single scalar from these multi-class models:
- Regime → `confidence = regime.confidence` (max class probability)
- Strategy → `confidence = strategy.confidence`

So the calibrator is applied to the max-class probability rather than the full probability vector. This is a simplification — it calibrates the confidence score but does not separately calibrate the probability of each class. For the ensemble's purposes (BUY/SELL/WAIT/NO_TRADE), this is acceptable.

---

## 7. OOS Training Path

`MetaDecisionEngine.fit_meta_layer()` expects `OOSPredictionRecord` objects:
```python
@dataclass
class OOSPredictionRecord:
    model_name: str
    raw_score: float
    label: float           # 0.0 or 1.0
    fold_id: int
```

This is the correct interface for collecting base-model predictions from walk-forward folds. The method:
1. Groups records by model
2. Skips models with fewer than `min_samples_per_model` records (default 50)
3. Validates labels are binary
4. Calls `fit_both()` — fits Platt and isotonic, selects better ECE

The design is right. The gap is that this path is never exercised in `train_all.py`.

---

## 8. Assessment

| Aspect | Status | Notes |
|---|---|---|
| Platt scaling implementation | ✅ Correct | Standard logistic regression approach |
| Isotonic regression implementation | ✅ Correct | Proper out-of-bounds clipping |
| ECE/MCE/Brier metrics | ✅ Correct | Standard formulations |
| In-sample quality measurement | ❌ Bug | Must be OOS |
| Multi-class calibration | ⚠️ Simplified | Binary calibration of max-class confidence |
| Serialization | ⚠️ Pickle | Acceptable for internal use |
| OOS training path | ✅ Designed | Never exercised in train_all.py |
| Ensemble weight dependency | ⚠️ Weak | In-sample quality barely differentiates |

---

## 9. Recommendations

| Priority | Action |
|---|---|
| 🔴 CRITICAL | `CalibrationStore.fit()`: compute quality metrics on a **separate held-out OOS set**, not the fitting data. Add an optional `eval_scores` / `eval_labels` parameter |
| 🔴 HIGH | Wire `fit_meta_layer()` into the training pipeline — collect OOS predictions from walk-forward folds and calibrate after training |
| 🟡 MEDIUM | Consider temperature scaling as a simpler alternative to Platt for softmax-output models (regime, strategy) |
| 🟡 MEDIUM | Add reliability curve plotting to the calibration output for visual inspection |
| 🟢 LOW | Replace pickle serialization with a JSON-serializable format (e.g., store X_thresholds_ and y_thresholds_ as arrays) |
| 🟢 LOW | Document minimum sample requirements for each calibrator in user-facing documentation |
