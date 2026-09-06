# AlphaForge ML Service — Remediation Roadmap

**Audit Date:** 2026-09-06  
**Scope:** Complete remediation plan derived from all 13 audit documents

---

## 1. Component Status Matrix

| Component | File(s) | Status | Risk | Evidence | Recommendation |
|---|---|---|---|---|---|
| WalkForwardValidator | `validation/walk_forward.py` | PRODUCTION_READY | LOW | Fully tested, 12 tests | KEEP |
| PurgedKFold | `validation/purged_kfold.py` | PRODUCTION_READY | LOW | Fully tested, sklearn-compatible | KEEP |
| EmbargoApplier | `validation/embargo.py` | PRODUCTION_READY | LOW | Fully tested, 7 tests | KEEP |
| CPCVSplitter | `validation/combinatorial_cv.py` | PRODUCTION_READY | LOW | Tested | KEEP |
| FinancialMetricsEvaluator | `validation/metrics.py` | PRODUCTION_READY | LOW | Tested | KEEP |
| ModelAcceptanceGate | `validation/metrics.py` | FIX | HIGH | Not wired to train_all.py | FIX — wire to training |
| DriftDetector | `monitoring/drift_detector.py` | PRODUCTION_READY | LOW | Thread-safe, PSI+KS+JS | KEEP |
| ModelRegistry | `monitoring/model_registry.py` | PRODUCTION_READY | LOW | State machine, persistence | KEEP |
| PerformanceMonitor | `monitoring/performance_monitor.py` | KEEP | MEDIUM | No feedback loop yet | KEEP — add outcome loop |
| AlertSystem | `monitoring/alerts.py` | KEEP | MEDIUM | No external delivery | KEEP — add webhook |
| Data normalization | `training/market_data_client.py` | PRODUCTION_READY | LOW | Tested, 7 normalization tests | KEEP |
| Data pipeline labels | `training/data_pipeline.py` | FIX | HIGH | Correct structure; no costs | FIX — add tx costs |
| train_all.py (regime) | `training/train_all.py` | REWRITE | CRITICAL | Random split — leakage | REWRITE split logic |
| train_all.py (strategy) | `training/train_all.py` | REWRITE | CRITICAL | Random split — leakage | REWRITE split logic |
| train_all.py (ranker) | `training/train_all.py` | FIX | HIGH | No embargo at boundary | FIX — add embargo |
| train_all.py (risk) | `training/train_all.py` | FIX | HIGH | No embargo at boundary | FIX — add embargo |
| detect_bos_choch() | `features/market_structure.py` | FIX | CRITICAL | center=True look-ahead | FIX — center=False |
| compute_vwap_distance_pct() | `features/volume.py` | FIX | HIGH | Cross-session cumsum | FIX — reset per session |
| compute_iv_rank() fallback | `features/derivatives.py` | FIX | MEDIUM | Hardcoded fake history | FIX — return 50.0 |
| compute_market_breadth() | `features/macro.py` | FIX | LOW | breadth_thrust always 0 | FIX or remove from features |
| engineer.py double write | `features/engineer.py` | FIX | LOW | obv_trend written twice | FIX |
| CalibrationStore.fit() | `meta/calibration.py` | FIX | HIGH | In-sample quality metrics | FIX — separate eval set |
| EnsembleWeighter | `meta/ensemble.py` | FIX | HIGH | Weights hardcoded; registry disconnected | FIX — inject registry weights |
| _strategy_to_direction() | `meta/meta_model.py` | FIX | MEDIUM | mean_reversion mapped to -1 | FIX or document |
| MarketRegimeClassifier | `models/market_regime.py` | EXPERIMENTAL | HIGH | Heuristic only; no OOS evidence | REWRITE train script; KEEP model |
| StockRanker | `models/stock_ranker.py` | EXPERIMENTAL | HIGH | Heuristic only; no OOS evidence | FIX train script; KEEP model |
| StrategySelector | `models/strategy_selector.py` | EXPERIMENTAL | HIGH | Heuristic only; no OOS evidence | REWRITE train script; KEEP model |
| RiskPredictor | `models/risk_predictor.py` | EXPERIMENTAL | HIGH | Labels lack costs; no OOS evidence | FIX labels; KEEP model |
| PortfolioOptimizer | `models/portfolio_optimizer.py` | RESEARCH_ONLY | MEDIUM | Functional; no cost/liquidity constraints | RESEARCH_ONLY → add constraints |
| RLExecutor | `models/rl_executor.py` | RESEARCH_ONLY | HIGH | Environment not validated | RESEARCH_ONLY |
| TRAINING_UNIVERSE | `training/data_pipeline.py` | FIX | HIGH | Static — survivorship bias | FIX — point-in-time universe |
| F&O ban list handling | (missing) | REWRITE | HIGH | Not implemented | ADD new component |
| Transaction cost model | (missing) | REWRITE | HIGH | Not implemented | ADD to label generators |

