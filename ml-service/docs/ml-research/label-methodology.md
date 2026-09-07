# Label Methodology — AlphaForge ML Service (lv2)

**Version:** lv2
**Last updated:** 2026-09-06
**Scope:** Indian equity and F&O daily bars (NSE/BSE)

This document describes the economic reasoning, mathematical definitions, and implementation decisions behind every label type in the `labels/` package. It is the design-level companion to `docs/ml-audit/phase-3c-label-v2.md` (which covers correctness and testing) and `reports/phase-3c-label-integrity.md` (which covers integrity and evidence status).

---

## 1. Why Event-Based Labels

### 1.1 The problem with fixed-horizon returns

A 5-day forward return `r_{t+5} / r_t - 1` is easy to compute but misrepresents how traders actually operate. A trader who enters at `t` and is stopped out at `t+1` does not hold until `t+5`. Using the 5-day return as the label trains the model on a P&L that is physically impossible.

Additionally:
- Two 5-day windows starting at `t` and `t+1` share 4 bars. Treating them as independent samples inflates effective sample size and corrupts cross-validation.
- Labels computed at `t+5` are only available at `t+5`, not at `t`. Using them during training without proper PIT treatment creates look-ahead bias.

### 1.2 The event-based solution

Event-based labels attach three fields to each observation:
- `event_start_time` — when the trade is entered (= observation time)
- `event_end_time` — when the label outcome is known (first barrier touch or time limit)
- `label_available_time` — earliest time a trainer may use this label (= `event_end_time`)

This enables:
1. **Correct P&L**: gross return is computed up to the actual exit, not a fixed horizon.
2. **Correct cross-validation**: PurgedKFold uses `event_end_time` per observation to purge training samples whose label windows overlap the test period.
3. **Honest unavailability**: tail events where `t + horizon >= n` are `DATA_INSUFFICIENT`, not `TIME_LIMIT`. They are excluded from supervised training.

---

## 2. Triple-Barrier Method

### 2.1 Definition

Three barriers bound each event window:

```
Upper barrier (TP):   entry × (1 + σ × pt_mult)   — for LONG
Lower barrier (SL):   entry × (1 - σ × sl_mult)   — for LONG
Vertical barrier:     entry bar + horizon_bars
```

where `σ` is the trailing ATR expressed as a fraction of close price.

For SHORT positions the barriers are mirrored:
```
TP:  entry × (1 - σ × pt_mult)   — price fell enough to profit
SL:  entry × (1 + σ × sl_mult)   — price rose enough to stop out
```

### 2.2 First-touch semantics

The implementation scans forward bar-by-bar from `i+1` to `i+horizon`. The scan stops at the FIRST bar where any barrier is touched. This is explicit sequential ordering, not `.any()` over the full window.

**Why this matters:** a `.any()` scan would return `True` for both TP and SL if both were hit at some point in the window, with no information about which came first. The sequential scan ensures the outcome is the one the trader actually experienced.

### 2.3 Intrabar ambiguity

Single-period OHLC data cannot tell us whether the high or the low occurred first within a bar. When a bar's high touches TP *and* its low touches SL, we have intrabar ambiguity.

Two policies are supported:

| Policy | Outcome | When to use |
|--------|---------|-------------|
| `CONSERVATIVE_SL` (default) | `STOP_LOSS` | Conservative (worst-case) training. The model learns to avoid trades that might stop out. |
| `DATA_AMBIGUOUS` | `INTRABAR_AMBIGUOUS` | Strict exclusion — these events are not used for training. Appropriate if training set is large enough to tolerate exclusion. |

The ambiguity is always recorded in `intrabar_ambiguous=True` regardless of policy. This allows post-hoc analysis.

**Why `CONSERVATIVE_SL` as default:** For Indian equity daily data, intrabar ambiguity is rare (< 2% expected). Discarding these events (`DATA_AMBIGUOUS`) would reduce the already-limited event set on thin-traded names. Conservative labelling is preferable to shrinking the training set.

### 2.4 Incomplete horizons

If the dataset ends before `i + horizon`, the event has no observable outcome. This is not a `TIME_LIMIT` event — the time barrier was not reached, the data simply ended.

These events are tagged `is_incomplete=True`, `first_touch=DATA_INSUFFICIENT`. They are excluded from:
- Supervised training
- Label distribution statistics
- Meta-label computation

They are retained in the event list for provenance and for live inference (incomplete events at the live frontier become complete as new bars arrive).

### 2.5 Volatility-based barrier sizing

Barriers are sized as multiples of the trailing ATR (Average True Range), expressed as a fraction of close price:

```
σ = ATR_absolute / close_price
upper_pct = pt_multiplier × σ × 100
lower_pct = sl_multiplier × σ × 100
```

