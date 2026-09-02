# AlphaForge — Opportunity Engine Baseline Audit

**Date:** 2026-09-02  
**Purpose:** Pre-implementation baseline. Documents exactly what exists, what is wired, what is merely defined, and what is proven — before adding the new opportunity validation, signal quality, risk gating, and alpha optimization layer.

---

## Audit Legend

| Status | Meaning |
|--------|---------|
| ✅ WIRED | Runs in production pipeline, exercises real market data |
| 🔶 DEFINED | Code exists, has tests, but NOT called from live pipeline |
| 🔷 PARTIAL | Exists but incomplete or partially wired |
| ❌ STUB | Referenced but not implemented |
| 🚫 MOCKED | Returns fake / static data |
| 📋 RESEARCH | Research/backtest only — never reaches live decisions |

---

## 1. Signal Sources

### 1.1 India F&O Signal Sources (Live)

| Source | Type | Status | Notes |
|--------|------|--------|-------|
| `india-builder.ts` — 14-factor AI confluence | STRATEGY: INDIA_AI_SIGNALS | ✅ WIRED | Primary production signal source. Produces `AiSignal`, NOT `EnrichedSignal` |
| `scanner/engine.ts` — range-expansion | SCANNER | ✅ WIRED | WR8 + bullish trend, 50 hits max |
| `scanner/engine.ts` — momentum | SCANNER | ✅ WIRED | F&O movers by % change |
| `scanner/engine.ts` — volume-breakout | SCANNER | ✅ WIRED | vol ≥1.5× avg + price quartile |
| `scanner/engine.ts` — oi-buildup | SCANNER | ✅ WIRED | ΔOI × price direction classification |
| `scanner/engine.ts` — pcr-extreme | SCANNER | ✅ WIRED | contrarian PCR extremes |
| `scanner/engine.ts` — iv-spike | SCANNER | ✅ WIRED | IV crush/spike detection |
| `strategies/opening-breakout.ts` | STRATEGY: OPENING_BREAKOUT | ✅ WIRED | 5-min ORB with ATR sizing |
| `strategies/positioning.ts` — LIQUIDITY_EDGE | STRATEGY | ✅ WIRED | ILE-Pine port, option chain engine |
| `strategies/positioning.ts` — MAX_PAIN_GRAVITY | STRATEGY | ✅ WIRED | IMPG-Pine port, max pain pull |
| Daily Picks builder (`india-builder.ts`) | MANUAL | ✅ WIRED | Top-3-per-bucket, frozen at 09:15 |
| FnO Trend Scanner (14-condition Chartink) | SCANNER | ✅ WIRED | MA + ADX + MACD screener |

### 1.2 Crypto Signal Sources (Live)

| Source | Type | Status |
|--------|------|--------|
| `scalping/strategies/` — 10 crypto strategies | STRATEGY | ✅ WIRED |
| `ai-signals/crypto-builder.ts` — 9-factor confluence | META | ✅ WIRED |

### 1.3 Sources Referenced But NOT Wired

| Source | Status | Gap |
|--------|--------|-----|
| `lib/signal-intelligence/` EnrichedSignal taxonomy | 🔶 DEFINED | `india-builder.ts` never produces `EnrichedSignal` |
| Multi-layer engine (structure/momentum/volume/volatility layers) | 🔶 DEFINED | Not called from any live signal path |
| Market context engine snapshot | 🔶 DEFINED | Not integrated into daily picks or auto-trader |
| ML service meta-decision | 🔷 PARTIAL | Regime/rank called, meta-decision NOT called |

---

## 2. Current Strategies

### 2.1 India F&O Strategies

| Strategy ID | Category | Status | Lifecycle |
|-------------|----------|--------|-----------|
| RANGE_EXPANSION | BREAKOUT | ✅ WIRED | RESEARCH |
| MOMENTUM | MOMENTUM | ✅ WIRED | RESEARCH |
| VOLUME_BREAKOUT | BREAKOUT | ✅ WIRED | RESEARCH |
| OI_BUILDUP | OPTIONS_FLOW | ✅ WIRED | RESEARCH |
| PCR_EXTREME | OPTIONS_FLOW | ✅ WIRED | RESEARCH |
| IV_SPIKE | VOLATILITY | ✅ WIRED | RESEARCH |
| LIQUIDITY_EDGE | LIQUIDITY | ✅ WIRED | RESEARCH |
| MAX_PAIN_GRAVITY | LIQUIDITY | ✅ WIRED | RESEARCH |
| OPENING_BREAKOUT | BREAKOUT | ✅ WIRED | RESEARCH |
| INDIA_AI_SIGNALS | STATISTICAL | ✅ WIRED | SHADOW |
| INDIA_SUPER_CONFLUENCE | TREND_FOLLOWING | 🔶 DEFINED | RESEARCH |