---

## 2. Top 20 Highest-Priority Problems

Ordered by: **impact × probability × difficulty** (where difficulty is inverse — simpler fixes are ranked higher when impact and probability are equal).

---

### P1 — Random splits in train_all.py for regime and strategy models

| | |
|---|---|
| **Severity** | CRITICAL |
| **Impact** | All reported regime/strategy validation metrics are invalid; any live model trained with this code has look-ahead bias baked in |
| **Probability** | 1.0 — confirmed in code |
| **Difficulty** | LOW — 3-line change per function |
| **File** | `training/train_all.py::train_regime_model()`, `train_strategy_model()` |
| **Fix** | Replace `train_test_split(X, y, ...)` with `WalkForwardValidator` splits; use last fold for evaluation |

---

### P2 — `center=True` look-ahead in BOS/CHOCH swing detection

| | |
|---|---|
| **Severity** | CRITICAL |
| **Impact** | Features `bos_net`, `choch_net`, `structure_score` contain future bar information. Both training AND live inference are contaminated |
| **Probability** | 1.0 — confirmed in code |
| **Difficulty** | LOW — 1-character change (`center=True` → `center=False`) |
| **File** | `features/market_structure.py::detect_bos_choch()` |
| **Fix** | Remove `center=True` argument from both `rolling()` calls |

---

### P3 — ModelAcceptanceGate not wired to training pipeline

| | |
|---|---|
| **Severity** | HIGH |
| **Impact** | Every model is saved regardless of OOS performance — no evidence gate enforced |
| **Probability** | 1.0 — confirmed in code |
| **Difficulty** | MEDIUM — requires collecting OOS predictions and calling gate |
| **File** | `training/train_all.py` |
| **Fix** | After each model trains on walk-forward folds, collect test-fold predictions, run `FinancialMetricsEvaluator` + `ModelAcceptanceGate`; reject and log if gate fails |

---

### P4 — No transaction costs in label generation

| | |
|---|---|
| **Severity** | HIGH |
| **Impact** | All ranking, risk, and strategy labels are gross P&L; models maximise gross return which does not translate to net profitability after NSE costs (0.3–0.5% round-trip) |
| **Probability** | 1.0 — confirmed |
| **Difficulty** | MEDIUM |
| **File** | `training/data_pipeline.py` |
| **Fix** | Deduct round-trip cost (brokerage + STT + exchange + SEBI + stamp) from excess return in `generate_ranking_labels_v2()`; adjust stop/target distances in `generate_risk_labels()` to include slippage |

---

### P5 — Survivorship bias in training universe

| | |
|---|---|
| **Severity** | HIGH |
| **Impact** | Models learn only from stocks that survived to today; historical universe was larger and included weaker companies |
| **Probability** | 1.0 — confirmed |
| **Difficulty** | HIGH — requires external data source (NSE F&O historical eligibility records) |
| **File** | `training/data_pipeline.py` — `TRAINING_UNIVERSE` |
| **Fix** | Build point-in-time universe table from NSE circulars or data vendor; replace static list with dynamic lookup at each training date |

---

### P6 — CalibrationStore quality metrics computed in-sample

