# Concept Drift Methodology

**Document type:** ML Research — Methodology  
**Phase:** 3I  
**Last updated:** 2026-09-06  
**Scope:** Concept-drift detection and classification for AlphaForge

---

## 1. Overview

Concept drift is the change in the statistical relationship between features and
the target over time. AlphaForge distinguishes six drift types rather than
collapsing them into one score, so that "the model broke" can be told apart from
"the market changed".

---

## 2. Drift Types (spec §37)

| Drift Type | Definition | Detected by |
|-----------|-----------|-------------|
| `DATA_DRIFT` | Raw input data distribution shifted | feature_stability (raw inputs) |
| `FEATURE_DRIFT` | Engineered feature distribution shifted | feature_stability (PSI/KS/Wasserstein) |
| `PREDICTION_DRIFT` | Model output distribution shifted | prediction_drift (alpha/prob/EV) |
| `CALIBRATION_DRIFT` | Predicted probability no longer matches realized frequency | calibration_drift (Brier/ECE/slope) |
| `LABEL_DRIFT` | Target distribution shifted (success rate, return dist) | label distribution comparison |
| `PERFORMANCE_DRIFT` | IC / Rank IC deteriorated | ic_decay (trend slope, temporal split) |

Each is recorded as a separate `ConceptDriftRecord` with severity, metric value,
threshold, and evidence level.

---

## 3. Drift Detection Statistics

### 3.1 PSI (Population Stability Index)

```
PSI = Σ (cur% − ref%) × ln(cur% / ref%)
```

Reference percentile bins prevent empty reference buckets. Thresholds:
< 0.10 stable, 0.10–0.20 minor, > 0.20 major (matches
`monitoring.drift_detector`).

### 3.2 Kolmogorov-Smirnov

`scipy.stats.ks_2samp` compares two empirical CDFs. p < 0.05 → warning,
p < 0.01 → high.

### 3.3 Wasserstein distance

1-D Earth Mover's Distance via sorted-array interpolation. Reported alongside
PSI for continuous features.

### 3.4 Jensen-Shannon divergence

Symmetric, bounded [0,1] measure used for prediction distribution comparison.

---

## 4. Change-Point Detection (spec §36)

CUSUM is the documented first method (deterministic, numpy-only):

```
CUSUM[t] = Σ (x[i] − mean(x))  for i ≤ t
change_point = argmax |CUSUM|  when range(CUSUM) > sensitivity × std
```

A simple deterministic method is preferred over adding a complex dependency
(`ruptures` / PELT / BOCPD) purely for sophistication.

---

## 5. Model vs Market Drift Separation (spec §39)

The framework attempts to distinguish:

| Observation | Interpretation |
|------------|----------------|
| IC ↓, feature dist unchanged, label dist unchanged | Model degradation |
| IC ↓, feature dist shifted | Input regime change (DATA/FEATURE drift) |
| IC ↓, label dist shifted | Target regime change (LABEL drift) |

By reporting FEATURE_DRIFT, LABEL_DRIFT, and PERFORMANCE_DRIFT separately, the
analyst can attribute the deterioration to its true cause. This is critical:
if gross alpha (IC) is stable but net performance falls, the cause is
execution/cost decay, not model decay (spec §56).

---

## 6. Drift Severity (spec §48)

| Severity | Basis |
|----------|-------|
| NONE | below all thresholds |
| LOW | marginal shift |
| MODERATE | PSI > 0.10 or KS p < 0.05 |
| HIGH | PSI > 0.20 or KS p < 0.01 |
| CRITICAL | PSI > 0.40 or KS p < 0.001 |

All thresholds are configurable via `StabilityAlertConfig`. No arbitrary
thresholds are hidden in code.

---

## 7. Signal Health Classification (spec §65)

`SignalHealth` decomposes into six independently-classified dimensions:

```
PREDICTIVE_STATUS   ← ic_decay
CALIBRATION_STATUS  ← calibration_drift
FEATURE_STATUS      ← feature_stability
REGIME_STATUS       ← regime_decay
EXECUTION_STATUS    ← portfolio_decay
CAPACITY_STATUS     ← portfolio_decay
OVERALL_STATUS      ← worst-case aggregation
```

Each dimension carries its own evidence string. This is NOT a black-box score.

Statuses: STABLE / WEAKENING / DECAYING / FAILED / DRIFTED / INSUFFICIENT_EVIDENCE.

---

## 8. Monitoring Contract (spec §49)

`SignalHealthRecord` is the machine-readable output for one signal at one
timestamp: ic, rank_ic, icir, ev, feature_drift, prediction_drift,
calibration_drift, label_drift, performance_drift, regime, liquidity_bucket,
status, evidence_level.

---

## 9. Alert Conditions (spec §51)

Research alerts are evidence-based, not triggered by a single negative daily
metric. An alert fires when a trend (not a point) crosses a configured threshold:
IC trend slope below `ic_deterioration_threshold`, Brier trend slope above
`brier_deterioration_slope`, feature PSI above `feature_drift_psi_warn`, etc.

---

## 10. Production Readiness (spec §50)

Phase 3I produces a readiness-oriented view (alpha/calibration/data/drift/
execution/capacity status) but does NOT implement Champion/Challenger promotion.
That is deferred to Phase 3J.

---

## 11. Limitations

- LABEL_DRIFT is architecturally supported but requires a real label
  distribution series.
- Change-point uses CUSUM only.
- Multiple-testing FDR control is a documented recommendation, not an enforced
  gate.
- No real dataset loaded — all drift results are INSUFFICIENT_EVIDENCE.

---

## 12. References

- Gama, J. et al. (2014). "A Survey on Concept Drift Adaptation." *ACM CSUR*.
- Page, E.S. (1954). "Continuous Inspection Schemes." *Biometrika* — CUSUM.
- Lin, J. (1991). "Divergence Measures Based on the Shannon Entropy." *IEEE IT*
  — Jensen-Shannon divergence.
