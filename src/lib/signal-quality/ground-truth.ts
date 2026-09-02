/**
 * Phase 1 — Ground Truth Definitions
 *
 * ABSOLUTE RULE: All evaluation rules are defined here, BEFORE any
 * outcome calculation occurs. Nothing is redefined after seeing results.
 *
 * Strategy-specific horizons — do NOT use a single EOD rule for all.
 */

import type { SignalOutcomeDefinition } from "./types";

// ─── Evaluation horizons by strategy type ────────────────────────────────────

/** 5-minute scalps (UT_SMC, AI_INSTITUTIONAL_PRO, FIB_PULLBACK, OPENING_BREAKOUT) */
const SCALP_HORIZON_MS = 30 * 60 * 1000; // 30 minutes

/** Intraday mean-reversion (VWAP strategies, RANGE_SCALP, PCR_EXTREME, MAX_PAIN_GRAVITY) */
const INTRADAY_MR_HORIZON_MS = 2 * 60 * 60 * 1000; // 2 hours

/** Intraday trend-following (EMA_PULLBACK, ORDERFLOW_SWEEP, NEWS_MOMENTUM, MOMENTUM) */
const INTRADAY_TREND_HORIZON_MS = 4 * 60 * 60 * 1000; // 4 hours / EOD for intraday

/** Daily swing (RANGE_EXPANSION, VOLUME_BREAKOUT, OI_BUILDUP) */
const SWING_HORIZON_MS = 24 * 60 * 60 * 1000; // 1 trading day (EOD square-off)

/** Options flow (IV_SPIKE, LIQUIDITY_EDGE) */
const OPTIONS_FLOW_HORIZON_MS = 3 * 60 * 60 * 1000; // 3 hours (session position)

// ─── Crypto strategy ground-truth definitions ─────────────────────────────────

