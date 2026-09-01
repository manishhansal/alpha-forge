/**
 * Phase 1 — StrategyRegistry
 *
 * Single source of truth for every strategy in AlphaForge.
 * No strategy should exist outside this registry.
 *
 * Each strategy is identified by a unique `strategyId`.  The registry
 * is a plain in-memory map populated at module load from the canonical
 * STRATEGY_CATALOG below.  It is deliberately NOT a database table because
 * strategy metadata is code — it must be version-controlled and reviewed.
 *
 * To add a strategy:
 *   1. Add a `StrategyMeta` entry to STRATEGY_CATALOG
 *   2. Define a `StrategyHypothesis` in the hypothesis registry
 *   3. Run the research pipeline to generate performance evidence
 *   4. The strategy starts in EXPERIMENTAL status
 */

import type {
  StrategyMeta,
  StrategyLifecycleStatus,
} from "../types";

// ─── Canonical Strategy Catalog ──────────────────────────────────────────────
// Every strategy that exists in AlphaForge must appear here.
// Strategies are grouped by market / instrument for clarity.

const STRATEGY_CATALOG: StrategyMeta[] = [
  // ── Crypto Scalping Strategies ─────────────────────────────────────────────
  {
    strategyId: "UT_SMC",
    strategyName: "UT Bot + SMC",
    version: "1.0.0",
    market: "CRYPTO",
    instrumentType: "CRYPTO_PERP",
    timeframe: "5m",
    entryLogic:
      "ATR trailing-stop flip (UT Bot, keyValue=1, ATR period=10) confirmed by SMC BOS/CHoCH pivot structure. Long when close crosses above trail in bullish pivot context; short when crosses below in bearish pivot context.",
    exitLogic: "Target 2×ATR beyond entry; hard stop at 1×ATR.",
    stopLossLogic: "1×ATR beyond entry in unfavourable direction.",
    targetLogic: "2×ATR from entry.",
    positionSizing: "Fixed-fraction 1% risk per trade, scaled by confidence.",
    requiredData: ["OHLCV 5m", "ATR(10)", "Swing pivots"],
    requiredFeatures: ["utBotTrail", "smcBias", "atr"],
    mlDependencies: [],
    riskDependencies: ["PortfolioRiskEngine", "KillSwitch"],
    expectedHoldingPeriod: "5–60 minutes",
    strategyCategory: "TREND_FOLLOWING",
    status: "RESEARCH",
    registeredAt: "2024-01-01T00:00:00Z",
    lastUpdatedAt: "2025-01-01T00:00:00Z",
  },
  {
    strategyId: "VWAP_SWEEP_TREND",
    strategyName: "VWAP Sweep + Trend",
    version: "1.0.0",
    market: "CRYPTO",
    instrumentType: "CRYPTO_PERP",
    timeframe: "5m",
    entryLogic:
      "Higher-timeframe EMA50 rising (slope > 0). Price sweeps prior swing H/L with current bar wick, stretched ≥0.8×ATR from VWAP. Entry on rejection candle closing in upper/lower third.",
    exitLogic: "Target = VWAP; stop = sweep wick ±0.25×ATR.",
    stopLossLogic: "Sweep wick extreme ±0.25×ATR.",
    targetLogic: "VWAP mean reversion target.",
    positionSizing: "Fixed-fraction 1% risk, confidence-scaled.",
    requiredData: ["OHLCV 5m", "VWAP", "EMA50", "Swing highs/lows"],
    requiredFeatures: ["vwap", "ema50", "atr", "swingHighLow"],
    mlDependencies: [],
    riskDependencies: ["PortfolioRiskEngine", "KillSwitch"],
    expectedHoldingPeriod: "10–90 minutes",
    strategyCategory: "MEAN_REVERSION",
    status: "RESEARCH",
    registeredAt: "2024-01-01T00:00:00Z",
    lastUpdatedAt: "2025-01-01T00:00:00Z",
  },
  {
    strategyId: "NEWS_MOMENTUM",
    strategyName: "News Momentum",
    version: "1.0.0",
    market: "CRYPTO",
    instrumentType: "CRYPTO_PERP",
    timeframe: "5m",
    entryLogic:
      "Volume ≥2.8× 20-bar avg AND bar range ≥1.8×ATR AND body in top/bottom 60% AND close above/below SMA20. Rides the impulse direction.",
    exitLogic: "Target 1.5× impulse bar range beyond entry; stop at impulse bar opposite extreme.",
    stopLossLogic: "Impulse bar opposite extreme.",
    targetLogic: "1.5× impulse bar range.",
    positionSizing: "Reduced size (0.5× base) due to volatility spike.",
    requiredData: ["OHLCV 5m", "SMA20", "ATR", "20-bar volume avg"],
    requiredFeatures: ["volumeRatio", "atr", "sma20", "barRange"],
    mlDependencies: [],
    riskDependencies: ["PortfolioRiskEngine", "KillSwitch"],
    expectedHoldingPeriod: "5–30 minutes",
    strategyCategory: "MOMENTUM",
    status: "RESEARCH",
    registeredAt: "2024-01-01T00:00:00Z",
    lastUpdatedAt: "2025-01-01T00:00:00Z",
  },
  {
    strategyId: "RANGE_SCALP",
    strategyName: "Range Scalp",
    version: "1.0.0",
    market: "CRYPTO",
    instrumentType: "CRYPTO_PERP",
    timeframe: "5m",
    entryLogic:
      "BB width ≤4.5×ATR (range-bound). BB upper/lower tagged; RSI ≤32 (long) or ≥68 (short); close back inside band. Flat midband filter to avoid trending markets.",
    exitLogic: "Target = BB midband (SMA20); stop = range extreme ±0.35×ATR.",
    stopLossLogic: "Band extreme ±0.35×ATR.",
    targetLogic: "SMA20 midband reversion.",
    positionSizing: "Fixed-fraction 1% risk.",
    requiredData: ["OHLCV 5m", "Bollinger Bands", "RSI(14)", "ATR"],
    requiredFeatures: ["bb", "rsi14", "atr", "bbWidth"],
    mlDependencies: [],
    riskDependencies: ["PortfolioRiskEngine"],
    expectedHoldingPeriod: "10–60 minutes",
    strategyCategory: "MEAN_REVERSION",
    status: "RESEARCH",
    registeredAt: "2024-01-01T00:00:00Z",
    lastUpdatedAt: "2025-01-01T00:00:00Z",
  },
  {
    strategyId: "EMA_PULLBACK",
    strategyName: "EMA Pullback",
    version: "1.0.0",
    market: "CRYPTO",
    instrumentType: "CRYPTO_PERP",
    timeframe: "5m",
    entryLogic:
      "EMA9 > EMA20 > EMA50 stack + rising slope. Prior bar low pierced EMA9-20 zone. Current bar closes bullish above EMA9.",
    exitLogic: "Target = 2× stop distance; stop = pullback low ±0.2×ATR.",
    stopLossLogic: "Pullback low ±0.2×ATR.",
    targetLogic: "2× risk reward from stop.",
    positionSizing: "Fixed-fraction 1% risk, confidence-scaled.",
    requiredData: ["OHLCV 5m", "EMA9", "EMA20", "EMA50", "ATR"],
    requiredFeatures: ["ema9", "ema20", "ema50", "atr"],
    mlDependencies: [],
    riskDependencies: ["PortfolioRiskEngine"],
    expectedHoldingPeriod: "15–120 minutes",
    strategyCategory: "TREND_FOLLOWING",
    status: "RESEARCH",
    registeredAt: "2024-01-01T00:00:00Z",
    lastUpdatedAt: "2025-01-01T00:00:00Z",
  },
  {
    strategyId: "VWAP_REVERSION",
    strategyName: "VWAP Reversion",
    version: "1.0.0",
    market: "CRYPTO",
    instrumentType: "CRYPTO_PERP",
    timeframe: "5m",
    entryLogic:
      "Price ≥1.5×ATR from VWAP. RSI at extreme (≤30 or ≥70). Prior bar more extreme than current (momentum weakening). Confirmation bar closes against extension.",
    exitLogic: "Target = VWAP; stop = 1×ATR beyond entry.",
    stopLossLogic: "1×ATR beyond entry.",
    targetLogic: "VWAP mean reversion.",
    positionSizing: "Fixed-fraction 1% risk.",
    requiredData: ["OHLCV 5m", "VWAP", "RSI(14)", "ATR"],
    requiredFeatures: ["vwap", "rsi14", "atr"],
    mlDependencies: [],
    riskDependencies: ["PortfolioRiskEngine"],
    expectedHoldingPeriod: "5–45 minutes",
    strategyCategory: "MEAN_REVERSION",
    status: "RESEARCH",
    registeredAt: "2024-01-01T00:00:00Z",
    lastUpdatedAt: "2025-01-01T00:00:00Z",
  },
  {
    strategyId: "ORDERFLOW_SWEEP",
    strategyName: "Orderflow Sweep",
    version: "1.0.0",
    market: "CRYPTO",
    instrumentType: "CRYPTO_PERP",
    timeframe: "5m",
    entryLogic:
      "Equal swing H/L cluster within 0.35×ATR. Current bar wick pierces cluster ≥0.15×ATR, closes back inside, volume ≥1.8×avg. Bullish/bearish close confirmation.",
    exitLogic: "Target = 2× stop distance; stop = wick extreme ±0.2×ATR.",
    stopLossLogic: "Wick extreme ±0.2×ATR.",
    targetLogic: "2× risk reward.",
    positionSizing: "Fixed-fraction 1% risk.",
    requiredData: ["OHLCV 5m", "ATR", "Swing H/L", "Volume"],
    requiredFeatures: ["atr", "swingHighLow", "volumeRatio"],
    mlDependencies: [],
    riskDependencies: ["PortfolioRiskEngine"],
    expectedHoldingPeriod: "5–30 minutes",
    strategyCategory: "LIQUIDITY",
    status: "RESEARCH",
    registeredAt: "2024-01-01T00:00:00Z",
    lastUpdatedAt: "2025-01-01T00:00:00Z",
  },
  {
    strategyId: "FIB_PULLBACK",
    strategyName: "Fib Pullback (1m)",
    version: "1.0.0",
    market: "CRYPTO",
    instrumentType: "CRYPTO_PERP",
    timeframe: "1m",
    entryLogic:
      "Impulse ≥3×ATR in last 12 bars. Pullback reaches 0.5-0.618 Fib without breaking 0.786. Confirmation candle pierces 0.5 Fib zone and closes back through.",
    exitLogic: "Target = 0.0 Fib (impulse extreme); stop = pullback wick ±0.15×ATR.",
    stopLossLogic: "Deepest pullback wick ±0.15×ATR.",
    targetLogic: "0.0 Fibonacci level (impulse extension).",
    positionSizing: "Smaller size (0.75×) due to 1m noise.",
    requiredData: ["OHLCV 1m", "ATR", "Fibonacci levels"],
    requiredFeatures: ["atr", "fibLevels", "impulseMagnitude"],
    mlDependencies: [],
    riskDependencies: ["PortfolioRiskEngine"],
    expectedHoldingPeriod: "1–15 minutes",
    strategyCategory: "TREND_FOLLOWING",
    status: "RESEARCH",
    registeredAt: "2024-01-01T00:00:00Z",
    lastUpdatedAt: "2025-01-01T00:00:00Z",
  },
  {
    strategyId: "INSTITUTIONAL_SMC",
    strategyName: "Institutional AI SMC",
    version: "1.0.0",
    market: "CRYPTO",
    instrumentType: "CRYPTO_PERP",
    timeframe: "5m",
    entryLogic:
      "9-component AI score (EMA20/50 trend, HTF EMA200 bias, VWAP, BOS, SSL/BSL sweep, FVG, volume spike, candle delta, kill zone) must reach 7/9 PLUS 4 preconditions: trend + VWAP + recent sweep + recent BOS.",
    exitLogic: "Target = entry ±2×ATR; stop = sweep wick ±0.25×ATR.",
    stopLossLogic: "Sweep wick extreme ±0.25×ATR.",
    targetLogic: "2×ATR extension.",
    positionSizing: "Confidence-scaled, max 2% risk.",
    requiredData: ["OHLCV 5m/15m", "VWAP", "EMA20/50/200", "Volume", "FVG scanner"],
    requiredFeatures: ["smcScore", "vwap", "ema20", "ema50", "htfEma200", "bos", "fvg", "killZone"],
    mlDependencies: ["AIScoreAggregator"],
    riskDependencies: ["PortfolioRiskEngine", "KillSwitch"],
    expectedHoldingPeriod: "15–120 minutes",
    strategyCategory: "ORDERFLOW",
    status: "RESEARCH",
    registeredAt: "2024-01-01T00:00:00Z",
    lastUpdatedAt: "2025-01-01T00:00:00Z",
  },
  {
    strategyId: "AI_INSTITUTIONAL_PRO",
    strategyName: "AI Institutional Pro v5",
    version: "5.0.0",
    market: "CRYPTO",
    instrumentType: "CRYPTO_PERP",
    timeframe: "5m",
    entryLogic:
      "Two-stage gate: (1) EMA20/50 trend + HTF EMA bias + RSI gate + per-direction cooldown; (2) 8-factor confluence score (VWAP, BOS, SSL/BSL sweep, FVG, order block, volume spike, kill zone, RSI side of 50) must clear mode preset threshold. Mode adapts to timeframe (1m/5m → Scalping; 15m → Intraday).",
    exitLogic: "ATR-multiple TP/SL per mode preset; cooldown rate-limiter between entries.",
    stopLossLogic: "entry ± slMult×ATR (2.0× scalp, 2.5× intraday).",
    targetLogic: "entry ± tpMult×ATR (2.0× scalp, 2.5× intraday).",
    positionSizing: "Confidence × mode-preset sizing, max 2% risk.",
    requiredData: ["OHLCV 1m/5m/15m", "VWAP", "EMA20/50/200", "RSI", "Volume"],
    requiredFeatures: ["confluenceScore", "ema20", "ema50", "htfBias", "rsi14", "vwap", "bos", "fvg", "orderBlock"],
    mlDependencies: ["AIScoreAggregator"],
    riskDependencies: ["PortfolioRiskEngine", "KillSwitch"],
    expectedHoldingPeriod: "5–90 minutes",
    strategyCategory: "ORDERFLOW",
    status: "RESEARCH",
    registeredAt: "2024-01-01T00:00:00Z",
    lastUpdatedAt: "2025-01-01T00:00:00Z",
  },

  // ── India F&O Scanners (promoted to strategies for tracking) ───────────────
  {
    strategyId: "FNO_TREND",
    strategyName: "F&O Bullish/Bearish Trend Scanner",
    version: "1.0.0",
    market: "NSE_FNO",
    instrumentType: "FUTURES",
    timeframe: "1d",
    entryLogic:
      "14-condition Chartink screener: EMA5>SMA20, WMA10>SMA20, ADX DI+>20, ADX>20, vol>1L, MACD>0, close>prev close, close>SMA50, close>150, DI+>DI−, RSI>50, MACD>signal, SMA20>SMA40 — all must pass. Bearish is mirror of all conditions.",
    exitLogic: "Manual or system-defined based on SL breach or target hit.",
    stopLossLogic: "Scan-derived ATR stop level.",
    targetLogic: "TP1=1×ATR, TP2=2×ATR, TP3=3×ATR from entry.",
    positionSizing: "Fixed lot size per market lot. PortfolioRiskEngine sizing applied.",
    requiredData: ["NSE OHLCV 1d 1y", "EMA5", "SMA20", "WMA10", "ADX", "MACD", "RSI", "Volume"],
    requiredFeatures: ["ema5", "sma20", "wma10", "adx", "macd", "rsi14", "volumeCheck"],
    mlDependencies: [],
    riskDependencies: ["PortfolioRiskEngine"],
    expectedHoldingPeriod: "1–5 trading days",
    strategyCategory: "TREND_FOLLOWING",
    status: "RESEARCH",
    registeredAt: "2024-01-01T00:00:00Z",
    lastUpdatedAt: "2025-01-01T00:00:00Z",
  },
  {
    strategyId: "FNO_RANGE_EXPANSION",
    strategyName: "F&O Range Expansion (WR8)",
    version: "1.0.0",
    market: "NSE_FNO",
    instrumentType: "FUTURES",
    timeframe: "1d",
    entryLogic:
      "Today H-L is widest of 8 sessions (range multiple ≥1.2×). Bullish candle (close > open > prevClose). Close in upper half. Volume ≥1.5× 20-day avg. Weekly + monthly open below close. SMA20 > SMA50 > SMA200 bull stack.",
    exitLogic: "System target or trailing SL based on ATR.",
    stopLossLogic: "Previous day low or 1.5×ATR whichever is closer.",
    targetLogic: "2×ATR from entry.",
    positionSizing: "Fixed lot size. PortfolioRiskEngine applied.",
    requiredData: ["NSE OHLCV 1d 1y", "SMA20/50/200", "Volume 20d avg"],
    requiredFeatures: ["rangeRatio", "volRatio", "sma20", "sma50", "sma200", "weekOpen", "monthOpen"],
    mlDependencies: [],
    riskDependencies: ["PortfolioRiskEngine"],
    expectedHoldingPeriod: "2–10 trading days",
    strategyCategory: "BREAKOUT",
    status: "RESEARCH",
    registeredAt: "2024-01-01T00:00:00Z",
    lastUpdatedAt: "2025-01-01T00:00:00Z",
  },
  {
    strategyId: "INDIA_MOMENTUM",
    strategyName: "India F&O Momentum Scanner",
    version: "1.0.0",
    market: "NSE_FNO",
    instrumentType: "FUTURES",
    timeframe: "1d",
    entryLogic:
      "Top F&O price gainers/losers by % change (near-month futures). Angel One SmartAPI first-party data; Yahoo fallback. Ranks by absolute % move.",
    exitLogic: "Discretionary or automated via paper-trading auto-trader.",
    stopLossLogic: "Auto-trader applies 2.5% max SL gate per trade.",
    targetLogic: "Auto-trader applies confidence-weighted target.",
    positionSizing: "Auto-trader: ₹20,000 per trade from ₹1L daily budget.",
    requiredData: ["NSE F&O near-month futures quotes", "OI data"],
    requiredFeatures: ["pctChange", "oi"],
    mlDependencies: [],
    riskDependencies: ["PortfolioRiskEngine"],
    expectedHoldingPeriod: "Intraday",
    strategyCategory: "MOMENTUM",
    status: "RESEARCH",
    registeredAt: "2024-01-01T00:00:00Z",
    lastUpdatedAt: "2025-01-01T00:00:00Z",
  },
  {
    strategyId: "INDIA_VOLUME_BREAKOUT",
    strategyName: "India F&O Volume Breakout",
    version: "1.0.0",
    market: "NSE_FNO",
    instrumentType: "FUTURES",
    timeframe: "1d",
    entryLogic:
      "F&O stocks with today's volume ≥1.5× 20-day average. Secondary filter: positive % change on high volume (upside breakout) or negative % change on high volume (downside breakout).",
    exitLogic: "System target or manual.",
    stopLossLogic: "Previous day close or 1×ATR.",
    targetLogic: "2×ATR extension.",
    positionSizing: "Fixed lot. PortfolioRiskEngine applied.",
    requiredData: ["NSE OHLCV 1d", "30d volume history"],
    requiredFeatures: ["volumeRatio", "pctChange"],
    mlDependencies: [],
    riskDependencies: ["PortfolioRiskEngine"],
    expectedHoldingPeriod: "1–3 trading days",
    strategyCategory: "BREAKOUT",
    status: "RESEARCH",
    registeredAt: "2024-01-01T00:00:00Z",
    lastUpdatedAt: "2025-01-01T00:00:00Z",
  },
  {
    strategyId: "INDIA_OI_BUILDUP",
    strategyName: "India OI Buildup Scanner",
    version: "1.0.0",
    market: "NSE_FNO",
    instrumentType: "OPTIONS",
    timeframe: "1d",
    entryLogic:
      "Open-interest direction × price action: Long/Short Built Up, Short Covering, Long Unwinding. Uses ΔPE OI − ΔCE OI for indices. Angel One SmartAPI first-party; NSE chain fallback.",
    exitLogic: "Signal-based exit at expiry or reversal.",
    stopLossLogic: "Defined per trade via AI Signals TP/SL levels.",
    targetLogic: "Defined per trade via AI Signals.",
    positionSizing: "Options lot-size based. Risk engine applied.",
    requiredData: ["NSE option chain", "OI change data", "Angel One SmartAPI"],
    requiredFeatures: ["peOiChange", "ceOiChange", "oi", "spotPrice"],
    mlDependencies: [],
    riskDependencies: ["PortfolioRiskEngine"],
    expectedHoldingPeriod: "Intraday to expiry",
    strategyCategory: "OPTIONS_FLOW",
    status: "RESEARCH",
    registeredAt: "2024-01-01T00:00:00Z",
    lastUpdatedAt: "2025-01-01T00:00:00Z",
  },

  // ── India AI Signal Composite Strategy ────────────────────────────────────
  {
    strategyId: "INDIA_AI_SIGNALS",
    strategyName: "India F&O AI Multi-Factor Signals",
    version: "2.0.0",
    market: "NSE_FNO",
    instrumentType: "OPTIONS",
    timeframe: "1d",
    entryLogic:
      "14-factor confluence: intraday demand (0.14), S/R breakout volume (0.13), market tape (0.12), news (0.08), SMA trend (0.08), RSI (0.05), 5d momentum (0.08), volume thrust (0.08), PCR OI (0.08), ATM IV (0.04), OI build-up (0.10), max-pain pull (0.05), scanner agreement (0.10), NSE session (0.04), Super Confluence score (0.10). WAIT unless composite ≥0.22 magnitude. Grade S/A signals only for auto-trading.",
    exitLogic: "ATR-scaled TP ladder (TP1/2/3) and stop loss per HORIZON_PROFILE.",
    stopLossLogic: "stopAtrMult × ATR from entry per horizon profile.",
    targetLogic: "Three tiered TPs at 1.6/2.6/4.0×ATR (intraday) or 1.0/1.8/2.6×ATR (scalp).",
    positionSizing: "Fixed-risk 1%, scaled by confidence and horizon profile cap.",
    requiredData: [
      "NSE F&O OHLCV daily",
      "Option chain (PCR, ATM IV, max-pain, OI)",
      "Angel One SmartAPI derivatives",
      "India news feed",
      "India best-time engine",
    ],
    requiredFeatures: [
      "dayChange", "breakoutScore", "marketRegime", "news", "smaStack",
      "rsi14", "momentum5d", "volumeThrust", "pcr", "atmIv", "oiBuildup",
      "maxPainPull", "scannerAgreement", "sessionStatus", "superConfluence",
      "quantPrefilter",
    ],
    mlDependencies: ["MarketRegimeClassifier", "StockRanker", "MetaDecisionEngine"],
    riskDependencies: ["PortfolioRiskEngine", "KillSwitch"],
    expectedHoldingPeriod: "Intraday (4h) to swing (3d)",
    strategyCategory: "STATISTICAL",
    status: "SHADOW",
    registeredAt: "2024-06-01T00:00:00Z",
    lastUpdatedAt: "2025-09-01T00:00:00Z",
  },

  // ── India Super Confluence Indicator Strategy ──────────────────────────────
  {
    strategyId: "INDIA_SUPER_CONFLUENCE",
    strategyName: "India Super Confluence (UT+SMC+EMA)",
    version: "1.0.0",
    market: "NSE_FNO",
    instrumentType: "FUTURES",
    timeframe: "5m",
    entryLogic:
      "All 4 sub-signals bullish simultaneously: UT Bot ATR trail, AI Neural Trend Line (HMA), SMC BOS/CHoCH structure, EMA 9/15/21 stack filter. Score ±1.0 = full confluence. Fire only at ±0.75 or ±1.0.",
    exitLogic: "Opposite signal or ATR-based stop.",
    stopLossLogic: "1×ATR from entry or SMC structure invalidation.",
    targetLogic: "2×ATR or next structural level.",
    positionSizing: "Fixed-fraction 1% risk.",
    requiredData: ["NSE OHLCV 5m", "ATR", "EMA9/15/21", "Pivot swings"],
    requiredFeatures: ["utBotTrail", "aiNeuralLine", "smcBias", "emaStack"],
    mlDependencies: [],
    riskDependencies: ["PortfolioRiskEngine"],
    expectedHoldingPeriod: "15–120 minutes",
    strategyCategory: "TREND_FOLLOWING",
    status: "RESEARCH",
    registeredAt: "2024-01-01T00:00:00Z",
    lastUpdatedAt: "2025-01-01T00:00:00Z",
  },

  // ── Strategy Lab User Strategies (generic tracking entry) ─────────────────
  {
    strategyId: "STRATEGY_LAB_USER",
    strategyName: "Strategy Lab — User-Defined",
    version: "dynamic",
    market: "CRYPTO",
    instrumentType: "CRYPTO_PERP",
    timeframe: "1d",
    entryLogic:
      "User-defined via natural-language prompt parsed into RSI/EMA/SMA/ATR/MACD/volume rules.",
    exitLogic: "User-defined rules or ATR-multiple exits.",
    stopLossLogic: "User-defined: stopLossPct or stopAtrMult.",
    targetLogic: "User-defined: takeProfitPct or targetAtrMult.",
    positionSizing: "User-defined notional size.",
    requiredData: ["OHLCV history for target symbol"],
    requiredFeatures: ["dynamic — depends on user rules"],
    mlDependencies: [],
    riskDependencies: [],
    expectedHoldingPeriod: "User-defined",
    strategyCategory: "STATISTICAL",
    status: "EXPERIMENTAL",
    registeredAt: "2024-01-01T00:00:00Z",
    lastUpdatedAt: "2025-01-01T00:00:00Z",
  },
];

