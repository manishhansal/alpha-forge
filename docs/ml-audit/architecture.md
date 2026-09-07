# AlphaForge ML Service — Architecture Audit

**Audit Date:** 2026-09-06  
**Scope:** `ml-service/src/` — complete structural and dependency analysis

---

## 1. System Context

The ml-service is a standalone Python/FastAPI microservice that sits behind the AlphaForge Next.js frontend. The frontend calls it via HTTP from server-side API routes (`/api/in/*`). The ml-service never writes to the database directly; it reads market data from an upstream AlphaForge API layer (Angel One → Upstox → PostgreSQL → yfinance fallback) and returns prediction responses.

```
Browser / Dashboard
       │
       ▼
Next.js App (src/app/api/in/*)
       │  HTTP
       ▼
ml-service (FastAPI :8100)
       │
       ├── AlphaForge API (Angel One / Upstox)
       ├── PostgreSQL (option_chain_snapshots, price_history)
       └── yfinance (last-resort fallback)
```

---

## 2. Module Map

```
ml-service/src/
├── config.py                  — Settings from env vars (frozen dataclass)
├── schemas.py                 — Pydantic v2 request/response models
├── server.py                  — FastAPI application entry point + routes
├── gex.py                     — Gamma Exposure calculator
├── greeks.py                  — Black-Scholes / Black-76 greeks
├── iv_regime_classifier.py    — IV regime classification (CRUSH/STABLE/SPIKE)
├── price_forecaster.py        — Price forecasting (heuristic; deep-learning pending)
├── vol_surface.py             — Volatility surface interpolation
│
├── features/
│   ├── engineer.py            — Feature orchestrator (150+ features)
│   ├── technical.py           — RSI, MACD, ADX, ATR, BB, EMA stack, candles, HT_TRENDLINE
│   ├── volume.py              — RelVol, VWAP, OBV, CMF, Force, VPIN
│   ├── momentum.py            — Returns, ROC, trend strength, breakout, RS vs index
│   ├── derivatives.py         — PCR, OI buildup, IV rank, max pain, OI walls
│   ├── market_structure.py    — FVG, Order Blocks, BOS/CHOCH, liquidity sweeps
│   └── macro.py               — VIX, breadth, sector rotation, time/expiry features
│
├── models/
│   ├── market_regime.py       — XGBoost 6-class regime classifier
│   ├── stock_ranker.py        — LightGBM regression / lambdarank
│   ├── strategy_selector.py   — CatBoost multiclass (8 strategies)
│   ├── risk_predictor.py      — XGBoost × 3 (stop-hit, target-hit, drawdown)
│   ├── portfolio_optimizer.py — Riskfolio-Lib HRP + CVaR
│   └── rl_executor.py         — PPO via Stable-Baselines3 (execution timing)
│
├── meta/
│   ├── ensemble.py            — Regime-aware weighted ensemble
│   ├── calibration.py         — Platt scaling + isotonic regression
│   ├── abstention.py          — WAIT / NO_TRADE gate (7 conditions)
│   ├── decision_policy.py     — Confidence decomposition + reason codes
│   └── meta_model.py          — MetaDecisionEngine orchestrator
│
├── validation/
│   ├── walk_forward.py        — WalkForwardValidator (rolling + expanding)
│   ├── purged_kfold.py        — PurgedKFold (sklearn-compatible, embargo)
│   ├── embargo.py             — EmbargoApplier (bars / minutes / days)
│   ├── combinatorial_cv.py    — CPCV (C(N,k) combinatorial purged CV)
│   └── metrics.py             — FinancialMetricsEvaluator + ModelAcceptanceGate
│
├── training/
│   ├── data_pipeline.py       — Dataset builders, label generators, leakage guard
│   ├── market_data_client.py  — AlphaForgeAPIClient + fallbacks
│   └── train_all.py           — Model training orchestrator (BUGS: random splits)
│
├── monitoring/
│   ├── drift_detector.py      — PSI + KS + JS drift detection
│   ├── feature_monitor.py     — Per-feature drift tracking
│   ├── model_registry.py      — HEALTHY/WARNING/DEGRADED/DISABLED state machine
│   ├── performance_monitor.py — Rolling Sharpe / Brier / win rate
│   ├── alerts.py              — Alert emission (INFO/WARNING/CRITICAL)
│   └── router.py              — FastAPI monitoring routes
│
└── explainability/
    └── shap_explainer.py      — SHAP value computation per model
```

