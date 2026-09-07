# Phase 3I — Current Stability Infrastructure Audit

**Date:** 2026-09-06  
**Branch:** `refactor/improve-ml-service`  
**Auditor:** Automated (pre-implementation audit)

---

## 1. Summary

`src/stability/` does **not exist**. The entire Phase 3I stability/decay analysis
package is greenfield. However, strong reusable building blocks exist across
`src/monitoring/`, `src/ranking/`, `src/meta/`, and `src/validation/`.

---

## 2. Existing Infrastructure — What Already Works

### 2.1 IC computation (`src/ranking/evaluation.py`) — VALID

| Function / Class | Description |
|-----------------|-------------|
| `compute_ic(scores, realized)` | Pearson IC per cross-section |
| `compute_rank_ic(scores, realized)` | Spearman Rank IC per cross-section |
| `compute_ic_series(panel_df, ...)` | Per-timestamp IC series as `pd.Series` |
| `ICSummary` | mean, median, std, ICIR, positive_pct, p5–p95, n_timestamps |
| `summarise_ic_series(ic_series)` | Summary stats for an IC time series |
| `annualize_icir(icir, periods=252)` | ICIR × √252 |
| `compute_decile_report(...)` | Full decile analysis, monotonicity score, top-bottom spread |
| `DecileStats`, `DecileReport` | Per-decile return stats |
| `compute_rank_stability(...)` | Mean Spearman correlation between adjacent timestamps |
| `compute_turnover_proxy(...)` | Top-K turnover proxy |

**Missing from this module:** IC decay over time, rolling ICIR window, IC autocorrelation, regime-conditional IC, change-point detection, half-life estimation.

### 2.2 Drift detection (`src/monitoring/drift_detector.py`) — VALID

| Function / Class | Description |
|-----------------|-------------|
| `_compute_psi(reference, current, n_bins)` | Population Stability Index |
| `_compute_js_divergence(reference, current)` | Jensen-Shannon divergence |
| `detect_drift(feature_name, reference, current)` | PSI + KS + JS combined |
| `DriftResult` | psi, ks_statistic, ks_p_value, js_divergence, severity |
| `DriftSeverity` | NONE / MINOR / MAJOR with calibrated thresholds |
| `DriftDetector` | Stateful reference store, thread-safe |

`scipy.stats.ks_2samp()` is already used — no new scipy import needed.

**Missing:** Rolling PSI time-series (PSI over moving windows), IC-level drift detection.

### 2.3 Calibration (`src/meta/calibration_engine.py`) — VALID

| Function / Class | Description |
|-----------------|-------------|
| `compute_calibration_metrics(probs, labels)` | ECE, MCE, Brier, log-loss, slope, intercept |
| `reliability_curve(probs, labels, n_bins)` | Binned predicted vs observed frequencies |
| `walk_forward_calibrate(...)` | Per-fold CalibrationFoldResult with Brier/ECE per fold |
| `CalibrationFoldResult` | platt_metrics, isotonic_metrics, reliability_bins per fold |

**Missing:** Rolling Brier indexed by date (existing monitoring uses a trade deque, not date-indexed), fold-by-fold Brier trend, calibration slope drift through time.

### 2.4 Regime classification (`src/models/market_regime.py`) — VALID

6 regime labels: `STRONG_BULL / BULL / SIDEWAYS / VOLATILE / BEAR / CRASH`  
`MarketRegimeClassifier.predict()` — XGBoost + heuristic fallback

**Missing:** Regime-conditional IC/Brier breakdown (IC given regime = BULL vs IC given regime = BEAR).

### 2.5 Performance monitoring (`src/monitoring/performance_monitor.py`) — VALID

Rolling Brier, rolling ECE, rolling Sharpe, rolling win-rate, `StrategyDecayMetrics`.  
**Note:** These operate over a rolling deque of `TradeOutcome` objects, not over date-indexed cross-sectional predictions. Not directly usable for IC decay analysis.

### 2.6 Validation (`src/validation/metrics.py`) — VALID

`StabilityAnalysis.sharpe_decay` = (first-half − second-half Sharpe) / |first-half Sharpe|.  
This is the only existing decay measure — it operates on trading Sharpe, not alpha IC.

### 2.7 PIT enforcement (`src/data/point_in_time.py`) — VALID

`PointInTimeValidator`, `DataAvailabilityStatus`, NSE-specific delay constants.  
All timestamps UTC-aware; strict availability_time ≤ prediction_time enforcement.

### 2.8 Feature leakage (`src/features/leakage_validator.py`) — VALID

Static AST scan for `shift(-N)`, `center=True`, `fillna(0)`. PIT mutation tests.  
**Missing:** Feature-level temporal stability, importance drift over time.

