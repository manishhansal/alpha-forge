# Phase 3I — Calibration Drift Report

**Generated:** 2026-09-06  
**Branch:** `refactor/improve-ml-service`  
**OOS evidence:** INSUFFICIENT_EVIDENCE

---

## 1. Scope

Documents calibration drift analysis in `src/stability/calibration_drift.py`.
Tracks whether the Phase 3F calibrated probabilities remain well-calibrated
through time.

---

## 2. Metrics Tracked Per Temporal Period

| Metric | Meaning | Ideal |
|--------|---------|-------|
| Brier score | mean squared error of probabilities | Lower |
| ECE | Expected Calibration Error | Lower |
| MCE | Maximum Calibration Error | Lower |
| Log loss | negative log-likelihood | Lower |
| Calibration slope | regression of outcome on probability | 1.0 |
| Calibration intercept | regression intercept | 0.0 |

These reuse `meta.calibration_engine.compute_calibration_metrics()`.

---

## 3. Drift Detection

Trend slopes are computed via `scipy.stats.linregress` over the per-period metrics:

- `brier_trend_slope > 0` → Brier increasing → calibration degrading
- `ece_trend_slope > 0` → ECE increasing → degrading
- `slope_trend` → calibration slope drifting away from 1.0

---

## 4. Predicted vs Realized (spec §20)

Calibration is NOT evaluated on probability distributions alone. Each temporal
period compares predicted probability to actual success frequency (via the Brier
and reliability curve). A period where predicted 0.70 but actual 0.51 surfaces
as calibration degradation (higher Brier, slope < 1).

---

## 5. Status Classification

| Status | Condition |
|--------|-----------|
| STABLE | Brier trend slope ≤ 0.001, recent Brier ≤ 1.05× early |
| WEAKENING | Brier trend slope in (0.001, 0.005], OR recent Brier 1.05–1.20× early |
| DECAYING | Brier trend slope > 0.005, OR recent Brier > 1.20× early |
| INSUFFICIENT_EVIDENCE | fewer than 2 valid folds |

---

## 6. Integration with walk_forward_calibrate

`analyse_calibration_fold_results()` consumes the per-fold output of
`meta.calibration_engine.walk_forward_calibrate()` (which enforces
`fit_end_time < eval_start_time`) and analyses the Brier/ECE trend across folds.
The fold index is the time axis — each fold's eval window is strictly after its
fit window (no temporal leakage).

---

## 7. Framework Verification (Synthetic Data)

| Scenario | Expected | Result |
|----------|----------|--------|
| Well-calibrated → miscalibrated | brier_trend_slope > 0 | PASS |
| Consistently calibrated | brier trend computed | PASS |
| 1 fold, 3 obs | INSUFFICIENT_EVIDENCE | PASS |
| Slope tracked per period | 3 periods returned | PASS |

---

## 8. OOS Evidence

**INSUFFICIENT_EVIDENCE** — no real calibrated-probability / realized-outcome
panel loaded. Real calibration drift requires production predictions with
resolved outcomes across multiple time periods.

---

## 9. Limitations

- `analyse_calibration_fold_results` reads Brier/ECE from fold metric dicts;
  it cannot recompute reliability curves without raw probs/labels per fold.
- Regime-conditional Brier (Brier by BULL vs BEAR) is available via
  `regime_decay` but requires regime labels aligned with probabilities.
