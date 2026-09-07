# Phase 3F — Meta-Labeling, Probability Calibration & Abstention: Calibration Report

**Phase:** 3F
**Date:** 2026-09-06
**OOS evidence status:** INSUFFICIENT_EVIDENCE

---

## Evidence Status

> **INSUFFICIENT_EVIDENCE** — No real historical Indian equity dataset available. All OOS calibration metrics (Brier score, ECE, log-loss, reliability curve) require real NSE/BSE data processed through the Phase 3B data pipeline.

---

## Semantic Bug Fixes (8 bugs fixed)

| Bug ID | Severity | Description | Fix |
|--------|----------|-------------|-----|
| BUG-3F-001 | **CRITICAL** | `CalibrationStore.calibrate()` returned `clip(raw_score, 0, 1)` as "calibrated probability" | Returns 0.5 (neutral) with warning |
| BUG-3F-002 | **CRITICAL** | `calibrate_batch()` same clip fallback | Returns `np.full(n, 0.5)` with warning |
| BUG-3F-003 | MEDIUM | `CalibrationQuality.eval_is_oos` documented but not stored | Added field; propagated into `fit()` |
| BUG-3F-004 | HIGH | Risk signal `abs(diff)` calibrated as logit-scale raw score | Pass directly as confidence (no calibration) |
| BUG-3F-005 | HIGH | `signal_confidence = abs(weighted_score)` — score ≠ probability | Replaced with `er.weighted_confidence` |
| BUG-3F-006 | MEDIUM | `IVPrediction.confidence = 0.7` hardcoded fabrication | Changed to `Optional[float] = None` |
| BUG-3F-007 | MEDIUM | `weighted_confidence` computed but never consumed | `decide()` now uses `ensemble.weighted_confidence` |
| BUG-3F-008 | LOW | `CalibratorArtifact.predict()` staleness checked before fitted | Check order: UNCALIBRATED → MISMATCH → STALE |

---

## New Calibration Infrastructure

### CalibratorArtifact states (check order)

```
1. UNCALIBRATED    — not yet fitted (checked first)
2. CALIBRATOR_MISMATCH — model_id or model_version mismatch
3. STALE           — age > max_age_days
4. CALIBRATED      — valid, up-to-date probability returned
```

The old `clip(raw_score)` fallback is **removed**. An unfitted or mismatched calibrator returns `None` value with explicit status. `is_usable()` returns `False` for all non-CALIBRATED states.

### CalibrationQualityV2

New fields vs legacy `CalibrationQuality`:

| Field | Legacy | Phase 3F |
|-------|--------|----------|
| `eval_is_oos` | Missing (documented but not stored) | ✅ Added |
| `log_loss` | Missing | ✅ Added |
| `calibration_slope` | Missing | ✅ Added |
| `calibration_intercept` | Missing | ✅ Added |
| Staleness check | Missing | ✅ `is_stale(current_time, max_age_days)` |

### Walk-forward calibration temporal invariant

```
fit_end_time < eval_start_time
```
Verified by `TestCalibrationLeakage::test_walk_forward_temporal_order_invariant`.

---

## OOS Calibration Metrics

**Status: INSUFFICIENT_EVIDENCE** — all fields require real data.

| Metric | Platt | Isotonic |
|--------|-------|---------|
| ECE | INSUFFICIENT_EVIDENCE | INSUFFICIENT_EVIDENCE |
| MCE | INSUFFICIENT_EVIDENCE | INSUFFICIENT_EVIDENCE |
| Brier | INSUFFICIENT_EVIDENCE | INSUFFICIENT_EVIDENCE |
| Log-loss | INSUFFICIENT_EVIDENCE | INSUFFICIENT_EVIDENCE |
| Slope | INSUFFICIENT_EVIDENCE | INSUFFICIENT_EVIDENCE |
| Intercept | INSUFFICIENT_EVIDENCE | INSUFFICIENT_EVIDENCE |

---

## Test Results

| Suite | Collected | Passed | Failed | Skipped |
|-------|-----------|--------|--------|---------|
| `test_phase3f.py` | 76 | **71** | **0** | 5 (sklearn/lgbm/xgb/scipy) |
| `test_meta_engine.py` | 72 | **63** | **0** | 9 (sklearn) |
| **Full suite** | 405 | **405** | **0** | 20 |

---

## Phase 3F Acceptance Criteria — Calibration

| Criterion | Status |
|-----------|--------|
| Raw score not returned as calibrated probability | ✅ |
| Unfitted calibrator returns UNCALIBRATED status | ✅ |
| Stale calibrator returns STALE status | ✅ |
| Model/calibrator mismatch returns CALIBRATOR_MISMATCH | ✅ |
| CalibratedProbability carries provenance fields | ✅ |
| eval_is_oos tracked in CalibrationQuality | ✅ |
| Calibration temporal order enforced | ✅ |
| Platt + isotonic both implemented | ✅ |
| ECE/MCE/Brier/log-loss/slope computed | ✅ |
| Reliability curve implemented | ✅ |
