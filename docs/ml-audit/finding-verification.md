# Finding Verification: Independent Re-Audit of Prompt 1 Findings

**Verification Date:** 2026-09-06  
**Method:** Direct source code inspection with file/line citations. No reliance on Prompt 1 text.  
**Scope:** Every critical and high-severity finding from the original forensic audit.

---

## Verification Legend

| Status | Meaning |
|---|---|
| `CONFIRMED` | Finding independently verified against source code with exact location |
| `PARTIALLY_CONFIRMED` | Core of finding is correct but details require refinement |
| `NOT_REPRODUCIBLE` | Could not find the cited code pattern |
| `INCORRECT` | Finding contradicts actual source code |
| `ALREADY_RESOLVED` | Bug was fixed before this verification pass |

---

## Critical Findings

### C1 — Random splits in train_all.py for regime and strategy models

| Field | Detail |
|---|---|
| **Original Finding** | `train_regime_model()` and `train_strategy_model()` use `sklearn.train_test_split` with random shuffling — temporal leakage |
| **File / Lines** | `src/training/train_all.py` lines 41, 50-53 (regime); lines 121, 130-133 (strategy) |
| **Evidence** | `from sklearn.model_selection import train_test_split` at line 41; `train_test_split(X, y, test_size=0.2, random_state=42, stratify=y)` at line 50 — confirmed random shuffle |
| **Current Status** | **CONFIRMED** |
| **Risk** | All regime and strategy model OOS metrics are invalid. Any trained artifact is contaminated. |
| **Required Action** | Replace with `WalkForwardValidator` using temporal splits |

---

### C2 — center=True look-ahead in detect_bos_choch()

| Field | Detail |
|---|---|
| **Original Finding** | `detect_bos_choch()` uses `rolling(center=True)` — swing detection sees 5 future bars |
| **File / Lines** | `src/features/market_structure.py` lines 136-137 |
| **Evidence** | `swing_high = high.rolling(window=lookback * 2 + 1, center=True).max()` and `swing_low = low.rolling(window=lookback * 2 + 1, center=True).min()` — confirmed |
| **Current Status** | **CONFIRMED** |
| **Risk** | `bos_net`, `choch_net`, `structure_score` features encode future price data. Both training AND live inference are contaminated. With default `lookback=5`, the window is 11 bars and uses 5 future bars. |
| **Required Action** | Remove `center=True` (one-character fix); or replace with `center=False` explicitly |

---

### C3 — VWAP cumsum cross-session contamination

| Field | Detail |
|---|---|
| **Original Finding** | `compute_vwap_distance_pct()` uses `cumsum()` over entire series — wrong for daily bars |
| **File / Lines** | `src/features/volume.py` lines 49-50 |
| **Evidence** | `cum_tp_vol = (typical_price * volume).cumsum()` and `cum_vol = volume.cumsum()` — cumulates from start of whatever series is passed in, not from session start |
| **Current Status** | **CONFIRMED** |
| **Risk** | Feature is semantically incorrect for daily data. For a 200-bar lookback window passed to this function, the VWAP represents a ~10-month cumulative average price, not an intraday VWAP. The docstring says "intraday VWAP (approximated for daily using typical price)" which is misleading. |
| **Required Action** | For daily bars: use a rolling N-day VWAP or remove this feature and replace with a meaningful daily price anchor |

---

### C4 — CalibrationStore quality metrics computed in-sample

| Field | Detail |
|---|---|
| **Original Finding** | `CalibrationStore.fit()` measures ECE/MCE/Brier on fitting data, not OOS data |
| **File / Lines** | `src/meta/calibration.py` lines 339-360 |
| **Evidence** | `entry.platt.fit(scores, labels)` then `cal_probs = entry.platt.predict_proba(scores)` then `ece, mce = _expected_calibration_error(cal_probs, labels)` — same `scores` object used for both fit and evaluate |
| **Current Status** | **CONFIRMED** |
| **Risk** | Calibration quality scores used to weight models in ensemble are systematically over-optimistic. In-sample ECE will always be lower than OOS ECE for Platt scaling. |
| **Required Action** | Add separate `eval_scores`/`eval_labels` parameters to `fit()`; compute quality metrics on held-out set |

---

### C5 — WalkForwardValidator / PurgedKFold not used in train_all.py

| Field | Detail |
|---|---|
| **Original Finding** | Validation framework is tested but not used in training |
| **File / Lines** | `src/training/train_all.py` — entire file. `src/validation/__init__.py` lines 40-95 |
| **Evidence** | No import of `WalkForwardValidator`, `PurgedKFold`, `EmbargoApplier` anywhere in `train_all.py`. The `data_pipeline.py` has its own local `walk_forward_splits()` function (line 114) which is a simpler version. |
| **Current Status** | **CONFIRMED** |
| **Risk** | The sophisticated validation framework (with integrity checks, fold manifests, purging, embargo) is entirely bypassed. The local `walk_forward_splits()` in `data_pipeline.py` lacks purging and embargo. |
| **Required Action** | Import and use `WalkForwardValidator` and `PurgedKFold` in `train_all.py` |

