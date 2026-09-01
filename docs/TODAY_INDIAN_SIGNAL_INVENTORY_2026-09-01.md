# TODAY'S INDIAN MARKET SIGNAL INVENTORY — 2026-09-01

**Generated:** 2026-09-01 22:10 IST  
**Certification Level:** CODE_EXISTS | UNIT_TESTED | TODAY_RUNTIME_VALIDATED

---

## 1. SCANNER-BASED SIGNAL SOURCES (8 types)

### SIG-001 · MOMENTUM
| Field | Value |
|---|---|
| SIGNAL_ID | SIG-001 |
| SIGNAL_NAME | F&O Momentum Gainers/Losers |
| STRATEGY_ID | MOMENTUM |
| MARKET | NSE |
| INSTRUMENT_TYPE | F&O STOCKS + INDICES |
| TIMEFRAME | Intraday (computed from latest quote) |
| SOURCE_FILE | `src/services/india/scanner/engine.ts` → `runMomentum()` |
| PRIMARY_PROVIDER | Angel One SmartAPI — `getTopGainersLosers("PercPriceGainers/Losers", "NEAR")` |
| FALLBACK_PROVIDER | Yahoo Finance `getQuotes(FNO_STOCKS)` |
| REQUIRED_DATA | Live % price change; Yahoo 20-day avg volume for fallback |
| ENTRY_CONDITIONS | Top N instruments by absolute `changePct` |
| DIRECTION_LOGIC | `changePct >= 0` → LONG; `changePct < 0` → SHORT |
| CONFIDENCE | `min(abs(changePct)/5, 1)` — 5% move = 1.0 |
| EXIT_CONDITIONS | SL = entry × (1 ∓ 0.5%); Target = entry × (1 ± 1.0%); RR = 2.0 |
| ML_DEPENDENCIES | None for raw scanner; ML regime used in AI signal overlay |
| STATUS | **TODAY_RUNTIME_VALIDATED** — 148 paper trades opened today via MOMENTUM strategy |

### SIG-002 · OI BUILDUP
| Field | Value |
|---|---|
| SIGNAL_ID | SIG-002 |
| SIGNAL_NAME | Open Interest Build-up / Unwinding |
| STRATEGY_ID | OI_BUILDUP |
| MARKET | NSE |
| INSTRUMENT_TYPE | F&O INDICES (NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY) |
| TIMEFRAME | Intraday (option chain snapshot cadence ~5 min) |
| SOURCE_FILE | `src/services/india/scanner/engine.ts` → `runOiBuildup()` |
| PRIMARY_PROVIDER | Angel One `getOiBuildup()` → NSE option chain delta fallback |
| REQUIRED_DATA | ΔPE OI, ΔCE OI, spot price change % |
| ENTRY_CONDITIONS | `ΔPE_OI - ΔCE_OI > 0 AND price up` → LONG_BUILDUP; `ΔPE_OI - ΔCE_OI < 0 AND price down` → SHORT_BUILDUP; etc. |
| DIRECTION_LOGIC | LONG_BUILDUP/SHORT_COVERING = LONG; SHORT_BUILDUP/LONG_UNWINDING = SHORT |
| CONFIDENCE | LONG/SHORT buildup: 0.70; Covering/Unwinding: 0.50 |
| EXIT_CONDITIONS | Synthetic 0.5%/1.0% SL/Target |
| ML_DEPENDENCIES | None |
| STATUS | **TODAY_RUNTIME_VALIDATED** — 12 paper trades today (all 4 indices × 3 timeframes) |

