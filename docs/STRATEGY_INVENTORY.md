# AlphaForge V6 — Canonical Strategy Inventory

> **Generated:** September 1, 2026  
> **Registry source:** `src/lib/research/registry/strategy-registry.ts`  
> **Hypothesis source:** `src/lib/research/hypothesis/strategy-hypothesis.ts`  
> **Total strategies:** 18  
> **Principle:** No strategy exists outside the `StrategyRegistry`. Every strategy requires a declared hypothesis before advancing past EXPERIMENTAL.

---

## Summary

| Market | Count | Statuses |
|--------|-------|----------|
| CRYPTO | 11 | 10 × RESEARCH, 1 × EXPERIMENTAL |
| NSE_FNO | 7 | 5 × RESEARCH, 1 × SHADOW, 1 × EXPERIMENTAL |

---

## Section 1 — Crypto Scalping Strategies

### 1.1 UT Bot + SMC (`UT_SMC`)

| Field | Value |
|-------|-------|
| **strategyId** | `UT_SMC` |
| **version** | 1.0.0 |
| **market** | CRYPTO |
| **instrumentType** | CRYPTO_PERP |
| **timeframe** | 5m |
| **strategyCategory** | TREND_FOLLOWING |
| **status** | RESEARCH |
| **hypothesisStatus** | DEFINED |

**Entry Logic:** ATR trailing-stop flip (UT Bot, keyValue=1, ATR period=10) confirmed by SMC BOS/CHoCH pivot structure. Long when close crosses above trail in bullish pivot context; short when crosses below in bearish pivot context.

**Exit Logic:** Target 2×ATR beyond entry; hard stop at 1×ATR.

**Stop Loss:** 1×ATR beyond entry in unfavourable direction.

**Position Sizing:** Fixed-fraction 1% risk per trade, scaled by confidence.

**Required Data:** OHLCV 5m, ATR(10), Swing pivots

**Expected Holding Period:** 5–60 minutes

**Expected Regimes:** BULL_TRENDING, BEAR_TRENDING

**Hypothesis:** When the ATR trailing stop flips direction AND price is breaking a structural pivot (BOS/CHoCH), the probability of follow-through is above chance because the dual confirmation filters out noise-driven trail flips in congestion zones.

**What Would Invalidate:** OOS Sharpe < 0.4 after full transaction costs over ≥200 trades. Sharpe collapse when keyValue changes from 1→0.8 or 1→1.2.

---

### 1.2 VWAP Sweep + Trend (`VWAP_SWEEP_TREND`)

| Field | Value |
|-------|-------|
| **strategyId** | `VWAP_SWEEP_TREND` |
| **version** | 1.0.0 |
| **market** | CRYPTO |
| **instrumentType** | CRYPTO_PERP |
| **timeframe** | 5m |
| **strategyCategory** | MEAN_REVERSION |
| **status** | RESEARCH |
| **hypothesisStatus** | DEFINED |

**Entry Logic:** EMA50 rising (slope > 0). Price sweeps prior swing H/L with current bar wick, stretched ≥0.8×ATR from VWAP. Entry on rejection candle closing in upper/lower third.

**Exit Logic:** Target = VWAP; stop = sweep wick ±0.25×ATR.

**Expected Regimes:** BULL_TRENDING, BEAR_TRENDING, NORMAL_DAY

**Hypothesis:** VWAP acts as a fair-value anchor. When price sweeps a prior swing H/L and is significantly stretched from VWAP, the subsequent mean-reversion back to VWAP has elevated probability.

**What Would Invalidate:** OOS Sharpe < 0.4. Win-rate below 45%. Average win < 0.8× average loss.

---

### 1.3 News Momentum (`NEWS_MOMENTUM`)

| Field | Value |
|-------|-------|
| **strategyId** | `NEWS_MOMENTUM` |
| **version** | 1.0.0 |
| **market** | CRYPTO |
| **instrumentType** | CRYPTO_PERP |
| **timeframe** | 5m |
| **strategyCategory** | MOMENTUM |
| **status** | RESEARCH |
| **hypothesisStatus** | DEFINED |

**Entry Logic:** Volume ≥2.8× 20-bar avg AND bar range ≥1.8×ATR AND body in top/bottom 60% AND close above/below SMA20.

**Expected Regimes:** HIGH_VOLATILITY, EVENT_DRIVEN

