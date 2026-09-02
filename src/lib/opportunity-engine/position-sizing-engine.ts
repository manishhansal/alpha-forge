/**
 * PositionSizingEngine — Risk-Aware Quality-Adjusted Sizing
 *
 * Position size is NOT fixed. It is a function of:
 *   - Signal quality tier (A+ gets more capital than C)
 *   - Net expected value (higher EV = larger position)
 *   - Current market regime (reduce in adverse regimes)
 *   - Liquidity quality (thin markets get smaller positions)
 *   - Portfolio correlation (reduce when correlated with existing)
 *   - Current drawdown state (reduce when in drawdown)
 *   - Account equity and risk budget
 *   - Hard position caps (cannot be overridden by any other factor)
 *
 * Framework:
 *   recommendedSizePct =
 *     baseRiskPct
 *     × qualityMultiplier     [0.25, 1.5]
 *     × evMultiplier          [0.5, 1.5]
 *     × regimeMultiplier      [0.5, 1.2]
 *     × liquidityMultiplier   [0.3, 1.0]
 *     × drawdownMultiplier    [0.0, 1.0]
 *     × correlationMultiplier [0.3, 1.0]
 *
 *   then apply hard caps
 *
 * This module is I/O-free.
 */

import type { QualityTier, MarketRegimeState } from "./types";

// ─── Sizing Configuration ─────────────────────────────────────────────────────

export interface SizingConfig {
  /** Base risk per trade as % of capital */
  baseRiskPct: number;
  /** Maximum position size as % of capital */
  maxPositionSizePct: number;
  /** Maximum total portfolio exposure % */
  maxPortfolioExposurePct: number;
  /** Capital available for trading (INR) */
  capitalINR: number;
  /** Current total deployed capital % */
  currentExposurePct: number;
  /** Current drawdown from equity peak % */
  currentDrawdownPct: number;
  /** Number of correlated open positions (same direction, same sector) */
  correlatedPositions: number;
}

export const DEFAULT_SIZING_CONFIG: SizingConfig = {
  baseRiskPct: 1.0,
  maxPositionSizePct: 20.0,
  maxPortfolioExposurePct: 80.0,
  capitalINR: 100_000,
  currentExposurePct: 0,
  currentDrawdownPct: 0,
  correlatedPositions: 0,
};

// ─── Sizing Result ────────────────────────────────────────────────────────────

export interface SizingResult {
  recommendedSizePct: number;    // % of capital
  recommendedSizeINR: number;    // absolute INR amount
  recommendedLots: number;       // rounded to lot size

  // Multiplier breakdown (for attribution)
  baseRiskPct: number;
  qualityMultiplier: number;
  evMultiplier: number;
  regimeMultiplier: number;
  liquidityMultiplier: number;
  drawdownMultiplier: number;
  correlationMultiplier: number;

  // Caps applied
  hardCapApplied: boolean;
  capReason: string | null;

  reasoning: string[];
}

// ─── Multiplier Tables ────────────────────────────────────────────────────────

const QUALITY_MULTIPLIER: Record<QualityTier, number> = {
  A_PLUS: 1.50,  // exceptional — full size
  A: 1.25,       // strong — 125% of base
  B: 1.00,       // solid — standard size
  C: 0.60,       // marginal — reduced
  D: 0.25,       // weak — minimal
  REJECT: 0.00,  // should not reach sizing, but if it does: 0
};

const REGIME_MULTIPLIER: Partial<Record<MarketRegimeState, number>> = {
  STRONG_BULL_TREND: 1.15,
  WEAK_BULL: 1.00,
  RANGE: 0.80,
  HIGH_VOLATILITY_RANGE: 0.65,
  STRONG_BEAR_TREND: 1.10,
  WEAK_BEAR: 0.95,
  PANIC: 0.40,
  TRANSITION: 0.70,
  UNKNOWN: 0.60,
};

// ─── Core Sizing Engine ───────────────────────────────────────────────────────

export interface SizingInput {
  qualityTier: QualityTier;
  netEV: number;              // Net expected value %
  liquidityScore: number;     // [0, 1]
  regime: MarketRegimeState;
  lotSize: number;            // shares per lot (1 for equities)
  currentPrice: number;       // for converting % to INR
  config: SizingConfig;
}

/**
 * Compute risk-aware quality-adjusted position size.
 *
 * Each multiplier is computed independently so the sizing decision
 * can be fully attributed and explained.
 */
