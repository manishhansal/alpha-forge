# AlphaForge V6 — Alpha Research Report

> **Date:** September 1, 2026  
> **Classification:** Internal Research Document  
> **Scope:** Full strategy universe evaluation framework  
> **Version:** V6.0.0  
> **Status:** Research Platform Initialised — Awaiting Backtest Execution

---

## 1. Executive Summary

AlphaForge V6 transforms the platform from a collection of sophisticated strategies into an **evidence-driven quant research platform**. This report documents the research framework, the strategy universe, the evaluation methodology, and the current validation status.

**Key facts:**

- 18 strategies registered and inventoried
- 18 hypotheses formally declared (17 DEFINED, 1 UNVALIDATED)
- 0 strategies have passed Walk-Forward Validation (pipeline not yet executed)
- 1 strategy in SHADOW status (INDIA_AI_SIGNALS — most mature)
- 10 strategies in RESEARCH status
- 6 strategies in RESEARCH status (India F&O scanners)
- All research infrastructure in place — awaiting backtest pipeline execution

**Critical principle this report enforces:**

> BACKTEST PROFIT IS NOT SUFFICIENT EVIDENCE. In-sample performance must never be used as promotion evidence. Every metric cited in this report must be out-of-sample.

---

## 2. Strategy Inventory

See `docs/STRATEGY_INVENTORY.md` for the complete per-strategy breakdown.

### 2.1 Universe Overview

| Category | Strategies | Market |
|----------|-----------|--------|
| TREND_FOLLOWING | 4 | CRYPTO (UT_SMC, EMA_PULLBACK, FIB_PULLBACK) + NSE (FNO_TREND) |
| MEAN_REVERSION | 3 | CRYPTO (VWAP_SWEEP_TREND, RANGE_SCALP, VWAP_REVERSION) |
| MOMENTUM | 2 | CRYPTO (NEWS_MOMENTUM) + NSE (INDIA_MOMENTUM) |
| ORDERFLOW/LIQUIDITY | 3 | CRYPTO (ORDERFLOW_SWEEP, INSTITUTIONAL_SMC, AI_INSTITUTIONAL_PRO) |
| BREAKOUT | 2 | NSE (FNO_RANGE_EXPANSION, INDIA_VOLUME_BREAKOUT) |
| OPTIONS_FLOW | 1 | NSE (INDIA_OI_BUILDUP) |
| STATISTICAL | 2 | NSE (INDIA_AI_SIGNALS) + User-defined (STRATEGY_LAB_USER) |
| Super-confluence | 1 | NSE (INDIA_SUPER_CONFLUENCE) |

---

## 3. Strategy Hypotheses

### 3.1 Hypothesis Declaration Status

All 17 operational strategies have formally declared hypotheses. Each hypothesis specifies:
- **HYPOTHESIS** — the precise predictive claim
- **MARKET INEFFICIENCY** — the structural reason the edge should exist
- **EXPECTED EDGE** — quantified performance expectation
- **EXPECTED FAILURE MODE** — exactly when the strategy should fail
- **EXPECTED REGIME** — which market regimes the strategy should outperform
- **WHAT WOULD INVALIDATE** — specific, falsifiable criteria

### 3.2 Key Hypotheses Summary

**UT_SMC:** ATR trail flip + SMC structure confirmation increases follow-through probability in trending regimes. Invalidated by OOS Sharpe < 0.4 or Sharpe collapse across keyValue neighbourhood.

**INDIA_AI_SIGNALS:** 14-factor confluence model produces signals with predictive value exceeding any single factor. Invalidated by ECE > 0.10, OOS Sharpe < 0.5, or Grade D signals outperforming Grade S.

**RANGE_SCALP:** BB width contraction with RSI extreme identifies range-bound mean-reversion entries. Invalidated by profitability in BULL_TRENDING regime (the strategy should fail there by design).

