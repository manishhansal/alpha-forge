# Model Audit: Every Model Classified

**Verification Date:** 2026-09-06  
**Method:** Direct inspection of each model file, training method, and inference path.

---

## Classification Legend

| Class | Meaning |
|---|---|
| `PRODUCTION-CANDIDATE` | Has OOS evidence; ready for shadow/live testing |
| `EXPERIMENTAL` | Designed for ML but lacks OOS validation evidence |
| `RESEARCH-ONLY` | Interesting architecturally; not ready for any live inference |
| `HEURISTIC` | Implemented as rule-based fallback; labeled as ML but currently pure heuristic |
| `UNJUSTIFIED` | No clear evidence basis; should be reconsidered |

---

## Model 1: MarketRegimeClassifier

| Attribute | Detail |
|---|---|
| **File** | `src/models/market_regime.py` |
| **Algorithm** | XGBoost `multi:softprob`, 6 classes, 300 estimators |
| **Inputs** | 28 `REGIME_FEATURES` from `engineer.py` |
| **Target** | 6-class regime (CRASH/BEAR/VOLATILE/SIDEWAYS/BULL/STRONG_BULL) |
| **Training method** | `train_test_split(stratify=y)` — **RANDOM SHUFFLE** |
| **Validation** | None beyond random-split val_accuracy |
| **Calibration** | Raw softmax probabilities; `CalibrationStore` unfitted |
| **Production usage** | Heuristic fallback active (no trained artifact) |
| **Evidence** | NONE — no OOS evidence; random-split metrics invalid |

**Current state: HEURISTIC** — The `_predict_heuristic()` method implements a sophisticated hand-tuned scoring system using VIX, breadth, ADX, PCR, and rotation features. This heuristic is always active because no trained model artifact exists.

**Heuristic quality assessment:** The heuristic uses additive scoring with ~40 manually-tuned threshold comparisons. Examples: `if vix > 30: crash_score += 0.25`, `if pcr > 1.8: crash_score += 0.10`. These constants are calibrated from developer intuition, not data. They likely produce reasonable outputs during typical market conditions but will fail at regime transitions.

**Classification: HEURISTIC** (when no artifact) / EXPERIMENTAL (when trained with correct splits)

---

## Model 2: StockRanker

| Attribute | Detail |
|---|---|
| **File** | `src/models/stock_ranker.py` |
| **Algorithm** | LightGBM regression (default) or LambdaRank |
| **Inputs** | 65+ `RANKING_FEATURES` |
| **Target** | Risk-adjusted forward relative return vs NIFTY |
| **Training method** | 80/20 time-based split — **NO embargo** |
| **Validation** | Val Spearman IC; no PurgedKFold |
| **Calibration** | Raw scores normalised to 0-100 percentile |
| **Production usage** | Heuristic fallback active (no trained artifact) |
| **Evidence** | NONE — no OOS IC measured; no embargo; no DSR |

**Heuristic quality assessment:** `_compute_heuristic_score()` is a multi-factor weighted composite with ~20 manually tuned weights. The derivatives component (0.22 weight) correctly prioritises OI/PCR signals. However, with 20 free parameters and no OOS testing, this heuristic is essentially overfit to the developer's understanding of Indian F&O.

**Note:** LambdaRank objective is commented as "alternative" but is the correct objective for ranking. The regression fallback (`objective="regression"`) optimises RMSE on excess returns, which is not the same as maximising rank order.

**Classification: HEURISTIC** (when no artifact) / EXPERIMENTAL (when trained with correct procedure)

---

## Model 3: StrategySelector

| Attribute | Detail |
|---|---|
| **File** | `src/models/strategy_selector.py` |
| **Algorithm** | CatBoost multiclass, 8 strategy classes |
| **Inputs** | 17 `STRATEGY_FEATURES` |
| **Target** | Which of 8 strategies produced best risk-adjusted return |
| **Training method** | `train_test_split(stratify=y)` — **RANDOM SHUFFLE** |
| **Validation** | None beyond random-split val_accuracy |
| **Evidence** | NONE — random-split metrics invalid |

**Issue with 8-class design:** 8 strategy classes on 17 features with a contaminated random split means the model has effectively no valid OOS evidence. Further, classifying into 8 strategies requires each class to have sufficient training examples — if momentum dominates (likely in bull regimes), the model will rarely learn when other strategies outperform.

**Heuristic fallback:** `_select_heuristic()` uses a condition-based rule table mapping (regime, technical conditions) → strategy. This is reasonable as a baseline but is not ML.

**Classification: HEURISTIC** (current) / EXPERIMENTAL (if retrained with temporal splits)

**Recommendation:** Consider reducing to 3-4 strategy classes to improve class balance and learnability.

---

## Model 4: RiskPredictor (Stop-Hit)

| Attribute | Detail |
|---|---|
| **File** | `src/models/risk_predictor.py` |
| **Algorithm** | XGBoost binary classifier (`binary:logistic`) |
| **Inputs** | 18 `RISK_FEATURES` |
| **Target** | P(stop loss hit within 20 bars) |
| **Training method** | 80/20 time-based split — **NO embargo** |
| **Evidence** | NONE — no OOS AUC with proper validation |

**Classification: EXPERIMENTAL** — design is correct; labels need simultaneous-hit fix; embargo needed.

---

