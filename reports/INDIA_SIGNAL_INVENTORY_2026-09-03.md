# AlphaForge — India Signal Inventory
**Date:** 2026-09-03  
**Purpose:** Complete audit of ALL Indian market signal producers in the codebase

---

## Complete Signal Family Registry

### 1. AI Signals (AI_SIGNAL Family)

| Field | Value |
|-------|-------|
| Source File | `src/features/ai-signals/india-builder.ts` |
| API Route | `GET /api/in/ai-signals` |
| Worker | `india-auto-trader` (60s cadence, market hours) |
| Timeframe | Multi-timeframe (1d primary, 1h/15m secondary) |
| Strategy | `AI_MULTI_FACTOR` |
| Model | `alphaforge-ai-v2` |
| Entry Logic | 10+ factors: SMA 20/50/200 trend, RSI(14), 5d momentum, volume thrust, PCR, ATM IV, ΔPE-CE OI, max-pain pull, scanner agreement, session quality, Super Confluence |
| Quant Pre-Filter | ADX ≥ 18, relVol ≥ 1.1×, ATR% ≥ 0.4% |
| ML Blending | 65% heuristic + 35% Python ML service |
| WAIT Threshold | 0.22 composite magnitude |
| Confidence | 0–1 continuous |
| Exit Logic | SL = ATR-based, TP1/2/3 at configurable R multiples |
| Risk/Reward | Per-signal, varies |
| Required Data | Quotes, option chain (PCR, IV, OI), historical candles |
| OI Required | Yes (PCR, ATM IV, OI delta) |
| Source Attribution | `AI_ENGINE:{modelVersion}` |
| WhatsApp | Yes (confidenceScore ≥ 60) |

**Universe:** NIFTY indices + major F&O stocks (ADX/vol/ATR filtered)

---

### 2. Daily Picks (DAILY_PICK Family) — 5 Buckets

| Field | Value |
|-------|-------|
| Source File | `src/features/india/daily-picks/engine.ts` + `builder.ts` |
| API Route | `GET /api/in/daily-picks` |
| Worker | `india-daily-picks` (60s, `runOnStart: true`) |
| Model Version | Tracked per pick |
| Persistence | `IndiaDailyPick` table (one row per tradeDate:bucket:rank) |
| WhatsApp | Yes (new picks dispatch on first-time freeze) |

#### Bucket Breakdown

| Bucket | Strategy ID | Universe | Description |
|--------|------------|----------|-------------|
| `INDICES_SCALP` | `INDICES_SCALP` | NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY | ATM/near-ATM option scalp. Entry/SL/TP are **option premiums (₹/lot)**, not index levels. `optionContract` JSON attached. |
| `OPENING_BREAKOUT` | `OPENING_BREAKOUT` | Full F&O universe | ORB (Opening Range Breakout) pattern |
| `HIGHLY_MOMENTUM` | `HIGHLY_MOMENTUM` | F&O stocks | Strong trend continuation candidates |
| `HIGHLY_SCALPING` | `HIGHLY_SCALPING` | F&O stocks | Intraday scalp setups |
| `HIGHLY_POTENTIAL` | `HIGHLY_POTENTIAL` | F&O stocks | Swing/positional upside setups |

**Key invariant:** Daily picks are FROZEN at selection time. Entry/SL/target are immutable. Live tracking (`status`, `lastPrice`, `pnlPct`) updates without changing the decision record.

---

### 3. F&O Scanners (FNO_SCANNER Family) — 6 Types

| Field | Value |
|-------|-------|
| Source File | `src/services/india/scanner/engine.ts` |
| API Route | `GET /api/in/signals` (unified board) + `GET /api/in/scanner?type=X` |
| Worker | `india-scanner` (5-min cadence) |
| Timeframe | 5m–15m |

#### Scanner Type Breakdown

| Type | Strategy ID | Logic | OI Required |
|------|------------|-------|-------------|
| `momentum` | `MOMENTUM` | F&O movers by % change; Angel OI-buildup first-party API if available | No |
| `oi-buildup` | `OI_BUILDUP` | ΔOI × price direction; 4-quadrant: LONG_BUILDUP / SHORT_BUILDUP / LONG_UNWIND / SHORT_COVERING | **Yes** |
| `pcr` | `PCR_EXTREME` | PCR extremes (>1.3 bullish / <0.7 bearish); contrarian signal | **Yes** |
| `iv-spike` | `IV_SPIKE` | ATM IV deviation from 20d mean | **Yes** |
| `volume-breakout` | `VOLUME_BREAKOUT` | Volume ≥ 1.5× 20d average + price quartile check | No |
| `range-expansion` | `RANGE_EXPANSION` | WR8 range expansion + bullish trend confirmation | No |