**FNO_TREND:** 14-condition Chartink screener identifies institutional accumulation phase in NSE F&O. Invalidated by OOS Sharpe < 0.5 or removing any 5 conditions improving OOS Sharpe.

---

## 4. Research Datasets

### 4.1 Canonical Dataset Definitions

| Dataset ID | Provider | Universe | Period | Timeframe | Fingerprint |
|-----------|----------|----------|--------|-----------|-------------|
| NSE_FNO_DAILY_5Y | Yahoo | NSE F&O (~170 stocks + 4 indices) | 2020–2025 | 1d | SHA-256 on generation |
| NSE_FNO_DAILY_2Y | Yahoo | NSE F&O | 2023–2025 | 1d | SHA-256 on generation |
| CRYPTO_5M_3Y | Binance | BTCUSDT, ETHUSDT, SOLUSDT | 2022–2025 | 5m | SHA-256 on generation |
| CRYPTO_1M_1Y | Binance | BTCUSDT, ETHUSDT, SOLUSDT | 2024–2025 | 1m | SHA-256 on generation |

All datasets are fingerprinted with SHA-256 before use. Any change to the underlying data invalidates the fingerprint and requires experiment re-registration.

### 4.2 Missing Data Policy

- NSE F&O: FORWARD_FILL (holiday gaps filled with prior close)
- Crypto: DROP (do not fill gaps; crypto data is nearly continuous)

---

## 5. In-Sample / Out-of-Sample Governance

### 5.1 Split Structure

Every experiment declares three non-overlapping periods:

| Period | Purpose | NSE F&O Main | Crypto 5m Main |
|--------|---------|-------------|---------------|
| DEVELOPMENT | Parameter search, model training | 2020–2022 | 2022–2023 |
| VALIDATION | Hyperparameter checking (not final OOS) | 2023 Q1–Q4 | 2024 Q1–Q3 |
| FINAL_OOS | Untouched test — never used for optimisation | 2024–2025 | 2025 |

### 5.2 Leakage Prevention

The `validateSplitIntegrity()` function enforces:
- Development end < Validation start (with ≥1 calendar day embargo)
- Validation end < Final OOS start (with ≥1 calendar day embargo)
- Hard assertion in `generateWalkForwardWindows()` that `testStart > trainEnd`

These are tested in `tests/research/oos-leakage.test.ts` (15 tests). Any temporal leak throws immediately rather than silently corrupting research results.

### 5.3 Validation Methods

| Strategy Type | Recommended Method |
|--------------|-------------------|
| Crypto daily/5m (≥200 bars) | PURGED_KFOLD with 48-bar embargo |
| NSE F&O daily | WALK_FORWARD (anchored, 5-bar embargo) |
| High-frequency 1m | WALK_FORWARD (fixed, 60-bar embargo) |
| ML models | CPCV (N=6, k=2) |

---

## 6. Performance Framework

### 6.1 Metrics Computed Per Period

The `StrategyPerformanceAnalyzer` computes 35 metrics per period:

**Return metrics:** TOTAL_RETURN, CAGR, SHARPE, SORTINO, CALMAR, PROFIT_FACTOR

**Risk metrics:** MAX_DRAWDOWN, AVERAGE_DRAWDOWN, DRAWDOWN_DURATION, ULCER_INDEX, TAIL_LOSS

**Trade quality:** WIN_RATE, LOSS_RATE, EXPECTANCY, AVG_WIN, AVG_LOSS, PAYOFF_RATIO, SQN

**Activity:** TRADE_COUNT, TRADES_PER_MONTH, TURNOVER, AVG_HOLD_TIME, EXPOSURE_TIME

**Statistical validity:** T_STATISTIC, P_VALUE, STATISTICALLY_SIGNIFICANT

**Distribution:** SKEWNESS, KURTOSIS, BEST_TRADE, WORST_TRADE

### 6.2 Periods Tracked