## Model 5: RiskPredictor (Target-Hit)

Same as stop-hit classifier, target: P(target hit within 20 bars). Same classification: **EXPERIMENTAL**.

---

## Model 6: RiskPredictor (Drawdown Regressor)

| Attribute | Detail |
|---|---|
| **Algorithm** | XGBoost regressor (`reg:squarederror`) |
| **Target** | Expected max adverse excursion % |

**Classification: EXPERIMENTAL** — the MAE label is the cleanest of the risk labels (no simultaneous-hit issue). This sub-model has the best prospect for valid OOS evaluation.

---

## Model 7: PortfolioOptimizer

| Attribute | Detail |
|---|---|
| **File** | `src/models/portfolio_optimizer.py` |
| **Algorithm** | Riskfolio-Lib HRP / CVaR |
| **Inputs** | Returns DataFrame |
| **Purpose** | Allocate weights among pre-selected stocks |

**This is NOT an ML model.** HRP and CVaR are mathematical optimisation routines, not learned models. They do not have training/validation cycles. They produce optimal weights given a covariance structure estimated from input returns.

**Current issues:** No transaction cost penalty; no lot-size rounding; Pearson (not Spearman) codependence.

**Classification: RESEARCH_ONLY** — functional but missing India-specific constraints. Not ML.

---

## Model 8: RLExecutor

| Attribute | Detail |
|---|---|
| **File** | `src/models/rl_executor.py` |
| **Algorithm** | PPO (Stable-Baselines3) |
| **State space** | 14-dimensional trade context |
| **Action space** | 7 discrete actions |
| **Purpose** | Execution timing optimisation |
| **Environment** | Gymnasium; dynamically loaded |
| **Evidence** | None — environment not validated; no OOS evaluation |

**Classification: RESEARCH_ONLY** — PPO execution agents require: (1) validated simulation environment, (2) extensive hyperparameter tuning, (3) rigorous OOS evaluation vs a simple baseline (VWAP/TWAP). None of these exist. Additionally, this model is being presented as ML when the base signal models (regime, ranker, strategy) are all heuristics. Optimising execution timing for heuristic signals is premature.

---

## Model 9: Price Forecaster

| Attribute | Detail |
|---|---|
| **File** | `src/price_forecaster.py` |
| **Algorithm** | Heuristic rule-based (deep learning commented out) |
| **Purpose** | Bull/bear/flat probability + confidence intervals |

**Classification: HEURISTIC** — explicitly heuristic. Deep learning dependencies (darts, tsai) are commented out. The heuristic uses VIX, breadth, momentum, and technical signals to estimate market direction — reasonable rules but not ML.

---

## Model 10: IV Regime Classifier

| Attribute | Detail |
|---|---|
| **File** | `src/iv_regime_classifier.py` |
| **Algorithm** | Rule-based threshold classification |
| **Purpose** | Classify IV regime as CRUSH/STABLE/SPIKE |

**Classification: HEURISTIC** — uses fixed VIX/IV thresholds. Simple and appropriate for its purpose. The test suite for this module passes (68 passing tests in `test_iv_classifier.py`).

---

## Model 11: Meta Decision Engine

| Attribute | Detail |
|---|---|
| **File** | `src/meta/meta_model.py` |
| **Inputs** | Outputs from all 7+ base models |
| **Output** | BUY/SELL/WAIT/NO_TRADE with confidence |

**Classification: HEURISTIC** — the meta-engine correctly implements the ensemble framework (calibration, weighting, abstention, decision policy). But because ALL base models are currently in heuristic mode (no trained artifacts), the meta-engine is combining 7 heuristic signals into a meta-heuristic output. The abstention logic (7 independent gates) is the most reliable part of this system.

---

## Heuristic vs ML Classification Summary

| Model | Currently ML? | Currently Heuristic? | OOS Evidence? | Classification |
|---|---|---|---|---|
| MarketRegimeClassifier | ❌ No artifact | ✅ Always active | ❌ None | HEURISTIC |
| StockRanker | ❌ No artifact | ✅ Always active | ❌ None | HEURISTIC |
| StrategySelector | ❌ No artifact | ✅ Always active | ❌ None | HEURISTIC |
| RiskPredictor (stop) | ❌ No artifact | ✅ Always active | ❌ None | HEURISTIC |
| RiskPredictor (target) | ❌ No artifact | ✅ Always active | ❌ None | HEURISTIC |
| RiskPredictor (drawdown) | ❌ No artifact | ✅ Always active | ❌ None | HEURISTIC |
| PortfolioOptimizer | ✅ (optimiser) | N/A | N/A | RESEARCH_ONLY |
| RLExecutor | ❌ No artifact | ✅ Likely active | ❌ None | RESEARCH_ONLY |
| Price Forecaster | ❌ Commented out | ✅ Always active | ❌ None | HEURISTIC |
| IV Regime Classifier | ❌ Rule-based | ✅ Always active | N/A | HEURISTIC |
| Meta Decision Engine | ❌ No base ML | ✅ Meta-heuristic | ❌ None | HEURISTIC |

**ALL models are currently operating in heuristic mode. The system is 100% heuristic.**

This is not a criticism of the architecture — the heuristic fallbacks are thoughtful and India-specific. But calling this system "ML-based" is inaccurate until at least one base model has trained with correct temporal splits and passes the ModelAcceptanceGate.