### 2.2 Strategy Registry (Research Platform Only)

18 strategies in `lib/research/registry/strategy-registry.ts`. All at RESEARCH except INDIA_AI_SIGNALS (SHADOW) and STRATEGY_LAB_USER (EXPERIMENTAL). No strategy has graduated beyond SHADOW into PAPER or LIVE.

---

## 3. Current Feature Groups

### 3.1 India AI Builder (TypeScript, Live)

| Feature Group | Features | Status |
|---------------|----------|--------|
| Price action | dayChangePct, 5d momentum, prevClose | ✅ WIRED |
| Trend stack | SMA 20/50/200 direction, price vs SMA20 | ✅ WIRED |
| Breakout | 20-day S/R + volume confirmation (breakoutScore) | ✅ WIRED |
| Oscillators | RSI(14), Wilder method | ✅ WIRED |
| Volume | volume thrust (today vs 20d avg) | ✅ WIRED |
| Derivatives | PCR OI (Angel first-party or chain), ATM IV, OI buildup, max-pain pull | ✅ WIRED |
| Scanner | Cross-scanner agreement score | ✅ WIRED |
| Session | NSE active-window gate | ✅ WIRED |
| Market regime | NIFTY/BANKNIFTY/FINNIFTY composite (blended 65% heuristic + 35% ML) | ✅ WIRED |
| News | Lexicon score (ET + WSJ RSS) | ✅ WIRED |
| Super Confluence | UT Bot + AI Neural (HMA) + SMC BOS/CHoCH + EMA 9/15/21 | ✅ WIRED |
| Quant pre-filter | ADX ≥18, relVol ≥1.1×, ATR% ≥0.4% | ✅ WIRED |
| ML rank boost | LightGBM stock ranker → ±0.06 confidence delta | ✅ WIRED |
| Futures screen | 7-condition institutional screen (Daily Picks only) | ✅ WIRED |

### 3.2 Python ML Service Features (150+, Partially Wired)

| Category | Key Features | Status |
|----------|-------------|--------|
| Technical | RSI, MACD, ADX, ATR, Bollinger, EMA stack (8/13/21/55/200), Supertrend | 🔶 DEFINED (needs training) |
| Volume | RVOL, VWAP distance, OBV, CMF, force index | 🔶 DEFINED |
| Momentum | Multi-period returns (1/2/3/5/10/20/60d), RS vs NIFTY | 🔶 DEFINED |
| Derivatives | PCR score, IV rank/percentile, VPIN, OI walls, delta skew | 🔶 DEFINED |
| Structure | FVG, Order Blocks, BOS/CHoCH, liquidity sweeps | 🔶 DEFINED |
| Macro | Market breadth, A/D ratio, VIX regime, sector rotation | 🔶 DEFINED |

### 3.3 Multi-Layer Engine Features (Defined, NOT Wired)

| Layer | Module | Status |
|-------|--------|--------|
| Market Structure (BOS/CHoCH/FVG) | `multi-layer-engine.ts` | 🔶 DEFINED |
| Momentum Quality (RSI/ADX/EMA slope) | `multi-layer-engine.ts` | 🔶 DEFINED |
| Volume Intelligence (RVOL/TOD-normalized) | `multi-layer-engine.ts` | 🔶 DEFINED |
| Volatility Regime (ATR percentile/realized vol) | `multi-layer-engine.ts` | 🔶 DEFINED |
| Liquidity/Execution Quality | `multi-layer-engine.ts` | 🔶 DEFINED |
| Breakout Quality (range/volume/close location) | `multi-layer-engine.ts` | 🔶 DEFINED |

---

## 4. Confidence Calculation (Current)

### 4.1 How Confidence is Currently Computed

