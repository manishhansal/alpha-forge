# AlphaForge ML Service — Monitoring Audit

**Audit Date:** 2026-09-06  
**Scope:** `monitoring/` — all 6 files

---

## 1. Monitoring Stack Overview

| Component | File | Purpose | Quality |
|---|---|---|---|
| DriftDetector | `drift_detector.py` | Statistical distribution shift (PSI + KS + JS) | ✅ Production-grade |
| FeatureMonitor | `feature_monitor.py` | Per-feature drift tracking | ✅ (signatures only) |
| ModelRegistry | `model_registry.py` | Model health state machine + provenance | ✅ Production-grade |
| PerformanceMonitor | `performance_monitor.py` | Rolling Sharpe / Brier / win rate | ✅ (signatures only) |
| AlertSystem | `alerts.py` | Alert emission (INFO/WARNING/CRITICAL/DISABLED) | ✅ (signatures only) |
| MonitoringRouter | `router.py` | FastAPI routes for monitoring dashboard | ✅ (signatures only) |

The monitoring stack is one of the strongest parts of the codebase. The design reflects genuine understanding of production ML operations.

---

## 2. DriftDetector

### 2.1 Statistics Used

| Statistic | Threshold NONE | Threshold MINOR | Threshold MAJOR |
|---|---|---|---|
| PSI | < 0.10 | 0.10–0.20 | > 0.20 |
| KS p-value | > 0.05 | 0.01–0.05 | < 0.01 |
| Jensen-Shannon | < 0.10 | 0.10–0.25 | > 0.25 |

**Assessment:** The three-statistic combination is appropriate:
- **PSI** (industry standard, credit risk origin) captures overall distributional shift
- **KS** provides a formal statistical test with p-values
- **JS divergence** is bounded [0,1] and symmetric — useful for categorical or mixed distributions

The combination reduces false positives: all three must be elevated to trigger MAJOR.

### 2.2 PSI Implementation

```python
def _compute_psi(reference, current, n_bins=10, eps=1e-8):
    percentiles = np.linspace(0, 100, n_bins + 1)
    bin_edges = np.percentile(reference, percentiles)  # reference-defined bins
    bin_edges = np.unique(bin_edges)
    ...
    psi = np.sum((cur_pct - ref_pct) * np.log(cur_pct / ref_pct))
```

**Correct:** Uses reference distribution to define bin edges — this is the standard approach that ensures well-populated reference bins. Handles duplicate edges with `np.unique()`.

**One potential issue:** If the reference distribution is highly concentrated (e.g., a binary feature), `np.unique(bin_edges)` may reduce to very few bins, making PSI unreliable. This should be guarded.

### 2.3 Thread Safety

DriftDetector uses `threading.Lock()` on reference updates and detections:
```python
with self._lock:
    self._refs[feature_name] = _ReferenceStore(data=arr, n_bins=n_bins)
```

**Assessment:** Correct. FastAPI handles concurrent requests, so thread-safe reference management is essential.

### 2.4 Prediction Distribution Summary

`prediction_distribution_summary()` computes:
- Action counts and ratios (BUY/SELL/WAIT/NO_TRADE)
- Confidence percentiles (P10, P50, P90)
- Buy/Sell ratio

Useful for detecting distribution shift in model outputs (e.g., a regime change causing a spike in NO_TRADE signals).

**Assessment: KEEP — production-grade.**

---

## 3. ModelRegistry

### 3.1 State Machine

```
HEALTHY → WARNING → DEGRADED → DISABLED
    ↑_____________________________|
         recover() (manual only)
```

Transitions:
- `set_warning()` → HEALTHY→WARNING; after N consecutive warnings → DEGRADED
- `set_degraded()` → direct DEGRADED regardless of current state
- `set_disabled()` → DISABLED (most severe; weight = 0)
- `recover()` → back to HEALTHY (requires explicit human action)

**Assessment:** The state machine is sound. The `warn_after_n=3` default (3 consecutive warnings before DEGRADED) prevents flapping. Manual recovery requirement for DISABLED is the right safety gate.

### 3.2 Weight Multipliers

| State | Weight Multiplier |
|---|---|
| HEALTHY | 1.00 |
| WARNING | 0.75 |
| DEGRADED | 0.30 |
| DISABLED | 0.00 |

These multipliers are used by the monitoring layer to inform the ensemble. **Gap:** There is no code path that automatically reads registry weights into `EnsembleWeighter` at inference time. The registry provides `get_weight()` and `get_all_weights()`, but the MetaDecisionEngine creates its `EnsembleWeighter` from `CalibrationStore.all_quality_scores()` only, not from registry weights.

This means a model in DEGRADED state (weight multiplier 0.30) is not automatically down-weighted in the ensemble — the registry state and the ensemble weights are disconnected.

### 3.3 Retraining Recommendations