### SIG-003 · PCR EXTREME
| Field | Value |
|---|---|
| SIGNAL_ID | SIG-003 |
| SIGNAL_NAME | Put-Call Ratio Extreme |
| STRATEGY_ID | PCR_EXTREME |
| MARKET | NSE |
| INSTRUMENT_TYPE | F&O INDICES |
| TIMEFRAME | Intraday |
| SOURCE_FILE | `src/services/india/scanner/engine.ts` → `runPcr()` |
| PRIMARY_PROVIDER | Angel One `getPutCallRatio()` |
| FALLBACK_PROVIDER | NSE index option chains |
| REQUIRED_DATA | PCR by OI across F&O segment per underlying |
| ENTRY_CONDITIONS | PCR ≥ 1.3 (excessive bearish positioning) → contrarian LONG; PCR ≤ 0.7 → contrarian SHORT |
| DIRECTION_LOGIC | Contrarian: high PCR = LONG (market over-positioned SHORT) |
| CONFIDENCE | `min(abs(PCR-1)/0.5, 1)` |
| ML_DEPENDENCIES | None |
| STATUS | **TODAY_RUNTIME_VALIDATED** — 12 paper trades today (all 4 indices × 3 timeframes) |

### SIG-004 · IV SPIKE
| Field | Value |
|---|---|
| SIGNAL_ID | SIG-004 |
| SIGNAL_NAME | Implied Volatility Spike |
| STRATEGY_ID | IV_SPIKE |
| MARKET | NSE |
| INSTRUMENT_TYPE | F&O INDICES |
| TIMEFRAME | Intraday (updated with each option chain snapshot) |
| SOURCE_FILE | `src/services/india/scanner/engine.ts` → `runIvSpike()` |
| PRIMARY_PROVIDER | NSE option chains (ATM IV) |
| REQUIRED_DATA | ATM IV per index; BANKNIFTY, NIFTY, FINNIFTY, MIDCPNIFTY option chains |
| ENTRY_CONDITIONS | ATM IV ≥ threshold (elevated: 14-25%) → LONG vega; compressed IV < 14 → SHORT vega |
| DIRECTION_LOGIC | IV ≥ 14 → LONG; IV < 14 → SHORT |
| CONFIDENCE | `min((IV-14)/16, 1)` |
| ML_DEPENDENCIES | IV regime classifier available (`predict_iv_regime`) — not applied in basic scanner path |
| STATUS | **TODAY_RUNTIME_VALIDATED** — 12 paper trades today |

### SIG-005 · VOLUME BREAKOUT
| Field | Value |
|---|---|
| SIGNAL_ID | SIG-005 |
| SIGNAL_NAME | Volume Breakout (institutional participation) |
| STRATEGY_ID | VOLUME_BREAKOUT |
| MARKET | NSE |
| INSTRUMENT_TYPE | F&O STOCKS |
| TIMEFRAME | Daily |
| SOURCE_FILE | `src/services/india/scanner/engine.ts` → `runVolumeBreakout()` |
| PRIMARY_PROVIDER | Yahoo Finance historical + quotes |
| REQUIRED_DATA | Today's volume; 20-day average volume per stock |
| ENTRY_CONDITIONS | Today volume ≥ 1.5× 20-day average AND absolute changePct ranked |
| DIRECTION_LOGIC | `changePct >= 0` → LONG; `< 0` → SHORT |
| CONFIDENCE | `min((volRatio-1)/2, 1)` |
| ML_DEPENDENCIES | None |
| STATUS | **TODAY_RUNTIME_VALIDATED** — 9 paper trades today (ADANIGREEN ×3 timeframes ×3 occurrences) |

### SIG-006 · RANGE EXPANSION (WR8)
| Field | Value |
|---|---|
| SIGNAL_ID | SIG-006 |
| SIGNAL_NAME | Range Expansion (WR8 + Bullish Trend Stack) |
| STRATEGY_ID | RANGE_EXPANSION |
| MARKET | NSE |
| INSTRUMENT_TYPE | F&O STOCKS |
| TIMEFRAME | Daily |
| SOURCE_FILE | `src/services/india/scanner/engine.ts` → `runRangeExpansion()` |
| PRIMARY_PROVIDER | Yahoo Finance (1y daily history) |
| REQUIRED_DATA | 200+ daily candles; today H-L > 1.2× widest of prior 7 days; SMA 20>50>200; vol ≥ 1.5×; close upper 50% of range; weekly/monthly close positive |
| ENTRY_CONDITIONS | All 7 conditions must pass (Chartink WR8 equivalent) |
| DIRECTION_LOGIC | Always LONG (scanner filters to bullish-trend setups only) |
| CONFIDENCE | 0.80 (fixed — every hit clears multiple gates) |
| ML_DEPENDENCIES | None |
| STATUS | **TODAY_RUNTIME_VALIDATED** — 1 hit today: BAJAJ-AUTO (rangeRatio=1.50) |