| | |
|---|---|
| **Severity** | HIGH |
| **Impact** | Ensemble weights are adjusted by misleading quality scores; well-calibrated models indistinguishable from poorly-calibrated ones |
| **Probability** | 1.0 — confirmed in code |
| **Difficulty** | MEDIUM |
| **File** | `meta/calibration.py::CalibrationStore.fit()` |
| **Fix** | Add `eval_scores` / `eval_labels` optional parameters; compute ECE/MCE/Brier on eval set, not fitting set |

---

### P7 — ModelRegistry weights not connected to EnsembleWeighter

| | |
|---|---|
| **Severity** | HIGH |
| **Impact** | A DEGRADED model (weight multiplier 0.30) continues to receive full weight in the ensemble; monitoring state has no effect on decisions |
| **Probability** | 1.0 — confirmed |
| **Difficulty** | MEDIUM |
| **File** | `meta/meta_model.py::MetaDecisionEngine._get_weighter()` |
| **Fix** | Inject registry weights into `EnsembleWeighter`; multiply base weights by `registry.get_weight(model_name)` |

---

### P8 — No embargo at ranking/risk train-val boundary

| | |
|---|---|
| **Severity** | HIGH |
| **Impact** | Last `horizon` training samples have labels that overlap with the validation window |
| **Probability** | 1.0 — confirmed |
| **Difficulty** | LOW |
| **File** | `training/train_all.py::train_ranking_model()`, `train_risk_model()` |
| **Fix** | After time-based split, apply `EmbargoApplier(EmbargoConfig.bars(horizon))` to remove last `horizon` training samples |

---

### P9 — VWAP feature uses cross-session cumsum for daily data

| | |
|---|---|
| **Severity** | HIGH |
| **Impact** | `vwap_distance_pct` is a multi-month cumulative average price, not an intraday VWAP; the feature meaning is inconsistent with its name and downstream interpretations |
| **Probability** | 1.0 — confirmed |
| **Difficulty** | MEDIUM |
| **File** | `features/volume.py::compute_vwap_distance_pct()` |
| **Fix** | For daily bars: use a rolling N-day VWAP with `groupby(date)` reset. For intraday bars: existing cumsum is correct |

---

### P10 — VOLATILE label uses non-shifted ATR (borderline look-ahead)

| | |
|---|---|
| **Severity** | HIGH |
| **Impact** | VOLATILE label determination partly depends on the same future window as the forward return; label thresholds may be calibrated to a non-causal statistic |
| **Probability** | 1.0 — confirmed |
| **Difficulty** | LOW |
| **File** | `models/market_regime.py::generate_regime_labels()` |
| **Fix** | Use trailing ATR only: `realized_atr_pct = tr.rolling(lookforward).mean() / close * 100` (no shift) — this is already backward-looking; verify it is not shifted forward |

---

### P11 — HPO leaks into validation set

| | |
|---|---|
| **Severity** | MEDIUM |
| **Impact** | Reported validation accuracy after HPO is optimistically biased; hyperparameters are overfit to the validation set |
| **Probability** | 1.0 — confirmed |
| **Difficulty** | MEDIUM |
| **File** | `training/train_all.py::_hpo_xgboost()` |
| **Fix** | Use 3-way split (train/val/test); HPO on val, final evaluation on test only |

---

### P12 — No F&O ban list filtering

| | |
|---|---|
| **Severity** | HIGH |
| **Impact** | Stocks in F&O ban have distorted OI data; signals generated for banned stocks are invalid; trading them is regulatory non-compliant |
| **Probability** | 1.0 — ban list changes daily |
| **Difficulty** | MEDIUM |
| **File** | New component needed |
| **Fix** | Fetch daily NSE F&O ban list; filter from universe in both training and inference |

---

### P13 — test suite does not cover train_all.py temporal split

| | |
|---|---|
| **Severity** | HIGH |
| **Impact** | CI passes despite random splits — bugs like P1 cannot be detected automatically |
| **Probability** | 1.0 — confirmed; `test_no_random_split_in_pipeline` only checks `data_pipeline.py` |
| **Difficulty** | LOW |
| **File** | `tests/test_data_pipeline.py` (extend) or new `tests/test_train_all.py` |
| **Fix** | Add AST check that `train_all.py` does not import `train_test_split`; add integration test that verifies time-ordering of train/val splits |

