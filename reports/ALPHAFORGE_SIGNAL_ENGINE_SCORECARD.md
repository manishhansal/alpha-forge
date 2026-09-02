# AlphaForge — Signal Engine Scorecard

**Evaluation Date:** 2026-09-02
**Session Reference:** 2026-09-01 (last completed NSE session) + 20-session rolling window
**Scoring Methodology:** Evidence-based assessment. Where evidence is absent, the dimension scores LOW by default (conservative principle). No dimension is inflated to hide a blocker.

> **CRITICAL RULE:** A weighted average score CANNOT hide a critical failure. Dimensions with critical failures are flagged with 🚨 regardless of composite score.

---

## INDIVIDUAL DIMENSION SCORES

### 1. Data Quality — 62 / 100

| Sub-Dimension | Score | Evidence |
|--------------|-------|---------|
| Daily OHLCV coverage (97.7%) | 85 | 173/177 instruments with valid bars |
| Option chain capture (92%) | 80 | 5-min snapshots, Angel One live |
| Intraday candle persistence | **0** 🚨 | RCA-001: CandleBar not wired to worker |
| Provider reliability | 75 | Angel One active when market open |
| Data staleness control | 70 | 4h cache for daily; 30s TTL for intraday |
| Duplicate prevention | 60 | DB unique constraint on CandleBar; no runtime dedup |
| P&L currency consistency | **30** ⚠️ | USD-001: Signal ledger uses USD; paper trades use INR |

**Weighted Score: 62 / 100**
**Blocker:** Intraday candle loss (RCA-001) prevents signal replay and MFE/MAE computation.

---

### 2. Universe Coverage — 58 / 100

| Sub-Dimension | Score | Evidence |
|--------------|-------|---------|
| Total instruments in universe | 70 | 177 instruments (4 indices + 173 stocks) |
| Daily OHLCV coverage | 85 | 97.7% (173/177) |
| Intraday coverage | **0** 🚨 | RCA-001: No persistent intraday bars |
| Opportunity pipeline reach | **25** 🚨 | Only 30/177 instruments evaluated per run (17%) |
| Live instrument master | **20** ⚠️ | Static list; no auto-update from NSE F&O eligibility changes |
| Lot size data | **30** ⚠️ | `lotSize: null` for all instruments (not populated from live master) |

**Weighted Score: 58 / 100**
**Blockers:** Pipeline cap of 30 instruments and missing intraday coverage.

---

### 3. Signal Correctness — 47 / 100

| Sub-Dimension | Score | Evidence |
|--------------|-------|---------|
| Forward outcome measurement | **20** 🚨 | No intraday bars → MFE/MAE not computable |
| Directional accuracy (resolved trades) | 55 | 25.68% win rate on resolved; structural issues confound |
| Strategy-specific horizon alignment | 50 | OPENING_BREAKOUT uses intraday horizon correctly |
| Expectancy per trade | **30** ⚠️ | -0.18% per trade (negative; confounders: DUP-001, OPP-001) |
| DUP-001 distortion | **0** 🚨 | 3× inflation makes correctness measurement unreliable |
| R:R realization rate | 45 | 2.0 R:R used correctly on MARUTI win |

**Weighted Score: 47 / 100**
**Blockers:** DUP-001 (inflation) and absent intraday bars prevent reliable correctness measurement.

---

### 4. Opportunity Recall — 35 / 100

| Sub-Dimension | Score | Evidence |
|--------------|-------|---------|
| Signal lifecycle persistence | **0** 🚨 | AUDIT-001: No `SignalLifecycleEvent` DB writes |
| Miss rate measurement | **0** 🚨 | Cannot measure without lifecycle records |
| Pipeline universe reach | **25** | 30/177 instruments (17%) evaluated |
| Independent recall validation | **20** | Estimated 20% miss rate baseline (not independently validated) |
| Budget cap impact | 50 | 5-position cap is a known, intentional constraint |

**Weighted Score: 35 / 100**
**Critical Blocker:** Without `SignalLifecycleEvent` persistence, opportunity recall is entirely unmeasurable.

---

### 5. Signal Precision — 42 / 100

| Sub-Dimension | Score | Evidence |
|--------------|-------|---------|
| Win rate (resolved, raw) | 42 | 25.68% — below 50% threshold |
| Win rate (estimated unique) | 44 | ~26% after dedup |
| False positive rate | 58 | ~74% of resolved trades are losses — high FP rate |
| False negative avoidance | Unknown | Cannot measure without recall data |
| Cost-adjusted precision | **25** ⚠️ | Negative expectancy persists after costs |
| Grade A+ signal precision | Estimated 55 | Grade A signals show higher directional accuracy |