- IN_SAMPLE (development period)
- VALIDATION (intermediate check — not used for promotion decisions)
- FINAL_OOS (authoritative — all promotion decisions based on this)
- PAPER (live paper trading results)
- SHADOW (shadow mode results)

**IN_SAMPLE PERFORMANCE IS NEVER USED AS PROMOTION EVIDENCE.**

---

## 7. Transaction Cost Attribution

### 7.1 Cost Models

**NSE F&O Options:**
- Brokerage: ₹20/order flat (Zerodha model)
- STT: 0.0125% on premium buy
- Exchange charges: 0.053% (NSE options)
- GST: 18% on brokerage + exchange
- Stamp duty: 0.003% buy side
- Slippage: 0.05% per side
- Spread: 0.03% per side

**Crypto Perpetuals (Binance):**
- Taker fee: 0.04% × 2 sides = 0.08% round-trip
- Slippage: 0.04% per side
- Spread: 0.02% per side

### 7.2 Cost Stress Testing

Every strategy is tested at 1×, 1.5×, 2×, 3× baseline costs.

**COST_FRAGILE** flag is set if the strategy becomes unprofitable at 2× costs. This is a hard promotion blocker for WALK_FORWARD_VALIDATED.

**Break-even multiple:** The minimum cost scaling at which the strategy becomes unprofitable. A robust strategy should have a break-even multiple ≥ 2.5×.

### 7.3 Current Status

No strategies have had cost attribution computed yet — the research pipeline has not been executed. All strategies are in RESEARCH or SHADOW status. Cost attribution will be generated when the backtest pipeline runs against the canonical datasets.

---

## 8. Regime Attribution

### 8.1 Regime Classification

Every trade is attributed to one of 10 regimes:

| Regime | Classification Heuristic |
|--------|------------------------|
| BULL_TRENDING | ADX > 25 + SMA20 slope > 0.2% |
| BEAR_TRENDING | ADX > 25 + SMA20 slope < -0.2% |
| RANGE_BOUND | ADX < 20 |
| HIGH_VOLATILITY | ATR > 1.5× 20-day avg |
| LOW_VOLATILITY | ATR < 0.7× 20-day avg |
| HIGH_LIQUIDITY | Volume > 1.5× avg |
| LOW_LIQUIDITY | Volume < 0.5× avg |
| EVENT_DRIVEN | External tag (earnings, RBI/FOMC) |
| EXPIRY_DAY | NSE weekly/monthly expiry calendar |
| NORMAL_DAY | None of the above |

The ML `MarketRegimeClassifier` (XGBoost) overrides the heuristic when available.

### 8.2 Declared vs Validated Regimes

| Strategy | Declared Good Regimes | Declared Failure Regimes |
|----------|----------------------|------------------------|
| UT_SMC | BULL_TRENDING, BEAR_TRENDING | RANGE_BOUND |
| RANGE_SCALP | RANGE_BOUND, LOW_VOL | BULL_TRENDING, BEAR_TRENDING |
| EMA_PULLBACK | BULL_TRENDING, BEAR_TRENDING | RANGE_BOUND |
| INDIA_AI_SIGNALS | BULL/BEAR_TRENDING, NORMAL_DAY, EXPIRY_DAY | HIGH_VOLATILITY |
| FNO_TREND | BULL_TRENDING | BEAR_TRENDING, RANGE_BOUND |

**A strategy performing well in its declared failure regime is evidence of model misspecification, not skill.**

---

## 9. Strategy Correlation & Redundancy

### 9.1 Correlation Framework

Five correlation metrics are computed between every strategy pair:
1. Return correlation (Pearson)
2. Signal correlation (directional agreement)
3. Trade overlap fraction (active days in common)
4. Drawdown correlation
5. Tail-loss correlation (lower 10th percentile)

### 9.2 Cluster Thresholds

Strategies are hierarchically clustered using complete linkage with a threshold of 0.70.