**Post-NSE-removal:** `indexChains()` now routes through `registry.getOptionChain()` (Angel One → Upstox → Yahoo). No direct NSE calls.

---

### 4. FnO Trend Scanners (FNO_TREND Family) — 14 Conditions

| Field | Value |
|-------|-------|
| Source Files | `src/app/api/in/fno-bullish-trend/route.ts` + `src/app/api/in/fno-bearish-trend/route.ts` |
| Worker | `india-fno-trend-track` (60s cadence) |
| Strategy | `FNO_TREND_14COND` |
| Timeframe | Daily (1d) |
| Persistence | `FnoTrendScan` table (tradeDate, scanType, symbol) |

#### 14 Bullish Conditions (all must pass)
1. EMA(5) > SMA(20)
2. ADX DI+(14) > 20
3. ADX(14) > 20
4. Volume > 1 Lakh (100,000 shares)
5. MACD Line > 0
6. RSI(14) > 50
7. Close > EMA(20)
8. Close > EMA(50)
9. Close > SMA(100)
10. Close > SMA(200)
11. OI > previous OI (OI buildup)
12. Price gaining (changePct > 0)
13. Within ATR(14) range of recent high
14. Volume trending up (3-day avg volume > 10-day avg)

**Level calculations:** SL = 1.4×ATR below entry, TP1 = 1.6×ATR, TP2 = 2.6×ATR, TP3 = 4.0×ATR

---

### 5. MSB Signals (MSB Family)

| Field | Value |
|-------|-------|
| Source File | `src/app/api/in/msb-signals/route.ts` |
| API Route | `GET /api/in/msb-signals` |
| Worker | None (on-demand) |
| Strategy | `MSB` |
| Timeframe | 1h, 15m, 5m |
| Description | Market Structure Break — BOS/CHoCH patterns from price action |
| Required Data | OHLCV candles |

---

### 6. Scalper Signals (SCALPER Family) — 9 F&O Strategies

| Field | Value |
|-------|-------|
| Source Files | `src/features/india/scalping/` |
| API Route | `GET /api/in/scalper/signals` |
| Worker | `india-scalper` (per-tick, processes candles every ~1min) |
| Persistence | `PaperTrade` table (with `in:{strategyId}:{tf}` source format) |

#### 9 Strategy IDs

| Strategy ID | Description | Timeframes |
|-------------|-------------|-----------|
| `UT_BOT_ATR` | UT Bot ATR trailing stop strategy | 1m, 3m, 5m |
| `SUPER_CONFLUENCE` | All 4 gates: UT Bot + AI Neural HMA + SMC BOS/CHoCH + EMA 9/15/21 | 1m, 5m |
| `SMC_BOS` | Smart Money Concepts Break of Structure | 5m, 15m |
| `SMC_CHOCH` | Smart Money Concepts Change of Character | 5m, 15m |
| `HMA_NEURAL` | AI Neural HMA trend filter | 1m, 5m |
| `EMA_STACK` | EMA 9/15/21 stack confirmation | 1m, 5m |
| `LIQUIDITY_EDGE` | OI wall + max-pain liquidity edge | 5m |
| `OPENING_BREAKOUT` | 9:15–9:25 ORB scalp | 1m (first 30min) |
| `VWAP_REVERSION` | VWAP mean reversion | 5m, 15m |

**DUP-001 fix:** Cross-timeframe duplicate guard — `existingOpenAnyTf` check prevents opening 3 trades (1m/5m/15m) for the same strategy signal.

---

### 7. Expiry Trades (EXPIRY_TRADE Family)

| Field | Value |
|-------|-------|
| Source Files | `src/features/india/expiry-trades/` |
| API Route | `GET /api/in/expiry-trades` |
| Worker | None (on-demand, expiry-day only) |
| Timeframe | Expiry day only |

#### Sub-Strategies

| Sub-Strategy | Description | Risk |
|-------------|-------------|------|
| `GAMMA_BLAST` | ATM/near-ATM options near expiry — high gamma | MEDIUM-HIGH |
| `HERO_ZERO` | Deep OTM options near expiry — lottery plays | VERY HIGH |