---

## 3. ML Lifecycle Flow

```
Raw Market Data (Angel One / Upstox / PostgreSQL / yfinance)
        │
        ▼
market_data_client.py
  AlphaForgeAPIClient._normalize_ohlcv_frame()
  DerivativesSnapshot (PCR, OI, IV, max pain)
        │
        ▼
data_pipeline.py  ←─────── enrich_with_derivatives()
  build_regime_training_data()     (lookback window per bar, no future leak)
  build_ranking_training_data()    (forward label = relative excess return)
  build_risk_training_data()       (stop/target/MAE from future OHLC)
  build_strategy_training_data()   (best strategy label per bar)
        │
        ▼
train_all.py  ← ⚠️ random split for regime/strategy (BUG C1)
  train_regime_model()     XGBoost 6-class
  train_ranking_model()    LightGBM regression
  train_strategy_model()   CatBoost multiclass
  train_risk_model()       XGBoost × 3
  train_rl_executor()      PPO
        │
        ▼
artifacts/  (model files saved as JSON / .txt / .cbm)
        │
        ▼
server.py  — loads models at startup
  /predict/regime          MarketRegimeClassifier.predict()
  /predict/rank            StockRanker.rank()
  /predict/strategy        StrategySelector.select()
  /predict/risk            RiskPredictor.predict()
  /predict/execute         RLExecutor.decide()
  /predict/portfolio-v2    PortfolioOptimizer.hrp_allocation()
  /decide                  MetaDecisionEngine.decide()    ← all models combined
        │
        ▼
MetaDecisionEngine.decide()
  1. CalibrationStore.calibrate()  — Platt / isotonic per model
  2. EnsembleWeighter.compute()    — regime-aware weights + disagreement penalty
  3. AbstentionPolicy.evaluate()   — 7-gate WAIT / NO_TRADE check
  4. DecisionPolicy.build_decision() — confidence decomposition + reason codes
        │
        ▼
MetaOutput { action, confidence, uncertainty, agreement,
             reason_codes, decomposition, abstention, explainability }
```

---

## 4. Data Flow — Training vs Inference

| Phase | Data source | Feature computation | Labels |
|---|---|---|---|
| Training | `data_pipeline.py` | `compute_stock_features()` on rolling lookback window ending at bar i | Forward window [i+1 … i+horizon] |
| Inference | `server.py` real-time | `compute_stock_features()` on most recent N bars from API | N/A — prediction only |
| Validation | `walk_forward.py` / `purged_kfold.py` | Same as training but structurally enforced OOS | Same labels |

Key invariant: feature window **always ends at the current bar**. Labels **always start at the next bar**. This is correctly implemented in `data_pipeline.py` but violated in `train_all.py` (random split).

---

## 5. Dependency Graph (Critical Path)

```
features/engineer.py
  └─ depends on: technical, volume, momentum, derivatives, market_structure, macro
        │
        ▼ RANKING_FEATURES, REGIME_FEATURES, STRATEGY_FEATURES, RISK_FEATURES
        │
models/*.py
  └─ depend on: features/engineer.py (canonical feature lists)
        │
meta/meta_model.py
  └─ depends on: all models + calibration + ensemble + abstention + decision_policy
        │
monitoring/*.py
  └─ depends on: meta_model (MetaOutput), model_registry (ModelRecord)
```

---

## 6. Architectural Strengths