```
Raw confidence = compositeScore(14 factors)
   where compositeScore = weighted sum of factor scores (weights sum to ~1.06 with bonuses)
   
Flow bonus: +0.08 when scanner+volume+OI+dayChange+futuresScreen all available
Quant penalty: ×0.82 when ADX<18 OR relVol<1.1× OR ATR%<0.4%
ML boost: clamp(base + mlRankBoost, 0, 0.98) where mlRankBoost ∈ [-0.10, 0.10] × 0.6
```

**Problems with current approach:**
1. Single opaque score — cannot separate structure quality from regime quality from ML quality
2. No calibration — raw confidence is NOT a win probability
3. No expected value calculation — no cost/slippage accounting
4. No hard gate separation — a regime-conflicting signal can still score highly
5. Confidence inflated by factor availability (more inputs → higher score regardless of quality)
6. No signal deduplication — 4 strategies on same breakout create 4 independent trades

### 4.2 Win Probability Calibration (Current)

```typescript
calibrateWinProbability(rawConfidence, strategyId):
  shrinkage = 0.65
  calibrated = rawConfidence × 0.65 + 0.5 × 0.35
  return clamp(calibrated, 0.30, 0.82)
```

**Problems:** Universal shrinkage for all strategies. No per-strategy calibration. No out-of-sample validation. No reliability curves. Returns at most 0.82 regardless of evidence.

---

## 5. ML Contribution (Current)

| Component | What it does | Status | Actual influence |
|-----------|-------------|--------|-----------------|
| MarketRegimeClassifier (XGBoost) | 6-class regime prediction | 🔷 PARTIAL | 35% weight in blended regime score |
| StockRanker (LightGBM) | 0-100 stock rank | 🔷 PARTIAL | ±0.06 confidence boost to top-20 |
| StrategySelector (CatBoost) | 8-class strategy recommendation | 🔶 DEFINED | NOT consumed by live pipeline |
| RiskPredictor (XGBoost×3) | P(stop hit), P(target hit) | 🔶 DEFINED | NOT consumed |
| PortfolioOptimizer (Riskfolio) | HRP+CVaR weights | 🔶 DEFINED | Not integrated into sizing |
| RL Executor (PPO) | Execution action | 🔶 DEFINED | NOT used |
| MetaDecisionEngine (ensemble+calibration) | Combined decision | 🔶 DEFINED | NOT called from live pipeline |

**Critical gap:** The ML MetaDecisionEngine with Platt calibration, isotonic regression, regime-weighted ensemble, and 7-condition abstention policy exists in Python but is **never called** by `india-builder.ts` or the auto-trader. The ML influence on live decisions is limited to a ±0.06 confidence nudge from the stock ranker.

---

## 6. Current Risk Gates

### 6.1 Auto-Trader Risk (Live, Simple)

```typescript
// In features/india/paper-trading/auto-trader.ts
const riskGate = (slPct: number) => Math.abs(entry - sl) / entry <= 0.025; // 2.5% max SL
const budgetGate = (totalDeployed: number) => totalDeployed < 100000; // ₹1L daily budget
const positionGate = (openCount: number) => openCount < 5; // max 5 open trades
```

No portfolio correlation check. No VaR. No drawdown control. No sector concentration. No strategy-level limits.

### 6.2 PortfolioRiskEngine v2 (Defined, NOT Wired)

`lib/risk/portfolio-risk.ts` — Complete 8-step pipeline:
1. Kill switch (HARD_KILL / SOFT_KILL)
2. Drawdown halt (4-tier: NORMAL/CAUTION/WARNING/DANGER/HALT)
3. VaR breach (historical + parametric)
4. Exposure checks (gross, symbol ≤5%, underlying ≤8%, sector ≤25%, strategy ≤20%)
5. Correlated-long cluster (max 3 Bank-sector longs)
6. Pairwise correlation risk (reject >0.7 correlated same-dir positions)
7. Risk budget (per-trade 0.5%, per-strategy 2%, per-sector 5%, portfolio 8%)
8. Dynamic sizing (confidence × vol × correlation × drawdown multipliers)

**Status:** 64 tests passing. NEVER CALLED from auto-trader or scalper.

### 6.3 Signal Intelligence Abstention Engine (Defined, NOT Wired)

`lib/signal-intelligence/signal-quality-vector.ts` — `evaluateAbstention()`:
- Checks: grade, EV, liquidity, data quality, regime, ML confidence, MTF conflict, derivatives conflict, correlation, portfolio exposure, expiry gamma, TOD bucket
- Returns `TRADE` or `NO_TRADE` with reasons