---

### P14 — No corporate action adjustment verification

| | |
|---|---|
| **Severity** | HIGH |
| **Impact** | Stocks with splits/bonuses show apparent price discontinuities in OHLCV; momentum, ATR, and distance-from-high features are corrupted |
| **Probability** | HIGH — corporate actions are frequent over a 3-year training window |
| **Difficulty** | HIGH — requires data vendor support |
| **File** | `training/market_data_client.py` |
| **Fix** | Verify with Angel One / Upstox whether OHLCV data is adjusted for corporate actions; add adjustment_type field to DatasetMetadata |

---

### P15 — IV rank fallback uses hardcoded fake history

| | |
|---|---|
| **Severity** | MEDIUM |
| **Impact** | IV rank returns 75.0 for a 20 IV vs fake [15,18,20,22,25] history; a meaningless signal is injected into the feature vector |
| **Probability** | 1.0 — triggered every time derivatives data is absent |
| **Difficulty** | LOW |
| **File** | `features/engineer.py::compute_stock_features()` |
| **Fix** | Return `50.0` when no history (neutral/unknown) instead of fabricating a 5-point history |

---

### P16 — strategy_to_direction maps mean_reversion to SELL

| | |
|---|---|
| **Severity** | MEDIUM |
| **Impact** | Mean-reversion is a direction-agnostic strategy; mapping it to -1 (bearish) biases the ensemble against mean-reversion signals in all market conditions |
| **Probability** | 1.0 — confirmed in code |
| **Difficulty** | LOW |
| **File** | `meta/meta_model.py::_strategy_to_direction()` |
| **Fix** | Map `mean_reversion` to 0 (neutral); it trades both long and short depending on entry conditions |

---

### P17 — No OOS calibration training in train_all.py

| | |
|---|---|
| **Severity** | MEDIUM |
| **Impact** | `fit_meta_layer()` is never called; calibrators are always unfitted; all model confidences are uncalibrated raw scores |
| **Probability** | 1.0 — confirmed |
| **Difficulty** | MEDIUM |
| **File** | `training/train_all.py` |
| **Fix** | After walk-forward training, collect OOS predictions per fold, construct `OOSPredictionRecord` list, call `meta_engine.fit_meta_layer()` |

---

### P18 — breadth_thrust always returns 0.0

| | |
|---|---|
| **Severity** | LOW |
| **Impact** | Dead feature in REGIME_FEATURES; zero-variance features waste a model slot and may cause issues in some normalisation schemes |
| **Probability** | 1.0 — confirmed in code |
| **Difficulty** | LOW |
| **File** | `features/macro.py::compute_market_breadth()` |
| **Fix** | Implement rolling breadth thrust (rate of change of pct_above_sma20) or remove from REGIME_FEATURES |

---

### P19 — pyproject.toml / requirements.txt dependency name mismatch

| | |
|---|---|
| **Severity** | LOW |
| **Impact** | Docker builds or fresh environments may fail silently if one file is used and not the other (`pypfopt` vs `pyportfolioopt`) |
| **Probability** | MEDIUM — affects anyone installing from pyproject.toml |
| **Difficulty** | LOW |
| **File** | `pyproject.toml`, `requirements.txt` |
| **Fix** | Align both files: use `pyportfolioopt==1.5.5` (the correct PyPI package name) |

---

### P20 — No trade outcome feedback loop for PerformanceMonitor

| | |
|---|---|
| **Severity** | MEDIUM |
| **Impact** | PerformanceMonitor has no data to process; performance degradation cannot be detected; ModelRegistry cannot escalate to DEGRADED based on trading performance |
| **Probability** | 1.0 — confirmed (no feedback mechanism in code) |
| **Difficulty** | HIGH — requires end-to-end integration with paper/live trading |
| **File** | New component + `monitoring/performance_monitor.py` |
| **Fix** | Implement `TradeOutcome` recording in the paper trading layer; pipe resolved outcomes back to PerformanceMonitor via a background worker |