ATR is computed from a trailing window `[i - vol_window, i]` — strictly past bars only, no forward look. The `min_volatility` floor prevents degenerate barriers on very low-volatility instruments.

**Default parameters (`LabelConfig.default_daily()`):**
- `horizon_bars = 20` (one trading month)
- `pt_multiplier = 1.5`
- `sl_multiplier = 1.0` (asymmetric: tighter SL than TP — reflects asymmetric risk appetite)
- `volatility_window = 20`
- `min_volatility = 0.005` (0.5% floor)

### 2.6 Config hashing

Every `LabelConfig` carries a deterministic 16-character hex hash of its parameters. This hash is written to `DatasetSnapshot.label_config_hash` and to every `TripleBarrierLabel` event. It allows exact reproduction of any historical label set.

---

## 3. Fixed-Horizon Labels

Fixed-horizon labels are retained alongside triple-barrier labels for:
- Ranking models that require a continuous return signal (not a discrete TP/SL)
- Benchmarking against lv1

Three variants are provided:

| Variant | Formula | Use case |
|---------|---------|----------|
| Raw return | `close[t+h] / close[t] - 1` | Baseline ranking |
| Vol-adjusted | `raw_return / rolling_std(h)` | Cross-sectional ranking — normalises for volatility differences across stocks |
| Directional | `UP` if `raw_return > threshold` else `DOWN`/`FLAT` | Binary/ternary classifiers |

All fixed-horizon labels respect the same PIT rules as triple-barrier: `is_incomplete=True` at the tail, `label_available_time = event_end_time = t + h`.

---

## 4. Meta-Label

The meta-label is a second-layer binary label that asks: *given that a primary model predicts a LONG/SHORT signal, should we take or skip this trade?*

```
meta_label = 1  if  gross_return > outcome_threshold  (TAKE)
meta_label = 0  otherwise                             (SKIP)
```

**Design decisions:**
- **Side-separated**: meta-labels are computed separately for LONG and SHORT events. A LONG meta-model and a SHORT meta-model can have different acceptance thresholds.
- **Outcome threshold**: defaults to 0.0 (any positive gross return = TAKE). Can be set to the round-trip cost to filter cost-negative trades once cost data is available.
- **`DATA_INSUFFICIENT` excluded**: incomplete events have no observable outcome and are always excluded from meta-label computation.

**Purpose in the training pipeline**: the meta-model is trained on the same feature set as the primary model, but its label is the outcome of the primary prediction, not the raw price outcome. This filters out trades where the model is systematically wrong at certain market conditions.

---

## 5. Risk Outcomes (MFE / MAE)

Maximum Favorable Excursion (MFE) and Maximum Adverse Excursion (MAE) describe the best and worst intraday price levels reached during the event window.

### 5.1 Signed conventions

| Metric | LONG | SHORT | Sign |
|--------|------|-------|------|
| MFE | `max(high[t+1..t1] - entry) / entry` | `max(entry - low[t+1..t1]) / entry` | Always ≥ 0 |
| MAE | `min(low[t+1..t1] - entry) / entry` | `min(-(high[t+1..t1] - entry)) / entry` | Always ≤ 0 |

The signed convention makes MFE/MAE directly interpretable regardless of direction: MFE is how much you could have made, MAE is how much you were underwater.

### 5.2 Use in training

MFE and MAE are **outcome fields**, not features. They must never be used as model inputs. They are stored in `RiskOutcomeLabel` and in `DatasetSnapshot` for post-hoc analysis:
- MFE/MAE ratio characterises trade quality (high MFE, low |MAE| = good risk/reward)
- MAE distribution informs SL placement calibration
- MFE distribution informs TP placement calibration

---

## 6. Sample Weights and the PurgedKFold Contract

### 6.1 The overlap problem

When a model is trained on overlapping event windows, the IID assumption is violated. Two observations at `t` and `t+1` with horizon=20 share 19 of their 20 forward bars. Using them as independent training samples overstates effective sample size and causes the cross-validator to leak future information.

### 6.2 Average uniqueness

For each event from `t0` to `t1`, the average uniqueness is:

```
uniqueness_k = mean(1 / concurrency[t]) for t in [t0, t1)
```

where `concurrency[t]` is the number of events active simultaneously at bar `t`.

- Non-overlapping events: `uniqueness = 1.0`
- Heavily overlapping events (e.g. hourly bars with 1-day horizon): `uniqueness ≈ 1/24`

`sample_weight = average_uniqueness` is passed to `model.fit(..., sample_weight=weights)` to down-weight overlapping observations.

### 6.3 The t1 series