**Status:** Implemented. NOT called from any live decision path.

---

## 7. Current Position Sizing

### 7.1 Auto-Trader (Live)

```typescript
// Fixed ₹20,000 per trade, regardless of:
// - signal quality
// - expected value
// - regime
// - volatility
// - portfolio correlation
// - drawdown state
const tradeSize = 20000; // INR, hardcoded
```

No quality multiplier. No EV multiplier. No regime multiplier. No drawdown tier.

### 7.2 AI Signals Builder

```typescript
suggestPositionSizePct(confidence, horizon):
  base = 1.0% of capital
  horizonCap: scalp=1%, intraday=2%, swing=3%, positional=5%
  return base × confidence × horizonCap
```

Not wired to actual position opening. Advisory only.

### 7.3 Dynamic Position Sizing (Defined, NOT Wired)

`lib/signal-intelligence/signal-lifecycle.ts` — `computeDynamicPositionSize()`:
- Signal score → base %
- Calibrated win probability adjustment
- Volatility adjustment
- Drawdown-based scaling
- Correlation penalty
- Liquidity scaling
- Portfolio exposure hard cap

**Status:** Implemented. NOT called by auto-trader or scalper.

---

## 8. Current Transaction-Cost Model

### 8.1 IndiaBrokerageModel (Backtesting v2 Only)

`lib/backtesting-v2/execution/india-brokerage-model.ts`:

| Component | Rate |
|-----------|------|
| Brokerage | ₹20 flat F&O (Zerodha) |
| STT | 0.0125% options buy / 0.0025% futures sell |
| NSE exchange | 0.053% options / 0.002% futures |
| SEBI | 0.0001% turnover |
| GST | 18% on brokerage + exchange |
| Stamp duty | 0.003% buy side |
| DP charges | ₹15.34 EQ delivery sell |

**Status:** Implemented in backtesting-v2. NOT applied to live paper trades or auto-trader.

### 8.2 Research Cost Model (Research Platform Only)

`lib/research/costs/cost-attribution.ts` — `NSE_FNO_OPTIONS_COST_MODEL` and `NSE_FNO_FUTURES_COST_MODEL` with 1×/1.5×/2×/3× stress testing and `COST_FRAGILE` flag.

**Status:** Research platform only. Not wired to live signals or sizing.

### 8.3 Live Signal Pipeline Cost Accounting

**None.** Paper trades are opened with a fixed notional of ₹1,000 and no transaction cost deduction. P&L is computed on raw % move from entry to exit/target/stop. The live system has zero cost-aware expected value calculation.

---

## 9. Current Slippage Model

### 9.1 Backtesting v2 Slippage

`lib/backtesting-v2/execution/india-slippage-model.ts`:
- `half-spread + √(market-impact) + ATR_penalty + OTM_premium_penalty`
- NSE tick rounding to ₹0.05

**Status:** Backtesting-v2 only. NOT applied to live system.

### 9.2 Live Paper Execution

No slippage at all. Entry is assumed at exactly `signal.entry`. No spread model. No market-impact. No latency.

---

## 10. Current Paper Execution

### 10.1 India Scalper Paper Trader

`features/india/scalping/paper-trader-core.ts`:
- ATR-sized SL (0.75×ATR) and TP (1.5×ATR)
- NSE 0.05-tick rounding
- Expiry cooldown: Thursday ≥14:30 → skip
- Dedup: `scalper:lastTrade:{symbol}:{tf}` Redis key (5min TTL)
- Outcome resolution: 5m NSE candles, conservative tie-break (both hit = stop)

### 10.2 Auto-Trader Paper Execution

`features/india/paper-trading/auto-trader.ts`:
- Ranks signals: 35% confidence + 25% winProb + 25% grade + 15% R:R ≥ 0.52 threshold
- Opens ≤5 positions × ₹20k within ₹1L daily budget
- Risk gate: SL% ≤2.5% of entry
- EOD close-out at 15:30 IST regardless of outcome

### 10.3 Signal Intelligence Paper Fidelity (Defined, NOT Wired)

`lib/signal-intelligence/paper-trading-fidelity.ts`:
- `computePaperFill()`: realistic fill with spread + impact + latency
- `buildSignalPaperFunnel()`: DETECTED→QUALIFIED→RISK_CHECKED→PAPER_OPENED→RESOLVED funnel
- Execution mode isolation: RESEARCH/SHADOW/PAPER/LIVE separation
- Deterministic replay hash