**Capital constraints per cluster:**
- 2-strategy cluster: max 25% combined allocation
- 3-strategy cluster: max 20% combined allocation
- 4+ strategy cluster: max 15% combined allocation

### 9.3 Expected Redundancy Risks

Based on strategy logic review (before empirical correlation is computed):

**Likely correlated:** `INSTITUTIONAL_SMC` and `AI_INSTITUTIONAL_PRO` both use BOS + sweep + VWAP + kill zone. These may form a cluster and be capital-constrained together.

**Likely correlated:** `UT_SMC` and `EMA_PULLBACK` both trade trend-continuation in BULL_TRENDING regime. May show moderate correlation.

**Likely uncorrelated:** Any trending strategy vs `RANGE_SCALP` or `VWAP_REVERSION` (opposite regime preferences).

---

## 10. Alpha Decay Monitor

### 10.1 Decay States

| State | Condition | Action |
|-------|-----------|--------|
| HEALTHY | Rolling metrics within 1σ of baseline | No action |
| WARNING | Rolling metrics 1-2σ below baseline | Monitor; reduce position size |
| DEGRADED | Rolling metrics 2-3σ below baseline | Reduce to 40% capital; paper-only |
| CRITICAL | Rolling metrics >3σ below baseline | Paper-only; auto-demotion triggered |
| DISABLED | Strategy disabled by demotion engine | No new trades; emergency close |

### 10.2 Tracked Metrics

Rolling window: last 52 weekly snapshots.

- Rolling Sharpe (vs OOS baseline)
- Rolling Expectancy
- Rolling Win Rate
- Rolling Profit Factor
- Rolling Max Drawdown
- Signal Quality (composite of p-value + kurtosis)

### 10.3 Current Status

No decay monitoring data yet — requires OOS baseline from the backtest pipeline.

---

## 11. Monte Carlo Robustness

### 11.1 Simulation Types (7 × 10,000 iterations each)

| Simulation | Description |
|-----------|-------------|
| TRADE_SHUFFLE | Random ordering of the historical trade sequence |
| BOOTSTRAP | Sample with replacement from historical trades |
| RETURN_PERTURB | Add Gaussian noise (30% of trade-level σ) |
| SLIPPAGE_PERTURB | Add extra Uniform(0, 0.3%) slippage per side |
| COST_PERTURB | Scale total costs by Uniform(0.8, 2.5) |
| MISSED_TRADES | Skip 10–30% of trades randomly |
| PARTIAL_FILL | Reduce position size 30–70% on random trades |

### 11.2 Robustness Score Interpretation

| Score | Label | Interpretation |
|-------|-------|----------------|
| 70–100 | ROBUST | Performance is stable across all perturbations |
| 45–69 | MODERATE | Some sensitivity to trade ordering or costs |
| 0–44 | FRAGILE | Performance heavily dependent on specific sequence; do not promote |

**FRAGILE strategies are blocked from WALK_FORWARD_VALIDATED promotion.**

---

## 12. Parameter Stability

### 12.1 Stability Score Bands

| Label | Condition |
|-------|-----------|
| STABLE | All parameters have flat neighbourhood (CV < 0.3) |
| MODERATE | Some parameters show moderate sensitivity |
| OVERFIT_SUSPECTED | Any parameter is a knife edge: best value surrounded by losses |

### 12.2 OVERFIT_SUSPECTED Criteria

A parameter is flagged OVERFIT_SUSPECTED if:
- Any neighbour Sharpe < optimal × 0.3 (>70% drop), OR
- Sharpe range across neighbourhood > 3.0, OR
- Canonical value is a local maximum with negative-Sharpe direct neighbours

**OVERFIT_SUSPECTED blocks WALK_FORWARD_VALIDATED promotion.**

### 12.3 Parameters Requiring Stability Testing

