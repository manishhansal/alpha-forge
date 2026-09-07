# Phase 3I — Feature Stability Report

**Generated:** 2026-09-06  
**Branch:** `refactor/improve-ml-service`  
**OOS evidence:** INSUFFICIENT_EVIDENCE

---

## 1. Scope

Documents the feature stability analysis in `src/stability/feature_stability.py`.
Tracks whether production feature distributions drift through time.

---

## 2. Drift Statistics

| Statistic | Method | Applies to |
|-----------|--------|-----------|
| PSI (Population Stability Index) | reference percentile bins | Continuous features |
| KS statistic + p-value | `scipy.stats.ks_2samp` | Continuous distributions |
| Wasserstein distance (EMD) | 1-D sorted interpolation | Continuous distributions |
| Missingness drift | comparison − reference missingness % | All features |

The report states which metric applies to which feature type. PSI is not
applied blindly — degenerate distributions (constant series) return PSI = 0.

---

## 3. Severity Classification

| Severity | Condition |
|----------|-----------|
| NONE | PSI ≤ 0.10 AND KS p ≥ 0.05 |
| MODERATE | PSI > 0.10, OR KS p < 0.05, OR missingness drift > 10% |
| HIGH | PSI > 0.20, OR KS p < 0.01 |
| CRITICAL | PSI > 0.40 |

Thresholds match the existing `monitoring.drift_detector` conventions for
consistency across the service.

---

## 4. Reference / Comparison Windows

- Reference = earliest 30% of the feature series (configurable)
- Comparison = remaining 70%
- PIT: the reference window uses only early values — no future data enters
  the reference distribution.

---

## 5. Feature Family Support

Features can be grouped by `FeatureFamily` (18 families: momentum, trend,
mean_reversion, volatility, volume_liquidity, market_structure, cross_sectional,
breadth, sector, derivatives, options_iv, expiry_contract, market_regime,
intermarket, microstructure, risk_tail, time_of_day, overnight_gap). Family-level
stability aggregation detects whether an entire alpha family is decaying vs a
single-feature failure.

---

## 6. Framework Verification (Synthetic Data)

| Scenario | Expected | Result |
|----------|----------|--------|
| Distribution shift (mean 0 → 3) | HIGH/CRITICAL, PSI > 0.2 | PASS |
| Stationary large sample | NONE/LOW/MODERATE | PASS |
| 50% missingness in late period | missingness_drift > 0.1 | PASS |
| KS statistic computed | 0 ≤ KS ≤ 1 | PASS |
| Wasserstein computed | > 0 for shifted | PASS |
| 3-observation feature | INSUFFICIENT_EVIDENCE | PASS |

---

## 7. OOS Evidence

**INSUFFICIENT_EVIDENCE** — no real feature panel loaded. Production feature
drift requires a real feature store with time-indexed feature values.

---

## 8. Limitations

- Reference/comparison split is a single cut (30/70). Rolling multi-window PSI
  time-series is a future enhancement.
- Feature importance stability (permutation importance drift across folds)
  requires trained model artifacts and is not computed here.
