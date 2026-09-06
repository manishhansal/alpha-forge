# Research Verification: Independent Evaluation of Prompt 2 Recommendations

**Verification Date:** 2026-09-06  
**Method:** Each recommendation evaluated against: statistical validity, applicability to financial time series, production suitability, India-market suitability, computational cost, maintainability, data requirements, research reproducibility.  
**Verdict options:** `ADOPT`, `ADOPT_WITH_CAVEATS`, `DEFER`, `DO_NOT_ADOPT`

---

## 1. Framework Recommendations

### 1.1 Qlib Point-In-Time Database Pattern

**Recommendation:** Adopt Qlib's PIT database to prevent leakage from delayed data publication.

**Verification:**
- Statistical validity: HIGH. PIT databases are a genuine best practice for fundamental data (earnings, analyst estimates). For daily OHLCV and derivatives (OI, IV), the publication delay is typically T+0 to T+1.
- Applicability to AlphaForge: For **fundamental** data (delivery %, financial ratios), PIT is essential. For **price/volume** data from Angel One/Upstox, data is received in real-time during market hours — PIT is less critical.
- India-specific concern: NSE OI data for the closing snapshot is published after market close (~16:00 IST). If a model uses closing OI to predict the same day's closing price, that is safe. If it uses closing OI as a feature for the NEXT day's opening, that is also safe (T+1 usage).
- Computational cost: A full PIT database requires a versioned data store (Parquet with snapshot timestamps). Non-trivial to implement.
- Verdict: **ADOPT_WITH_CAVEATS** — PIT is essential for fundamental data; for OHLCV/OI, a simpler T+1 publication-delay policy is sufficient.

### 1.2 Qlib Expression Engine for Feature Algebra

**Recommendation:** Adopt Qlib's formulaic feature construction (`Ref($close, 60) / $close`).

**Verification:**
- Statistical validity: HIGH. Formulaic feature definitions are reproducible and versionable.
- Applicability to AlphaForge: AlphaForge already has a well-structured `features/` directory with named functions. The Qlib expression engine adds auto-caching and PIT enforcement on top.
- Computational cost: Significant refactoring to adopt. The expression engine is Qlib-specific infrastructure.
- Maintainability: Lower. Introducing Qlib as a dependency ties AlphaForge to Qlib's release cycle.
- Better alternative: Version feature functions explicitly (add a `FEATURE_VERSION` constant to each module) and enforce training/inference parity via a single entry-point function.
- Verdict: **DO_NOT_ADOPT** the Qlib expression engine specifically. The principle (reproducible feature definitions) is correct but the implementation can be achieved without adopting Qlib as a dependency.

### 1.3 Qlib Recorder Pattern (Automatic Experiment Recording)

**Recommendation:** Auto-capture every training run's dataset version, fold manifest, metrics, and artifact.

**Verification:**
- Statistical validity: Essential for reproducibility. Without it, claims about model performance cannot be verified.
- Applicability: AlphaForge's `ModelRecord` already has version fields; they are just not populated.
- Data requirements: None beyond what already exists.
- Computational cost: Negligible — writing JSON files.
- Alternative: MLflow. Lightweight, widely adopted, integrates with Optuna.
- Verdict: **ADOPT** — implement either MLflow integration or a simple JSON recorder. This is among the highest-priority improvements.

### 1.4 FreqAI Adaptive Sliding-Window Retraining

**Recommendation:** Implement sliding-window model retraining as new data arrives.

**Verification:**
- Statistical validity: CONDITIONAL. Adaptive retraining prevents model staleness but introduces risk: if the retraining window is too short, the model overfits to recent noise. If too long, it doesn't adapt.
- Applicability: Appropriate after initial model is validated with OOS evidence. Premature if base models haven't been validated yet.
- India-specific: Indian markets have structural breaks (SEBI regulations, expiry day changes). Adaptive retraining may help but must include a structural break detector.
- Production risk: Automated retraining without human review is dangerous in financial systems.
- Verdict: **DEFER** — implement only after the base model has ≥252 days of validated OOS evidence. Currently, base models have zero validated OOS evidence.

### 1.5 FreqAI Feature Parity (Single Function for Training and Inference)

**Recommendation:** Use one feature function in both training pipeline and inference server.

**Verification:**
- Statistical validity: CRITICAL. Training/inference feature mismatch is a systematic production risk.
- Current state: AlphaForge's `compute_stock_features()` is called from both `data_pipeline.py` and `server.py`. This means training and inference share the same function — feature parity already exists at the function level.
- The risk is subtler: in training, the function receives a 200-bar rolling window ending at bar i. In inference, it receives the most recent N bars. If these windows have different statistical properties (e.g., different lengths), the feature values will differ.
- Verdict: **ADOPT_WITH_CAVEATS** — the basic parity exists. Add explicit tests that compute features on the same input in both training and inference contexts and verify identical output.