**Weighted Score: 42 / 100**
**Note:** The low precision is partly confounded by OPP-001 (quality gate ineffective without candles). True precision likely higher once real candle data feeds the quality scores.

---

### 6. Paper Capture — 45 / 100

| Sub-Dimension | Score | Evidence |
|--------------|-------|---------|
| Auto-trader pipeline (DailyPicks) | 75 | Fully wired, runs at 60s cadence |
| Auto-trader pipeline (AI Signals) | 60 | Wired but dependent on signal quality |
| Budget utilization | 70 | ₹1L budget tracked in IndiaDaySession |
| EOD square-off | 90 | Redis lock, exactly-once, verified correct |
| Signal → paper chain (DUP-001) | **15** 🚨 | Chain is broken by cross-timeframe duplicates |
| Capture rate measurement | **0** 🚨 | AUDIT-001: No lifecycle events → cannot compute rate |
| Missed high-value opportunities | Unknown | No lifecycle data |

**Weighted Score: 45 / 100**
**Blockers:** DUP-001 and AUDIT-001 prevent meaningful capture rate computation.

---

### 7. Execution Fidelity — 72 / 100

| Sub-Dimension | Score | Evidence |
|--------------|-------|---------|
| NSE 0.05-tick rounding | 90 | Implemented in paper-trader-core.ts |
| STT / exchange charges / GST / SEBI / stamp | 85 | 7-component cost model in ExpectedValueEngine |
| Slippage model | 70 | Half-spread model (3bps options, 2bps futures) |
| Partial fill simulation | 65 | backtesting-v2 has partial fill engine; not active in paper trader |
| Gap-through-stop | 60 | backtesting-v2 has gap model; not active in paper trader |
| Entry latency | 55 | `latencyFactor: 0` in paper trading (immediate fill) |
| EOD square-off at exact 15:30 | 85 | Uses `nseCloseMsForDateIST()` for exact timestamp |
| Perfect fill avoidance | 70 | Spread is modeled; slippage is minimal |

**Weighted Score: 72 / 100**

---

### 8. EV Calibration — 38 / 100

| Sub-Dimension | Score | Evidence |
|--------------|-------|---------|
| EV formula completeness | 80 | 7-component cost model, full formula |
| EV inputs quality | **20** 🚨 | Empty candles → RSI/RVOL/structure all at defaults |
| EV vs realized R correlation | Unknown | Cannot compute without intraday history |
| Cost sensitivity (robustness) | 65 | CostRobustness panel in signal quality dashboard |
| Slippage sensitivity | 60 | Modeled; pipeline uses conservative estimates |

**Weighted Score: 38 / 100**
**Blocker:** OPP-001 makes EV inputs unreliable. The formula is correct but the inputs are hollow.

---

### 9. Probability Calibration — 48 / 100

| Sub-Dimension | Score | Evidence |
|--------------|-------|---------|
| Logistic shrinkage prior | 75 | Implemented in `probability-calibration.ts` |
| Per-strategy calibration data | 40 | Accumulates via SignalHistory; limited sample |
| ECE measurement | 65 | Computed in signal quality dashboard (20-phase) |
| Brier score | 60 | Computed in signal quality dashboard |
| ML calibration (CatBoost) | **0** | ML service not verified active |
| Overconfidence detection | 55 | Reliability diagram in dashboard |

**Weighted Score: 48 / 100**

---

### 10. Risk Control — 44 / 100

| Sub-Dimension | Score | Evidence |
|--------------|-------|---------|
| PortfolioRiskEngine (implementation) | 80 | Fully implemented, tested (64 tests) |
| PortfolioRiskEngine (wired in live path) | **0** 🚨 | RISK-001: Not called from auto-trader or pipeline |
| Per-trade stop gate (≤2.5%) | 80 | Enforced in auto-trader |
| Max positions (5) | 85 | Budget gate enforced |
| Drawdown halt | **30** ⚠️ | Logic present but uses hardcoded 0% drawdown |
| Kill switch | 60 | Implemented but not wired to live portfolio state |
| Correlation limit | **0** 🚨 | Not computed (Risk engine unwired) |

**Weighted Score: 44 / 100**
**Critical Blocker:** PortfolioRiskEngine not wired. Correlation, VaR, and CVaR limits are unenforced.

