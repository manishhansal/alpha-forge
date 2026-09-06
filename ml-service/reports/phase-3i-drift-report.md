# Phase 3I — Concept Drift Report

**Generated:** 2026-09-06  
**Branch:** `refactor/improve-ml-service`  
**OOS evidence:** INSUFFICIENT_EVIDENCE

---

## 1. Scope

Documents the concept-drift framework in `src/stability/signal_health.py` and
`src/stability/prediction_drift.py`. Distinguishes the different types of drift
rather than collapsing them into one score (spec §37).

---

## 2. Drift Types (kept separate)

| Drift Type | Source module | What it measures |
|-----------|--------------|-----------------|
| `DATA_DRIFT` | feature_stability | Raw input distribution shift |
| `FEATURE_DRIFT` | feature_stability | Engineered feature distribution shift |
| `PREDICTION_DRIFT` | prediction_drift | Alpha score / probability / EV distribution shift |
| `CALIBRATION_DRIFT` | calibration_drift | Brier / ECE / slope degradation |
| `LABEL_DRIFT` | schemas (framework) | Target success-rate / return distribution shift |
| `PERFORMANCE_DRIFT` | ic_decay | IC / Rank IC deterioration |

Each is recorded as a separate `ConceptDriftRecord` with its own severity,
metric value, threshold, and evidence level.

---

## 3. Drift Severity (spec §48)

| Severity | Basis |
|----------|-------|
| NONE | below all thresholds |
| LOW | marginal |
| MODERATE | PSI > 0.10 or KS p < 0.05 |
| HIGH | PSI > 0.20 or KS p < 0.01 |
| CRITICAL | PSI > 0.40 or KS p < 0.001 |

Thresholds are configurable via `StabilityAlertConfig` — none are hidden
arbitrary constants in logic.

---

## 4. Model vs Market Drift (spec §39)

The framework separates:
- **Model degradation** — IC ↓ with feature distribution unchanged
- **Market/target change** — IC ↓ with feature distribution shifted OR label
  distribution shifted

By reporting FEATURE_DRIFT, LABEL_DRIFT, and PERFORMANCE_DRIFT separately, the
report enables distinguishing "the model broke" from "the market changed".

---

## 5. Change-Point Detection

CUSUM (deterministic, numpy-only) detects level shifts in:
- IC series (via `ic_decay.cusum_changepoint`)
- Prediction distributions (via `prediction_drift`)

PELT/BOCPD (the `ruptures` library) is not installed; CUSUM is the documented
deterministic first method (spec §36).

---

## 6. Multiple Testing (spec §43)

The framework generates many diagnostics. Findings are classified as
exploratory vs confirmatory. Where hypothesis testing is used (linregress
p-values on IC trend), the p-values are reported but NOT treated as confirmatory
alpha without multiple-testing control. A Benjamini-Hochberg FDR helper is
recommended before treating any single significant p-value as genuine.

---

## 7. Framework Verification (Synthetic Data)

| Scenario | Expected | Result |
|----------|----------|--------|
| Prediction distribution shift | PREDICTION_DRIFT, HIGH/CRITICAL | PASS |
| Decaying IC | PERFORMANCE_DRIFT record | PASS |
| Feature shift | FEATURE_DRIFT record | PASS |
| Calibration degradation | CALIBRATION_DRIFT record | PASS |
| CUSUM deterministic | same input → same output | PASS |

---

## 8. OOS Evidence

**INSUFFICIENT_EVIDENCE** — no real dataset loaded. Concept-drift detection
requires production feature, prediction, calibration, and label panels across
time.

---

## 9. Limitations

- Change-point uses CUSUM only (no PELT/BOCPD dependency).
- LABEL_DRIFT is architecturally supported (schema present) but requires a real
  label distribution series to compute.
- Multiple-testing FDR control is documented as a recommendation, not yet an
  enforced gate.
