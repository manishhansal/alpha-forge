# AlphaForge ML — Framework Benchmark

**Date:** 2026-09-06  
**Scope:** Comparative analysis of AlphaForge ml-service against 7 leading quantitative ML frameworks.  
**Purpose:** Identify missing capabilities, unnecessary complexity, architectural weaknesses, and best practices worth adopting.

> Content was synthesised from official documentation, research papers, and GitHub repositories for each framework. All findings are paraphrased for compliance with licensing restrictions.

---

## 1. Framework Overview Matrix

| Dimension | AlphaForge | Qlib (Microsoft) | LEAN (QuantConnect) | NautilusTrader | MlFinLab | FreqAI | VectorBT |
|---|---|---|---|---|---|---|---|
| **Primary purpose** | India F&O ML signals | Full quant research platform | Algorithmic trading engine | Production trading engine | Financial ML primitives | Adaptive ML for live trading | Vectorized backtesting |
| **Language** | Python | Python | C# / Python | Rust / Python | Python | Python | Python (Numba/Rust) |
| **ML pipeline** | Custom (FastAPI) | End-to-end | Precomputed predictions | External | Primitives only | Sliding-window retrain | Not ML-native |
| **Feature store** | Ad-hoc dict | Expression engine + PIT DB | Universe data handlers | External | Manual | Feature pipeline | Indicator arrays |
| **Validation** | WalkForward + PurgedKFold ✅ (unused in training) | Walk-forward + recorder | Walk-forward in research | BacktestEngine | Purged CV + CPCV | Sliding window refit | Vectorized parameter sweep |
| **Experiment tracking** | Custom ModelRegistry | Recorder (MLflow-like) | Algorithm logs | External | None | File-based artifacts | None |
| **Execution** | RL PPO | QlibRL | 5-module framework | Deterministic event-driven | None | Freqtrade live integration | None |
| **Portfolio construction** | Riskfolio-Lib HRP/CVaR | Optimizer module | 5 built-in PC models | Portfolio component | None | Simple sizing | PortfolioStats |
| **Research/live parity** | ❌ separate | Partial | Framework-level | ✅ Architectural guarantee | N/A | Partial | N/A (research only) |
| **India F&O specifics** | ✅ Native | ❌ China-focused defaults | ❌ None | ❌ None | ❌ None | ❌ None | ❌ None |
| **Point-in-time data** | Partial (ffill guard) | ✅ PIT database | Partial | ✅ Event timestamps | Manual | Not enforced | Not enforced |
| **Transaction costs** | ❌ Not in labels | Partial (slippage models) | ✅ Commission/slippage | ✅ Full model | Not in scope | Partial | ✅ Fees/slippage |
| **Production readiness** | ❌ EXPERIMENTAL | ✅ Research-grade | ✅ Production-grade | ✅ Production-grade | Library only | ✅ Live trading | ❌ Research only |

---

## 2. Deep Comparison — Dimension by Dimension

### 2.1 Data Architecture

**Qlib** introduces a Point-In-Time (PIT) database — every fundamental datapoint is stored with its announcement date, not its reference date. This prevents the leakage where, for example, a company's quarterly earnings announced in May are used in a model trained on April data. Qlib's expression engine allows formulaic feature construction (`Ref($close, 60) / $close`) with automatic PIT enforcement.

**AlphaForge gap:** The data client correctly normalises OHLCV and has a `ffill(limit=5)` guard on derivatives data. But there is no PIT database. Fundamental data (delivery %, OI, PCR) is stored with the event date rather than the announcement/publication date. For quarterly fundamental factors (earnings growth, P/E), this creates potential leakage. For daily OI/IV data, the gap is small but not zero (T+1 publication delays are common).

**LEAN** uses event-driven data subscriptions — data is only available to the algorithm when its timestamp is reached. This is architecturally look-ahead-proof because the engine enforces wall-clock ordering.

**NautilusTrader** is the strictest: nanosecond-resolution event timestamps ensure no future data can enter an actor's state. The deterministic time model is an architectural guarantee rather than a convention.

**Recommendation for AlphaForge:** Adopt a PIT-aware data layer for any fundamental or derived data with publication delays. At minimum, document and enforce the T+1 publication assumption for all OI/IV/breadth data.

---

### 2.2 Feature Engineering