When a model enters DEGRADED or DISABLED state, a `RetrainingRecommendation` is automatically created. This never triggers automatic retraining — it creates a human-reviewable record. This is the correct conservative approach for a financial system.

### 3.4 Persistence

Registry state is saved to a JSON file on every state change (`_maybe_persist()`). JSON uses `asdict()` for serialization with enum reconstruction on load. This is correct and restart-safe.

### 3.5 Thread Safety

Per-model locks (`self._locks[name]`) plus a global lock (`self._global_lock`) for registry-level operations. Two-level locking prevents deadlock while ensuring model-level operations don't block global reads.

**Assessment: PRODUCTION_READY — the ModelRegistry is well-designed.**

### 3.6 Provenance Gap

`build_default_registry()` populates `dataset_version="ds-baseline-v1"` and `feature_version="feat-v1"` as hardcoded strings. After each training run, the registry should be updated with the actual `DATASET_VERSION` and `FEATURE_VERSION` from `data_pipeline.py`. This version chain is broken.

---

## 4. PerformanceMonitor

### 4.1 Metrics

From the module docstring:
- **Brier score** — mean squared error on calibrated probabilities
- **Calibration ECE** — expected calibration error on live outcomes
- **Accuracy** — fraction of correct directional predictions
- **Log-loss** — cross-entropy on predicted probabilities
- **Trading expectancy** — E[P&L per trade]
- **Rolling Sharpe** — annualised Sharpe over a rolling window
- **Rolling win rate** — fraction of profitable trades
- **Rolling drawdown** — maximum drawdown in rolling window

**Assessment:** The dual-metric approach (model quality + trading performance) is correct. A model can have good Brier score but poor trading performance if its well-calibrated predictions are concentrated in the noise region.

### 4.2 TradeOutcome

`TradeOutcome` is the atomic data unit with predicted probability, actual outcome, and P&L. This is the correct abstraction — it links model output to trading result.

**Gap:** For `TradeOutcome` to be collected, there must be a feedback loop: the live system must record which trades were entered based on ML signals, then update outcomes when those trades close. This feedback mechanism is not visible in the codebase. Without it, `PerformanceMonitor` has no data to process.

---

## 5. Alert System

### 5.1 Alert Categories and Severities

From signatures:
- `AlertCategory`: MODEL_STATE, DRIFT, PERFORMANCE, DATA_QUALITY, SYSTEM
- `AlertSeverity`: INFO, WARNING, CRITICAL, DISABLED

### 5.2 Alert Emission

Alerts are emitted by:
- `ModelRegistry._emit_alert()` on every state transition
- `DriftDetector.detect()` when drift is detected

**Gap:** No evidence of alert delivery to an external notification system (email, Slack, PagerDuty). The `AlertSystem._emit()` method presumably stores alerts in memory or logs them. For production, alerts must be delivered to operators.

---

## 6. Monitoring ↔ Training Lifecycle Gap

The monitoring stack is designed for production operations:
1. DriftDetector detects feature/prediction drift
2. ModelRegistry escalates model state
3. PerformanceMonitor detects performance degradation
4. RetrainingRecommendation is created

But there is no automated path from "recommendation created" to "retraining triggered" to "new model validated" to "registry updated". Each step requires manual operator action.

This is **correct for a financial system** — automatic retraining without human review is dangerous. However, the manual steps are not documented, and the interfaces for "operator reviews recommendation" and "operator deploys new model" are not specified.

---

## 7. Assessment

| Component | Status | Notes |
|---|---|---|
| DriftDetector | PRODUCTION_READY | PSI + KS + JS combination; thread-safe |
| ModelRegistry | PRODUCTION_READY | State machine; persistence; retraining recommendations |
| PerformanceMonitor | KEEP | Correct metrics; no feedback loop data yet |
| AlertSystem | KEEP | Delivery mechanism not visible |
| Registry ↔ Ensemble | ❌ Gap | Registry weights not read by EnsembleWeighter |
| Provenance chain | ❌ Gap | Dataset/feature version not auto-injected at training |

---

## 8. Recommendations

| Priority | Action |
|---|---|
| 🔴 HIGH | Connect ModelRegistry weights to EnsembleWeighter at inference time — DEGRADED models must actually be down-weighted |
| 🔴 HIGH | Implement trade outcome feedback loop so PerformanceMonitor has data to process |
| 🟡 MEDIUM | Auto-inject `DATASET_VERSION` and `FEATURE_VERSION` into ModelRecord at training time |
| 🟡 MEDIUM | Add external alert delivery (webhook / email) to AlertSystem |
| 🟡 MEDIUM | Document the manual operator workflow: drift detected → review → retrain → validate → deploy |
| 🟢 LOW | Add guard in `_compute_psi()` for low-cardinality features (< 3 unique bins) |
| 🟢 LOW | Add Slack / PagerDuty webhook integration for CRITICAL alerts |
