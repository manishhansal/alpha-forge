# AlphaForge ML Service — Forensic Audit: Executive Summary

**Audit Date:** 2026-09-06  
**Auditor:** Kiro AI (automated forensic inspection)  
**Scope:** Complete ml-service codebase — all source files, tests, configs, documentation  
**Status:** READ-ONLY AUDIT — no code was modified

---

## 1. System Under Audit

AlphaForge ml-service is a Python/FastAPI microservice that provides AI-driven trading signals for the Indian NSE F&O market. It implements a 7-model ensemble meta-decision engine covering:

- Market regime classification (XGBoost)
- Stock ranking / outperformance prediction (LightGBM)
- Strategy selection (CatBoost)
- Risk prediction — stop-hit, target-hit, drawdown (XGBoost × 3)
- Price forecasting (heuristic, deep learning planned)
- IV regime classification (rule-based)
- RL execution agent (PPO via Stable-Baselines3)

All models feed a MetaDecisionEngine that produces BUY / SELL / WAIT / NO_TRADE decisions with calibrated confidence, 5-component decomposition, and SHAP-style explainability.

---

## 2. Overall Assessment

**RESEARCH-GRADE ARCHITECTURE, PRE-PRODUCTION CODE.**

The design intent is sound and reflects awareness of the key pitfalls in financial ML. The validation framework (walk-forward, PurgedKFold, embargo) is well-engineered. The abstention/NO_TRADE logic is present and meaningful. The monitoring stack (drift detection, model registry, performance tracking) is above average for this class of project.

However, **several critical bugs** undermine the validity of any trained model artifact and expose the system to look-ahead bias and overstated out-of-sample performance. Until these are fixed, no trained model should be treated as evidence of genuine predictive power.

**Verdict: EXPERIMENTAL / RESEARCH_ONLY — not production-ready.**

---

## 3. Critical Findings (Severity: BLOCKING)

These issues invalidate current trained models and must be fixed before any model is used for live trading or cited as evidence of alpha.

| # | Location | Issue | Impact |
|---|---|---|---|
| C1 | `training/train_all.py` | `train_regime_model()` and `train_strategy_model()` use `sklearn.train_test_split` with random shuffling — **temporal leakage** for time-series data | All regime and strategy model artifacts are contaminated; OOS metrics are inflated |
| C2 | `features/market_structure.py` | `detect_bos_choch()` uses `rolling(center=True)` — **look-ahead bias**: swing detection uses future bars | All features derived from BOS/CHOCH are forward-contaminated |
| C3 | `features/volume.py` | `compute_vwap_distance_pct()` uses `cumsum()` over the entire series passed in — for daily data the VWAP incorporates all prior days, making it a cross-session cumulative price rather than an intraday VWAP | VWAP feature is semantically wrong for daily bars |
| C4 | `meta/calibration.py` | `CalibrationStore.fit()` computes ECE/MCE/Brier on the **same data used for fitting** — the quality score used to weight calibrators in the ensemble is in-sample and systematically over-optimistic | Ensemble weighting is based on misleading quality scores |
| C5 | `training/train_all.py` | `train_regime_model()` and `train_strategy_model()` do not use `WalkForwardValidator` or `PurgedKFold` despite those classes existing and being tested | The validation infrastructure is unused in actual training |
| C6 | `training/data_pipeline.py` | `assert_no_future_leakage()` only checks Pearson correlation > 0.95 — this misses indirect leakage, partial leakage, monotone transformations, and lagged interactions | Leakage guard provides false confidence |

---

## 4. High-Severity Findings (Severity: HIGH)

| # | Location | Issue |
|---|---|---|
| H1 | `training/data_pipeline.py` | `TRAINING_UNIVERSE` is a static hardcoded list of current F&O stocks — **survivorship bias**: delisted or removed stocks are absent from training history |
| H2 | All label generation | No transaction cost model anywhere: labels are gross P&L, not net. NSE F&O costs (0.03–0.05% per leg, STT, SEBI, stamp duty) are not deducted from ranking or risk labels |
| H3 | `meta/ensemble.py` | Regime-specific ensemble weights are **hand-coded constants**, not learned from OOS data. There is no evidence these weights are optimal or even monotone with respect to regime performance |
| H4 | `features/derivatives.py` | `compute_iv_rank()` fallback uses hardcoded `[15,18,20,22,25]` when `iv_history` is absent — a 5-point fake history that produces a meaningless IV rank percentile |
| H5 | `meta/decision_policy.py` | `_strategy_to_direction()` maps `mean_reversion` → `-1` (bearish). Mean-reversion is directionally agnostic by design; this mis-mapping biases the ensemble against mean-reversion signals |
| H6 | `models/market_regime.py` | `generate_regime_labels()` uses `fwd_return.shift(-lookforward)` and `fwd_max_dd` — forward window labels computed from `close.shift(-lookforward)`. When these labels are joined to a feature DataFrame built from the same NIFTY series, there is no structural barrier preventing accidental label leakage if the feature pipeline is modified |
| H7 | No component | No point-in-time universe membership records: the F&O universe changes quarterly (SEBI stock inclusion/exclusion). Historical backtesting with today's universe creates selection bias |
| H8 | `training/train_all.py` | HPO (`_hpo_xgboost`) optimises on a validation set but uses the same val set for early stopping — **hyperparameter leakage** into the validation set |