**Qlib** separates feature expression (formulaic, auto-cached, PIT-enforced) from data processing (normalization, standardization via configurable Processors). This allows features to be shared across models with guaranteed consistency between training and inference.

**FreqAI** uses a dedicated feature engineering hook (`feature_engineering_expand_all`) that attaches computed indicators to the Freqtrade DataFrame. The same function runs identically in backtest and live — eliminating feature-parity bugs.

**AlphaForge gap:** Feature computation in `engineer.py` is called independently in training (`data_pipeline.py`) and inference (`server.py`). There is no framework-level guarantee that the two calls produce identical results for the same inputs. If a feature computation depends on the global state of the input series (e.g., VWAP cumsum), training and inference will produce different values. This is a subtle but consequential bug.

**Missing capability:** A feature-serving layer that:
1. Registers features by name and version
2. Guarantees identical computation in training and inference
3. Provides feature lineage (which data version produced which feature values)

---

### 2.3 Validation Architecture

**MlFinLab** provides the most complete implementation of financial ML validation primitives:
- Purged K-Fold with t0/t1 label times
- Combinatorial Purged CV (CPCV) with C(N,k) paths
- Sample weights for overlapping labels (uniqueness-based)
- Structural break tests (CUSUM, SADF, GSADF)
- Deflated Sharpe Ratio (false strategy discovery rate)

**AlphaForge** ships a well-implemented `WalkForwardValidator`, `PurgedKFold`, and `EmbargoApplier`. This matches MlFinLab's core CV primitives. The critical difference: MlFinLab primitives are used in every training run by design — they are the library. AlphaForge's primitives exist but are bypassed in `train_all.py`.

**Qlib Recorder** automatically captures every experiment run: parameters, metrics, model artifacts, fold manifests. AlphaForge has `save_fold_manifest()` but it is never called from training. Qlib's recorder is called automatically.

**VectorBT** enables parameter sweeps over thousands of strategy configurations in seconds via vectorization. This is valuable for signal research (testing many lookback periods simultaneously) but is a different paradigm from ML training.

**Recommendation for AlphaForge:** Adopt Qlib's convention of automatic experiment recording. Every training run should produce an immutable record containing: dataset version, feature version, fold manifest, validation metrics, model artifact hash.

---

### 2.4 Model Training

**Qlib** supports supervised learning (LightGBM, XGBoost, MLP, Transformer), market dynamics models (MDM), and reinforcement learning (QlibRL) within a unified training framework. Each model type has a standard interface (`Model.fit()`, `Model.predict()`).

**FreqAI** trains models in a sliding window: the training window advances by `refit_period_days` in live deployment, keeping models current. AlphaForge has no equivalent mechanism — models are trained once and deployed statically. In a regime-shifting market (e.g., post-COVID volatility shift, post-SEBI derivatives regulation change in 2024), a static model will decay.

**AlphaForge gap:** No scheduled model retraining triggered by drift detection. The monitoring stack detects drift (PSI/KS/JS) but does not trigger retraining. The loop from "drift detected" → "retrain scheduled" → "new model validated" → "registry updated" is entirely manual.

**LEAN** takes a different approach: ML predictions are precomputed offline and streamed into the backtester as custom universe data. This decouples the ML training cadence from the execution engine, which is architecturally clean but requires an external retraining pipeline.

---

### 2.5 Portfolio Construction

**Qlib** has an Optimizer module supporting MVO, CVaR, HRP with configurable constraints (max weight, sector cap, turnover limit). It integrates directly with the alpha signal output.

**skfolio** (not currently used by AlphaForge) is sklearn-compatible and supports:
- HRP, CVaR, MVO, Max Diversification
- Online walk-forward portfolio CV (tuning portfolio hyperparameters on OOS data)
- Factor risk models (Fama-French style)
- Risk parity with multiple risk measures

**AlphaForge** uses Riskfolio-Lib, which is functional but:
- Not sklearn-compatible (cannot be cross-validated with standard CV tools)
- Does not support online walk-forward tuning of portfolio parameters
- Missing transaction cost penalisation in the objective

**LEAN** has 5 built-in portfolio construction models: Equal Weighting, Mean-Variance Optimization, Insight Weighting, Black-Litterman, and Null (custom). These are called within the 5-module algorithm framework.

**Recommendation for AlphaForge:** Evaluate replacing Riskfolio-Lib with skfolio for better sklearn integration and online portfolio CV. At minimum, add a turnover penalty to the HRP/CVaR objective.