| Strategy | Parameters to Test | Canonical | Step |
|----------|------------------|-----------|------|
| UT_SMC | keyValue | 1 | 0.2 |
| RANGE_SCALP | bbWidth threshold | 4.5 | 0.5 |
| EMA_PULLBACK | EMA periods (9, 20, 50) | [9,20,50] | [1,2,5] |
| INDIA_AI_SIGNALS | minMagnitude threshold | 0.22 | 0.02 |
| FNO_TREND | ADX threshold | 20 | 2 |

---

## 13. Overfitting Risk

### 13.1 Multiple Testing Corrections Applied

**Deflated Sharpe Ratio (DSR):** Adjusts observed Sharpe for the number of strategies and parameters tested. DSR < observed Sharpe; DSR < 0 means the strategy is likely the product of selection bias.

**Probability of Backtest Overfitting (PBO):** Estimated from CPCV ratio of IS rank vs OOS rank. PBO > 0.5 means the best IS strategy is more likely than not to underperform on OOS data.

**Bonferroni correction:** Family-wise error rate α/n_tests.

**Benjamini-Hochberg FDR:** Less conservative multiple testing correction.

### 13.2 Risks in AlphaForge's Universe

AlphaForge contains 18 registered strategies across two markets. The research team has been actively developing and iterating. The following risks apply:

- **Selection bias:** Strategies were not generated randomly; they were designed with knowledge of historical market conditions.
- **Multiple testing:** If 100 parameter combinations were tested for a given strategy, ~5 will appear significant by chance at α=0.05.
- **Regime selection:** Strategies may have been tuned on periods that were particularly favourable.

**Mitigation:** All performance evidence for promotion must come from FINAL_OOS periods. The deflated Sharpe ratio must remain positive. PBO must be < 0.5. These are hard gates in the `MultipleTestingGuard`.

---

## 14. Signal Calibration

### 14.1 Calibration Requirements

A signal that claims 70% win probability must win approximately 70% of the time. Poorly calibrated confidence is dangerous because it leads to incorrect position sizing.

**Metrics:**
- **Brier Score:** Mean squared error of probability predictions. 0 = perfect, 0.25 = no-skill baseline.
- **ECE (Expected Calibration Error):** Weighted MAE of predicted vs actual win rate per bin. < 0.05 = well-calibrated.
- **Well-Calibrated flag:** Set when ECE < 0.05.

### 14.2 Calibration Status

`INDIA_AI_SIGNALS` has the most developed confidence scoring system (grades S/A/B/C/D based on composite score). Its calibration has been implemented and is awaiting OOS outcome data.

The current `calibrateWinProbability()` function (logistic curve, offset 0.38) targets 47–78% win probability range. Actual calibration must be verified against realised outcomes.

### 14.3 INDIA_AI_SIGNALS Calibration Thresholds (Declared)

| Grade | Score | Declared Win Probability |
|-------|-------|------------------------|
| S | ≥ 0.82 | ~78% |
| A | ≥ 0.68 | ~70% |
| B | ≥ 0.54 | ~60% |
| C | ≥ 0.38 | ~52% |
| D | < 0.38 | ~47% |

These declared rates must be verified against OOS outcomes. If realised win rates deviate by >10 percentage points from predicted, the calibration is broken.

---

## 15. Strategy Ablation

### 15.1 Ablation Framework

Every complex multi-component strategy must support ablation testing. For each component:
1. Run full strategy (with component)
2. Run strategy without that component (filter trades that fired with component enabled)
3. Compare OOS Sharpe, Expectancy, Win Rate

A `LOW_VALUE_COMPONENT` is marked when removing it does not degrade OOS Sharpe by more than 0.05.

### 15.2 Priority Ablation Tests