### 1.6 MlFinLab Triple-Barrier Labeling

**Recommendation:** Replace fixed-horizon labels with event-driven triple-barrier labels.

**Verification:**
- Statistical validity: HIGH. Triple-barrier labels better reflect actual trading outcomes (positions are closed at stop or target, not always held to a fixed horizon).
- Applicability to AlphaForge: AlphaForge already simulates stop/target in `generate_risk_labels()`. However, the simultaneous stop+target hit is not resolved (original finding H2's sub-issue).
- Data requirements: Same OHLCV data; no additional data needed.
- Implementation complexity: Moderate — a bar-by-bar scan to find the first barrier hit.
- Verdict: **ADOPT** — specifically for the risk model labels. For ranking labels (where there is no explicit stop/target), fixed-horizon relative return is still appropriate.

### 1.7 MlFinLab Sample Weights for Overlapping Labels

**Recommendation:** Down-weight training observations with overlapping labels.

**Verification:**
- Statistical validity: HIGH for overlapping labels. A 5-day forward return label at bar t and bar t+1 share 4 days of data. Treating them as independent inflates effective sample size.
- Applicability to AlphaForge: The 5-day ranking labels and 20-day risk labels both have significant overlap. With N=1,260 trading days and horizon=5, effective sample size is approximately 1,260/5 = 252 independent observations, not 1,260.
- Implementation: `sample_weight` parameter exists in XGBoost, LightGBM, CatBoost. Computing uniqueness weights requires a t1 series.
- Computational cost: Negligible.
- Verdict: **ADOPT** — straightforward to implement once PurgedKFold (which requires the same t1 series) is in place.

### 1.8 MlFinLab Deflated Sharpe Ratio

**Recommendation:** Apply DSR correction to account for multiple testing in HPO.

**Verification:**
- Statistical validity: HIGH. DSR is the correct statistic when multiple strategy configurations are tested on the same data.
- Applicability: Directly applicable to AlphaForge's Optuna HPO (30 trials per model).
- Implementation complexity: Low — the DSR formula is a closed-form correction applied to the observed Sharpe.
- Verdict: **ADOPT** — add DSR computation to `ModelAcceptanceGate`. This is a correctness requirement, not an enhancement.

### 1.9 NautilusTrader Research-to-Live Parity

**Recommendation:** Use a shared execution kernel for backtest and live trading.

**Verification:**
- Statistical validity: Essential in principle. Backtest/live parity eliminates deployment gap.
- Applicability to AlphaForge: Adopting NautilusTrader as AlphaForge's execution engine would require replacing the existing Next.js + FastAPI architecture. This is a major architectural change.
- More practical alternative: Document and enforce the execution assumptions in the FastAPI service; add integration tests that verify live inference produces identical outputs to batch feature computation on the same input data.
- Verdict: **DO_NOT_ADOPT** the NautilusTrader engine specifically. The principle (research/live parity) is correct and achievable at lower cost by enforcing API contract tests between training pipeline and inference server.

### 1.10 skfolio as Replacement for Riskfolio-Lib

**Recommendation:** Replace Riskfolio-Lib with skfolio for sklearn compatibility and online portfolio CV.

**Verification:**
- Statistical validity: skfolio's online walk-forward CV is valid and well-designed.
- Applicability: skfolio is sklearn-compatible (sklearn is already a dependency). It offers HRP, CVaR, MVO, factor models.
- Migration cost: Moderate — `rp.HCPortfolio` → `skfolio.HierarchicalRiskParity`. API is different but concepts are the same.
- Risk: Riskfolio-Lib is functional; migration introduces regression risk without guaranteed performance improvement.
- Verdict: **DEFER** — Riskfolio-Lib is functional. Migrate to skfolio in Phase 4+ after core ML bugs are fixed. Add turnover penalty to existing Riskfolio implementation as a near-term improvement.

### 1.11 LEAN 5-Module Framework

**Recommendation:** Restructure AlphaForge as Universe Selection → Alpha → Portfolio Construction → Risk Management → Execution modules.

**Verification:**
- AlphaForge's current structure closely mirrors this: Regime → Stock Ranker → Portfolio Optimizer → Risk Predictor → RL Executor.
- The key difference is loose coupling: LEAN enforces the interface contract between modules. AlphaForge does not.
- Full adoption would require significant refactoring.
- Verdict: **ADOPT_WITH_CAVEATS** — adopt the module interface contracts (define clean input/output schemas between components) without rewriting the components themselves.

---

## 2. Book-Derived Recommendations

### 2.1 López de Prado — Triple-Barrier and Meta-Labeling

**Meta-labeling verdict:** **ADOPT_WITH_CAVEATS**  
- Meta-labeling adds a secondary model layer on top of the existing signal. With the base models currently untrained (all heuristic), there is nothing for the meta-labeler to calibrate against. Implement after base models have OOS IC > 0.02.

**Triple-barrier verdict:** **ADOPT** for risk labels. Replace simultaneous-hit logic with sequential bar-scan.

### 2.2 López de Prado — Fractional Differentiation

**Verdict:** **DEFER**  
- Fractional differentiation preserves long-range memory while achieving approximate stationarity. The implementation is non-trivial (requires truncation and careful parameter search for the d parameter).
- AlphaForge's multi-period returns (1d, 5d, 20d) already provide some memory preservation. Full fractional diff is premature while core bugs exist.

### 2.3 Carver — Volatility Targeting for Position Sizing

**Verdict:** **ADOPT_WITH_CAVEATS**  
- Carver's volatility-targeting is more robust than Kelly in practice (less sensitive to probability estimates, which are unreliable from uncalibrated models).
- However, replacing the current Kelly sizing before models are validated changes the baseline behaviour. Should be added as an alternative sizing mode.

### 2.4 Grinold-Kahn — IC as Primary Metric

**Verdict:** **ADOPT**  
- Adding OOS IC measurement is zero-cost (one Spearman correlation computation per fold). It should be the first metric added to the training evaluation loop.

### 2.5 Ilmanen — IV Carry (VIX - HV Spread)

**Verdict:** **ADOPT**  
- IV carry (India VIX / 100 − 30-day realized volatility) is a genuine return premium in Indian options markets. The feature requires only VIX and OHLCV data already available. Low implementation cost, high potential signal value.

---

## 3. Recommendations That Should NOT Be Adopted

### 3.1 Do Not Adopt: Qlib Expression Engine as AlphaForge Dependency

AlphaForge's Python feature functions are already structured, testable, and maintainable. Adopting Qlib's DSL would add complexity without proportionate benefit.

### 3.2 Do Not Adopt: NautilusTrader as Execution Engine

Replacing the existing FastAPI service with a Rust/Python event-driven engine would require rewriting the entire application. The research-to-live parity principle can be implemented more cheaply.

### 3.3 Do Not Adopt: Automated Retraining in Production (Now)

FreqAI's adaptive retraining is appropriate for a validated model. With zero OOS-validated models, automated retraining would propagate invalid models without human review. Implement this in Phase 4 after OOS validation.

### 3.4 Do Not Adopt: Black-Litterman Model (Immediately)

Black-Litterman requires calibrated expected returns from a validated alpha model. Using uncalibrated heuristic scores as BL views would produce arbitrary portfolio weights. Defer until base models have validated OOS IC.

### 3.5 Do Not Adopt: Deep Learning (LSTM/Transformer) for Price Forecasting

With ~1,260 daily observations after 5-year training window, deep learning models are almost certain to overfit. The research document correctly notes this but the recommendation to use LightGBM on lagged features is the right choice.

---

## 4. Summary Verdict Table

| Recommendation | Verdict | Priority | Reason |
|---|---|---|---|
| Qlib PIT for fundamental data | ADOPT_WITH_CAVEATS | Medium | Required for fundamental factors; less critical for OHLCV |
| Qlib Expression Engine | DO_NOT_ADOPT | — | Unnecessary dependency; current structure is sufficient |
| Qlib Recorder / MLflow | ADOPT | High | Zero-cost reproducibility; critical for evidence tracking |
| FreqAI adaptive retraining | DEFER | Low | Premature without validated base models |
| FreqAI feature parity | ADOPT_WITH_CAVEATS | High | Verify parity with integration tests; function already shared |
| MlFinLab triple-barrier | ADOPT | High | For risk labels; straightforward implementation |
| MlFinLab sample weights | ADOPT | High | One line: `model.fit(..., sample_weight=w)` |
| MlFinLab DSR | ADOPT | High | Correctness requirement for HPO reporting |
| NautilusTrader engine | DO_NOT_ADOPT | — | Over-engineering for AlphaForge's scale |
| skfolio migration | DEFER | Low | Riskfolio-Lib is functional; migrate later |
| LEAN 5-module interface | ADOPT_WITH_CAVEATS | Medium | Define clean interfaces; don't rewrite components |
| IC as primary metric | ADOPT | High | Free to implement; essential correctness metric |
| Carver vol-targeting | ADOPT_WITH_CAVEATS | Medium | Add as alternative mode alongside Kelly |
| IV carry feature | ADOPT | Medium | Low cost, genuine India-specific signal |
| Meta-labeling | ADOPT_WITH_CAVEATS | Low | Only after base models have OOS IC > 0.02 |
| Fractional differentiation | DEFER | Low | Complexity not justified before core bugs fixed |
| Black-Litterman | DO_NOT_ADOPT (now) | — | Requires validated alpha model first |
| Deep learning forecasters | DO_NOT_ADOPT | — | Insufficient data; LightGBM is better choice |
