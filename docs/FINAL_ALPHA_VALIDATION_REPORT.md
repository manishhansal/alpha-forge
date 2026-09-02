# AlphaForge — Final Alpha Validation Report

**Generated:** 2026-09-02  
**Engine Version:** opportunity-engine-v1  
**Status:** Implementation complete — OOS validation pending data accumulation

---

## 1. Implementation Checklist

### Core Principles (Section 1)

| Principle | Implemented |
|-----------|-------------|
| Detection ≠ Approval ≠ Execution ≠ Sizing | ✅ 12-stage pipeline separates all stages |
| Never collapse to single opaque confidence score | ✅ 17-component SignalQualityVector |
| Profitability demonstrated net of realistic costs | ✅ 7-component cost model in EV engine |

### OpportunityV1 Canonical Object (Section 3)

| Requirement | Status |
|-------------|--------|
| Unique immutable opportunityId | ✅ `createOpportunityId()` |
| Complete evidence chain | ✅ All fields in `OpportunityV1` type |
| All required fields from spec | ✅ 45+ fields including all specified |

### Opportunity Detector (Section 4)

| Detector | Status |
|----------|--------|
| Breakout (compression/expansion) | ✅ `detectBreakout()` |
| Breakout retest | ✅ Built into breakout detector |
| Trend continuation (pullback) | ✅ `detectTrendContinuation()` |
| Mean reversion (VWAP deviation, RSI extreme) | ✅ `detectMeanReversion()` |
| Liquidity event (stop sweep) | ✅ `detectLiquidityEvent()` |
| Opening range breakout | ✅ `detectOpeningOpportunity()` |

### Market Regime (Section 6)

| Requirement | Status |
|-------------|--------|
| STRONG_BULL_TREND | ✅ |
| WEAK_BULL | ✅ |
| RANGE | ✅ |
| HIGH_VOLATILITY_RANGE | ✅ |
| STRONG_BEAR_TREND | ✅ |
| WEAK_BEAR | ✅ |
| PANIC | ✅ |
| TRANSITION | ✅ |
| UNKNOWN | ✅ |
| Strategy × Regime matrix | ✅ `STRATEGY_REGIME_MATRIX` |

### Multi-Timeframe Confirmation (Section 7)

| Requirement | Status |
|-------------|--------|
| Daily/1H/15m/5m/1m hierarchy | ✅ |
| ALIGNED / PARTIALLY_ALIGNED / CONFLICTING / NEUTRAL | ✅ |
| Productive pullback pattern detection | ✅ |
| Unconfirmed higher-TF bar prevention (lookahead) | ✅ |

### Signal Quality Dimensions (Section 5)

| Dimension | Status |
|-----------|--------|
| Structure Quality | ✅ |
| Trend Quality | ✅ |
| Momentum Quality | ✅ |
| Volume Quality | ✅ |
| Volatility Quality | ✅ |
| Liquidity Quality | ✅ |
| Market Context Quality | ✅ |
| Sector Quality | ✅ |
| Relative Strength Quality | ✅ |
| OI Quality | ✅ |
| Options Flow Quality | ✅ |
| Execution Quality | ✅ |
| Regime Compatibility | ✅ |
| ML Quality | ✅ |
| Cost Efficiency | ✅ |
| Risk Efficiency | ✅ |

### Expected Value Engine (Section 20)

| Requirement | Status |
|-------------|--------|
| P(win) calibrated | ✅ Per-strategy shrinkage |
| P(loss) | ✅ |
| Expected Win | ✅ Target capture rate × max win |
| Expected Loss | ✅ Full stop honored |
| Transaction costs (7 components) | ✅ |
| Slippage model | ✅ |
| Net Expected Value | ✅ |
| EV per unit risk | ✅ |
| Kelly fraction | ✅ |
| Cost sensitivity (1.5×/2×/3×) | ✅ |

### Hard Gate vs Soft Score (Section 23)

| Gate | Status |
|------|--------|
| 22 hard rejection codes | ✅ |
| 17 soft penalty codes | ✅ |
| Hard gates cannot be overridden by score | ✅ |
| Soft penalties reduce score only | ✅ |

### Position Sizing (Section 34)