---

## 5. Medium-Severity Findings (Severity: MEDIUM)

| # | Location | Issue |
|---|---|---|
| M1 | `features/engineer.py` | `RANKING_FEATURES` list (65+ features) is much wider than `STRATEGY_FEATURES` (17) and `RISK_FEATURES` (18), but all features are computed every call — no lazy evaluation or feature-version tagging per model |
| M2 | `models/*.py` | Every model has a heuristic fallback that is always active before any trained model exists. Heuristic logic is hand-tuned, not OOS-validated, and will produce signals with no evidence of profitability |
| M3 | `meta/abstention.py` | All AbstentionThresholds are hardcoded constants with no calibration procedure. Thresholds are stated as "calibrated on NSE F&O typical conditions" but no calibration data or methodology is documented |
| M4 | `validation/metrics.py` | `ModelAcceptanceGate` exists but is never called by `train_all.py` — trained models are never subjected to the dual-pass (accuracy + trading performance) gate before saving |
| M5 | `pyproject.toml` | Lists `pypfopt==1.5.5` but `requirements.txt` lists `pyportfolioopt==1.5.5` — different package names (former is the PyPI alias). Docker build may fail silently |
| M6 | No component | No corporate action adjustment: splits, bonuses, rights issues affect historical OHLCV and OI continuity. No evidence of adjustment in the data client |
| M7 | `models/portfolio_optimizer.py` | HRP and CVaR allocations use `DAILY_RF = 0.071/252` (10-yr G-Sec) but the comment says "7.1% p.a." — current RBI repo is ~6.5%; the Sharpe numerator is slightly penalised |
| M8 | `features/momentum.py` | `compute_sector_momentum()` returns a Series of constant value (the mean sector return repeated) — it always outputs a scalar, not a per-stock rolling metric |

---

## 6. Low-Severity / Design Observations (Severity: LOW)

- The walk-forward validator and PurgedKFold implementations are well-written and sklearn-compatible. They should be adopted in `train_all.py`.
- The drift detector (PSI + KS + JS) is production-grade. The model registry state machine is sound.
- SHAP explainability is wired up but the `shap_explainer.py` module is only used on demand via `/explain` endpoint — not in the training or validation pipeline.
- RL executor is properly separated from signal generation. The reward function includes over-trading penalties, which is appropriate.
- The meta-layer abstention logic (7 independent gates, WAIT vs NO_TRADE distinction) is a genuine strength and differentiates this from naive ensemble approaches.
- Deep-learning forecasters (darts/tsai) are referenced in comments but commented out of requirements — the `price_forecaster.py` is running in heuristic mode.
- Test coverage is above average but has a blind spot: `train_all.py` is not covered by any test, meaning the random-split bug (C1) is undetected by CI.

---

## 7. What is Genuinely Good

1. **Validation framework** — `WalkForwardValidator`, `PurgedKFold`, `EmbargoApplier`, `CPCVSplitter` are research-grade and exceed most open-source financial ML toolkits.
2. **Abstention system** — the WAIT / NO_TRADE distinction is principled and traceable.
3. **Monitoring stack** — DriftDetector (PSI + KS + JS), ModelRegistry (state machine), PerformanceMonitor (rolling Sharpe / Brier) are production-grade.
4. **F&O-specific features** — OI buildup quadrants, PCR scoring, IV rank, max-pain distance, OI wall proximity, VPIN — these are India-specific and non-trivial.
5. **Label generation in data_pipeline.py** — correctly uses forward windows with explicit temporal leakage guard and point-in-time barriers.
6. **Test suite** — 15 test files, strong coverage of validation, meta-engine, and data pipeline components.

---

## 8. Overall Risk Rating

| Dimension | Rating | Notes |
|---|---|---|
| Temporal leakage risk | 🔴 HIGH | C1 (random splits), C2 (center=True), C3 (VWAP cumsum) |
| Survivorship bias risk | 🔴 HIGH | Static universe, no delisting records |
| Overfitting risk | 🟡 MEDIUM | HPO leaks into val set; ensemble weights hand-tuned |
| Production readiness | 🔴 NOT READY | No live-trade tested models, heuristics always active |
| Monitoring readiness | 🟢 GOOD | DriftDetector + ModelRegistry + PerformanceMonitor present |
| Code quality | 🟢 GOOD | Well-structured, documented, type-annotated |
| Test coverage | 🟡 MEDIUM | Strong unit tests; train_all.py uncovered |

---

## 9. Immediate Recommended Actions (Priority Order)

1. **Fix C1 immediately**: Replace `train_test_split` in `train_all.py` with `WalkForwardValidator` for regime and strategy models.
2. **Fix C2 immediately**: Change `center=True` → `center=False` in `detect_bos_choch()` swing detection rolling windows.
3. **Fix C3**: Refactor `compute_vwap_distance_pct()` to reset per trading session for daily data.
4. **Fix C4**: Measure calibration quality on a held-out OOS fold, not the fitting data.
5. **Wire up ModelAcceptanceGate** in `train_all.py` — no model should be saved without passing the dual gate.
6. **Build a point-in-time universe registry** before claiming any historical backtest result.
7. **Add transaction costs** to ranking and risk label generation.
8. **Extend test coverage** to `train_all.py` — specifically the temporal split behaviour.

---

*Full findings for each dimension are detailed in the accompanying audit documents.*