### SIG-007 · FNO BULLISH TREND (Chartink-equivalent)
| Field | Value |
|---|---|
| SIGNAL_ID | SIG-007 |
| SIGNAL_NAME | F&O Bullish Trend Stack (14-condition) |
| STRATEGY_ID | FNO_TREND (bullish variant) |
| MARKET | NSE |
| INSTRUMENT_TYPE | F&O STOCKS |
| TIMEFRAME | Daily |
| SOURCE_FILE | `src/services/india/scanner/engine.ts` → `runFnoBullishTrend()` |
| PRIMARY_PROVIDER | Yahoo Finance (1y daily history) |
| REQUIRED_DATA | EMA(5), SMA(20), WMA(10), SMA(40), SMA(50), ADX(14), DI+/DI-, MACD(12,26,9), RSI(14), volume, price |
| ENTRY_CONDITIONS | All 14 conditions: EMA5>SMA20, WMA10>SMA20, ADX DI+>20, ADX>20, Vol>100k, MACD>0, Close>prev/2d close, Close>SMA50, Close>150, DI+>DI-, RSI>50, MACD>Signal, SMA20>SMA40 |
| DIRECTION_LOGIC | Always LONG |
| ML_DEPENDENCIES | None |
| STATUS | **TODAY_RUNTIME_VALIDATED** — 3 hits today: BAJAJ-AUTO, KOTAKBANK, OIL |

### SIG-008 · FNO BEARISH TREND (Chartink-equivalent)
| Field | Value |
|---|---|
| SIGNAL_ID | SIG-008 |
| SIGNAL_NAME | F&O Bearish Trend Stack (14-condition inverse) |
| STRATEGY_ID | FNO_TREND (bearish variant) |
| MARKET | NSE |
| INSTRUMENT_TYPE | F&O STOCKS |
| TIMEFRAME | Daily |
| SOURCE_FILE | `src/services/india/scanner/engine.ts` → `runFnoBearishTrend()` |
| PRIMARY_PROVIDER | Yahoo Finance (1y daily history) |
| REQUIRED_DATA | Same as bullish; all conditions inverted |
| ENTRY_CONDITIONS | Exact inverse of bullish 14-condition stack |
| DIRECTION_LOGIC | Always SHORT |
| ML_DEPENDENCIES | None |
| STATUS | **TODAY_RUNTIME_VALIDATED** — 10 hits today: ADANIENSOL, BANDHANBNK, HINDPETRO, LUPIN, MARUTI, RECLTD, RVNL, SBILIFE, TATACONSUM, WAAREEENER |

---

## 2. POSITIONING-BASED SIGNAL SOURCES (2 types)

### SIG-009 · LIQUIDITY EDGE (ILE-Pine port)
| Field | Value |
|---|---|
| SIGNAL_ID | SIG-009 |
| SIGNAL_NAME | India Liquidity Edge |
| STRATEGY_ID | LIQUIDITY_EDGE |
| MARKET | NSE |
| INSTRUMENT_TYPE | F&O INDICES |
| TIMEFRAME | 1m / 5m / 15m |
| SOURCE_FILE | `src/features/india/scalping/strategies/positioning.ts` |
| REQUIRED_DATA | PCR OI, max pain, spot, CE/PE OI walls, price trend |
| ENTRY_CONDITIONS | Bullish confluence: PCR > neutral + max pain above + PE floor OI wall + rising price. Bearish: inverse. |
| DIRECTION_LOGIC | Composite score-based confluence gate |
| ML_DEPENDENCIES | None |
| STATUS | **TODAY_RUNTIME_VALIDATED** — 12 paper trades today (4 indices × 3 timeframes) |