**Hypothesis:** Explosive moves (volume ≥2.8×, range ≥1.8×ATR) represent information-driven dislocations that exhibit short-term momentum continuation as information diffuses through the market.

**What Would Invalidate:** Net expectancy ≤ 0 after 2× slippage stress-test. Strategy becomes COST_FRAGILE at 1.5× costs.

---

### 1.4 Range Scalp (`RANGE_SCALP`)

| Field | Value |
|-------|-------|
| **strategyId** | `RANGE_SCALP` |
| **version** | 1.0.0 |
| **market** | CRYPTO |
| **instrumentType** | CRYPTO_PERP |
| **timeframe** | 5m |
| **strategyCategory** | MEAN_REVERSION |
| **status** | RESEARCH |
| **hypothesisStatus** | DEFINED |

**Entry Logic:** BB width ≤4.5×ATR (range-bound gate). BB upper/lower tagged; RSI ≤32 (long) or ≥68 (short); close back inside band.

**Expected Regimes:** RANGE_BOUND, LOW_VOLATILITY

**Hypothesis:** In range-bound markets (BB width contracted), price oscillates between upper/lower bands. RSI extreme + close back inside represents exhaustion of the short-term move.

**What Would Invalidate:** OOS Sharpe < 0.5 in RANGE_BOUND regime. Win-rate below 55%. Profitable in BULL_TRENDING regime (it should NOT be).

---

### 1.5 EMA Pullback (`EMA_PULLBACK`)

| Field | Value |
|-------|-------|
| **strategyId** | `EMA_PULLBACK` |
| **version** | 1.0.0 |
| **market** | CRYPTO |
| **instrumentType** | CRYPTO_PERP |
| **timeframe** | 5m |
| **strategyCategory** | TREND_FOLLOWING |
| **status** | RESEARCH |
| **hypothesisStatus** | DEFINED |

**Entry Logic:** EMA9 > EMA20 > EMA50 stack + rising slope. Prior bar low pierced EMA9-20 zone. Current bar closes bullish above EMA9.

**Expected Regimes:** BULL_TRENDING, BEAR_TRENDING

**Hypothesis:** In confirmed uptrend (EMA9 > EMA20 > EMA50), pullbacks into the EMA9-20 zone represent temporary imbalances. The trend's momentum reasserts when a confirmation candle closes above EMA9.

---

### 1.6 VWAP Reversion (`VWAP_REVERSION`)

| Field | Value |
|-------|-------|
| **strategyId** | `VWAP_REVERSION` |
| **version** | 1.0.0 |
| **market** | CRYPTO |
| **instrumentType** | CRYPTO_PERP |
| **timeframe** | 5m |
| **strategyCategory** | MEAN_REVERSION |
| **status** | RESEARCH |
| **hypothesisStatus** | DEFINED |

**Entry Logic:** Price ≥1.5×ATR from VWAP. RSI at extreme (≤30 or ≥70). Prior bar more extreme than current (momentum weakening).

**Expected Regimes:** RANGE_BOUND, NORMAL_DAY, HIGH_LIQUIDITY

---

### 1.7 Orderflow Sweep (`ORDERFLOW_SWEEP`)

| Field | Value |
|-------|-------|
| **strategyId** | `ORDERFLOW_SWEEP` |
| **version** | 1.0.0 |
| **market** | CRYPTO |
| **instrumentType** | CRYPTO_PERP |
| **timeframe** | 5m |
| **strategyCategory** | LIQUIDITY |
| **status** | RESEARCH |
| **hypothesisStatus** | DEFINED |

**Entry Logic:** Equal swing H/L cluster within 0.35×ATR. Current bar wick pierces cluster ≥0.15×ATR, closes back inside, volume ≥1.8×avg.

**Expected Regimes:** HIGH_LIQUIDITY, NORMAL_DAY, BULL_TRENDING, BEAR_TRENDING

---

### 1.8 Fib Pullback 1m (`FIB_PULLBACK`)

| Field | Value |
|-------|-------|
| **strategyId** | `FIB_PULLBACK` |
| **version** | 1.0.0 |
| **market** | CRYPTO |
| **instrumentType** | CRYPTO_PERP |
| **timeframe** | 1m |
| **strategyCategory** | TREND_FOLLOWING |
| **status** | RESEARCH |
| **hypothesisStatus** | DEFINED |