---

### 2.6 Execution and Research-to-Live Parity

**NautilusTrader** is the gold standard for research-to-live parity: the same Rust execution kernel processes historical data in backtesting and live market data in production. Strategies are written once and deployed without code changes. This eliminates an entire class of bugs where backtest assumptions differ from live execution.

**AlphaForge gap:** There is no documented research → paper → shadow → live promotion path. The ML service produces BUY/SELL/WAIT/NO_TRADE decisions, but:
1. How are these decisions translated into actual F&O orders (lot sizes, expiry selection)?
2. How is slippage estimated and modelled?
3. How is the live execution layer validated against backtest assumptions?

**FreqAI** uses Freqtrade's live trading integration — the same strategy code backtests and trades live. AlphaForge has no equivalent live execution integration documented.

**LEAN** enforces execution through an Execution model that translates PortfolioTarget → actual orders, with commission/slippage models applied consistently in backtest and live.

---

### 2.7 Experiment Tracking and Reproducibility

**Qlib Recorder** is tightly integrated: every `qrun` captures the full experiment in a structured directory. Metrics, parameters, model artifacts, and predictions are automatically stored.

**MLflow** (external tool) provides: run tracking with parameters/metrics, model registry with staging (Staging → Production → Archived), artifact storage, and model serving. It is the industry standard for ML experiment management.

**AlphaForge** has a custom `ModelRegistry` with version fields (`dataset_version`, `feature_version`) but they are populated with hardcoded placeholder strings. There is no automatic capture of hyperparameters, training metrics, or dataset fingerprints per run.

**Missing capability:** AlphaForge needs either native MLflow integration or an equivalent automatic recorder that captures: (1) every training run's hyperparameters, (2) OOS metrics from walk-forward folds, (3) artifact checksums, (4) dataset version + universe fingerprint. This would make every trained model fully reproducible.

---

## 3. Missing Capabilities in AlphaForge

| Capability | Best-of-class | AlphaForge Gap | Priority |
|---|---|---|---|
| Point-in-time feature serving | Qlib PIT database | No PIT enforcement | 🔴 HIGH |
| Automatic experiment recording | Qlib Recorder / MLflow | Manual, placeholder versions | 🔴 HIGH |
| Training/inference feature parity | FreqAI feature hook | Independent code paths | 🔴 HIGH |
| Automated model retraining on drift | FreqAI sliding window | Manual only | 🟡 MEDIUM |
| Deflated Sharpe Ratio | MlFinLab DSR | Not implemented | 🟡 MEDIUM |
| Sample weights for overlapping labels | MlFinLab AFML | Not implemented | 🟡 MEDIUM |
| Triple-barrier labeling | MlFinLab AFML | Fixed-horizon only | 🟡 MEDIUM |
| Transaction costs in objectives | LEAN / VectorBT | Not in labels or objectives | 🔴 HIGH |
| Research-to-live parity | NautilusTrader | No shared execution kernel | 🟡 MEDIUM |
| NSE expiry calendar (Tuesday) | — | Hardcoded Thursday (pre-2025) | 🔴 CRITICAL |
| Online portfolio CV | skfolio | Not in Riskfolio-Lib | 🟢 LOW |
| Structural break detection | MlFinLab | Not implemented | 🟢 LOW |

---

## 4. Unnecessary Complexity in AlphaForge

| Component | Over-engineering | Simpler alternative |
|---|---|---|
| `detect_bos_choch()` SMC features | Smart Money Concepts (FVG, OB, BOS) are retail trading heuristics with unproven statistical validity in quantitative backtests | Remove or reclassify as EXPERIMENTAL; measure IC first |
| 7-model ensemble meta-engine | 7 models × regime-aware weights × calibration × abstention adds enormous complexity without OOS evidence | Start with 2-3 models with proven OOS IC; add models only if they improve ensemble OOS IR |
| RL execution agent | PPO for execution requires validated environment + reward function + extensive RL engineering; overkill before any base model is validated | Rule-based execution (VWAP, TWAP, limit vs market) with cost model is simpler and often better |
| CatBoost for strategy selection | CatBoost multiclass for 8 strategy classes on 17 features may underfit badly | Consider reducing to 3-4 strategy classes or using regime-conditional rule table until OOS evidence supports ML |
| Heuristic fallbacks for every model | Well-intentioned but the heuristics are always active because no trained model exists; the system is 100% heuristic in current state | Explicitly label system state as HEURISTIC_MODE; add circuit breaker if no trained model within N days |

