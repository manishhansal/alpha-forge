# Current ML Architecture: Verified End-to-End Trace

**Verification Date:** 2026-09-06  
**Method:** Direct source code tracing. Every component verified against actual file contents.

---

## Architecture Flow Diagram

```
NSE Market Data (Angel One / Upstox)
         │
         ▼
market_data_client.py
  AlphaForgeAPIClient._normalize_ohlcv_frame()
  PostgreSQL fallback
  yfinance last-resort
         │
         ▼ DerivativesSnapshot (PCR, OI, IV, max pain)
         │
         ▼
data_pipeline.py
  enrich_with_derivatives()          ← forwards-fill limit=5 bars
  build_regime_training_data()        ← point-in-time barriers ✅
  build_ranking_training_data()       ← point-in-time barriers ✅
  build_risk_training_data()          ← point-in-time barriers ✅
  build_strategy_training_data()      ← point-in-time barriers ✅
         │
         ▼ .npz files (X, y arrays)
         │
         ▼
FEATURE ENGINEERING
  features/engineer.py
    compute_stock_features()          ← 150+ features
    compute_regime_features()         ← 28 REGIME_FEATURES
    ├── features/technical.py         ← RSI, MACD, ADX, ATR, BB, EMA ⚠️ requires talib
    ├── features/volume.py            ← RelVol, VWAP [BUG: cumsum], OBV, VPIN
    ├── features/momentum.py          ← Returns, ROC, breakout, RS
    ├── features/derivatives.py       ← PCR, OI buildup, IV rank [BUG: fake fallback]
    ├── features/market_structure.py  ← FVG, OB, BOS/CHOCH [BUG: center=True]
    └── features/macro.py             ← VIX, breadth, time/expiry [BUG: breadth_thrust=0]
         │
         ▼
LABEL GENERATION
  data_pipeline.py
    generate_regime_labels_v2()       → 6-class (CRASH/BEAR/VOLATILE/SIDEWAYS/BULL/STRONG_BULL)
    generate_ranking_labels_v2()      → risk-adj excess return vs NIFTY (5-day)
    generate_risk_labels()            → stop_hit, target_hit, MAE (20-day)
    generate_strategy_labels()        → 8-class best-strategy (in strategy_selector.py)
  ALL LABELS: no transaction costs ❌
         │
         ▼
DATASET CONSTRUCTION
  data_pipeline.py
    _save_dataset()                   → .npz + JSON metadata sidecar
    DATASET_VERSION = "af-v3.0-fv4"  → version string (not auto-updated per run)
    TRAINING_UNIVERSE: static list    ← survivorship bias ❌
         │
         ▼
TRAINING (train_all.py)
  train_regime_model()
    ❌ train_test_split(stratify=y)   ← RANDOM SHUFFLE — temporal leakage
    ❌ No WalkForwardValidator
    ❌ No PurgedKFold / embargo
    XGBoostClassifier (6-class, 300 trees)
    save → artifacts/market_regime.json

  train_ranking_model()
    ✅ 80/20 time-based split
    ❌ No embargo at boundary
    LightGBM regression/lambdarank (500 trees)
    save → artifacts/stock_ranker.txt

  train_strategy_model()
    ❌ train_test_split(stratify=y)   ← RANDOM SHUFFLE — temporal leakage
    ❌ No WalkForwardValidator
    CatBoost multiclass (8 classes)
    save → artifacts/strategy_selector.cbm

  train_risk_model()
    ✅ 80/20 time-based split
    ❌ No embargo at boundary
    XGBoost × 3 (stop-hit, target-hit, drawdown)
    save → artifacts/risk/{stop_hit,target_hit,drawdown}.json

  train_rl_executor()
    PPO (Stable-Baselines3)
    ❌ Environment not validated
    save → artifacts/rl_executor/

  _hpo_xgboost()
    Optuna TPE (30 trials)
    ❌ Evaluates on same val set used for final metrics (HPO leakage)

  ❌ ModelAcceptanceGate: NEVER called
         │
         ▼
VALIDATION (validation/) — infrastructure exists, NOT used in training
  WalkForwardValidator   ✅ Correct implementation; unused in train_all.py
  PurgedKFold            ✅ sklearn-compatible; unused in train_all.py
  EmbargoApplier         ✅ Correct; unused in train_all.py
  CombinatorialPurgedCV  ✅ CPCV implemented; unused in train_all.py
  FinancialMetricsEvaluator ✅ Dual-pass metrics; unused in train_all.py
  ModelAcceptanceGate    ✅ Evidence gate; unused in train_all.py
         │
         ▼
MODEL ARTIFACTS (artifacts/)
  No trained artifacts checked into repo
  All models fall through to heuristic fallbacks at inference time
         │
         ▼
CALIBRATION (meta/calibration.py)
  CalibrationStore
    PlattCalibrator      ← sklearn LogisticRegression
    IsotonicCalibrator   ← sklearn IsotonicRegression
    ❌ Quality metrics computed in-sample
    ❌ fit_meta_layer() never called from training
  All models: uncalibrated raw scores passed through sigmoid/clip
         │
         ▼
META MODEL (meta/meta_model.py)
  MetaDecisionEngine.decide()
    1. _get_weighter() → EnsembleWeighter(cal_quality_scores)
       ❌ ModelRegistry weights NOT injected
    2. _build_signals() → 7 ModelSignal objects
       regime, ranker, strategy, risk, price_forecaster, iv_classifier, quant_engine
    3. EnsembleWeighter.compute() → regime-aware weighted score
    4. AbstentionPolicy.evaluate() → NONE/WAIT/NO_TRADE
    5. DecisionPolicy.build_decision() → BUY/SELL/WAIT/NO_TRADE
    Output: MetaOutput {action, confidence, uncertainty, agreement, ...}
         │
         ▼
RISK (models/risk_predictor.py)
  RiskPredictor.predict()
    IF trained models exist → ML prediction
    ELSE → heuristic fallback (always active; no trained models in repo)
  Output: {prob_stop_hit, prob_target_hit, expected_drawdown_pct,
           suggested_position_size_pct, risk_score}
         │
         ▼
PORTFOLIO (models/portfolio_optimizer.py)
  PortfolioOptimizer
    hrp_allocation()     ← Riskfolio-Lib HCPortfolio (Pearson codependence)
    cvar_allocation()    ← CVaR MVO at alpha=0.05
    optimize() (legacy) ← Heuristic scoring-based allocation
    ❌ No transaction cost penalty
    ❌ No lot-size rounding
    ❌ No liquidity constraints
         │
         ▼
SIGNAL GENERATION (server.py FastAPI endpoints)
  /predict/regime       → MarketRegimeClassifier.predict()  [heuristic mode]
  /predict/rank         → StockRanker.rank()               [heuristic mode]
  /predict/strategy     → StrategySelector.select()         [heuristic mode]
  /predict/risk         → RiskPredictor.predict()           [heuristic mode]
  /predict/execute      → RLExecutor.decide()               [heuristic mode]
  /predict/portfolio-v2 → PortfolioOptimizer.*_allocation() [functional]
  /decide               → MetaDecisionEngine.decide()       [heuristic mode]
         │
         ▼
MONITORING (monitoring/)
  DriftDetector         ✅ PSI+KS+JS; stateful; thread-safe
  ModelRegistry         ✅ State machine; persistence
  PerformanceMonitor    ✅ Rolling metrics
  AlertSystem           ✅ Alert emission
  ❌ No trade outcome feedback loop (no TradeOutcome data collection)
  ❌ Registry weights not connected to EnsembleWeighter
```