`build_t1_from_events(events, index)` returns a `pd.Series` indexed by observation time, with values = `event_end_time`. This is the event-aware replacement for the fixed-horizon `t1 = index + horizon_bars`.

The `t1` series is consumed by `PurgedKFold`:
- For each test fold spanning `[t_test_start, t_test_end]`, any training observation where `t1[train_obs] >= t_test_start - embargo` is purged from training.
- This prevents the training label window from overlapping the test period.

---

## 7. Relative Labels

### 7.1 Excess return vs benchmark

```
excess_return = stock_return(t, t+h) - benchmark_return(t, t+h)
```

Default benchmark: `NIFTY 50` close series. An excess return > 0 means the stock outperformed the market over the horizon.

Optionally vol-normalised:
```
vol_adj_excess = excess_return / rolling_vol(h)
```

This is the basis for the cross-sectional ranking label used in `generate_ranking_labels_v2()`.

### 7.2 Sector-relative labels

```
sector_relative = stock_return(t, t+h) - mean(peer_return(t, t+h))
```

where peers are the sector index constituents. This measures stock-specific alpha net of sector rotation.

**`DATA_UNAVAILABLE` policy**: when sector peer data is absent (as in the offline test environment), sector-relative labels return `gross_return = None` rather than fabricating a value or falling back to a single-stock benchmark. Absent data must be explicitly represented, not silently replaced.

---

## 8. Leakage Prevention

### 8.1 What constitutes leakage in labels

Label leakage occurs when:
1. An outcome column (e.g. `stop_hit`, `target_hit`) is included in the feature matrix.
2. A label is computed using data available only after `label_available_time` but used as if it were available at `event_start_time`.
3. An incomplete event is mislabelled as `TIME_LIMIT` and included in training — it appears to be a complete observation but uses a truncated forward window.

### 8.2 `LabelLeakageValidator`

Seven rules are enforced. The two most important:

**Rule 1 — Outcome in features (CRITICAL):** If any of `{stop_hit, target_hit, y_stop, y_target, fwd_return, future_price, barrier_hit}` appears in the feature column list, raise CRITICAL. This is the most common form of accidental leakage.

**Rule 7 — Incomplete as TIME_LIMIT (ERROR):** If `is_incomplete=True` and `first_touch == TIME_LIMIT`, raise ERROR. This indicates a bug in the label generator that incorrectly classified a truncated horizon as a legitimate time-barrier outcome.

### 8.3 PIT mutation test

The PIT test verifies that appending a future bar to the OHLCV DataFrame does not change the `first_touch` or `gross_return` of any previously-completed event. This guards against implementation bugs where the label generator reads beyond the intended event window.

---

## 9. Label Registry

Every label type is registered in `LABEL_REGISTRY` in `registry.py`:

```python
LABEL_REGISTRY["TRIPLE_BARRIER_V2_DAILY"] = LabelRegistration(
    label_id="TRIPLE_BARRIER_V2_DAILY",
    label_family=LabelFamily.TRIPLE_BARRIER,
    description="...",
    label_config_hash=...,
    tested=True,
    deprecated=False,
)
```

The registry enforces:
- Every active label must have `tested=True`.
- Every deprecated label must have a `deprecation_note`.
- Label config hashes are accessible programmatically for provenance tracking.

The registry is the single source of truth for what labels exist and whether they are safe to use in production.

---

## 10. Design Decisions and Rejected Alternatives

| Decision | Chosen | Rejected | Reason |
|----------|--------|----------|--------|
| Default ambiguity policy | `CONSERVATIVE_SL` | `DATA_AMBIGUOUS` | Discarding all ambiguous events reduces already-limited event sets on thin-traded names. Conservative labelling is safer for model training. |
| lv1 consumer compat | Delegate `generate_risk_labels()` to lv2 | Rewrite `train_all.py` | `train_all.py` changes are high-risk; deferred to Phase 3D. Delegation preserves the API surface while fixing the first-touch bug. |
| Cost model default | `DATA_UNAVAILABLE` | Hardcoded SEBI STT | Costs vary by broker, instrument, and turnover tier. Hardcoding one number would silently be wrong for most users. Explicit unavailability forces callers to opt in. |
| Barrier sizing | ATR-based (vol-relative) | Fixed percentage | Fixed % barriers are too wide for low-vol stocks and too narrow for high-vol F&O. ATR-relative sizing self-calibrates. |
| Sector peer data absent | Return `gross_return=None` | Fall back to NIFTY | Returning `None` makes the missing data explicit. Using NIFTY as a proxy for sector would be quietly wrong. |
| Label module isolation | Labels do not import from `data-service` | Shared import | The `ml-service` and `data-service` are separate microservices. Cross-service imports at the Python level would create tight coupling. Labels mirror semantics only. |