### SIG-010 · MAX PAIN GRAVITY (ILE-Pine port)
| Field | Value |
|---|---|
| SIGNAL_ID | SIG-010 |
| SIGNAL_NAME | Max Pain Gravity |
| STRATEGY_ID | MAX_PAIN_GRAVITY |
| MARKET | NSE |
| INSTRUMENT_TYPE | F&O INDICES |
| TIMEFRAME | 1m / 5m / 15m |
| SOURCE_FILE | `src/features/india/scalping/strategies/positioning.ts` |
| REQUIRED_DATA | Max pain strike, current spot, OI concentration |
| ENTRY_CONDITIONS | Spot ≥ `buffer_pct` away from max pain → fade back toward max pain; confidence boosted by OI wall in fade direction |
| DIRECTION_LOGIC | LONG when spot < max pain; SHORT when spot > max pain |
| ML_DEPENDENCIES | None |
| STATUS | **TODAY_RUNTIME_VALIDATED** — 9 paper trades today (4 indices × 3 timeframes minus NIFTY/5m & 15m) |

---

## 3. PRICE-ACTION SIGNAL SOURCES (1 type)

### SIG-011 · OPENING RANGE BREAKOUT
| Field | Value |
|---|---|
| SIGNAL_ID | SIG-011 |
| SIGNAL_NAME | Opening Range Breakout (ORB) |
| STRATEGY_ID | OPENING_BREAKOUT |
| MARKET | NSE |
| INSTRUMENT_TYPE | F&O STOCKS + INDICES |
| TIMEFRAME | 1m / 5m / 15m |
| SOURCE_FILE | `src/features/india/scalping/strategies/opening-breakout.ts` |
| REQUIRED_DATA | 09:15–09:20 IST 5-min candle (opening range HIGH/LOW); subsequent candle close vs range |
| ENTRY_CONDITIONS | Close > opening HIGH → LONG breakout; Close < opening LOW → SHORT breakdown; ATR confirmation; volume filter |
| EXIT_CONDITIONS | SL = opening range boundary; Target = entry ± (opening range × multiplier) |
| RISK_REQUIREMENTS | ATR ≥ minimum; volume ≥ threshold |
| ML_DEPENDENCIES | None (pure price action) |
| STATUS | **TODAY_RUNTIME_VALIDATED** — 102 paper trades today across multiple stocks |

---

## 4. ML-ENHANCED SIGNAL SOURCES

### SIG-012 · AI SIGNAL (Decision Pipeline)
| Field | Value |
|---|---|
| SIGNAL_ID | SIG-012 |
| SIGNAL_NAME | AI Signal (ML Decision Pipeline) |
| STRATEGY_ID | AI_SIGNAL |
| MARKET | NSE |
| INSTRUMENT_TYPE | F&O STOCKS |
| TIMEFRAME | Daily / 1d |
| SOURCE_FILE | `src/app/api/in/ai-signals/route.ts` |
| PIPELINE | Market data → Feature engine → ML regime classifier → ML stock ranker → ML strategy selector → ML risk predictor → Meta calibration → Signal |
| ML_DEPENDENCIES | `predictRegime()`, `predictRankings()`, `predictStrategy()`, `predictRisk()` — all called via `src/lib/india/ml-client.ts` |
| FALLBACK | Rule-based heuristic scoring when ML service unavailable (ML_MODE=fallback) |
| STATUS | **TODAY_RUNTIME_VALIDATED** — 1 paper trade today (BAJAJ-AUTO, AI_SIGNAL:1d) |

### SIG-013 · DAILY PICK (IndiaDailyPick engine)
| Field | Value |
|---|---|
| SIGNAL_ID | SIG-013 |
| SIGNAL_NAME | India F&O Daily Pick |
| STRATEGY_ID | DAILY_PICK |
| MARKET | NSE |
| INSTRUMENT_TYPE | F&O STOCKS + INDICES (option-expressed for INDICES_SCALP bucket) |
| TIMEFRAME | Daily (frozen at market open, tracked intraday) |
| SOURCE_FILE | `src/features/india/daily-picks/engine.ts` |
| BUCKETS | INDICES_SCALP (option premium-level), MOMENTUM, SCALPING, POTENTIAL, OPENING_BREAKOUT, SHORT_MOMENTUM |
| ML_DEPENDENCIES | ML regime + ranking influence bucket scoring |
| STATUS | **TODAY_RUNTIME_VALIDATED** — 17 daily picks today across 6 buckets; 4 paper trades |