---

## Component-by-Component Analysis

### DATA → PREPROCESSING

| Attribute | Status |
|---|---|
| Actual implementation | `AlphaForgeAPIClient._normalize_ohlcv_frame()` normalises field names, enforces UTC, adds `_quality` and `_source` columns |
| Expected implementation | PIT-aware data with publication delay flags |
| Missing component | PIT database; corporate action adjustment verification |
| Leakage risk | LOW for OHLCV. MEDIUM for fundamental data (none currently used) |
| API contract | `pd.DataFrame` with columns [open, high, low, close, volume, _quality, _source] |
| Test coverage | `test_data_pipeline.py::TestDataNormalization` — 7 tests; FAILING (missing talib transitive import) |

### PREPROCESSING → FEATURE ENGINEERING

| Attribute | Status |
|---|---|
| Actual implementation | `compute_stock_features()` called per-stock per rolling window |
| Expected implementation | Same function for training and inference (feature parity) |
| Missing component | Explicit test that training and inference produce identical outputs |
| Leakage risk | **HIGH** — `center=True` in BOS/CHOCH; cumsum VWAP |
| Coupling | All models share canonical feature lists defined in `engineer.py` |
| Test coverage | 0 tests for `engineer.py` directly; tested indirectly via data_pipeline tests |