**Entry Logic:** Impulse ≥3×ATR in last 12 bars. Pullback reaches 0.5-0.618 Fib without breaking 0.786. Confirmation candle pierces 0.5 Fib zone and closes back through.

**Expected Regimes:** BULL_TRENDING, BEAR_TRENDING

---

### 1.9 Institutional AI SMC (`INSTITUTIONAL_SMC`)

| Field | Value |
|-------|-------|
| **strategyId** | `INSTITUTIONAL_SMC` |
| **version** | 1.0.0 |
| **market** | CRYPTO |
| **instrumentType** | CRYPTO_PERP |
| **timeframe** | 5m |
| **strategyCategory** | ORDERFLOW |
| **status** | RESEARCH |
| **hypothesisStatus** | DEFINED |

**Entry Logic:** 9-component AI score must reach 7/9 PLUS 4 preconditions: trend + VWAP + recent sweep + recent BOS.

**ML Dependencies:** AIScoreAggregator

**Expected Regimes:** BULL_TRENDING, BEAR_TRENDING, HIGH_LIQUIDITY

---

### 1.10 AI Institutional Pro v5 (`AI_INSTITUTIONAL_PRO`)

| Field | Value |
|-------|-------|
| **strategyId** | `AI_INSTITUTIONAL_PRO` |
| **version** | 5.0.0 |
| **market** | CRYPTO |
| **instrumentType** | CRYPTO_PERP |
| **timeframe** | 5m |
| **strategyCategory** | ORDERFLOW |
| **status** | RESEARCH |
| **hypothesisStatus** | DEFINED |

**Entry Logic:** Two-stage gate: (1) Hard gates (EMA20/50 + HTF EMA + RSI + cooldown); (2) 8-factor confluence score must clear mode preset threshold. Mode adapts to timeframe.

**ML Dependencies:** AIScoreAggregator

**Expected Regimes:** BULL_TRENDING, BEAR_TRENDING, NORMAL_DAY

---

## Section 2 — India F&O Strategies

### 2.1 F&O Bullish/Bearish Trend Scanner (`FNO_TREND`)

| Field | Value |
|-------|-------|
| **strategyId** | `FNO_TREND` |
| **version** | 1.0.0 |
| **market** | NSE_FNO |
| **instrumentType** | FUTURES |
| **timeframe** | 1d |
| **strategyCategory** | TREND_FOLLOWING |
| **status** | RESEARCH |
| **hypothesisStatus** | DEFINED |

**Entry Logic:** 14-condition Chartink screener: EMA5>SMA20, WMA10>SMA20, ADX DI+>20, ADX>20, vol>1L, MACD>0, close>prev close, close>SMA50, close>150, DI+>DI−, RSI>50, MACD>signal, SMA20>SMA40 — ALL conditions must pass. Bearish is the mirror.

**Expected Regimes:** BULL_TRENDING

---

### 2.2 F&O Range Expansion WR8 (`FNO_RANGE_EXPANSION`)

| Field | Value |
|-------|-------|
| **strategyId** | `FNO_RANGE_EXPANSION` |
| **version** | 1.0.0 |
| **market** | NSE_FNO |
| **instrumentType** | FUTURES |
| **timeframe** | 1d |
| **strategyCategory** | BREAKOUT |
| **status** | RESEARCH |
| **hypothesisStatus** | DEFINED |

**Entry Logic:** Today H-L is widest of 8 sessions (≥1.2× prior 7-bar max). Bullish candle. Close in upper half. Volume ≥1.5× 20-day avg. Weekly + monthly open below close. SMA20 > SMA50 > SMA200.

**Expected Regimes:** BULL_TRENDING, HIGH_VOLATILITY

---

### 2.3 India F&O Momentum Scanner (`INDIA_MOMENTUM`)

| Field | Value |
|-------|-------|
| **strategyId** | `INDIA_MOMENTUM` |
| **version** | 1.0.0 |
| **market** | NSE_FNO |
| **instrumentType** | FUTURES |
| **timeframe** | 1d |
| **strategyCategory** | MOMENTUM |
| **status** | RESEARCH |
| **hypothesisStatus** | DEFINED |

**Entry Logic:** Top F&O gainers/losers by absolute % change (near-month futures). Angel One SmartAPI first-party; Yahoo fallback.

