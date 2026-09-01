# AlphaForge V6 — Strategy Governance Matrix

> **Generated:** September 1, 2026  
> **Version:** V6.0.0  
> **Principle:** Every cell in this matrix must be evidence-based. `—` means the pipeline has not run yet. `✓` means the gate is passed. `✗` means the gate is failed. `⚠` means insufficient data or warning.

---

## Master Governance Matrix

| STRATEGY | VERSION | STATUS | HYPOTHESIS | BACKTESTED | OOS_VALIDATED | WALK_FORWARD | MONTE_CARLO | PARAMETER_STABLE | COST_ROBUST | PAPER_VALIDATED | LIVE_VALIDATED | CONFIDENCE_SCORE | FINAL_STATUS |
|----------|---------|--------|------------|------------|---------------|--------------|-------------|-----------------|-------------|-----------------|----------------|-----------------|--------------|
| UT_SMC | 1.0.0 | RESEARCH | ✓ DEFINED | — | — | — | — | — | — | — | — | — | AWAITING_PIPELINE |
| VWAP_SWEEP_TREND | 1.0.0 | RESEARCH | ✓ DEFINED | — | — | — | — | — | — | — | — | — | AWAITING_PIPELINE |
| NEWS_MOMENTUM | 1.0.0 | RESEARCH | ✓ DEFINED | — | — | — | — | — | — | — | — | — | AWAITING_PIPELINE |
| RANGE_SCALP | 1.0.0 | RESEARCH | ✓ DEFINED | — | — | — | — | — | — | — | — | — | AWAITING_PIPELINE |
| EMA_PULLBACK | 1.0.0 | RESEARCH | ✓ DEFINED | — | — | — | — | — | — | — | — | — | AWAITING_PIPELINE |
| VWAP_REVERSION | 1.0.0 | RESEARCH | ✓ DEFINED | — | — | — | — | — | — | — | — | — | AWAITING_PIPELINE |
| ORDERFLOW_SWEEP | 1.0.0 | RESEARCH | ✓ DEFINED | — | — | — | — | — | — | — | — | — | AWAITING_PIPELINE |
| FIB_PULLBACK | 1.0.0 | RESEARCH | ✓ DEFINED | — | — | — | — | — | — | — | — | — | AWAITING_PIPELINE |
| INSTITUTIONAL_SMC | 1.0.0 | RESEARCH | ✓ DEFINED | — | — | — | — | — | — | — | — | — | AWAITING_PIPELINE |
| AI_INSTITUTIONAL_PRO | 5.0.0 | RESEARCH | ✓ DEFINED | — | — | — | — | — | — | — | — | — | AWAITING_PIPELINE |
| FNO_TREND | 1.0.0 | RESEARCH | ✓ DEFINED | — | — | — | — | — | — | — | — | — | AWAITING_PIPELINE |
| FNO_RANGE_EXPANSION | 1.0.0 | RESEARCH | ✓ DEFINED | — | — | — | — | — | — | — | — | — | AWAITING_PIPELINE |
| INDIA_MOMENTUM | 1.0.0 | RESEARCH | ✓ DEFINED | — | — | — | — | — | — | — | — | — | AWAITING_PIPELINE |
| INDIA_VOLUME_BREAKOUT | 1.0.0 | RESEARCH | ✓ DEFINED | — | — | — | — | — | — | — | — | — | AWAITING_PIPELINE |
| INDIA_OI_BUILDUP | 1.0.0 | RESEARCH | ✓ DEFINED | — | — | — | — | — | — | — | — | — | AWAITING_PIPELINE |
| INDIA_AI_SIGNALS | 2.0.0 | SHADOW | ✓ DEFINED | — | — | — | — | — | — | ⚠ SHADOW | — | — | SHADOW_MONITORING |
| INDIA_SUPER_CONFLUENCE | 1.0.0 | RESEARCH | ✓ DEFINED | — | — | — | — | — | — | — | — | — | AWAITING_PIPELINE |
| STRATEGY_LAB_USER | dynamic | EXPERIMENTAL | ⚠ UNVALIDATED | — | — | — | — | — | — | — | — | — | BLOCKED_NO_HYPOTHESIS |