**Status:** Implemented. NOT called by any live path.

---

## 11. Signal Deduplication (Current)

| Level | Mechanism | Status |
|-------|-----------|--------|
| Scalper-level | Redis `scalper:lastTrade:{sym}:{tf}` key (5min TTL) | ✅ WIRED |
| Auto-trader level | Score threshold gate (≥0.52) + budget limit | ✅ WIRED |
| Signal Intelligence cluster dedup | `clusterSignals()` in `conflict-resolver.ts` | 🔶 DEFINED |
| Cross-strategy dedup | `OpportunityCluster` DB model | 🔶 DEFINED |

**Gap:** The same underlying opportunity (e.g. NIFTY breakout at 10:15) can currently produce independent paper trades from: OPENING_BREAKOUT + MOMENTUM + VOLUME_BREAKOUT + AI_SIGNAL + DAILY_PICK. These are counted as 5 independent trades with no correlation awareness.

---

## 12. Strategy Attribution (Current)

| Capability | Status | Notes |
|------------|--------|-------|
| Per-strategy win rate in journal | ✅ WIRED | `getIndiaJournalStats()` by source prefix |
| Per-strategy score/grade display | ✅ WIRED | `score-board.ts`, `strategy-score.ts` |
| Strategy×regime performance matrix | 🔶 DEFINED | `lib/research/regimes/regime-attribution.ts` |
| Strategy attribution to P&L | 🔶 DEFINED | `lib/research/performance/` |
| Feature-level attribution | 🔶 DEFINED | `lib/signal-intelligence/signal-lifecycle.ts` `buildSignalAttribution()` |
| What-drove-this-win analysis | 🔶 DEFINED | Not called in live path |

---

## 13. Regime Logic (Current)

### 13.1 Live Heuristic Regime

```typescript
// india-builder.ts: buildIndiaContext()
regimeScore ∈ [-1, 1]
= avg(NIFTY%change/1.5, BANKNIFTY%change/1.5)
+ VIX adjustment (VIX>18 → -0.3, VIX>25 → -0.6)
+ news sentiment contribution

Classification:
> 0.3 → risk-on / bull
< -0.3 → risk-off / bear  
else → mixed
```

No formal STRONG_BULL / WEAK_BULL / RANGE / HIGH_VOL / STRONG_BEAR / WEAK_BEAR / PANIC / TRANSITION / UNKNOWN classification.

### 13.2 ML Regime Classifier (Partial)

`lib/india/ml-client.ts` — `predictRegime()`:
- 6 classes: strong_bull / bull / sideways / volatile / bear / crash
- 35% weight in blended score
- Falls back to heuristic when ML service unavailable

### 13.3 Research Regime Attribution (Not Live)

`lib/research/regimes/` — 10 regime types for backtest attribution. Not used in live signal evaluation.

**Gap:** No `Strategy × Regime` performance matrix wired to live decisions. No regime-conditional signal boosting or penalizing.

---

## 14. Walk-Forward Validation (Current)

| Component | Status |
|-----------|--------|
| IS/OOS split governance | 🔶 DEFINED (`lib/research/splits/`) |
| Walk-forward optimization | 🔶 DEFINED (research platform) |
| Purged K-Fold / CPCV | 🔶 DEFINED (research platform) |
| Actual validated OOS performance for any strategy | ❌ NONE |
| Champion/challenger framework | 🔶 DEFINED (`lib/experiments/`) |

No strategy has been walk-forward validated. All strategies are at RESEARCH status. No production promotion has occurred.

---

## 15. Calibration (Current)

| Component | Status |
|-----------|--------|
| Win probability calibration | 🔷 PARTIAL (universal logistic shrinkage, no per-strategy curves) |
| Reliability curves / calibration bins | 🔶 DEFINED (`lib/research/signals/`) |
| Brier score tracking | 🔶 DEFINED (research platform) |
| Isotonic regression | 🔶 DEFINED (Python ML service) |
| Per-strategy ECE | 🔶 DEFINED (research platform) |
| Actual calibration data from paper trades | 🚫 NONE — insufficient paper-trade outcomes |

---

## 16. Signal Lifecycle (Current)

### 16.1 Defined Lifecycle