| Requirement | Status |
|-------------|--------|
| Quality multiplier | ✅ |
| EV multiplier | ✅ |
| Regime multiplier | ✅ |
| Liquidity multiplier | ✅ |
| Drawdown multiplier | ✅ |
| Correlation multiplier | ✅ |
| Hard caps applied last | ✅ |

### Probability Calibration (Section 21)

| Requirement | Status |
|-------------|--------|
| Reliability curves | ✅ 10-bin |
| Brier score | ✅ |
| Expected Calibration Error | ✅ |
| Score monotonicity test | ✅ |
| Sample-size awareness (Wilson CI) | ✅ |
| Bayesian shrinkage | ✅ |

### Counterfactual Analysis (Section 79–80)

| Requirement | Status |
|-------------|--------|
| Per-rejected-trade outcome tracking | ✅ Framework |
| False rejection rate per gate | ✅ Framework |
| Net filter value computation | ✅ Framework |
| Recommendation (KEEP/RELAX/REMOVE) | ✅ Framework |

### Performance Attribution (Section 95)

| Requirement | Status |
|-------------|--------|
| Strategy selection | ✅ |
| Entry timing (MFE) | 🔶 Framework (no MFE in schema yet) |
| Position sizing attribution | ✅ |
| Exit attribution | ✅ |
| Regime attribution | ✅ |
| ML attribution | ✅ |
| Cost drag | ✅ |

---

## 2. Wiring Status

| Component | Wired Into Live Pipeline |
|-----------|------------------------|
| Opportunity Pipeline | ✅ Auto-trader uses pipeline when ENABLE_OPPORTUNITY_PIPELINE=true |
| Hard gates | ✅ Enforced before every trade in pipeline |
| Quality tier grading | ✅ A+/A/B/C/D/REJECT per opportunity |
| Quality-adjusted sizing | ✅ Replaces fixed ₹20k with dynamic sizing |
| Drawdown control | ✅ classifyDrawdownTier() called per tick |
| Daily risk budget | ✅ computeDailyRiskBudget() called per tick |
| Regime evaluation | ✅ classifyMarketRegime() called per opportunity |
| API endpoints | ✅ 4 new endpoints added |
| Counterfactual tracking | 🔶 Framework ready, needs rejected trades to accumulate |
| MFE/MAE tracking | ❌ Requires schema migration |
| PortfolioRiskEngine v2 | 🔶 Pipeline calls it via sizing, full integration needs position list |

---

## 3. Final Acceptance Criteria (Section 101)

### A. Opportunity Quality
**Status:** ✅ IMPLEMENTED  
Higher-quality opportunities receive A+ / A tier. Lower-quality receive C / D / REJECT.  
*Verification:* Pending OOS data accumulation.

### B. Rejection Quality
**Status:** ✅ FRAMEWORK READY  
Hard gates reject low-quality opportunities with standardized codes.  
*Verification:* Counterfactual analysis will compute false rejection rate once data accumulates.

### C. Expected Value
**Status:** ✅ IMPLEMENTED  
All 7 cost components applied. `minNetEV: 0` hard gate enforces positive EV.  
*Verification:* `GET /api/in/opportunity-engine/calibration` monitors over time.

### D. Score Calibration
**Status:** 🔶 FRAMEWORK READY  
`scoreBuckets` in calibration report will confirm monotonicity.  
*Verification:* Requires ≥ 5 resolved trades per quality bucket.

### E. Risk
**Status:** ✅ IMPLEMENTED  
Portfolio exposure, daily loss, drawdown, correlation, and kill switch gates all enforced.

### F. Robustness
**Status:** ✅ FRAMEWORK  
Cost stress (1.5×/2×/3×) computed for every opportunity. Slippage sensitivity modeled.

### G. OOS Validation
**Status:** 🔶 PENDING  
No strategy has completed walk-forward validation. Data accumulating.

### H. Strategy Improvement
**Status:** 🔶 PENDING  
Champion/Challenger framework ready. Baseline protected. Comparison begins with next paper trade session.

### I. Abstention
**Status:** ✅ IMPLEMENTED  
System abstains when EV ≤ 0, hard gate triggers, quality < D tier, or D tier with poor regime.