const CRYPTO_DEFINITIONS: SignalOutcomeDefinition[] = [
  {
    strategyId: "UT_SMC",
    label: "UT Bot + SMC",
    validOpportunityDescription:
      "ATR trailing-stop flip (UT Bot key=1, ATR=10) AND SMC BOS or CHoCH confirmed on the same timeframe. " +
      "The UT Bot close-above-trail AND pivot structure must both be satisfied at signal candle close. " +
      "Future data NOT used for signal generation.",
    successDefinition: "TARGET_BEFORE_STOP",
    failureDefinition: "STOP_BEFORE_TARGET",
    neutralDefinition: "TIME_EXIT",
    evaluationHorizonMs: SCALP_HORIZON_MS,
    horizonLabel: "30 min",
    tiebreakerRule: "STOP_WINS",
  },
  {
    strategyId: "VWAP_SWEEP_TREND",
    label: "VWAP Sweep + Trend",
    validOpportunityDescription:
      "Higher-timeframe trend filter aligned AND prior swing H/L swept on a high-volume wick " +
      "AND price stretched ≥ 1.5σ from VWAP. All three must hold at candle close.",
    successDefinition: "TARGET_BEFORE_STOP",
    failureDefinition: "STOP_BEFORE_TARGET",
    neutralDefinition: "TIME_EXIT",
    evaluationHorizonMs: INTRADAY_MR_HORIZON_MS,
    horizonLabel: "2 hr",
    tiebreakerRule: "STOP_WINS",
  },
  {
    strategyId: "NEWS_MOMENTUM",
    label: "News Momentum",
    validOpportunityDescription:
      "Volume spike ≥ 3× 20-bar avg AND candle range ≥ 2.5× ATR(14) on the impulse candle. " +
      "Directional bias taken from impulse close direction.",
    successDefinition: "TARGET_BEFORE_STOP",
    failureDefinition: "STOP_BEFORE_TARGET",
    neutralDefinition: "TIME_EXIT",
    evaluationHorizonMs: INTRADAY_TREND_HORIZON_MS,
    horizonLabel: "4 hr",
    tiebreakerRule: "STOP_WINS",
  },
  {
    strategyId: "RANGE_SCALP",
    label: "Range Scalp",
    validOpportunityDescription:
      "Price at Bollinger Band extreme (upper for short, lower for long) AND RSI overbought/oversold " +
      "AND Bollinger bandwidth < 20-bar average (volatility contracting, not expanding).",
    successDefinition: "TARGET_BEFORE_STOP",
    failureDefinition: "STOP_BEFORE_TARGET",
    neutralDefinition: "TIME_EXIT",
    evaluationHorizonMs: INTRADAY_MR_HORIZON_MS,
    horizonLabel: "2 hr",
    tiebreakerRule: "STOP_WINS",
  },
  {
    strategyId: "EMA_PULLBACK",
    label: "EMA Pullback",
    validOpportunityDescription:
      "9/20/50 EMA stack bullish (9 > 20 > 50) or bearish (9 < 20 < 50) AND price pulling back " +
      "into the 9–20 EMA zone AND a confirmation candle closing back in trend direction.",
    successDefinition: "TARGET_BEFORE_STOP",
    failureDefinition: "STOP_BEFORE_TARGET",
    neutralDefinition: "TIME_EXIT",
    evaluationHorizonMs: INTRADAY_TREND_HORIZON_MS,
    horizonLabel: "4 hr",
    tiebreakerRule: "STOP_WINS",
  },
  {
    strategyId: "VWAP_REVERSION",
    label: "VWAP Reversion",
    validOpportunityDescription:
      "|price − VWAP| ≥ 2σ (2 std dev bands) AND RSI at extreme (≥ 70 for short, ≤ 30 for long) " +
      "AND reversal candle (close moves back toward VWAP).",
    successDefinition: "TARGET_BEFORE_STOP",
    failureDefinition: "STOP_BEFORE_TARGET",
    neutralDefinition: "TIME_EXIT",
    evaluationHorizonMs: INTRADAY_MR_HORIZON_MS,
    horizonLabel: "2 hr",
    tiebreakerRule: "STOP_WINS",
  },
  {
    strategyId: "ORDERFLOW_SWEEP",
    label: "Orderflow Sweep",
    validOpportunityDescription:
      "Equal highs or equal lows swept (wick pierces prior equal level) AND volume spike ≥ 2× " +
      "AND immediate rejection (close back inside prior range within same candle).",
    successDefinition: "TARGET_BEFORE_STOP",
    failureDefinition: "STOP_BEFORE_TARGET",
    neutralDefinition: "TIME_EXIT",
    evaluationHorizonMs: INTRADAY_TREND_HORIZON_MS,
    horizonLabel: "4 hr",
    tiebreakerRule: "STOP_WINS",
  },
  {
    strategyId: "FIB_PULLBACK",
    label: "Fib Pullback (1m)",
    validOpportunityDescription:
      "Impulse move ≥ 3× ATR(14) in 3–5 bars AND retracement to 0.50–0.618 Fib zone of that impulse " +
      "AND a confirmation candle that pierces and closes back through the 0.5 Fib level.",
    successDefinition: "TARGET_BEFORE_STOP",
    failureDefinition: "STOP_BEFORE_TARGET",
    neutralDefinition: "TIME_EXIT",
    evaluationHorizonMs: SCALP_HORIZON_MS,
    horizonLabel: "30 min",
    tiebreakerRule: "STOP_WINS",
  },
  {
    strategyId: "INSTITUTIONAL_SMC",
    label: "Institutional AI SMC",
    validOpportunityDescription:
      "9-component AI score ≥ 7 AND all 4 institutional preconditions: (1) EMA20/50 trend aligned, " +
      "(2) price above/below VWAP, (3) SSL/BSL sweep within last 10 bars, " +
      "(4) BOS within last 10 bars. All conditions at candle close, NO future data.",
    successDefinition: "TARGET_BEFORE_STOP",
    failureDefinition: "STOP_BEFORE_TARGET",
    neutralDefinition: "TIME_EXIT",
    evaluationHorizonMs: INTRADAY_TREND_HORIZON_MS,
    horizonLabel: "4 hr",
    tiebreakerRule: "STOP_WINS",
  },
  {
    strategyId: "AI_INSTITUTIONAL_PRO",
    label: "AI Institutional Pro v5",
    validOpportunityDescription:
      "Hard gates all pass: EMA20/50 trend + HTF EMA bias + RSI gate + per-direction cooldown (no same-direction entry within 3 bars). " +
      "Confluence score ≥ mode threshold (Scalping=6 for 1m/5m, Intraday=5 for 15m). " +
      "All gates evaluated at candle CLOSE, no lookahead.",
    successDefinition: "TARGET_BEFORE_STOP",
    failureDefinition: "STOP_BEFORE_TARGET",
    neutralDefinition: "TIME_EXIT",
    evaluationHorizonMs: SCALP_HORIZON_MS,
    horizonLabel: "30 min",
    tiebreakerRule: "STOP_WINS",
  },
];

// ─── India F&O strategy ground-truth definitions ──────────────────────────────