export function computePositionSize(input: SizingInput): SizingResult {
  const reasoning: string[] = [];
  const { config } = input;

  if (input.qualityTier === "REJECT") {
    return {
      recommendedSizePct: 0, recommendedSizeINR: 0, recommendedLots: 0,
      baseRiskPct: config.baseRiskPct, qualityMultiplier: 0, evMultiplier: 0,
      regimeMultiplier: 0, liquidityMultiplier: 0, drawdownMultiplier: 0,
      correlationMultiplier: 0, hardCapApplied: true,
      capReason: "REJECT grade — zero sizing", reasoning: ["REJECT grade"],
    };
  }

  // ── Quality multiplier ────────────────────────────────────────────────────
  const qualityMultiplier = QUALITY_MULTIPLIER[input.qualityTier];
  reasoning.push(`Quality ${input.qualityTier}: ×${qualityMultiplier}`);

  // ── EV multiplier: scales from 0.5 (EV just positive) to 1.5 (EV >> 0.5%) ─
  const evMultiplier = Math.max(0.5, Math.min(1.5,
    0.5 + (input.netEV / 0.5) * 0.5
  ));
  if (input.netEV > 0) {
    reasoning.push(`Net EV ${input.netEV.toFixed(3)}%: EV×${evMultiplier.toFixed(2)}`);
  }

  // ── Regime multiplier ─────────────────────────────────────────────────────
  const regimeMultiplier = REGIME_MULTIPLIER[input.regime] ?? 0.75;
  if (regimeMultiplier < 0.9) {
    reasoning.push(`Regime ${input.regime}: regime×${regimeMultiplier}`);
  }

  // ── Liquidity multiplier ──────────────────────────────────────────────────
  const liquidityMultiplier = Math.max(0.3, Math.min(1.0, input.liquidityScore));
  if (liquidityMultiplier < 0.9) {
    reasoning.push(`Liquidity score ${input.liquidityScore.toFixed(2)}: liq×${liquidityMultiplier.toFixed(2)}`);
  }

  // ── Drawdown multiplier ───────────────────────────────────────────────────
  let drawdownMultiplier: number;
  if (config.currentDrawdownPct >= 20) {
    drawdownMultiplier = 0;
    reasoning.push(`Severe drawdown ${config.currentDrawdownPct.toFixed(1)}% — no new positions`);
  } else if (config.currentDrawdownPct >= 15) {
    drawdownMultiplier = 0.25;
    reasoning.push(`Deep drawdown ${config.currentDrawdownPct.toFixed(1)}% — severe reduction`);
  } else if (config.currentDrawdownPct >= 10) {
    drawdownMultiplier = 0.50;
    reasoning.push(`Elevated drawdown ${config.currentDrawdownPct.toFixed(1)}% — 50% reduction`);
  } else if (config.currentDrawdownPct >= 5) {
    drawdownMultiplier = 0.75;
    reasoning.push(`Moderate drawdown ${config.currentDrawdownPct.toFixed(1)}% — 25% reduction`);
  } else {
    drawdownMultiplier = 1.0;
  }

  // ── Correlation multiplier ────────────────────────────────────────────────
  const correlatedPositions = config.correlatedPositions;
  const correlationMultiplier =
    correlatedPositions >= 4 ? 0.25 :
    correlatedPositions === 3 ? 0.40 :
    correlatedPositions === 2 ? 0.65 :
    correlatedPositions === 1 ? 0.85 : 1.0;
  if (correlatedPositions > 0) {
    reasoning.push(`${correlatedPositions} correlated positions: corr×${correlationMultiplier}`);
  }

  // ── Compute recommended size ───────────────────────────────────────────────
  let sizePct = config.baseRiskPct
    * qualityMultiplier
    * evMultiplier
    * regimeMultiplier
    * liquidityMultiplier
    * drawdownMultiplier
    * correlationMultiplier;

  // ── Hard caps ─────────────────────────────────────────────────────────────
  let hardCapApplied = false;
  let capReason: string | null = null;

  // Cap 1: max position size
  if (sizePct > config.maxPositionSizePct) {
    sizePct = config.maxPositionSizePct;
    hardCapApplied = true;
    capReason = `Position cap ${config.maxPositionSizePct}%`;
    reasoning.push(`Capped at max position ${config.maxPositionSizePct}%`);
  }

  // Cap 2: portfolio exposure remaining
  const remainingCapacity = config.maxPortfolioExposurePct - config.currentExposurePct;
  if (sizePct > remainingCapacity) {
    sizePct = Math.max(0, remainingCapacity);
    hardCapApplied = true;
    capReason = `Portfolio exposure cap (remaining: ${remainingCapacity.toFixed(1)}%)`;
    reasoning.push(`Portfolio exposure cap: remaining=${remainingCapacity.toFixed(1)}%`);
  }

  sizePct = Math.max(0, sizePct);

  const sizeINR = config.capitalINR * sizePct / 100;
  const lotsFloat = input.currentPrice > 0 && input.lotSize > 0
    ? sizeINR / (input.currentPrice * input.lotSize)
    : 0;
  const lots = Math.max(0, Math.floor(lotsFloat));

  return {
    recommendedSizePct: sizePct,
    recommendedSizeINR: sizeINR,
    recommendedLots: lots,
    baseRiskPct: config.baseRiskPct,
    qualityMultiplier,
    evMultiplier,
    regimeMultiplier,
    liquidityMultiplier,
    drawdownMultiplier,
    correlationMultiplier,
    hardCapApplied,
    capReason,
    reasoning,
  };
}