```
DETECTED → VALIDATING → QUALIFIED → RISK_CHECK → APPROVED → PAPER_EXECUTED
  → ACTIVE → PARTIAL → EXITED / EXPIRED / CANCELLED
  At any point → REJECTED
```

**Status:** Type system and state machine defined in `lib/signal-intelligence/types.ts` and `signal-lifecycle.ts`. DB model `SignalLifecycleEvent` exists. NOT populated by any live worker job.

### 16.2 Actual Live Signal Lifecycle

```
signal generated by india-builder.ts
    ↓
scored by auto-trader (35%×conf + 25%×winProb + 25%×grade + 15%×RR)
    ↓
PaperTrade row opened (no lifecycle events recorded)
    ↓
resolved at EOD (WIN/LOSS/EXPIRED) or by 5m candle check
    ↓
pnlPct stored in PaperTrade row
```

No lifecycle state transitions recorded. No rejection reasons stored. No attribution data. No feature contribution at decision time.

---

## 17. Trade Outcome Storage (Current)

| Model | What it stores | Status |
|-------|----------------|--------|
| `PaperTrade` | entry/exit prices, pnlPct, rationale strings, source | ✅ WIRED |
| `IndiaDailyPick` | frozen levels, live tracking, status, achievedPct | ✅ WIRED |
| `FnoTrendScan` | TP1/SL outcomes, adxVal, rsiVal | ✅ WIRED |
| `SignalHistory` | crypto signal outcomes with features JSON | ✅ WIRED |
| `SignalLifecycleEvent` | lifecycle state transitions | ❌ NOT POPULATED |
| `SignalIntelligenceRecord` | full EnrichedSignal envelope | ❌ NOT POPULATED |
| `OpportunityCluster` | anti-dedup clusters | ❌ NOT POPULATED |
| `IndiaDaySession` | daily session P&L summary | ✅ WIRED |

---

## 18. MFE / MAE Support (Current)

| Capability | Status |
|------------|--------|
| MFE tracking in paper trade | ❌ NOT IMPLEMENTED |
| MAE tracking in paper trade | ❌ NOT IMPLEMENTED |
| Time-to-target tracking | 🔷 PARTIAL (`achievedPct` in IndiaDailyPick, no time dimension) |
| Stop optimization from MAE | ❌ NOT IMPLEMENTED |
| Target optimization from MFE | ❌ NOT IMPLEMENTED |

---

## 19. P&L Attribution (Current)

| Attribution Component | Status |
|----------------------|--------|
| By strategy | ✅ WIRED (journal grouping) |
| By regime | 🔶 DEFINED (research platform, not live) |
| By entry timing | ❌ NOT IMPLEMENTED |
| By sizing | ❌ NOT IMPLEMENTED |
| By exit type | ❌ NOT IMPLEMENTED |
| P&L from ML contribution | ❌ NOT IMPLEMENTED |
| P&L lost to costs | ❌ NOT IMPLEMENTED (no cost model applied live) |
| P&L lost to slippage | ❌ NOT IMPLEMENTED |

---

## 20. Feature Attribution (Current)

| Capability | Status |
|------------|--------|
| Which factors drove signal direction | 🔷 PARTIAL (top-6 reasons shown in UI) |
| Feature contribution to final score | 🔷 PARTIAL (factor weights × scores visible) |
| SHAP values from ML model | 🔶 DEFINED (`explainPrediction()` in ml-client) |
| Post-trade feature attribution | 🔶 DEFINED (`buildSignalAttribution()`) |
| Feature IC / stability analysis | 🔶 DEFINED (research ablation engine) |
| Ablation testing results | 📋 RESEARCH (no production data) |

---

## 21. Portfolio Correlation Controls (Current)

| Control | Status |
|---------|--------|
| Max 3 Bank-sector longs | 🔶 DEFINED (PortfolioRiskEngine — NOT wired) |
| Pairwise correlation matrix | 🔶 DEFINED (PortfolioRiskEngine — NOT wired) |
| Sector concentration limit | 🔶 DEFINED (exposure.ts — NOT wired) |
| Strategy concentration limit | 🔶 DEFINED (exposure.ts — NOT wired) |
| Cross-instrument dedup | ❌ NONE IN LIVE SYSTEM |
| ICICI + HDFC + SBIN all open simultaneously | ✅ ALLOWED (no guard in auto-trader) |