---

### 8. Opportunity Engine (OPPORTUNITY_ENGINE Family)

| Field | Value |
|-------|-------|
| Source Files | `src/lib/opportunity-engine/` |
| API Route | `GET /api/in/opportunity-engine` |
| Worker | `india-auto-trader` (60s) |
| Pipeline | 12-stage validation → paper trade creation |
| Budget | ₹1,00,000/day, max 5 positions × ₹20,000 notional |
| Entry Gate | Score ≥ 0.52 (`0.35×confidence + 0.25×winProbability + 0.25×grade + 0.15×R:R`) |
| Risk Gate | SL distance ≤ 2.5% of entry |
| No-new-entry after | 14:45 IST |
| EOD square-off | 15:30 IST |

---

### 9. Strategy Lab Signals (STRATEGY_LAB Family)

| Field | Value |
|-------|-------|
| Source Files | `src/features/strategy-lab/` |
| Worker | `strategy-lab` (per hourly bar) |
| Persistence | `StrategyPaperTrade` table |
| Currency | INR for India trades |

---

## Signal Consumer Map

| Consumer | Signal Sources | Purpose |
|----------|--------------|---------|
| `india-auto-trader` worker | All signal families | Score → 12-stage pipeline → PaperTrade |
| `/api/in/signal-center` | All signal families | Unified deduplicated view |
| Dashboard UI | All API routes | Display, filter, sort |
| WhatsApp notifier | AI Signals (score≥60), Scanner (>p70), Daily Picks (new) | Push notifications |
| `SignalHistory` table | `signal-ingest` worker (30min dedup) | Historical record |
| `SignalLifecycleEvent` | Signal Intelligence Engine | State machine tracking |
| `OpportunityCluster` | `OpportunityCluster` model | Anti-double-counting |
| `PaperTrade` | Paper trading execution | Execution + P&L |

---

## Signal Deduplication Architecture

**DUP-001 Root Cause:** Same underlying opportunity generates signals from multiple families (AI Signal + F&O Scanner + Daily Pick + FnO Trend) and from multiple timeframes (1m + 5m + 15m for same strategy).

**Fix Applied:**

1. **Cross-family deduplication** — `india-signal-center/aggregator.ts`:
   - Signals with same `(symbol, direction)` within 30-minute window → one `OpportunityCluster`
   - `independentConfirmations` = count of unique families (not signal count)
   - Display: "1 Opportunity, 4 confirmations" not "4 separate signals"

2. **Cross-timeframe deduplication** — `india/scalping/paper-trader.ts`:
   - `existingOpenAnyTf` check: if ANY timeframe for this strategy+symbol is open, skip
   - Prevents 3× inflation from 1m/5m/15m parallelism

3. **30-minute signal dedup** — `signal-ingest` worker:
   - 30-minute per-symbol deduplication on `SignalHistory` insertion

---

## Source Attribution Rules

| Signal Family | Required Attribution Format |
|--------------|---------------------------|
| AI Signals | `AI_ENGINE:{modelVersion}` — never just "technical" |
| Daily Picks | `DAILY_PICK:{bucket}` |
| F&O Scanners | `FNO_SCANNER:{type.toUpperCase()}` |
| FnO Trend | `FNO_TREND:BULLISH` or `FNO_TREND:BEARISH` |
| MSB | `MSB:{timeframe}` |
| Scalper | `SCALPER:{strategyId}:{timeframe}` |
| Expiry | `EXPIRY_TRADE:{GAMMA_BLAST\|HERO_ZERO}` |
| Opportunity Engine | `OPPORTUNITY_ENGINE:{sourceSignalId}` |

**Rule:** Every signal must have `sourceAttribution` that identifies the specific sub-strategy. Generic "technical" attribution is prohibited.

---

## Signals NOT In Production Scope (RESEARCH only)

| Signal | Status | Reason |
|--------|--------|--------|
| Backtesting V2 signals | RESEARCH | Runs in isolated backtesting context |
| Shadow trading (experiments) | RESEARCH | Requires explicit approvalToken |
| ML pure model signals | EXPERIMENTAL | `ENABLE_PRICE_FORECASTER=false` by default |
| RL executor signals | EXPERIMENTAL | `ENABLE_RL_EXECUTOR=false` by default |

---

*Inventory completed 2026-09-03 via full codebase scan. 9 signal families, 33 distinct strategies identified.*