// ─── Drawdown-Aware Risk Control ──────────────────────────────────────────────

export type DrawdownTier = "NORMAL" | "CAUTION" | "DEFENSIVE" | "SEVERE" | "HALT";

export interface DrawdownState {
  tier: DrawdownTier;
  currentDrawdownPct: number;
  riskBudgetMultiplier: number;   // 0 = no new trades, 1 = full budget
  allowNewTrades: boolean;
  reason: string;
}

export function classifyDrawdownTier(currentDrawdownPct: number): DrawdownState {
  if (currentDrawdownPct >= 20) {
    return { tier: "HALT", currentDrawdownPct, riskBudgetMultiplier: 0, allowNewTrades: false, reason: `Drawdown ${currentDrawdownPct.toFixed(1)}% — HALT` };
  }
  if (currentDrawdownPct >= 15) {
    return { tier: "SEVERE", currentDrawdownPct, riskBudgetMultiplier: 0.25, allowNewTrades: true, reason: `Severe drawdown ${currentDrawdownPct.toFixed(1)}%` };
  }
  if (currentDrawdownPct >= 10) {
    return { tier: "DEFENSIVE", currentDrawdownPct, riskBudgetMultiplier: 0.50, allowNewTrades: true, reason: `Defensive: drawdown ${currentDrawdownPct.toFixed(1)}%` };
  }
  if (currentDrawdownPct >= 5) {
    return { tier: "CAUTION", currentDrawdownPct, riskBudgetMultiplier: 0.75, allowNewTrades: true, reason: `Caution: drawdown ${currentDrawdownPct.toFixed(1)}%` };
  }
  return { tier: "NORMAL", currentDrawdownPct, riskBudgetMultiplier: 1.0, allowNewTrades: true, reason: "Normal operating mode" };
}

// ─── Daily Risk Budget ────────────────────────────────────────────────────────

export interface DailyRiskBudget {
  /** Total daily capital budget (INR) */
  totalBudgetINR: number;
  /** Already deployed today (INR) */
  deployedINR: number;
  /** Remaining capacity (INR) */
  remainingINR: number;
  /** Today's realized P&L (INR) */
  realizedPnlINR: number;
  /** Max loss allowed today before stopping */
  maxDailyLossINR: number;
  /** Whether new trades are allowed */
  allowNewTrades: boolean;
  /** Maximum single trade size remaining */
  maxSingleTradeINR: number;
  /** Number of trades opened today */
  tradesOpenedToday: number;
  /** Max trades per day */
  maxTradesPerDay: number;
  reason: string;
}

export function computeDailyRiskBudget(
  capitalINR: number,
  deployedINR: number,
  realizedPnlINR: number,
  tradesOpenedToday: number,
  config: {
    dailyBudgetPct?: number;          // default 80%
    maxDailyLossPct?: number;         // default 3%
    maxTradesPerDay?: number;         // default 10
    maxSingleTradePct?: number;       // default 20%
  } = {},
): DailyRiskBudget {
  const dailyBudgetPct = config.dailyBudgetPct ?? 80;
  const maxDailyLossPct = config.maxDailyLossPct ?? 3;
  const maxTradesPerDay = config.maxTradesPerDay ?? 10;
  const maxSingleTradePct = config.maxSingleTradePct ?? 20;

  const totalBudgetINR = capitalINR * dailyBudgetPct / 100;
  const maxDailyLossINR = capitalINR * maxDailyLossPct / 100;
  const remainingINR = Math.max(0, totalBudgetINR - deployedINR);
  const maxSingleTradeINR = capitalINR * maxSingleTradePct / 100;

  // Stop trading if max daily loss hit
  const dailyLossLimitHit = realizedPnlINR < -maxDailyLossINR;
  // Stop if max trades reached
  const maxTradesHit = tradesOpenedToday >= maxTradesPerDay;
  // Stop if no remaining capacity
  const budgetExhausted = remainingINR <= 0;

  let allowNewTrades = !dailyLossLimitHit && !maxTradesHit && !budgetExhausted;
  let reason = "Budget available";

  if (dailyLossLimitHit) reason = `Daily loss limit ₹${maxDailyLossINR.toFixed(0)} reached`;
  else if (maxTradesHit) reason = `Max ${maxTradesPerDay} trades reached`;
  else if (budgetExhausted) reason = "Daily budget exhausted";

  return {
    totalBudgetINR,
    deployedINR,
    remainingINR,
    realizedPnlINR,
    maxDailyLossINR,
    allowNewTrades,
    maxSingleTradeINR: Math.min(maxSingleTradeINR, remainingINR),
    tradesOpenedToday,
    maxTradesPerDay,
    reason,
  };
}