---

### C6 — ModelAcceptanceGate never called from training

| Field | Detail |
|---|---|
| **Original Finding** | `ModelAcceptanceGate` exists in `validation/metrics.py` but is never called from `train_all.py` |
| **File / Lines** | `src/validation/metrics.py` line 714 (definition); `src/training/train_all.py` — no import |
| **Evidence** | Confirmed no import of `ModelAcceptanceGate` in `train_all.py`. Models are saved unconditionally after training regardless of OOS performance. |
| **Current Status** | **CONFIRMED** |
| **Risk** | No evidence gate. A model that performs worse than the heuristic baseline will be saved and deployed. |
| **Required Action** | Call `ModelAcceptanceGate.evaluate(result)` before `model.save()`; reject if gate fails |

---

## High-Severity Findings

### H1 — Survivorship bias in TRAINING_UNIVERSE

| Field | Detail |
|---|---|
| **Original Finding** | Static hardcoded 50-symbol universe creates survivorship bias |
| **File / Lines** | `src/training/data_pipeline.py` lines 77-106 |
| **Evidence** | `TRAINING_UNIVERSE: list[str] = ["NIFTY", "BANKNIFTY", ...]` — confirmed static list of today's F&O-eligible stocks |
| **Current Status** | **CONFIRMED** |
| **Risk** | All historical training data only includes stocks that survived to today. Stocks removed from F&O list (due to corporate actions, low volume, regulatory action) are excluded. This inflates apparent historical alpha. |
| **Required Action** | Build point-in-time universe registry with NSE F&O eligibility dates |

---

### H2 — No transaction costs in label generation

| Field | Detail |
|---|---|
| **Original Finding** | All labels are gross P&L; no STT, brokerage, slippage deducted |
| **File / Lines** | `src/training/data_pipeline.py` — `generate_ranking_labels_v2()` (line 355), `generate_risk_labels()` (line 384) |
| **Evidence** | Grepped entire `src/` for "transaction_cost", "brokerage", "stt", "STT", "round_trip" — zero results. Labels compute raw excess return with no cost deduction. |
| **Current Status** | **CONFIRMED** |
| **Risk** | Models trained on gross labels will select strategies that maximise gross return. After realistic NSE costs (0.25-0.45% round-trip), many signals that appear profitable are not. |
| **Required Action** | Add NSE cost model; deduct costs from all return-based labels |

---

### H3 — Ensemble weights not connected to ModelRegistry state

| Field | Detail |
|---|---|
| **Original Finding** | ModelRegistry DEGRADED/DISABLED weight multipliers not applied by EnsembleWeighter |
| **File / Lines** | `src/meta/meta_model.py` `_get_weighter()` method; `src/monitoring/model_registry.py` |
| **Evidence** | `_get_weighter()` uses `self.calibration_store.all_quality_scores()` only. No import of `ModelRegistry` in `meta_model.py`. A DEGRADED model (registry weight 0.30) receives full ensemble weight. |
| **Current Status** | **CONFIRMED** |
| **Risk** | ModelRegistry state machine has zero effect on live inference. DEGRADED and DISABLED models are treated identically to HEALTHY models in the ensemble. |
| **Required Action** | Inject registry into MetaDecisionEngine; multiply base weights by `registry.get_weight(model_name)` |

---

### H4 — IV rank fallback uses fake history

| Field | Detail |
|---|---|
| **Original Finding** | `compute_iv_rank()` fallback uses hardcoded `[15, 18, 20, 22, 25]` |
| **File / Lines** | `src/features/engineer.py` line 343 |
| **Evidence** | `compute_iv_rank(current_iv or 20.0, iv_history if iv_history else [15, 18, 20, 22, 25])` — confirmed |
| **Current Status** | **CONFIRMED** |
| **Risk** | When no derivatives data available (common in training on partial data), IV rank is computed against a 5-element fake history producing a deterministic but meaningless value (e.g., IV=20 always returns 75.0 against [15,18,20,22,25]). |
| **Required Action** | Return 50.0 (neutral/unknown) when history < 5 bars |

---

### H5 — HPO leaks into validation set