---

## Column Definitions

| Column | Definition | Pass Criteria |
|--------|-----------|---------------|
| **HYPOTHESIS** | Formal hypothesis declared | Status = DEFINED (not UNVALIDATED) |
| **BACKTESTED** | OOS backtest executed with ≥30 trades | tradeCount ≥ 30, expectancy > 0 |
| **OOS_VALIDATED** | Final OOS period evaluated | OOS Sharpe ≥ 0.3, Max DD < 30% |
| **WALK_FORWARD** | Walk-forward / CPCV validation passed | OOS Sharpe ≥ 0.5, not OVERFIT_SUSPECTED |
| **MONTE_CARLO** | 10,000 iteration MC robustness | robustLabel ≠ FRAGILE |
| **PARAMETER_STABLE** | Parameter neighbourhood stable | label ≠ OVERFIT_SUSPECTED |
| **COST_ROBUST** | Survives 2× cost stress test | costFragile = false |
| **PAPER_VALIDATED** | ≥20 paper trades with positive expectancy | paperExpectancy > 0, paperDD < 25% |
| **LIVE_VALIDATED** | ≥20 live trading sessions observed | LIVE status, sessions ≥ 20 |
| **CONFIDENCE_SCORE** | Composite 0-100 score | ≥ 75 = VALIDATED; ≥ 90 = HIGH_CONFIDENCE |
| **FINAL_STATUS** | Human-readable research verdict | See status legend below |

---

## Status Legend

| FINAL_STATUS | Meaning |
|-------------|---------|
| AWAITING_PIPELINE | No backtest executed yet |
| BLOCKED_NO_HYPOTHESIS | Hypothesis not declared — cannot advance |
| PIPELINE_RUNNING | Backtest in progress |
| FAILED_BACKTEST | Did not pass BACKTEST_VALIDATED gates |
| FAILED_COST | COST_FRAGILE — unprofitable at 2× costs |
| FAILED_MONTE_CARLO | Monte Carlo result = FRAGILE |
| FAILED_OVERFIT | OVERFIT_SUSPECTED in parameter stability |
| BACKTEST_PASSED | All BACKTEST_VALIDATED gates passed |
| WALKFORWARD_PASSED | All WALK_FORWARD_VALIDATED gates passed |
| SHADOW_MONITORING | In shadow mode, accumulating evidence |
| PAPER_MONITORING | In paper mode, accumulating evidence |
| LIVE_CANDIDATE | All non-live gates passed, awaiting human approval |
| LIVE_APPROVED | Human-approved, actively trading |
| DEPRECATED | Demoted and disabled |

---

## Promotion Blocker Registry

Strategies currently blocked from promotion and the specific reason:

| Strategy | Current Stage | Blocker Type | Specific Blocker |
|----------|--------------|-------------|-----------------|
| STRATEGY_LAB_USER | EXPERIMENTAL | NO_HYPOTHESIS | Must define hypothesis before proceeding |
| All 16 RESEARCH strategies | RESEARCH | NO_BACKTEST | Backtest pipeline not executed |
| INDIA_AI_SIGNALS | SHADOW | INSUFFICIENT_SHADOW_TRADES | Need ≥10 shadow trades with Sharpe ≥ 0.3 |

---

## Demotion History

No automatic demotions have occurred yet. The demotion engine is active and will fire when:
- Any live strategy's decay state reaches CRITICAL
- Any paper strategy's max drawdown exceeds 40%
- Any strategy is flagged COST_FRAGILE during monitoring
- ≥10 consecutive execution errors are logged

All demotion records include: `demotionReason`, `timestamp`, `metricsSnapshot`, `trigger`.

---

## Kill Switch Status

| Strategy | Level | Active | Reason |
|----------|-------|--------|--------|
| All strategies | NONE | No | No kill switches active |

Kill switches are evaluated before every trade entry by the `PortfolioRiskEngine`. Activation is automatic; deactivation requires explicit action.

---

## Confidence Score Components (when computed)