### FEATURE ENGINEERING → LABEL GENERATION

| Attribute | Status |
|---|---|
| Actual implementation | Forward windows computed in `data_pipeline.py`; point-in-time barriers enforced |
| Expected implementation | Triple-barrier labels; cost-adjusted returns |
| Missing component | Transaction costs; sequential barrier resolution; sample weights |
| Leakage risk | **LOW** — labels correctly use future data; features correctly use only past data |
| Coupling | Labels and features share the same OHLCV DataFrame; temporal barrier maintained |

### LABEL GENERATION → DATASET

| Attribute | Status |
|---|---|
| Actual implementation | Saves `.npz` with version metadata sidecar |
| Expected implementation | Version chain: pipeline_version → feature_version → dataset_version → model_version |
| Missing component | Auto-injection of dataset hash into ModelRecord at training time |
| Leakage risk | None — dataset is a snapshot at a point in time |

### DATASET → TRAINING

| Attribute | Status |
|---|---|
| Actual implementation | `train_all.py` with `train_test_split` for regime/strategy; 80/20 time-based for ranker/risk |
| Expected implementation | `WalkForwardValidator` for all models with `PurgedKFold` for HPO |
| Missing component | Temporal splits; embargo; purging; `ModelAcceptanceGate` |
| **Leakage risk** | **CRITICAL** — random splits for regime and strategy models |
| Test coverage | No tests for `train_all.py` |

### TRAINING → VALIDATION

**THIS TRANSITION DOES NOT EXIST.** Training and validation are entirely disconnected. The `validation/` framework is never called by `train_all.py`.

### MODEL → CALIBRATION

| Attribute | Status |
|---|---|
| Actual implementation | `CalibrationStore` with Platt and Isotonic calibrators |
| Expected implementation | OOS-calibrated quality metrics |
| Missing component | Separate eval set for quality measurement; `fit_meta_layer()` called from training |
| Leakage risk | In-sample quality metrics — inflated calibration scores |

### CALIBRATION → META MODEL

| Attribute | Status |
|---|---|
| Actual implementation | `EnsembleWeighter` with regime-aware base weights; calibration quality multiplier |
| Expected implementation | Registry state weights × calibration quality × base weights |
| Missing component | ModelRegistry integration into `_get_weighter()` |

### META MODEL → MONITORING

| Attribute | Status |
|---|---|
| Actual implementation | `DriftDetector`, `ModelRegistry`, `PerformanceMonitor` all implemented correctly |
| Missing | Feedback loop: trade outcomes never recorded; monitoring has no data |
| Test coverage | `test_monitoring.py` — FAILING (scipy missing) |

---

## Critical Architecture Gaps Summary

| Gap | Severity | Location |
|---|---|---|
| Training-validation pipeline disconnected | 🔴 CRITICAL | `train_all.py` |
| Temporal leakage in regime/strategy training | 🔴 CRITICAL | `train_all.py` lines 50, 130 |
| Look-ahead in BOS/CHOCH features (center=True) | 🔴 CRITICAL | `market_structure.py` lines 136-137 |
| No evidence gate (ModelAcceptanceGate) | 🔴 HIGH | `train_all.py` |
| No transaction costs anywhere | 🔴 HIGH | `data_pipeline.py` |
| No corporate action handling | 🔴 HIGH | `market_data_client.py` |
| No F&O ban list | 🔴 HIGH | Missing |
| No NSE expiry calendar | 🟡 MEDIUM | `macro.py` |
| ModelRegistry disconnected from ensemble | 🟡 MEDIUM | `meta_model.py` |
| Trade outcome feedback loop missing | 🟡 MEDIUM | `performance_monitor.py` |