| Strategy | High-Priority Components to Ablate |
|----------|-----------------------------------|
| INSTITUTIONAL_SMC | Kill zone gate (does it add value beyond score?) |
| AI_INSTITUTIONAL_PRO | HTF EMA bias gate (does removing it improve or degrade?) |
| INDIA_AI_SIGNALS | ML rank boost (does the ML signal add value over base?) |
| INDIA_AI_SIGNALS | Super confluence score (10% weight — is it additive?) |
| FNO_TREND | Any 5 of 14 conditions (are all 14 necessary?) |

---

## 16. Promotion Pipeline

### 16.1 Evidence Gates Per Stage

```
EXPERIMENTAL → RESEARCH
  Gate: HYPOTHESIS_DEFINED

RESEARCH → BACKTEST_VALIDATED
  Gate: MIN_TRADE_COUNT (≥30 OOS trades)
  Gate: POSITIVE_EXPECTANCY (OOS expectancy > 0)
  Gate: MAX_DRAWDOWN_LIMIT (OOS max DD < 30%)
  Gate: COST_ADJUSTED_PROFITABLE (net PnL after costs > 0)
  Gate: SHARPE_MINIMUM (OOS Sharpe ≥ 0.3)
  Gate: HYPOTHESIS_DEFINED

BACKTEST_VALIDATED → WALK_FORWARD_VALIDATED
  Gate: OOS_SHARPE_STABLE (≥ 0.5)
  Gate: PARAMETER_NOT_OVERFIT (not OVERFIT_SUSPECTED)
  Gate: MONTE_CARLO_NOT_FRAGILE (not FRAGILE)
  Gate: MIN_TRADE_COUNT_OOS (≥50 OOS trades)
  Gate: NOT_COST_FRAGILE (survives 2× costs)

WALK_FORWARD_VALIDATED → SHADOW
  Gate: SHADOW_PERIOD_MIN (≥10 shadow trades)
  Gate: SHADOW_SHARPE (shadow Sharpe ≥ 0.3)
  Gate: DECAY_STATE_OK (not CRITICAL or DISABLED)

SHADOW → PAPER
  Gate: PAPER_MIN_TRADES (≥20 paper trades)
  Gate: PAPER_POSITIVE_EXPECTANCY
  Gate: PAPER_MAX_DRAWDOWN (< 25%)
  Gate: NO_MATERIAL_BACKTEST_DRIFT
  Gate: DECAY_STATE_OK (HEALTHY or WARNING)

PAPER → LIVE_CANDIDATE
  Gate: PAPER_SESSIONS_MIN (≥20 sessions)
  Gate: PAPER_SESSIONS_PREFERRED (≥40 sessions)
  Gate: PAPER_SHARPE (≥ 0.6)
  Gate: PAPER_PROFIT_FACTOR (≥ 1.2)
  Gate: DECAY_STATE_HEALTHY
  Gate: COST_NOT_FRAGILE

LIVE_CANDIDATE → MANUAL_APPROVAL → LIVE
  Gate: MANUAL_HUMAN_APPROVAL (explicit token + approvedBy — NEVER automatic)
```

### 16.2 Current Pipeline Status

| Strategy | Current Stage | Next Gate Blocker |
|----------|--------------|------------------|
| INDIA_AI_SIGNALS | SHADOW | ≥10 shadow trades with Sharpe ≥ 0.3 |
| All others | RESEARCH | Backtest pipeline execution |
| STRATEGY_LAB_USER | EXPERIMENTAL | Hypothesis definition per individual strategy |

---

## 17. Strategy Demotion

### 17.1 Automatic Demotion Triggers

| Trigger | Threshold | Auto-Demotion |
|---------|-----------|--------------|
| ALPHA_DECAY | Decay state = CRITICAL | LIVE → DEGRADED |
| EXCESSIVE_DRAWDOWN | Paper DD > 40% | LIVE/PAPER → previous stage |
| COST_DETERIORATION | COST_FRAGILE | Block promotion; demote if live |
| MODEL_DRIFT | ML model performance degrades | WARNING → DEGRADED |
| REPEATED_ERRORS | ≥10 consecutive errors | HARD_KILL |