// ─── Registry Class ───────────────────────────────────────────────────────────

class StrategyRegistryImpl {
  private readonly strategies: Map<string, StrategyMeta>;

  constructor(catalog: StrategyMeta[]) {
    this.strategies = new Map(catalog.map((s) => [s.strategyId, s]));
  }

  getAll(): StrategyMeta[] {
    return Array.from(this.strategies.values());
  }

  get(strategyId: string): StrategyMeta | undefined {
    return this.strategies.get(strategyId);
  }

  getOrThrow(strategyId: string): StrategyMeta {
    const s = this.strategies.get(strategyId);
    if (!s) {
      throw new Error(
        `Strategy "${strategyId}" is not registered. ` +
          `Add it to STRATEGY_CATALOG in strategy-registry.ts before use.`,
      );
    }
    return s;
  }

  has(strategyId: string): boolean {
    return this.strategies.has(strategyId);
  }

  byStatus(status: StrategyLifecycleStatus): StrategyMeta[] {
    return this.getAll().filter((s) => s.status === status);
  }

  byMarket(market: StrategyMeta["market"]): StrategyMeta[] {
    return this.getAll().filter((s) => s.market === market);
  }

  ids(): string[] {
    return Array.from(this.strategies.keys());
  }

  /**
   * Update the lifecycle status of a strategy.
   * This is the only mutation allowed on the registry; all other
   * fields are set at catalog definition time.
   */
  updateStatus(strategyId: string, status: StrategyLifecycleStatus): void {
    const s = this.getOrThrow(strategyId);
    s.status = status;
    s.lastUpdatedAt = new Date().toISOString();
  }
}

/** Singleton strategy registry — exported for use throughout the app. */
export const StrategyRegistry = new StrategyRegistryImpl(STRATEGY_CATALOG);