| Field | Detail |
|---|---|
| **Original Finding** | `_hpo_xgboost()` optimises on val set then reports val metrics as OOS |
| **File / Lines** | `src/training/train_all.py` lines 224-270 |
| **Evidence** | `study.optimize(objective_fn, n_trials=n_trials)` where `objective_fn` evaluates on `X_val`; then `train_regime_model` calls `model.train(..., eval_set=(X_val, y_val))` using the same `X_val`. |
| **Current Status** | **CONFIRMED** |
| **Risk** | Any model found via HPO has its val_accuracy inflated. The "best" of 30 trials on the same val set has expected accuracy inflation ≈ sqrt(2×ln(30)) × SE ≈ 2.45 SE. |
| **Required Action** | Use 3-way split; HPO on val; report final metrics on held-out test set only |

---

### H6 — No F&O ban list filtering

| Field | Detail |
|---|---|
| **Original Finding** | No filtering of NSE F&O ban list stocks |
| **Evidence** | Grepped entire `src/` for "ban_list", "fno_ban", "mwpl", "MWPL" — zero results |
| **Current Status** | **CONFIRMED** |
| **Risk** | Signals generated for F&O-banned stocks are: (a) regulatory non-compliant (only closing trades allowed), (b) based on distorted OI data (only unwinding OI, no new positions). |
| **Required Action** | Add daily NSE F&O ban list fetch and filter before signal generation |

---

## Medium-Severity Findings

### M1 — obv_trend written twice to features dict

| Field | Detail |
|---|---|
| **Original Finding** | `features["obv_trend"]` assigned twice in `compute_stock_features()` |
| **File / Lines** | `src/features/engineer.py` lines 213 and 244 |
| **Evidence** | Line 213: `features["obv_trend"] = _last(obv_t)` (in technical block); line 244: `features["obv_trend"] = _last(obv_t)` (in volume block) — second write overwrites first with same value |
| **Current Status** | **CONFIRMED** |
| **Risk** | Low — same value, no functional bug. Indicates copy-paste error. |
| **Required Action** | Remove duplicate write on line 244 |

---

### M2 — breadth_thrust always returns 0.0

| Field | Detail |
|---|---|
| **Original Finding** | `compute_market_breadth()` always sets `breadth_thrust = 0.0` |
| **File / Lines** | `src/features/macro.py` line 53 |
| **Evidence** | `"breadth_thrust": 0.0,  # Requires historical breadth data` — confirmed dead feature in REGIME_FEATURES |
| **Current Status** | **CONFIRMED** |
| **Risk** | Zero-variance feature in REGIME_FEATURES. Tree models will ignore it (zero gain) but it wastes a feature slot and may confuse feature importance reporting. |
| **Required Action** | Remove from REGIME_FEATURES or implement properly |

---

### M3 — pyproject.toml / requirements.txt dependency name mismatch

| Field | Detail |
|---|---|
| **Original Finding** | `pyproject.toml` lists `pypfopt` but `requirements.txt` lists `pyportfolioopt` |
| **Evidence** | `pyproject.toml` line: `"pypfopt==1.5.5"`. `requirements.txt` line: `pyportfolioopt==1.5.5`. These are different PyPI package names (`pypfopt` is the correct name; `pyportfolioopt` does not exist as a separate package — `PyPortfolioOpt` is the correct full name). |
| **Current Status** | **PARTIALLY_CONFIRMED** — The names differ but both may resolve to the same package depending on PyPI. The `pyportfolioopt` vs `pypfopt` naming is the actual risk. |
| **Risk** | Build may fail in environments that use `pyproject.toml` as the install source |
| **Required Action** | Standardise to `PyPortfolioOpt==1.5.5` in both files |

---

### M4 — VOLATILE label uses trailing ATR with forward return

| Field | Detail |
|---|---|
| **Original Finding** | `realized_atr_pct` in VOLATILE label uses forward-looking ATR |
| **File / Lines** | `src/models/market_regime.py` lines 462-480 |
| **Evidence** | `realized_atr_pct = tr.rolling(lookforward).mean() / close * 100` — this is a **trailing** window (rolling backward). The comment in the original audit was imprecise. The window is NOT forward-shifted. However, `volatile_mask = (realized_atr_pct > 1.8) & (fwd_return.abs() < 0.03)` mixes past ATR with future return in the **same label**. |
| **Current Status** | **PARTIALLY_CONFIRMED** — The ATR is trailing (not look-ahead), but the VOLATILE label definition depends on BOTH past volatility AND future direction, creating a structurally unusual label. |
| **Risk** | VOLATILE label identifies periods where past vol was high but future return was small in absolute terms. This is a legitimate label definition (high-vol, non-trending periods) but it is NOT pure look-ahead. The original audit overstated this as look-ahead. |
| **Required Action** | Document the label semantics clearly; consider whether the mixed past/future definition is intentional. Not a leakage bug. |

---

### M5 — fii_net_cr not in REGIME_FEATURES