### 17.2 Kill Switch Levels

| Level | Effect |
|-------|--------|
| SOFT_KILL | No new trades; existing trades managed normally |
| HARD_KILL | No new trades; existing exposure follows EMERGENCY_CLOSE policy |

Kill switches are recorded with: `trigger`, `reason`, `activatedAt`. They are never automatically removed — requires explicit `deactivateKillSwitch()` call.

---

## 18. Confidence Score

### 18.1 Component Weighting (documented)

| Component | Weight | Score Source |
|-----------|--------|-------------|
| OOS Performance | 0.25 | Normalised OOS Sharpe (logistic curve) |
| Walk-Forward Stability | 0.15 | Validation period Sharpe |
| Monte Carlo Robustness | 0.15 | MC overall score / 100 |
| Parameter Stability | 0.10 | Stability score / 100 (0 if OVERFIT_SUSPECTED) |
| Cost Robustness | 0.10 | Break-even multiple normalised to 0-100 |
| Regime Consistency | 0.10 | Regime fit score × 100 |
| Paper Performance | 0.10 | Paper Sharpe (cross-validated vs OOS) |
| Statistical Confidence | 0.05 | (1 − p_value) × 100 |

Unavailable components have their weight redistributed proportionally among available components.

### 18.2 Score Bands

| Band | Score Range | Interpretation |
|------|------------|----------------|
| HIGH_CONFIDENCE | 90–100 | Robust evidence across all dimensions |
| VALIDATED | 75–89 | Strong evidence; minor gaps acceptable |
| WATCH | 60–74 | Moderate evidence; increased monitoring |
| DEGRADED | 40–59 | Insufficient evidence or deteriorating |
| DISABLED | 0–39 | No promotion; immediate review required |

---

## 19. Paper Performance vs Backtest

### 19.1 Material Drift Thresholds

| Metric | Threshold for Material Drift |
|--------|---------------------------|
| Sharpe | > 30% relative change |
| Expectancy | > 50% relative change |
| Win Rate | > 10 percentage point absolute change |
| Profit Factor | > 25% relative change |
| Max Drawdown | > 50% relative change |

If any metric shows material drift, `requiresInvestigation = true` and promotion to LIVE_CANDIDATE is blocked.

### 19.2 INDIA_AI_SIGNALS Current Status

`INDIA_AI_SIGNALS` is in SHADOW status. Backtest vs shadow comparison will be computed as shadow data accumulates. Key items to monitor:

- **Signal drift:** Are the 14-factor composite scores staying calibrated?
- **Fill quality:** Are TP1/TP2/TP3 levels being filled at expected prices?
- **Slippage:** Is actual slippage within 2× the modelled slippage?
- **Regime distribution:** Is the shadow period seeing similar regimes to the backtest?

---

## 20. Known Limitations

### 20.1 Data Limitations

1. **Yahoo Finance survivorship bias:** NSE OHLCV from Yahoo may have survivorship bias. Strategies tested on Yahoo historical data may overstate performance by excluding companies that delisted during the period.

2. **Angel One SmartAPI real-time data:** PCR and OI build-up data is only available during market hours. Shadow/paper testing should be constrained to market hours only.

3. **Crypto data completeness:** Binance historical data before 2021 may have gaps during exchange maintenance and flash crashes. The DROP missing data policy means these periods are excluded.

4. **Options premium data:** Historical NSE options premium data is not readily available at tick level. The INDIA_AI_SIGNALS strategy uses daily-level options data (PCR, ATM IV, max-pain), which limits intraday validation.

### 20.2 Methodological Limitations

1. **No live data backtest:** All backtests use historical OHLCV. Market impact, partial fills, and execution quality are simulated, not observed.