---

## 5. Architectural Weaknesses vs Peers

| Weakness | Context |
|---|---|
| **No shared execution kernel** | NautilusTrader guarantees backtest = live by architecture. AlphaForge has no such guarantee — undocumented assumptions between backtest and live will cause performance divergence. |
| **Static universe** | Qlib supports dynamic universe membership with filter_pipe and PIT database. AlphaForge's `TRAINING_UNIVERSE` is static. NSE F&O eligibility changes quarterly. |
| **No formulaic feature algebra** | Qlib's expression engine (`Ref($close, 60) / $close`) makes feature construction auditable and cacheable. AlphaForge features are Python functions — harder to version, cache, and audit. |
| **No separation of signal IC from portfolio IR** | Grinold-Kahn's Fundamental Law requires measuring raw signal IC separately from portfolio IR. AlphaForge conflates them — the MetaDecisionEngine produces trade decisions, not IC scores for each factor. |
| **No regime model for cost regime** | Transaction costs in India change with market regimes (high-impact-cost during low-liquidity regimes, higher STT on specific instruments). No cost regime model exists. |

---

## 6. Best Practices Worth Adopting

### From Qlib
1. **PIT-aware data layer** — enforce publication-date-based data access; never use announcement date as access date
2. **Expression engine** for feature algebra — makes features auditable, versionable, cacheable
3. **Recorder pattern** — automatic experiment capture per training run (data version + feature version + model version + fold manifest + metrics)
4. **Unified online/offline serving** — same feature computation code in training and inference, enforced by framework

### From LEAN
5. **5-module algorithm framework** — Universe Selection → Alpha → Portfolio Construction → Risk Management → Execution; each module is independently testable and replaceable
6. **Portfolio targets** — express portfolio intent as {symbol: target_weight} and let the execution model translate to orders; separates signal from execution

### From NautilusTrader
7. **Research-to-live parity as architecture** — the same event-processing kernel must run in backtest and live; strategy code must be identical
8. **Deterministic time model** — every event has a timestamp; no event can reference data from a later timestamp

### From MlFinLab / AFML
9. **Sample weights based on label uniqueness** — overlapping labels should be down-weighted in proportion to their overlap fraction
10. **Triple-barrier labeling** — replace fixed-horizon labels with event-driven labels that respect stop-loss and profit-taking geometry
11. **Deflated Sharpe Ratio** — penalise Sharpe by the number of strategy configurations tested; prevents false discovery

### From FreqAI
12. **Adaptive retraining loop** — models should retrain on a rolling window as new data arrives; static models decay
13. **Feature parity guarantee** — the same feature function must run in training and live inference; this is a CI/CD constraint, not just a code convention

### From skfolio
14. **Online walk-forward portfolio hyperparameter tuning** — portfolio construction parameters (risk aversion, max weight) should be tuned on OOS data, not held fixed
15. **sklearn pipeline compatibility** — portfolio construction as a sklearn estimator enables systematic CV of the full pipeline from features to weights

### From VectorBT
16. **Parameter sensitivity testing** — before trusting any signal, sweep the lookback parameters across a wide range; if performance degrades rapidly with small parameter changes, the signal is overfit

---

## 7. Summary Recommendation

AlphaForge should be understood as a **framework in between MlFinLab and FreqAI**:
- It has the right ML primitives (like MlFinLab) but they are unused in practice
- It needs the adaptive retraining loop and training/inference parity guarantees of FreqAI
- It needs the experiment tracking and PIT data discipline of Qlib
- It does not need NautilusTrader's Rust execution engine (FastAPI is adequate for India NSE daily/intraday signals at AlphaForge's scale)

The highest-leverage adoptions are:
1. **Qlib Recorder pattern** — automatic, immutable experiment records (1-2 days to implement)
2. **FreqAI feature parity** — single feature function called in both training and serving (1 day)
3. **MlFinLab sample weights** — down-weight overlapping labels before training (1 day)
4. **MlFinLab triple-barrier labels** — replace fixed-horizon with event-driven labels (2-3 days)
5. **NSE Tuesday expiry calendar** — update all hardcoded Thursday references immediately (half day)