---

## 3. What Does NOT Exist — Gap Register

| Required Component | Status | Notes |
|--------------------|--------|-------|
| `src/stability/` package | MISSING | Entire package |
| IC decay curve (time trend, mean-shift) | MISSING | `compute_ic_series()` exists but no decay analysis |
| Rolling ICIR over moving window | MISSING | Only total-period ICIR in `ICSummary` |
| IC autocorrelation (lag-1, lag-N) | MISSING | `statsmodels.tsa.stattools.acf` in venv but undeclared |
| IC half-life estimation | MISSING | No exponential fit or autocorrelation decay |
| Regime-conditional IC/ICIR/EV/Brier | MISSING | MarketRegimeClassifier + compute_ic_series exist separately |
| Forward-horizon decay (1D/3D/5D/10D/20D) | MISSING | |
| Change-point detection on IC stream | MISSING | CUSUM via numpy/scipy |
| Rolling PSI time-series (weekly/monthly) | MISSING | Only per-snapshot PSI |
| Rolling Brier by date (not trade deque) | MISSING | |
| Brier decay curve (fold-by-fold trend) | MISSING | `CalibrationFoldResult` has per-fold data |
| Calibration slope drift through time | MISSING | |
| Feature importance stability across folds | MISSING | |
| EV drift analysis (realized vs predicted) | MISSING | |
| Label distribution drift (success rate) | MISSING | |
| Concept drift framework (data/feature/prediction/calibration) | MISSING | |
| `AlphaDecayObservation` schema | MISSING | |
| `SignalHealthRecord` schema | MISSING | |
| `DecayStatus`, `SignalHealth` enums | MISSING | |
| Signal survival analysis | MISSING | |
| Stability matrix (temporal × metric) | MISSING | |
| Portfolio decay (rolling Sharpe/CVaR through time) | MISSING | Phase 3H has cross-sectional stability, not time-series |
| Crowding proxy (top-N correlation over time) | MISSING | |
| Liquidity decay by ADV bucket | MISSING | |
| Capacity decay analysis | MISSING | |
| Cost/edge decay (gross vs net alpha) | MISSING | |

---

## 4. Reusable Building Blocks for `src/stability/`

| Phase 3I Module | Reuse from |
|----------------|-----------|
| `ic_decay.py` | `ranking.evaluation.compute_ic_series()` (input), `scipy.stats.linregress` (trend), `scipy.stats.pearsonr` (autocorrelation) |
| `quantile_analysis.py` | `ranking.evaluation.compute_decile_report()` (already does full decile) — extend with temporal window support |
| `feature_stability.py` | `monitoring.drift_detector._compute_psi()`, `detect_drift()` |
| `prediction_drift.py` | `monitoring.drift_detector.detect_drift()`, `monitoring.drift_detector.DriftDetector` |
| `calibration_drift.py` | `meta.calibration_engine.compute_calibration_metrics()`, `walk_forward_calibrate()` output |
| `regime_decay.py` | `models.market_regime.REGIME_CLASSES`, `ranking.evaluation.compute_ic()` |
| `portfolio_decay.py` | `portfolio.analytics.PortfolioAnalytics.performance_metrics()`, rolling HHI from `portfolio.analytics` |
| `signal_health.py` | All of the above |

---

## 5. Dependency Notes

- `scipy` (1.14.1) — declared; KS, linregress, pearsonr all available
- `numpy` — declared; CUSUM implementation via pure numpy
- `pandas` — declared; rolling windows, groupby
- `statsmodels` — in `.venv` (0.14.6) but **NOT declared in pyproject.toml**; use `scipy.stats` instead
- `ruptures` (PELT/BOCPD) — NOT installed; use CUSUM via numpy
- No new dependencies required for Phase 3I

---

## 6. Phase 3I Build Plan

Build 9 modules in `src/stability/`:

```
src/stability/
├── __init__.py
├── schemas.py           — AlphaDecayObservation, SignalHealthRecord, DecayStatus, etc.
├── ic_decay.py          — IC decay, rolling ICIR, half-life, autocorrelation, forward-horizon
├── quantile_analysis.py — Quantile/decile temporal stability, monotonicity decay, top-bottom spread
├── feature_stability.py — PSI time-series, KS drift, missingness drift, feature family stability
├── prediction_drift.py  — Alpha score/probability/EV distribution drift, change-point (CUSUM)
├── calibration_drift.py — Brier/ECE/slope drift over folds and time
├── regime_decay.py      — Regime-conditional IC/EV/return; transition analysis; sector stability
├── portfolio_decay.py   — Rolling portfolio metrics, concentration decay, turnover/capacity decay
└── signal_health.py     — SignalHealth classification, stability matrix, concept-drift, alerts
```