2. **Small OOS samples expected:** Some strategies (particularly INSTITUTIONAL_SMC with 7/9 confluence threshold) may have very few OOS trades per year, limiting statistical significance.

3. **Regime classifier dependency:** `INDIA_AI_SIGNALS` relies on the ML `MarketRegimeClassifier` for the market tape factor. If the classifier performs poorly in live trading, the signal quality degrades.

4. **Single-provider backtest:** Backtests use Yahoo as the primary provider. Live performance uses Angel One → Upstox → Yahoo failover. Provider differences may cause backtest vs live divergence.

### 20.3 Research Gaps

1. **No tick-level data:** All strategies are backtested on OHLCV bars. Strategies using intrabar stops (VWAP_REVERSION, RANGE_SCALP) may have slightly different real-world performance.

2. **Correlation not yet computed:** Strategy clusters and capital constraints are based on logic review, not empirical return correlation data.

3. **No live performance data:** With 0 strategies at LIVE status, there is no real-world validation of any strategy.

---

## 21. Research Roadmap

### Phase 1 (Immediate): Backtest Pipeline Execution

1. Run crypto strategies (UT_SMC, VWAP_SWEEP_TREND, NEWS_MOMENTUM, RANGE_SCALP, EMA_PULLBACK, VWAP_REVERSION, ORDERFLOW_SWEEP, FIB_PULLBACK, INSTITUTIONAL_SMC, AI_INSTITUTIONAL_PRO) against CRYPTO_5M_3Y dataset
2. Compute full cost attribution using CRYPTO_PERP_COST_MODEL
3. Run Monte Carlo (7 types × 10,000 iterations) for each strategy
4. Run parameter stability tests for key parameters
5. Compute regime attribution using heuristic classifier
6. Compute strategy correlation matrix

### Phase 2 (30 days): India F&O Backtesting

1. Run NSE F&O strategies against NSE_FNO_DAILY_5Y dataset
2. Apply NSE_FNO_FUTURES_COST_MODEL (futures) and NSE_FNO_OPTIONS_COST_MODEL (options)
3. Compute regime attribution using ML MarketRegimeClassifier
4. Cross-validate INDIA_AI_SIGNALS shadow results against backtest

### Phase 3 (60 days): Confidence Scoring & Promotion

1. Generate full confidence scores for all strategies with complete data
2. Promote any strategies that pass BACKTEST_VALIDATED gates
3. Begin ablation testing for complex multi-component strategies
4. Begin WALK_FORWARD_VALIDATED promotion evaluations

### Phase 4 (Ongoing): Paper Trading Validation

1. Minimum 20 paper trading sessions per strategy before LIVE_CANDIDATE consideration
2. Ensure regime diversity (trending + range + expiry + high-vol sessions)
3. Compare paper fills against backtest slippage assumptions

---

## 22. Final Research Verdict (Current)

**Q: Which strategies have evidence of real alpha?**

> **A: None yet.** The research pipeline has not been executed. All strategies are in RESEARCH or SHADOW status with no OOS backtest results. `INDIA_AI_SIGNALS` has the most operational evidence (shadow mode) but lacks sufficient shadow trades for a statistically significant verdict.

**Q: Which strategies fail after costs?**

> **A: Unknown.** Cost attribution requires backtest execution first.

**Q: Which strategies only work in specific regimes?**

> **A: Declared (based on hypothesis):** RANGE_SCALP and VWAP_REVERSION are explicitly designed to fail in trending regimes. FNO_TREND is designed to fail in non-trending regimes. Empirical validation pending.

**Q: Which signals are redundant?**

> **A: Suspected (based on logic):** INSTITUTIONAL_SMC and AI_INSTITUTIONAL_PRO share most components and likely have high signal correlation. Empirical correlation matrix pending.

**Q: Which strategies should be promoted?**

> **A: None.** Promotion gates require OOS backtest results. Execute the research pipeline first.

---

*This report will be updated after each research pipeline execution cycle.*