**Expected Regimes:** BULL_TRENDING, BEAR_TRENDING, HIGH_VOLATILITY

---

### 2.4 India F&O Volume Breakout (`INDIA_VOLUME_BREAKOUT`)

| Field | Value |
|-------|-------|
| **strategyId** | `INDIA_VOLUME_BREAKOUT` |
| **version** | 1.0.0 |
| **market** | NSE_FNO |
| **instrumentType** | FUTURES |
| **timeframe** | 1d |
| **strategyCategory** | BREAKOUT |
| **status** | RESEARCH |
| **hypothesisStatus** | DEFINED |

**Entry Logic:** F&O stocks with today's volume ≥1.5× 20-day average.

**Expected Regimes:** BULL_TRENDING, BEAR_TRENDING

---

### 2.5 India OI Buildup Scanner (`INDIA_OI_BUILDUP`)

| Field | Value |
|-------|-------|
| **strategyId** | `INDIA_OI_BUILDUP` |
| **version** | 1.0.0 |
| **market** | NSE_FNO |
| **instrumentType** | OPTIONS |
| **timeframe** | 1d |
| **strategyCategory** | OPTIONS_FLOW |
| **status** | RESEARCH |
| **hypothesisStatus** | DEFINED |

**Entry Logic:** Open-interest direction × price action (Long/Short Built Up, Short Covering, Long Unwinding). Uses ΔPE OI − ΔCE OI. Angel One SmartAPI first-party; NSE chain fallback.

**Expected Regimes:** BULL_TRENDING, BEAR_TRENDING, EXPIRY_DAY, NORMAL_DAY

---

### 2.6 India F&O AI Multi-Factor Signals (`INDIA_AI_SIGNALS`)

| Field | Value |
|-------|-------|
| **strategyId** | `INDIA_AI_SIGNALS` |
| **version** | 2.0.0 |
| **market** | NSE_FNO |
| **instrumentType** | OPTIONS |
| **timeframe** | 1d |
| **strategyCategory** | STATISTICAL |
| **status** | SHADOW |
| **hypothesisStatus** | DEFINED |

**Entry Logic:** 14-factor weighted confluence model (total weight = 1.0):
- Intraday demand (0.14)
- S/R breakout with volume (0.13)
- Market tape / regime (0.12)
- News flow (0.08)
- Daily SMA trend (0.08)
- RSI (0.05)
- 5-day momentum (0.08)
- Volume thrust (0.08)
- PCR OI (0.08)
- ATM IV (0.04)
- OI build-up Δ (0.10)
- Max-pain pull (0.05)
- Scanner agreement (0.10)
- NSE session (0.04)
- Super Confluence score (0.10)
- Institutional futures screen (0.14, Daily Picks only)

Minimum composite magnitude threshold: 0.22. Grade S/A only for auto-trading.

**ML Dependencies:** MarketRegimeClassifier, StockRanker, MetaDecisionEngine

**Expected Regimes:** BULL_TRENDING, BEAR_TRENDING, NORMAL_DAY, EXPIRY_DAY

**Hypothesis:** A 14-factor weighted confluence model aggregating intraday demand, breakout quality, market regime, derivatives data (PCR, ATM IV, OI build-up, max-pain), news flow, and ML model outputs produces F&O trading signals with meaningful predictive value that exceeds any individual factor alone.

**What Would Invalidate:** ECE (Expected Calibration Error) > 0.10 on OOS sample. OOS Sharpe < 0.5. Paper performance materially worse than shadow. Grade D signals consistently outperforming Grade S signals.

---

### 2.7 India Super Confluence (`INDIA_SUPER_CONFLUENCE`)

| Field | Value |
|-------|-------|
| **strategyId** | `INDIA_SUPER_CONFLUENCE` |
| **version** | 1.0.0 |
| **market** | NSE_FNO |
| **instrumentType** | FUTURES |
| **timeframe** | 5m |
| **strategyCategory** | TREND_FOLLOWING |
| **status** | RESEARCH |
| **hypothesisStatus** | DEFINED |

**Entry Logic:** All 4 sub-signals bullish simultaneously: UT Bot ATR trail, AI Neural Trend Line (HMA), SMC BOS/CHoCH structure, EMA 9/15/21 stack. Score ±0.75 or ±1.0 required to fire.