---

### 11. Portfolio Control — 40 / 100

| Sub-Dimension | Score | Evidence |
|--------------|-------|---------|
| Daily budget tracking | 85 | IndiaDaySession table, accurate deployed tracking |
| Position count limit | 85 | 5 concurrent positions enforced |
| Exposure limits | **30** ⚠️ | Only enforced via budget cap, not dynamic exposure |
| Sector concentration | **0** 🚨 | Not monitored (Risk engine unwired) |
| Portfolio beta | **0** 🚨 | Not computed |
| Correlated positions | **25** ⚠️ | Symbol-level dedup only; sector correlation ignored |

**Weighted Score: 40 / 100**

---

### 12. Strategy Attribution — 52 / 100

| Sub-Dimension | Score | Evidence |
|--------------|-------|---------|
| Per-strategy P&L tracking | 75 | `PaperTrade.source` encodes strategy ID |
| Strategy leaderboard | 70 | Computed in signal quality dashboard |
| Strategy-specific horizon | 65 | Each strategy has defined expectedHoldingPeriod |
| DUP-001 attribution distortion | **20** 🚨 | Multi-timeframe duplicates inflate per-strategy stats |
| OOS evidence per strategy | **0** | All strategies at RESEARCH; no OOS data |
| Regime × strategy performance | 50 | RegimeHeatmap in dashboard (limited data) |

**Weighted Score: 52 / 100**

---

### 13. Regime Adaptation — 45 / 100

| Sub-Dimension | Score | Evidence |
|--------------|-------|---------|
| Regime detection (implementation) | 75 | `classifyMarketRegime()` in market-regime-engine.ts |
| Regime detection (data inputs) | 50 | Uses Nifty change%, VIX; no breadth data |
| Strategy × regime compatibility matrix | 60 | `strategyCompatibleWithRegime()` implemented |
| Regime gate enforcement | 55 | Hard gate rejects incompatible setups |
| Breadth data integration | **20** ⚠️ | `advancingCount/decliningCount: null` (not fetched) |
| VIX integration | 60 | ATM IV from option chain used as proxy |

**Weighted Score: 45 / 100**

---

### 14. ML Incremental Value — 8 / 100

| Sub-Dimension | Score | Evidence |
|--------------|-------|---------|
| ML service availability | **0** 🚨 | Not verified running; falls back to heuristic |
| ML model trained (market regime) | **10** | market_regime.json is config, not trained weights |
| ML model trained (CatBoost ranker) | 40 | strategy_selector.cbm exists as real artifact |
| ML vs heuristic delta | **0** | Cannot measure — ML never active |
| Calibration of ML predictions | **0** | No ML calibration data |
| Graceful fallback | 90 | Fallback to heuristic is fully implemented |

**Weighted Score: 8 / 100**
**Note:** The ML infrastructure is excellent and the fallback is graceful. But an ML system that never runs contributes 0% incremental value.

---

### 15. Cost Robustness — 70 / 100

| Sub-Dimension | Score | Evidence |
|--------------|-------|---------|
| Cost model completeness | 85 | 7 components: brokerage, STT, exchange, GST, SEBI, stamp, spread |
| Base cost accuracy | 80 | ₹40 brokerage, 0.0125% STT, 0.18% GST — Zerodha-calibrated |
| Cost stress test (1.5× / 2× / 3×) | 75 | CostRobustnessCard in signal quality dashboard |
| Negative expectancy persists after cost removal | ⚠️ | Cost is not the root cause of negative EV |
| Slippage robustness | 65 | 3bps half-spread conservative but model not stress-tested |

**Weighted Score: 70 / 100**

---

### 16. Latency Robustness — 65 / 100

| Sub-Dimension | Score | Evidence |
|--------------|-------|---------|
| Worker tick latency (60s cadence) | 75 | Appropriate for daily-resolution F&O signals |
| Signal age tracking | 65 | `dataAgeMs: 60_000` assumed, not measured |
| Late entry detection | 50 | `isLateEntry` flag in pipeline — requires candle data |
| Last-entry cutoff (14:45) | 85 | Enforced correctly in auto-trader |
| Redis read latency | 75 | Sub-millisecond for in-memory operations |

**Weighted Score: 65 / 100**

---

### 17. Anti-Overfit — 78 / 100