| Field | Detail |
|---|---|
| **Original Finding** | FII flows feature referenced in docs but not wired into training |
| **File / Lines** | `src/features/engineer.py` line 398 (docstring only); actual `REGIME_FEATURES` list lines 80-95 |
| **Evidence** | `fii_net_cr` appears in the `compute_regime_features()` docstring under `market_data` keys but NOT in the `REGIME_FEATURES` list. The `schemas.py` RegimePredictionRequest also includes `fii_net_cr` as an optional field. But `REGIME_FEATURES` has 28 items; `fii_net_cr` is not one of them. |
| **Current Status** | **CONFIRMED** |
| **Risk** | FII/DII flow data is available and recognised as a regime signal but the feature is never extracted or used in training. Missed signal. |
| **Required Action** | Add `fii_net_5d_cr` (normalised 5-day rolling FII flow) to REGIME_FEATURES |

---

### M6 — NSE expiry day claim needs nuancing

| Field | Detail |
|---|---|
| **Original Finding** | AlphaForge hardcodes Thursday expiry assumptions |
| **Evidence** | Grepped entire `src/` for "Thursday", "thursday" — zero results. The `compute_expiry_features()` function takes `days_to_weekly_expiry` and `is_expiry_day` as **parameters** passed by the caller. There is no hardcoded Thursday. However: default fallback is `days_to_weekly_expiry or 5`, meaning if the caller omits this, the system assumes 5 days to expiry, which would only be correct on a specific day and is effectively arbitrary. |
| **Current Status** | **PARTIALLY_CONFIRMED** — There is no hardcoded Thursday string. But there is no NSE expiry calendar embedded in the system either. The caller is responsible for computing the correct expiry proximity, creating a documentation and integration gap rather than a code-level hardcoding. |
| **Risk** | Any calling code that passes the default (omitting the parameter) will always produce `days_to_weekly_expiry = 5`, which is arbitrary. The system has no internal expiry calendar. |
| **Required Action** | Embed an NSE F&O expiry calendar; compute `days_to_weekly_expiry` from a real calendar, not from caller-supplied values with a fallback of 5 |

---

## Summary Table

| ID | Finding | Status | Risk | Required Action |
|---|---|---|---|---|
| C1 | Random splits in train_all.py | **CONFIRMED** | 🔴 CRITICAL | Replace with WalkForwardValidator |
| C2 | center=True look-ahead in BOS/CHOCH | **CONFIRMED** | 🔴 CRITICAL | Remove center=True |
| C3 | VWAP cumsum cross-session | **CONFIRMED** | 🔴 HIGH | Reset per session for daily data |
| C4 | CalibrationStore in-sample quality | **CONFIRMED** | 🔴 HIGH | Add separate eval set |
| C5 | Validation framework unused | **CONFIRMED** | 🔴 CRITICAL | Use in train_all.py |
| C6 | ModelAcceptanceGate never called | **CONFIRMED** | 🔴 HIGH | Wire to training |
| H1 | Survivorship bias in universe | **CONFIRMED** | 🔴 HIGH | PIT universe registry |
| H2 | No transaction costs | **CONFIRMED** | 🔴 HIGH | Add NSE cost model |
| H3 | Registry weights not in ensemble | **CONFIRMED** | 🟡 MEDIUM | Inject registry into MetaEngine |
| H4 | IV rank fake fallback | **CONFIRMED** | 🟡 MEDIUM | Return 50.0 default |
| H5 | HPO leaks into val set | **CONFIRMED** | 🟡 MEDIUM | 3-way split |
| H6 | No F&O ban list filtering | **CONFIRMED** | 🔴 HIGH | Daily ban list integration |
| M1 | obv_trend double write | **CONFIRMED** | 🟢 LOW | Remove duplicate line 244 |
| M2 | breadth_thrust always 0 | **CONFIRMED** | 🟢 LOW | Implement or remove |
| M3 | pyproject.toml/requirements mismatch | **PARTIALLY_CONFIRMED** | 🟡 MEDIUM | Standardise dependency names |
| M4 | VOLATILE label look-ahead claim | **PARTIALLY_CONFIRMED (overstated)** | 🟢 LOW | Clarify documentation only |
| M5 | fii_net_cr not in REGIME_FEATURES | **CONFIRMED** | 🟡 MEDIUM | Add to REGIME_FEATURES |
| M6 | Thursday expiry hardcoding | **PARTIALLY_CONFIRMED (imprecise)** | 🟡 MEDIUM | Embed NSE expiry calendar |

**Corrections to Prompt 1:** Finding M4 (VOLATILE label) was overstated as look-ahead; it is not. Finding M6 (Thursday hardcoding) is imprecise; there is no hardcoded day string, only a missing calendar implementation.