---

## 5. SIGNAL SNAPSHOTTER (Background service)

### SIG-014 · SIGNAL SNAPSHOTTER
| Field | Value |
|---|---|
| SIGNAL_ID | SIG-014 |
| SIGNAL_NAME | F&O Signal Snapshotter (8-factor score) |
| STRATEGY_ID | N/A (background scoring, not trade-triggering) |
| MARKET | NSE |
| INSTRUMENT_TYPE | All 172 F&O STOCKS |
| TIMEFRAME | 60-second refresh cycle during 09:00–16:00 IST |
| SOURCE_FILE | `src/services/india/signals/snapshotter.ts` |
| SCORING | 8-factor model: SMA50 proximity (15pts) + SMA200 proximity (15pts) + intraday change (20pts) + analyst target (15pts) + RSI(14) (10pts) + ADX(14) (8pts) + relative volume (9pts) + delivery% (8pts) = 100pts max |
| LABELS | STRONG BUY ≥55; BUY ≥20; HOLD; SELL ≤-20; STRONG SELL ≤-55 |
| PERSISTENCE | Redis `fno-pulse:signal:{SYMBOL}` TTL 7 days; `since` resets only on label change |
| STATUS | **TODAY_RUNTIME_VALIDATED** — 172 symbols snapshotted; 8 BUY, 18 SELL, 146 HOLD as of session close |

---

## SIGNAL SOURCE SUMMARY TABLE

| ID | Name | Type | Instruments | Today Hits | Paper Trades | Status |
|---|---|---|---|---|---|---|
| SIG-001 | Momentum | Scanner | 172 stocks | Live feed | 148 | RUNTIME_VALIDATED |
| SIG-002 | OI Buildup | Scanner | 4 indices | 4 indices | 12 | RUNTIME_VALIDATED |
| SIG-003 | PCR Extreme | Scanner | 4 indices | 4 indices | 12 | RUNTIME_VALIDATED |
| SIG-004 | IV Spike | Scanner | 4 indices | 4 indices | 12 | RUNTIME_VALIDATED |
| SIG-005 | Volume Breakout | Scanner | 172 stocks | ADANIGREEN (1+) | 9 | RUNTIME_VALIDATED |
| SIG-006 | Range Expansion | Scanner | 172 stocks | 1 (BAJAJ-AUTO) | 0* | RUNTIME_VALIDATED |
| SIG-007 | FnO Bullish Trend | Scanner | 172 stocks | 3 stocks | 0* | RUNTIME_VALIDATED |
| SIG-008 | FnO Bearish Trend | Scanner | 172 stocks | 10 stocks | 0* | RUNTIME_VALIDATED |
| SIG-009 | Liquidity Edge | Positioning | 4 indices | 4 indices | 12 | RUNTIME_VALIDATED |
| SIG-010 | Max Pain Gravity | Positioning | 4 indices | 4 indices | 9 | RUNTIME_VALIDATED |
| SIG-011 | Opening Breakout | Price Action | 46 stocks/idx | Multiple | 102 | RUNTIME_VALIDATED |
| SIG-012 | AI Signal | ML Pipeline | F&O stocks | 1 (BAJAJ-AUTO) | 1 | RUNTIME_VALIDATED |
| SIG-013 | Daily Pick | ML+Rule | 17 picks | 17 (6 buckets) | 4 | RUNTIME_VALIDATED |
| SIG-014 | Snapshotter | Scoring | 172 stocks | 172 scored | N/A | RUNTIME_VALIDATED |

*FnO trend scanner hits are surfaced as signals in the scanner UI but not automatically paper-traded by the scalper job today (scanner job feeds WhatsApp notifications, not the scalper's direct signal engine).

---

*File generated: 2026-09-01 | Source of truth: Redis state + PostgreSQL + live code inspection*