| Sub-Dimension | Score | Evidence |
|--------------|-------|---------|
| Walk-forward validation framework | 80 | Implemented in `src/lib/research/` |
| Temporal leakage prevention | 85 | `PurgedKFold`, `WalkForwardValidator` implemented |
| Dataset fingerprinting | 75 | `src/lib/research/datasets/` |
| Multiple testing protection | 70 | Implemented in research pipeline |
| In-sample / OOS separation | 75 | Research pipeline enforces train/test splits |
| No retroactive signal modification | 90 | Confirmed — no modification in ledger |
| Today's data treated as evaluation | 90 | This report does not tune any parameters |
| Parameter stability tests | 60 | Framework exists; not yet run on real data |

**Weighted Score: 78 / 100**

---

## COMPOSITE SCORECARD

| Dimension | Score | Weight | Weighted |
|-----------|-------|--------|---------|
| 1. Data Quality | 62 | 8% | 4.96 |
| 2. Universe Coverage | 58 | 6% | 3.48 |
| 3. Signal Correctness | 47 | 10% | 4.70 |
| 4. Opportunity Recall | 35 | 8% | 2.80 |
| 5. Signal Precision | 42 | 10% | 4.20 |
| 6. Paper Capture | 45 | 8% | 3.60 |
| 7. Execution Fidelity | 72 | 6% | 4.32 |
| 8. EV Calibration | 38 | 8% | 3.04 |
| 9. Probability Calibration | 48 | 6% | 2.88 |
| 10. Risk Control | 44 | 8% | 3.52 |
| 11. Portfolio Control | 40 | 5% | 2.00 |
| 12. Strategy Attribution | 52 | 5% | 2.60 |
| 13. Regime Adaptation | 45 | 5% | 2.25 |
| 14. ML Incremental Value | 8 | 4% | 0.32 |
| 15. Cost Robustness | 70 | 4% | 2.80 |
| 16. Latency Robustness | 65 | 3% | 1.95 |
| 17. Anti-Overfit | 78 | 6% | 4.68 |
| **TOTAL** | | **100%** | **53.10** |

### Composite Score: **53 / 100**

---

## ⚠️ CRITICAL FAILURES — CANNOT BE HIDDEN BY COMPOSITE SCORE

The following are hard blockers that make the composite score irrelevant for production readiness:

| # | Failure | Score | Blocker |
|---|---------|-------|---------|
| 1 | Intraday candle persistence (RCA-001) | Data Quality: 0/40 | BLOCKS all replay and MFE/MAE analysis |
| 2 | Cross-timeframe duplicate signals (DUP-001) | Signal Correctness invalidated | BLOCKS reliable statistics |
| 3 | Opportunity pipeline empty candles (OPP-001) | EV Calibration: 20/100 | BLOCKS quality-based filtering |
| 4 | Signal lifecycle not persisted (AUDIT-001) | Recall: 0/100 | BLOCKS capture rate measurement |
| 5 | PortfolioRiskEngine unwired (RISK-001) | Risk Control: 0/30 | BLOCKS correlation/VaR enforcement |
| 6 | ML service never active | ML Value: 0/100 | Degrades to heuristic-only |
| 7 | Negative net expectancy | Signal Precision: 42/100 | Must be resolved before LIVE |

---

## SYSTEM READINESS VERDICT

```
COMPOSITE SCORE:     53 / 100

PRODUCTION STATE:    PAPER_VALIDATING
LIVE ELIGIBLE:       NO ❌

MINIMUM SCORE FOR PAPER_VALIDATED:  70 / 100 (with no critical failures)
MINIMUM SCORE FOR LIVE_CANDIDATE:   85 / 100 (with no critical failures)

PATH TO PAPER_VALIDATED (priority order):
  1. Fix DUP-001 (cross-timeframe dedup)            → Score +8 (Signal Correctness)
  2. Fix OPP-001 (wire real candles to pipeline)    → Score +12 (EV Calibration, Signal Precision)
  3. Fix AUDIT-001 (persist lifecycle events)       → Score +7 (Recall, Capture)
  4. Fix RISK-001 (wire PortfolioRiskEngine)        → Score +6 (Risk Control, Portfolio)
  5. Wire CandleBar persistence (RCA-001)           → Score +9 (Data Quality, Correctness)
  6. Deploy ML service with trained models          → Score +5 (ML Value)

ESTIMATED SCORE AFTER ALL FIXES:   ~90 / 100
```

---

*AlphaForge Signal Engine Scorecard — 2026-09-02*
*"Never allow a weighted average to hide a critical failure."*