**Expected Regimes:** BULL_TRENDING, BEAR_TRENDING

---

## Section 3 — User-Defined

### 3.1 Strategy Lab User Strategies (`STRATEGY_LAB_USER`)

| Field | Value |
|-------|-------|
| **strategyId** | `STRATEGY_LAB_USER` |
| **version** | dynamic |
| **market** | CRYPTO |
| **instrumentType** | CRYPTO_PERP |
| **timeframe** | 1d |
| **strategyCategory** | STATISTICAL |
| **status** | EXPERIMENTAL |
| **hypothesisStatus** | UNVALIDATED |

**Entry Logic:** User-defined via natural-language prompt parsed into RSI/EMA/SMA/ATR/MACD/volume rules.

**Note:** User strategies are tracked generically. Each individual user strategy must declare its own hypothesis before advancing past EXPERIMENTAL.

---

## Appendix A — Strategy Status Lifecycle

```
EXPERIMENTAL
    ↓ (hypothesis defined)
RESEARCH
    ↓ (≥30 OOS trades, +expectancy, DD<30%, cost-adjusted profitable, Sharpe≥0.3)
BACKTEST_VALIDATED
    ↓ (OOS Sharpe≥0.5, not OVERFIT_SUSPECTED, MC not FRAGILE, not COST_FRAGILE)
WALK_FORWARD_VALIDATED
    ↓ (≥10 shadow trades, shadow Sharpe≥0.3, decay not CRITICAL)
SHADOW
    ↓ (≥20 paper trades, +expectancy, DD<25%, no material backtest drift)
PAPER
    ↓ (≥20 sessions, paper Sharpe≥0.6, PF≥1.2, decay HEALTHY)
LIVE_CANDIDATE
    ↓ (manual human approval token required — NEVER automatic)
MANUAL_APPROVAL
    ↓ (explicit approvalToken + approvedBy)
LIVE

Any stage ← WARNING ← DEGRADED ← PAPER_ONLY ← DISABLED (automatic demotion)
```

---

## Appendix B — Research Infrastructure

All research code lives under `src/lib/research/`:

| Module | File | Purpose |
|--------|------|---------|
| Registry | `registry/strategy-registry.ts` | Canonical strategy inventory |
| Hypothesis | `hypothesis/strategy-hypothesis.ts` | Hypothesis declarations |
| Datasets | `datasets/research-dataset-builder.ts` | SHA-256 fingerprinted research datasets |
| Splits | `splits/research-split.ts` | IS/OOS governance with leakage prevention |
| Performance | `performance/strategy-performance-analyzer.ts` | 35+ metrics, all periods |
| Costs | `costs/cost-attribution.ts` | Full cost breakdown + stress testing |
| Regimes | `regimes/regime-attribution.ts` | Trade → regime attribution + matrix |
| Correlation | `correlation/strategy-correlation.ts` | Return/signal/drawdown/tail correlation |
| Decay | `decay/alpha-decay-monitor.ts` | Rolling metrics vs baseline, 5-state machine |
| Monte Carlo | `montecarlo/monte-carlo-robustness.ts` | 7 simulation types × 10,000 iterations |
| Parameters | `parameters/parameter-stability.ts` | Neighbourhood stability, OVERFIT_SUSPECTED |
| Overfitting | `overfitting/multiple-testing-guard.ts` | PBO, Deflated Sharpe Ratio, BH FDR |
| Calibration | `signals/signal-calibration.ts` | Brier Score, ECE, reliability diagram |
| Ablation | `ablation/strategy-ablation.ts` | Component ablation, LOW_VALUE_COMPONENT |
| Promotion | `promotion/strategy-promotion-engine.ts` | Evidence gates per lifecycle stage |
| Confidence | `confidence/strategy-confidence-score.ts` | 0-100 weighted confidence score |
| Experiments | `experiments/research-experiment-tracker.ts` | Immutable experiment records |
| Leaderboard | `leaderboard/strategy-leaderboard.ts` | Ranked views + allocation engine |
| Kill Switch | `killswitch/strategy-kill-switch.ts` | SOFT_KILL / HARD_KILL |
| Paper Analysis | `paper-analysis/paper-performance-analyzer.ts` | Backtest vs paper drift analysis |
| Validation | `validation-sessions/validation-session-tracker.ts` | Real-market session tracking |