---

## 22. Expiry-Day Logic (Current)

| Capability | Status |
|------------|--------|
| Expiry day detection (Thursday weekly) | ✅ WIRED (scalper cooldown ≥14:30) |
| Monthly expiry detection | ✅ WIRED (SimulationClock in backtesting-v2) |
| Expiry-specific strategy policies | 🔶 DEFINED (`getStrategyExpiryBehavior()`) |
| Gamma Blast / Hero Zero expiry trades | ✅ WIRED (`features/india/expiry-trades/`) |
| IV behavior modeling on expiry | 🔶 DEFINED (derivatives intelligence) |
| OI concentration on expiry | 🔷 PARTIAL (option chain capture) |

---

## 23. Market-Hours Logic (Current)

| Capability | Status |
|------------|--------|
| NSE session open/close detection | ✅ WIRED (`isNseMarketOpenIST()`) |
| 7-window best-time engine | ✅ WIRED |
| Pre-market signal queuing | ✅ WIRED (buildTimingWindow → nextSession) |
| Off-hours cache refresh | ✅ WIRED (5min cache when closed) |
| Intraday window quality scoring | ✅ WIRED (TOD priors in signal-quality-vector) |

---

## 24. Provider Freshness Logic (Current)

| Capability | Status |
|------------|--------|
| Provider health score (0–100, circuit breaker) | ✅ WIRED |
| Data age tracking per quote | ✅ WIRED (`fetchedAt` on MDQuote) |
| OI freshness guard (15min stale threshold) | ✅ WIRED (derivatives-intelligence.ts) |
| Stale cache detection (2× TTL threshold) | ✅ WIRED (`cached()` in redis.ts) |
| Signal data quality downgrade on stale data | 🔶 DEFINED (`DataQualityMetadata`) |
| Provider confidence propagation to signal | ❌ NONE IN LIVE PATH |

---

## 25. Summary: What Exists vs What Actually Works

### What EXISTS and IS WIRED (produces live paper trades)

```
✅ India F&O signal generation (14-factor confluence)
✅ 9 official F&O strategy scanners
✅ Provider failover chain (Angel → Upstox → NSE → Yahoo)
✅ NSE option chain capture (5min snapshots)
✅ Daily Picks (freeze-or-track, DB-backed)
✅ Auto-trader (₹1L budget, 5 positions max, 2.5% SL gate)
✅ Paper trading with EOD close
✅ 14 worker jobs
✅ Redis caching
✅ Signal outcome tracking (WIN/LOSS/EXPIRED)
```

### What IS BUILT but NOT WIRED

```
🔶 PortfolioRiskEngine v2 (8-step, 64 tests) — auto-trader ignores it
🔶 MicrostructureEngine (VPIN, depth, spread, 974 tests) — not in pipeline
🔶 Signal Intelligence multi-layer evaluation — not called from india-builder
🔶 EnrichedSignal / SignalQualityVector — not produced by any live signal
🔶 Expected Value engine — not used in any sizing or approval decision
🔶 Hard gate vs soft score separation — not enforced anywhere
🔶 Signal lifecycle state machine — never populated
🔶 Opportunity clustering / deduplication — never called
🔶 Dynamic position sizing — not used by auto-trader
🔶 Transaction cost accounting — not applied to live trades
🔶 Slippage model — not applied to paper fills
🔶 MetaDecisionEngine (Python) — never called from TypeScript pipeline
🔶 Walk-forward validation — no strategy has passed it
🔶 Champion/challenger framework — exists, not connected to live strategies
🔶 Signal decay detection — not monitored automatically
```

### What IS NOT IMPLEMENTED AT ALL

```
❌ OpportunityV1 canonical object
❌ OpportunityDetector (breakout/trend/mean-reversion/liquidity event detection)
❌ MarketRegimeEngine (STRONG_BULL/WEAK_BULL/RANGE/HIGH_VOL/BEAR/PANIC)
❌ Strategy × Regime conditional performance matrix (live)
❌ Multi-timeframe confirmation evaluator
❌ RelativeStrengthEngine (stock vs NIFTY vs sector vs peers)
❌ SectorContextEngine (sector trend/momentum/breadth)
❌ MFE / MAE tracking in paper trades
❌ Counterfactual rejection analysis
❌ Performance attribution (entry/sizing/exits/ML/costs)
❌ Signal falsification / adversarial tests
❌ Point-in-time universe validation
❌ Probability of Backtest Overfitting (PBO) computation with actual data
❌ Rejection quality metrics (false rejection rate / false acceptance rate)
❌ Hard rejection codes (standardized, searchable)
❌ Signal quality tiers A+/A/B/C/D/REJECT with evidence-based thresholds
```