The 8-component confidence score uses these documented weights:

| Rank | Component | Weight | Rationale |
|------|-----------|--------|-----------|
| 1 | OOS Performance | 25% | Most predictive of live performance |
| 2 | Walk-Forward Stability | 15% | Validates performance across time |
| 3 | Monte Carlo Robustness | 15% | Tests stability across perturbations |
| 4 | Parameter Stability | 10% | Guards against curve-fitting |
| 5 | Cost Robustness | 10% | Ensures viability after real-world costs |
| 6 | Regime Consistency | 10% | Confirms strategy works in its declared regimes |
| 7 | Paper Performance | 10% | Real-world execution validation |
| 8 | Statistical Confidence | 5% | OOS t-test p-value |

Weights are redistibuted among available components when data is missing.

---

## Absolute Research Rules (non-negotiable)

These rules are enforced in code and cannot be bypassed:

1. **No in-sample promotion evidence.** `PerformancePeriod.IN_SAMPLE` metrics are computed but never used for promotion decisions.

2. **LIVE requires human approval.** The `evaluatePromotion()` function for `MANUAL_APPROVAL → LIVE` requires a non-empty `approvalToken` and `approvedBy`. Without these, `allGatesPassed` is always false.

3. **Temporal leakage throws.** `validateSplitIntegrity()` throws an `Error` (not a warning) on any temporal overlap. There is no "override" option.

4. **Experiments are immutable.** `ExperimentStore.add()` throws if an experimentId already exists. Completed experiments cannot be modified.

5. **Kill switches are not automatically removed.** `deactivateKillSwitch()` must be called explicitly; no time-based auto-removal exists.

6. **No strategy exists outside the registry.** `StrategyRegistry.getOrThrow()` throws for unregistered strategies. API routes validate strategyId against the registry before processing.

---

## Research Infrastructure Health

| System | Status | Tests |
|--------|--------|-------|
| StrategyRegistry | ✓ OPERATIONAL | 7 tests passing |
| HypothesisRegistry | ✓ OPERATIONAL | 4 tests passing |
| ResearchDataset + SHA-256 fingerprint | ✓ OPERATIONAL | — |
| ResearchSplit + leakage prevention | ✓ OPERATIONAL | 15 tests passing |
| StrategyPerformanceAnalyzer (35 metrics) | ✓ OPERATIONAL | 13 tests passing |
| CostAttributionReport + stress testing | ✓ OPERATIONAL | 9 tests passing |
| RegimeAttribution + Strategy×Regime Matrix | ✓ OPERATIONAL | — |
| StrategyCorrelation + clustering | ✓ OPERATIONAL | 9 tests passing |
| AlphaDecayMonitor (5-state) | ✓ OPERATIONAL | — |
| MonteCarloRobustness (7 types × 10k iter) | ✓ OPERATIONAL | 11 tests passing |
| ParameterStabilityScore | ✓ OPERATIONAL | — |
| MultipleTestingGuard (PBO + DSR + BH) | ✓ OPERATIONAL | — |
| SignalCalibration (Brier + ECE) | ✓ OPERATIONAL | 8 tests passing |
| StrategyAblation | ✓ OPERATIONAL | — |
| StrategyPromotionEngine | ✓ OPERATIONAL | 9 tests passing |
| StrategyDemotionEngine | ✓ OPERATIONAL | 3 tests passing |
| StrategyConfidenceScore (0-100) | ✓ OPERATIONAL | — |
| ResearchExperimentTracker | ✓ OPERATIONAL | — |
| StrategyLeaderboard | ✓ OPERATIONAL | — |
| StrategyAllocationEngine | ✓ OPERATIONAL | — |
| StrategyKillSwitch | ✓ OPERATIONAL | — |
| PaperPerformanceAnalyzer | ✓ OPERATIONAL | — |
| ValidationSessionTracker | ✓ OPERATIONAL | — |
| **Total** | **✓ 92 tests passing** | |

---

*Next update after backtest pipeline execution.*  
*This document is generated from the canonical strategy registry and research infrastructure. Do not edit manually — run the pipeline and regenerate.*