const INDIA_DEFINITIONS: SignalOutcomeDefinition[] = [
  {
    strategyId: "RANGE_EXPANSION",
    label: "Range Expansion",
    validOpportunityDescription:
      "Today's H−L is widest of last 8 sessions (WR8) with bullish daily/weekly/monthly close " +
      "AND SMA 20 > 50 > 200 stack AND volume ≥ 1.5× 20-day avg AND price in upper half of range. " +
      "All conditions evaluated at end-of-day close of the signal day.",
    successDefinition: "TARGET_BEFORE_STOP",
    failureDefinition: "STOP_BEFORE_TARGET",
    neutralDefinition: "TIME_EXIT",
    evaluationHorizonMs: SWING_HORIZON_MS,
    horizonLabel: "EOD (15:30 IST)",
    tiebreakerRule: "STOP_WINS",
  },
  {
    strategyId: "MOMENTUM",
    label: "Momentum",
    validOpportunityDescription:
      "F&O stock ranked in top decile by intraday % change at time of signal generation. " +
      "Signal generated only during NSE market hours (09:15–15:30 IST).",
    successDefinition: "TARGET_BEFORE_STOP",
    failureDefinition: "STOP_BEFORE_TARGET",
    neutralDefinition: "TIME_EXIT",
    evaluationHorizonMs: INTRADAY_TREND_HORIZON_MS,
    horizonLabel: "4 hr (or EOD 15:30 IST)",
    tiebreakerRule: "STOP_WINS",
  },
  {
    strategyId: "VOLUME_BREAKOUT",
    label: "Volume Breakout",
    validOpportunityDescription:
      "Volume ≥ 1.5× 20-day average AND price closing in top quartile (long) or bottom quartile (short) " +
      "of the bar's H−L range. Evaluated at candle close, not intrabar.",
    successDefinition: "TARGET_BEFORE_STOP",
    failureDefinition: "STOP_BEFORE_TARGET",
    neutralDefinition: "TIME_EXIT",
    evaluationHorizonMs: INTRADAY_TREND_HORIZON_MS,
    horizonLabel: "4 hr",
    tiebreakerRule: "STOP_WINS",
  },
  {
    strategyId: "OI_BUILDUP",
    label: "OI Build-up",
    validOpportunityDescription:
      "OI direction aligns with price direction: (price up + OI up) = Long Build-up; " +
      "(price down + OI up) = Short Build-up. Only BUILDUP signals evaluated (not unwinding). " +
      "OI delta ≥ 5% in the session evaluated at candle close.",
    successDefinition: "TARGET_BEFORE_STOP",
    failureDefinition: "STOP_BEFORE_TARGET",
    neutralDefinition: "TIME_EXIT",
    evaluationHorizonMs: INTRADAY_TREND_HORIZON_MS,
    horizonLabel: "4 hr",
    tiebreakerRule: "STOP_WINS",
  },
  {
    strategyId: "PCR_EXTREME",
    label: "PCR Extreme",
    validOpportunityDescription:
      "NIFTY/BANKNIFTY PCR ≥ 1.5 (excessive bearish sentiment → long setup) or " +
      "PCR ≤ 0.7 (excessive bullish sentiment → short setup). " +
      "PCR measured from most recent option chain snapshot at signal time.",
    successDefinition: "TARGET_BEFORE_STOP",
    failureDefinition: "STOP_BEFORE_TARGET",
    neutralDefinition: "TIME_EXIT",
    evaluationHorizonMs: INTRADAY_MR_HORIZON_MS,
    horizonLabel: "2 hr",
    tiebreakerRule: "STOP_WINS",
  },
  {
    strategyId: "IV_SPIKE",
    label: "IV Spike",
    validOpportunityDescription:
      "ATM IV spike ≥ 20% above prior 5-day average IV without a commensurate underlying price move " +
      "(|price change| < 1× ATR) — event risk premium not yet resolved. " +
      "Direction based on PCR and OI build-up alignment at time of spike.",
    successDefinition: "TARGET_BEFORE_STOP",
    failureDefinition: "STOP_BEFORE_TARGET",
    neutralDefinition: "TIME_EXIT",
    evaluationHorizonMs: OPTIONS_FLOW_HORIZON_MS,
    horizonLabel: "3 hr",
    tiebreakerRule: "STOP_WINS",
  },
  {
    strategyId: "LIQUIDITY_EDGE",
    label: "India Liquidity Edge",
    validOpportunityDescription:
      "Net liquidity confluence score ≥ configured threshold from 5 inputs: " +
      "(1) PCR side (>1.2 bullish / <0.85 bearish), (2) max-pain pull direction, " +
      "(3) OI wall proximity (at PE floor = support / CE wall = resistance), " +
      "(4) ΔPE−ΔCE build-up direction, (5) intraday trend vs prev close. " +
      "All inputs from most recent option chain snapshot at signal time.",
    successDefinition: "TARGET_BEFORE_STOP",
    failureDefinition: "STOP_BEFORE_TARGET",
    neutralDefinition: "TIME_EXIT",
    evaluationHorizonMs: OPTIONS_FLOW_HORIZON_MS,
    horizonLabel: "3 hr",
    tiebreakerRule: "STOP_WINS",
  },
  {
    strategyId: "MAX_PAIN_GRAVITY",
    label: "Max-Pain Gravity",
    validOpportunityDescription:
      "Spot has drifted ≥ pull buffer (1.5× ATR(14) from max-pain strike) AND " +
      "at least one confirming OI wall aligns with fade direction AND PCR skew aligns. " +
      "Max-pain strike and pull buffer evaluated at signal time from OC snapshot.",
    successDefinition: "TARGET_BEFORE_STOP",
    failureDefinition: "STOP_BEFORE_TARGET",
    neutralDefinition: "TIME_EXIT",
    evaluationHorizonMs: OPTIONS_FLOW_HORIZON_MS,
    horizonLabel: "3 hr",
    tiebreakerRule: "STOP_WINS",
  },
  {
    strategyId: "OPENING_BREAKOUT",
    label: "Opening Breakout",
    validOpportunityDescription:
      "First 5-min candle (09:15–09:19:59 IST) range established AND a 5-min close beyond " +
      "the opening candle high (long) or low (short) with volume ≥ 1.5× pre-market avg. " +
      "Entry is at the RETEST of the broken level (breakout high/low becomes support/resistance). " +
      "Signal valid only between 09:20–10:00 IST. ATM or 1-strike ITM only.",
    successDefinition: "TARGET_BEFORE_STOP",
    failureDefinition: "STOP_BEFORE_TARGET",
    neutralDefinition: "TIME_EXIT",
    evaluationHorizonMs: SCALP_HORIZON_MS,
    horizonLabel: "30 min",
    tiebreakerRule: "STOP_WINS",
  },
  // AI Signal and Daily Pick are evaluated against their frozen TP/SL
  {
    strategyId: "AI_SIGNAL",
    label: "AI Signal",
    validOpportunityDescription:
      "AI composite confidence score ≥ 45 (grade C or above) with action LONG or SHORT " +
      "(not WAIT). Win probability ≥ 0.45. TP and SL frozen at generation time.",
    successDefinition: "TARGET_BEFORE_STOP",
    failureDefinition: "STOP_BEFORE_TARGET",
    neutralDefinition: "TIME_EXIT",
    evaluationHorizonMs: INTRADAY_TREND_HORIZON_MS,
    horizonLabel: "4 hr (or EOD)",
    tiebreakerRule: "STOP_WINS",
  },
  {
    strategyId: "DAILY_PICK",
    label: "Daily Pick",
    validOpportunityDescription:
      "Bucket score ≥ 0.5 AND direction is LONG or SHORT AND pick was frozen at 09:15 IST. " +
      "Levels (entry, SL, target) are the immutable frozen values — never updated after generation.",
    successDefinition: "TARGET_BEFORE_STOP",
    failureDefinition: "STOP_BEFORE_TARGET",
    neutralDefinition: "TIME_EXIT",
    evaluationHorizonMs: SWING_HORIZON_MS,
    horizonLabel: "EOD (15:30 IST)",
    tiebreakerRule: "STOP_WINS",
  },
];

export const ALL_GROUND_TRUTH_DEFINITIONS: ReadonlyArray<SignalOutcomeDefinition> = [
  ...CRYPTO_DEFINITIONS,
  ...INDIA_DEFINITIONS,
];

export const GROUND_TRUTH_BY_STRATEGY = new Map<string, SignalOutcomeDefinition>(
  ALL_GROUND_TRUTH_DEFINITIONS.map((d) => [d.strategyId, d]),
);

/** Returns the evaluation horizon for a strategy, defaulting to 4hr intraday */
export function getEvaluationHorizonMs(strategyId: string): number {
  return GROUND_TRUTH_BY_STRATEGY.get(strategyId)?.evaluationHorizonMs ?? INTRADAY_TREND_HORIZON_MS;
}