- **Clean separation** between feature engineering, model training, inference, meta-layer, and monitoring. Each layer has a well-defined interface.
- **Heuristic fallbacks** for every model: the system is always operational even before training. This is appropriate for a research platform.
- **Canonical feature lists** (`RANKING_FEATURES`, `REGIME_FEATURES`, etc.) defined in one place (`features/engineer.py`) and imported by every model. Feature versioning is present via `FEATURE_VERSION` constant.
- **Graceful degradation**: `MetaInput` optional fields allow the engine to operate with a subset of models, with `data_quality` score computed automatically.
- **Thread-safe monitoring**: DriftDetector and ModelRegistry use `threading.Lock`.

---

## 7. Architectural Weaknesses

### 7.1 Training / Validation Disconnect
The validation framework (`WalkForwardValidator`, `PurgedKFold`) is implemented correctly and tested thoroughly, but `train_all.py` does not use it. The training script bypasses the framework entirely and uses `sklearn.train_test_split` for two of five models.

### 7.2 No Model Versioning Provenance Chain
The `ModelRecord` schema (`model_version`, `dataset_version`, `feature_version`) is defined but populated with hardcoded placeholder strings (`"ds-baseline-v1"`, `"feat-v1"`) in `build_default_registry()`. There is no mechanism to automatically tag a trained artifact with the actual dataset hash, feature version, and training period.

### 7.3 No Artifact Integrity Check
Models are loaded from disk with a try/except that silently falls back to heuristic on any load failure (including corrupt or mismatched artifacts). There is no checksum, model hash, or schema version check at load time.

### 7.4 Shared Canonical Feature Lists Create Tight Coupling
If a feature is added to `RANKING_FEATURES` without retraining the LightGBM model, the model silently fills the new feature with 0.0 (`feat.get(f, 0.0)`). This is handled gracefully at inference time but creates silent mismatches that are hard to detect.

### 7.5 No Separation Between Research, Paper, Shadow, and Live Execution
The codebase does not enforce the research → paper → shadow → live promotion boundary. All predictions share the same code path. There is no schema-level or configuration-level gate preventing a model in the DEGRADED state from affecting a live trade.

### 7.6 ModelAcceptanceGate Not Wired
`validation/metrics.py` implements a `ModelAcceptanceGate` that enforces dual-pass (accuracy + trading performance) acceptance criteria. It is never called by `train_all.py`.

---

## 8. Component Status Summary

| Component | Exists | Tested | Production-Ready | Notes |
|---|---|---|---|---|
| Feature engineering | ✅ | ✅ | ⚠️ Partial | BOS/CHOCH look-ahead, VWAP error |
| Data pipeline | ✅ | ✅ | ✅ | Well-implemented; leakage guard weak |
| Walk-forward CV | ✅ | ✅ | ✅ | Excellent implementation |
| PurgedKFold | ✅ | ✅ | ✅ | sklearn-compatible, correct |
| Regime classifier | ✅ | ✅ | ❌ | Random split in train_all.py |
| Stock ranker | ✅ | ⚠️ | ❌ | No trained artifact checked in |
| Strategy selector | ✅ | ⚠️ | ❌ | Random split in train_all.py |
| Risk predictor | ✅ | ⚠️ | ❌ | No transaction costs in labels |
| Portfolio optimizer | ✅ | ✅ | ⚠️ | Riskfolio-Lib integration functional |
| RL executor | ✅ | ❌ | ❌ | Untested; env not validated |
| Meta decision engine | ✅ | ✅ | ⚠️ | Calibration quality in-sample |
| Drift detector | ✅ | ✅ | ✅ | Production-grade |
| Model registry | ✅ | ✅ | ✅ | State machine is sound |
| Performance monitor | ✅ | ⚠️ | ✅ | Minimal direct test coverage |
| SHAP explainability | ✅ | ⚠️ | ⚠️ | On-demand only |
| ModelAcceptanceGate | ✅ | ✅ | ❌ | Not wired to train_all.py |