---

## 26. Three-Way Comparison Baseline (Pre-Implementation)

| Metric | Current Baseline (System A) | Notes |
|--------|----------------------------|-------|
| Opportunities identified | ~170 F&O symbols evaluated per run | Every symbol gets a score |
| Approved | All non-WAIT signals (~40–60% of universe) | No hard quality gate |
| Rejected | WAIT signals only | Based on score < 0.22 magnitude |
| Hard-rejected | 0 | No hard gate exists |
| Trades/day | 0–5 (budget limited) | Auto-trader budget cap |
| Win rate | Unknown (insufficient resolved paper data) | |
| Expectancy | Unknown (no cost model) | |
| MFE/MAE | Not tracked | |
| Cost drag | 0% (not computed) | |
| Slippage drag | 0% (not computed) | |
| False acceptance rate | Unknown | |
| False rejection rate | Unknown | |
| Calibration error | Unknown | |
| Correlation control | None | Multiple banking stocks simultaneously |
| Drawdown control | None beyond SL gate | |

---

## 27. Identified Structural Risks

1. **Confidence inflation**: Factor availability increases score. If 3 factors are unavailable, the signal scores lower — not because the setup is weaker but because data is missing.

2. **Zero cost awareness**: Paper P&L is gross. A "profitable" strategy may be unprofitable after real brokerage, STT, exchange fees, GST, slippage, and spread.

3. **No correlation control**: ICICI + HDFC + SBI + BANKNIFTY can all be simultaneously open, creating hidden concentration in the Banking sector.

4. **Deduplication gap**: OPENING_BREAKOUT + MOMENTUM + VOLUME_BREAKOUT + AI_SIGNAL on the same NIFTY breakout create 4 paper trades treating one opportunity as four.

5. **Uncalibrated probabilities**: Win probability is a universal logistic transform. A "72% confident" signal has no empirical backing.

6. **No abstention enforcement**: The abstention engine exists but is never consulted. The system will attempt to trade in adverse regimes, on stale data, and when costs exceed expected edge.

7. **Fixed sizing**: Quality × EV × regime information is discarded. Every trade gets ₹20,000 regardless of whether it is an A+ or a C signal.

8. **No live drawdown state**: If the account loses ₹30,000 in the first 90 minutes, the auto-trader continues opening ₹20,000 positions.

9. **No strategy lifecycle enforcement**: All strategies are perpetually RESEARCH. No strategy has graduated to PAPER or LIVE with evidence-based gates.

10. **Lookahead risk not audited**: The current system uses daily OHLCV. No formal audit confirms that intraday signals do not use same-bar close information.

---

## 28. Recommended Implementation Sequence

Based on this audit, the following build order minimizes risk and maximizes immediate improvement:

1. **OpportunityV1 type** — canonical immutable opportunity object  
2. **MarketRegimeEngine** — formal regime states, replaces heuristic inline code  
3. **Multi-timeframe confirmation** — evaluates Daily/1H/15m/5m/1m alignment  
4. **RelativeStrength + SectorContext** — cross-sectional ranking  
5. **ExpectedValueEngine (enhanced)** — P(win)×EV - costs - slippage = net EV  
6. **Hard gate engine** — explicit REJECT vs soft penalization  
7. **OpportunityDetector** — detects candidate setups before approval  
8. **Quality tier grading** — A+/A/B/C/D/REJECT with evidence criteria  
9. **OpportunityClusterEngine** — deduplication before sizing  
10. **PositionSizingEngine** — quality × EV × regime × drawdown multipliers  
11. **Wire PortfolioRiskEngine v2** — connect to auto-trader  
12. **Counterfactual rejection analysis** — learn from rejections  
13. **Performance attribution** — decompose P&L  
14. **Champion/challenger wiring** — protect baseline, test challenger  
15. **API endpoints** — expose opportunity pipeline  
16. **Report generation** — all required docs  

---

*This document is the pre-implementation baseline. It must be preserved to enable the three-way comparison (System A vs B vs C) required by the specification.*