---

## 3. Remediation Phases

### Phase 1 — Leakage Eradication (Before Any Model Training)
*Must complete before any model artifact is treated as evidence of alpha.*

| # | Task | Effort |
|---|---|---|
| 1.1 | Fix `center=True` in `detect_bos_choch()` | 30 min |
| 1.2 | Replace random splits with WalkForwardValidator in train_all.py | 4 hrs |
| 1.3 | Add embargo at ranking/risk train-val boundary | 2 hrs |
| 1.4 | Fix IV rank fallback | 30 min |
| 1.5 | Fix VOLATILE label ATR calculation | 1 hr |
| 1.6 | Fix VWAP for daily bars | 2 hrs |
| 1.7 | Fix strategy_to_direction for mean_reversion | 30 min |
| 1.8 | Add test coverage for train_all.py temporal split | 2 hrs |

**Total Phase 1 effort: ~12 hours**

---

### Phase 2 — Evidence Gates (Before Any Signal Is Claimed as Alpha)
*Required before claiming any model generates genuine OOS alpha.*

| # | Task | Effort |
|---|---|---|
| 2.1 | Wire ModelAcceptanceGate into train_all.py | 4 hrs |
| 2.2 | Fix CalibrationStore quality metrics to use held-out OOS data | 3 hrs |
| 2.3 | Wire fit_meta_layer() into training pipeline | 4 hrs |
| 2.4 | Connect ModelRegistry weights to EnsembleWeighter | 2 hrs |
| 2.5 | Add 3-way split (train/val/test) to HPO | 3 hrs |

**Total Phase 2 effort: ~16 hours**

---

### Phase 3 — India Market Correctness (Before Live Trading)
*Required before the system produces actionable signals for live trading.*

| # | Task | Effort |
|---|---|---|
| 3.1 | Add NSE transaction cost model to all label generators | 4 hrs |
| 3.2 | Implement F&O ban list filtering | 8 hrs |
| 3.3 | Add NSE expiry calendar for expiry feature computation | 4 hrs |
| 3.4 | Verify corporate action adjustment in data client | 8 hrs |
| 3.5 | Add rollover detection features | 4 hrs |
| 3.6 | Add lot-size reconciliation in execution layer | 4 hrs |

**Total Phase 3 effort: ~32 hours**

---

### Phase 4 — Production Hardening
*Required before any live capital deployment.*

| # | Task | Effort |
|---|---|---|
| 4.1 | Build point-in-time universe registry | 16 hrs |
| 4.2 | Implement trade outcome feedback loop | 16 hrs |
| 4.3 | Auto-inject dataset/feature version into ModelRecord | 4 hrs |
| 4.4 | Add external alert delivery (webhook/email) | 4 hrs |
| 4.5 | Add model artifact integrity check (hash + schema version) | 4 hrs |
| 4.6 | Implement research/paper/shadow/live execution separation | 16 hrs |

**Total Phase 4 effort: ~60 hours**

---

## 4. INSUFFICIENT_EVIDENCE Statement

Based on this audit, the following statement applies to the current ml-service:

> **INSUFFICIENT_EVIDENCE**
>
> No currently trained model artifact in this repository constitutes valid evidence of OOS alpha. The following conditions must be true before any performance claim is made:
> 1. All Phase 1 (Leakage Eradication) fixes applied and verified
> 2. Models retrained from scratch using WalkForwardValidator
> 3. ModelAcceptanceGate passes on a held-out test set not used during training or HPO
> 4. Rolling walk-forward OOS performance shows stable positive net-of-cost excess returns over a minimum 252-day OOS window
> 5. The regime, strategy, and ranking model OOS Spearman IC > 0.05 at a statistically significant level (p < 0.05) with no single time window contributing > 30% of total performance

Until these conditions are met, all heuristic fallbacks are operating in the system. The heuristics are thoughtful and India-appropriate but are **not evidence of ML alpha** — they are prior beliefs encoded as rules.