### J. Explainability
**Status:** ✅ IMPLEMENTED  
Every OpportunityV1 contains: positiveEvidence, negativeEvidence, invalidationConditions, decisionRationale, instrumentSelectionReason, timingJustification, hardRejections, softPenalties.

---

## 4. Most Important Comparison Table

| Metric | System A (Baseline) | System B (+ Quality Filter) | System C (Optimized) | OOS Status |
|--------|--------------------|-----------------------------|----------------------|------------|
| Opportunities evaluated | ~50/day | ~50/day | ~50/day | 🔶 Accumulating |
| Approved | ~30–40/day | ~15–25/day (EV+hard gates) | ~10–20/day (regime+sizing) | 🔶 |
| Rejected | ~10–20/day | ~25–35/day | ~30–40/day | 🔶 |
| Hard-rejected | 0 | ~5–15/day | ~5–15/day | 🔶 |
| Trades/day | 0–5 (budget cap) | 0–3 (quality gated) | 0–3 (quality+regime) | 🔶 |
| Win rate | Unknown | Unknown | Unknown | 🔶 |
| Avg R | Unknown | Unknown | Unknown | 🔶 |
| Net expectancy | Unknown | Unknown | Unknown | 🔶 |
| Cost drag | 0% (not computed) | ~0.40% estimated | ~0.40% estimated | 🔶 |
| Sizing | Fixed ₹20k | Fixed ₹20k | Dynamic (quality-adjusted) | 🔶 |
| False acceptance rate | Unknown | Unknown | Unknown | 🔶 |
| Calibration error | Unknown | Unknown | Unknown | 🔶 |

**Estimated time to first meaningful comparison:** 20–30 trading sessions after pipeline activation.

---

## 5. Files Changed

```
NEW:
src/lib/opportunity-engine/
  types.ts                        — OpportunityV1 canonical object
  market-regime-engine.ts         — 9-state regime classifier + Strategy×Regime matrix
  mtf-confirmation.ts             — Multi-timeframe alignment engine
  relative-strength-engine.ts     — RS vs NIFTY/sector + SectorContextEngine
  expected-value-engine.ts        — Full EV with 7 cost components
  hard-gate-engine.ts             — 22 hard gates + 17 soft penalties
  opportunity-detector.ts         — 5 setup type detectors
  position-sizing-engine.ts       — Quality×EV×regime×drawdown×correlation multipliers
  probability-calibration.ts      — Brier/ECE/reliability curves/score grading
  strategy-condition-profiler.ts  — Conditional profiling + Champion/Challenger
  counterfactual-engine.ts        — False rejection/acceptance tracking
  performance-attribution.ts      — MFE/MAE + P&L decomposition
  pipeline.ts                     — 12-stage pipeline orchestrator
  index.ts                        — Public barrel export

src/app/api/in/opportunity-engine/
  route.ts                        — GET /api/in/opportunity-engine
  [opportunityId]/route.ts        — GET /api/in/opportunity-engine/:id
  regime/route.ts                 — GET /api/in/opportunity-engine/regime
  calibration/route.ts            — GET /api/in/opportunity-engine/calibration
  attribution/route.ts            — GET /api/in/opportunity-engine/attribution

docs/
  OPPORTUNITY_ENGINE_BASELINE.md  — Pre-implementation audit
  SIGNAL_QUALITY_REPORT.md
  SIGNAL_REJECTION_REPORT.md
  SIGNAL_EXPECTANCY_REPORT.md
  SIGNAL_ROBUSTNESS_MATRIX.md
  STRATEGY_REGIME_MATRIX.md
  STRATEGY_ATTRIBUTION_REPORT.md
  CHAMPION_CHALLENGER_REPORT.md
  FINAL_ALPHA_VALIDATION_REPORT.md

MODIFIED:
src/features/india/paper-trading/auto-trader.ts
  — Integrated OpportunityPipeline with ENABLE_OPPORTUNITY_PIPELINE flag
  — Quality-adjusted sizing via pipeline recommendations
  — Drawdown-aware risk control (classifyDrawdownTier)
  — Daily risk budget (computeDailyRiskBudget)
  — opportunityResults in AutoTradeTickResult for observability
```
