/**
 * Hard Gate Engine — Mandatory Rejection Layer
 *
 * HARD GATES block trades immediately regardless of signal quality score.
 * They cannot be overridden by high confidence, high ML probability, or
 * strong technical alignment.
 *
 * Distinction:
 *   HARD GATE → REJECT (unconditional, logged with code)
 *   SOFT PENALTY → score reduction (influences ranking only)
 *
 * Every hard gate produces:
 *   - A standardized HardRejectionCode
 *   - A human-readable reason
 *   - The specific value that triggered the gate
 *
 * Configuration:
 *   All thresholds are in a config object so they can be adjusted
 *   without code changes and validated against OOS data.
 *
 * This module is I/O-free.
 */

import type { HardRejectionCode } from "./types";
import type { EVResult } from "./expected-value-engine";

// ─── Gate Configuration ───────────────────────────────────────────────────────

export interface HardGateConfig {
  /** Maximum acceptable data age in ms */
  maxDataAgeMs: number;
  /** Minimum R:R required */
  minRiskReward: number;
  /** Maximum acceptable spread as % of price */
  maxSpreadPct: number;
  /** Minimum net expected value (after all costs) */
  minNetEV: number;
  /** Maximum portfolio exposure fraction [0, 1] */
  maxPortfolioExposurePct: number;
  /** Maximum pairwise correlation for same-direction positions */
  maxPairwiseCorrelation: number;
  /** Daily loss limit as fraction of capital */
  dailyLossLimitPct: number;
  /** Maximum open risk across all positions */
  maxOpenRiskPct: number;
  /** Maximum SL % from entry */
  maxStopLossPct: number;
  /** Minimum volume ratio (current vs 20d avg) */
  minVolumeRatio: number;
  /** Whether market must be in NSE hours */
  enforceMarketHours: boolean;
  /** Whether to require ML model when configured */
  requireMLWhenConfigured: boolean;
}

export const DEFAULT_HARD_GATE_CONFIG: HardGateConfig = {
  maxDataAgeMs: 5 * 60 * 1000,       // 5 minutes
  minRiskReward: 1.5,                  // minimum 1.5:1 R:R
  maxSpreadPct: 0.50,                  // 50bps max spread
  minNetEV: 0,                         // EV must be positive after costs
  maxPortfolioExposurePct: 85,         // no more than 85% deployed
  maxPairwiseCorrelation: 0.80,        // reject if >80% correlated with existing
  dailyLossLimitPct: 3.0,             // 3% daily loss limit
  maxOpenRiskPct: 8.0,                 // 8% total open risk
  maxStopLossPct: 4.0,                 // max 4% SL from entry
  minVolumeRatio: 0.15,                // at least 15% of average volume
  enforceMarketHours: true,
  requireMLWhenConfigured: false,      // don't require ML by default
};

// ─── Gate Evaluation Result ───────────────────────────────────────────────────

export interface HardGateResult {
  /** Whether the opportunity passes ALL hard gates */
  passes: boolean;
  /** All triggered hard gates */
  triggeredGates: Array<{
    code: HardRejectionCode;
    reason: string;
    value: string;
    threshold: string;
  }>;
  /** Summary message */
  summary: string;
}

// ─── Gate Inputs ─────────────────────────────────────────────────────────────

export interface HardGateInputs {
  // Data freshness
  dataAgeMs: number;
  isDataValid: boolean;
  ohlcValid: boolean; // high >= open >= low, high >= close >= low

  // Trade levels
  entry: number;
  stopLoss: number;
  target1: number;
  target2: number;

  // EV result from ExpectedValueEngine
  evResult: EVResult;

  // Market conditions
  spreadPct: number | null;
  volumeRatio: number | null; // current volume / 20d avg
  isMarketOpen: boolean;
  isInstrumentSuspended: boolean;

  // Portfolio state
  currentPortfolioExposurePct: number;
  dailyPnlPct: number;       // today's running P&L as % of capital (negative = loss)
  openRiskPct: number;       // current total open risk as % of capital
  existingCorrelation: number | null; // max pairwise correlation with same-dir positions

  // Risk state
  isKillSwitchActive: boolean;
  isDrawdownHalt: boolean;
  isDailyLossBreach: boolean;

  // Opportunity-specific
  riskReward: number;
  stopLossPct: number;       // |entry - stop| / entry * 100
  isDuplicateOpportunity: boolean;
  isInstrumentInUniverse: boolean;
  isModelRequiredAndUnavailable: boolean;
  isExpiryGammaRiskTooHigh: boolean;

  // Config
  config?: Partial<HardGateConfig>;
}

// ─── Gate Evaluator ───────────────────────────────────────────────────────────

/**
 * Evaluate all hard gates for a candidate opportunity.
 *
 * Gates are evaluated in priority order:
 *   1. Critical infrastructure (kill switch, data validity)
 *   2. Market conditions (hours, suspension)
 *   3. Trade level validity (R:R, stop loss)
 *   4. Economic viability (EV, spread)
 *   5. Portfolio constraints (exposure, correlation, loss limits)
 *   6. Opportunity deduplication
 *
 * Returns on first failure when `failFast = true`.
 * Returns all failures when `failFast = false` (for audit reports).
 */
export function evaluateHardGates(
  inputs: HardGateInputs,
  failFast = false,
): HardGateResult {
  const cfg: HardGateConfig = { ...DEFAULT_HARD_GATE_CONFIG, ...inputs.config };
  const triggered: HardGateResult["triggeredGates"] = [];

  function fail(code: HardRejectionCode, reason: string, value: string, threshold: string) {
    triggered.push({ code, reason, value, threshold });
    return failFast;
  }

  // ── Gate 1: Kill switch ───────────────────────────────────────────────────
  if (inputs.isKillSwitchActive) {
    if (fail("KILL_SWITCH_ACTIVE", "Kill switch is active — all new trades blocked",
      "ACTIVE", "OFF")) {
      return buildResult(triggered);
    }
  }

  // ── Gate 2: Data validity ─────────────────────────────────────────────────
  if (!inputs.isDataValid) {
    if (fail("CRITICAL_DATA_CORRUPTION", "Market data failed validity check",
      "INVALID", "VALID")) {
      return buildResult(triggered);
    }
  }

  if (!inputs.ohlcValid) {
    if (fail("INVALID_OHLC", "OHLC integrity check failed (high < low or close out of range)",
      "INVALID", "VALID")) {
      return buildResult(triggered);
    }
  }

  if (inputs.dataAgeMs > cfg.maxDataAgeMs) {
    if (fail("STALE_MARKET_DATA",
      `Data is ${Math.round(inputs.dataAgeMs / 60000)}min old — beyond ${cfg.maxDataAgeMs / 60000}min threshold`,
      `${Math.round(inputs.dataAgeMs / 60000)}min`,
      `≤${cfg.maxDataAgeMs / 60000}min`)) {
      return buildResult(triggered);
    }
  }

  // ── Gate 3: Market conditions ─────────────────────────────────────────────
  if (cfg.enforceMarketHours && !inputs.isMarketOpen) {
    if (fail("MARKET_CLOSED", "NSE market is closed", "CLOSED", "OPEN")) {
      return buildResult(triggered);
    }
  }

  if (inputs.isInstrumentSuspended) {
    if (fail("INSTRUMENT_SUSPENDED", "Instrument is suspended or circuit-locked",
      "SUSPENDED", "ACTIVE")) {
      return buildResult(triggered);
    }
  }

  if (!inputs.isInstrumentInUniverse) {
    if (fail("EXECUTION_IMPOSSIBLE", "Instrument not in active F&O universe",
      "NOT_IN_UNIVERSE", "IN_UNIVERSE")) {
      return buildResult(triggered);
    }
  }

  // ── Gate 4: Trade level validity ──────────────────────────────────────────
  if (inputs.entry <= 0 || inputs.stopLoss <= 0 || inputs.target1 <= 0) {
    if (fail("MISSING_REQUIRED_PRICE", "Entry, stop, or target price is missing or invalid",
      `entry=${inputs.entry} sl=${inputs.stopLoss} tp=${inputs.target1}`,
      "> 0")) {
      return buildResult(triggered);
    }
  }

  if (inputs.riskReward < cfg.minRiskReward) {
    if (fail("RR_BELOW_MINIMUM",
      `R:R ${inputs.riskReward.toFixed(2)} below minimum ${cfg.minRiskReward.toFixed(2)}`,
      inputs.riskReward.toFixed(2),
      `≥${cfg.minRiskReward}`)) {
      return buildResult(triggered);
    }
  }

  if (inputs.stopLossPct > cfg.maxStopLossPct) {
    if (fail("INVALID_RISK_PARAMS",
      `Stop loss ${inputs.stopLossPct.toFixed(2)}% exceeds maximum ${cfg.maxStopLossPct}%`,
      `${inputs.stopLossPct.toFixed(2)}%`,
      `≤${cfg.maxStopLossPct}%`)) {
      return buildResult(triggered);
    }
  }

  // ── Gate 5: Liquidity ─────────────────────────────────────────────────────
  if (inputs.spreadPct !== null && inputs.spreadPct > cfg.maxSpreadPct) {
    if (fail("EXCESSIVE_SPREAD",
      `Spread ${inputs.spreadPct.toFixed(3)}% exceeds ${cfg.maxSpreadPct}% — edge consumed by spread`,
      `${inputs.spreadPct.toFixed(3)}%`,
      `≤${cfg.maxSpreadPct}%`)) {
      return buildResult(triggered);
    }
  }

  if (inputs.volumeRatio !== null && inputs.volumeRatio < cfg.minVolumeRatio) {
    if (fail("ZERO_LIQUIDITY",
      `Volume ${(inputs.volumeRatio * 100).toFixed(0)}% of average — insufficient liquidity`,
      `${(inputs.volumeRatio * 100).toFixed(0)}%`,
      `≥${(cfg.minVolumeRatio * 100).toFixed(0)}%`)) {
      return buildResult(triggered);
    }
  }

  // ── Gate 6: Economic viability ────────────────────────────────────────────
  if (inputs.evResult.netEV < cfg.minNetEV) {
    if (fail("NEGATIVE_EXPECTED_VALUE",
      `Net EV ${inputs.evResult.netEV.toFixed(3)}% is negative after costs`,
      `${inputs.evResult.netEV.toFixed(3)}%`,
      `≥${cfg.minNetEV}%`)) {
      return buildResult(triggered);
    }
  }

  // ── Gate 7: Portfolio risk constraints ────────────────────────────────────
  if (inputs.isKillSwitchActive) {
    // Already handled above
  }

  if (inputs.isDrawdownHalt) {
    if (fail("DRAWDOWN_HALT", "Drawdown tier requires halt — no new positions",
      "HALT", "NORMAL")) {
      return buildResult(triggered);
    }
  }

  if (inputs.isDailyLossBreach || inputs.dailyPnlPct < -cfg.dailyLossLimitPct) {
    if (fail("DAILY_LOSS_LIMIT_BREACHED",
      `Daily loss ${Math.abs(inputs.dailyPnlPct).toFixed(2)}% exceeds ${cfg.dailyLossLimitPct}% limit`,
      `${inputs.dailyPnlPct.toFixed(2)}%`,
      `≥-${cfg.dailyLossLimitPct}%`)) {
      return buildResult(triggered);
    }
  }

  if (inputs.currentPortfolioExposurePct > cfg.maxPortfolioExposurePct) {
    if (fail("PORTFOLIO_EXPOSURE_EXCEEDED",
      `Portfolio at ${inputs.currentPortfolioExposurePct.toFixed(1)}% — exceeds ${cfg.maxPortfolioExposurePct}% limit`,
      `${inputs.currentPortfolioExposurePct.toFixed(1)}%`,
      `≤${cfg.maxPortfolioExposurePct}%`)) {
      return buildResult(triggered);
    }
  }

  if (inputs.openRiskPct > cfg.maxOpenRiskPct) {
    if (fail("PORTFOLIO_EXPOSURE_EXCEEDED",
      `Open risk ${inputs.openRiskPct.toFixed(2)}% exceeds ${cfg.maxOpenRiskPct}% limit`,
      `${inputs.openRiskPct.toFixed(2)}%`,
      `≤${cfg.maxOpenRiskPct}%`)) {
      return buildResult(triggered);
    }
  }

  if (inputs.existingCorrelation !== null && inputs.existingCorrelation > cfg.maxPairwiseCorrelation) {
    if (fail("CORRELATION_LIMIT_EXCEEDED",
      `New trade ${(inputs.existingCorrelation * 100).toFixed(0)}% correlated with existing position`,
      `${(inputs.existingCorrelation * 100).toFixed(0)}%`,
      `≤${(cfg.maxPairwiseCorrelation * 100).toFixed(0)}%`)) {
      return buildResult(triggered);
    }
  }

  // ── Gate 8: Duplicate / expiry ────────────────────────────────────────────
  if (inputs.isDuplicateOpportunity) {
    if (fail("DUPLICATE_OPPORTUNITY", "An equivalent active opportunity already exists",
      "DUPLICATE", "UNIQUE")) {
      return buildResult(triggered);
    }
  }

  if (inputs.isExpiryGammaRiskTooHigh) {
    if (fail("EXPIRY_GAMMA_RISK",
      "Expiry-day gamma risk too high — strategy disabled near expiry",
      "HIGH", "ACCEPTABLE")) {
      return buildResult(triggered);
    }
  }

  // ── Gate 9: Model availability ────────────────────────────────────────────
  if (cfg.requireMLWhenConfigured && inputs.isModelRequiredAndUnavailable) {
    if (fail("MODEL_UNAVAILABLE",
      "Required ML model unavailable and fallback not configured",
      "UNAVAILABLE", "AVAILABLE")) {
      return buildResult(triggered);
    }
  }

  return buildResult(triggered);
}

function buildResult(triggered: HardGateResult["triggeredGates"]): HardGateResult {
  const passes = triggered.length === 0;
  const summary = passes
    ? "All hard gates passed"
    : `REJECTED: ${triggered.map(g => g.code).join(", ")}`;
  return { passes, triggeredGates: triggered, summary };
}

// ─── Soft Penalty Evaluator ───────────────────────────────────────────────────

import type { SoftPenaltyCode } from "./types";
import type { MarketRegimeState } from "./types";

export interface SoftPenaltyResult {
  penalties: Array<{
    code: SoftPenaltyCode;
    scoreReduction: number;   // [0, 0.3] — how much to reduce quality score
    reason: string;
  }>;
  totalScoreReduction: number;
}

export interface SoftPenaltyInputs {
  marketRegime: MarketRegimeState;
  strategyCompatibleWithRegime: boolean;
  sectorSupportsDirection: boolean;
  marketSupportsDirection: boolean;
  oiBiasSupportsDirection: boolean;
  optionFlowSupportsDirection: boolean;
  volatilityTooHigh: boolean;  // ATR > 90th percentile
  isLateEntry: boolean;        // missed ideal entry zone
  isSignalExpired: boolean;
  mlUncertain: boolean;        // ML confidence < 0.4
  isCalibrationPoor: boolean;
  volumeAdequate: boolean;
  structureStrong: boolean;
  momentumConfirmed: boolean;
  slippageRisk: "LOW" | "MEDIUM" | "HIGH";
  timeOfDayRecommendation: "TRADE" | "CAUTION" | "AVOID";
  mtfConflict: boolean;
  sectorBreadthMixed: boolean;
  highCorrelationPenalty: boolean; // below threshold but still elevated
}

/**
 * Evaluate soft penalties. These reduce the final score but do NOT block.
 */
export function evaluateSoftPenalties(inputs: SoftPenaltyInputs): SoftPenaltyResult {
  const penalties: SoftPenaltyResult["penalties"] = [];

  if (!inputs.strategyCompatibleWithRegime) {
    penalties.push({
      code: "REGIME_CONFLICT",
      scoreReduction: 0.20,
      reason: `Current regime (${inputs.marketRegime}) has reduced edge for this strategy`,
    });
  }

  if (!inputs.sectorSupportsDirection) {
    penalties.push({ code: "SECTOR_CONFLICT", scoreReduction: 0.12, reason: "Sector trend contradicts trade direction" });
  }

  if (!inputs.marketSupportsDirection) {
    penalties.push({ code: "MARKET_CONFLICT", scoreReduction: 0.10, reason: "Broad market direction conflicts with trade" });
  }

  if (!inputs.oiBiasSupportsDirection) {
    penalties.push({ code: "OI_CONFLICT", scoreReduction: 0.08, reason: "OI positioning contradicts direction" });
  }

  if (!inputs.optionFlowSupportsDirection) {
    penalties.push({ code: "OPTION_FLOW_CONFLICT", scoreReduction: 0.07, reason: "Options flow contradicts direction" });
  }

  if (inputs.volatilityTooHigh) {
    penalties.push({ code: "VOLATILITY_TOO_HIGH", scoreReduction: 0.15, reason: "ATR in extreme percentile — widened stops reduce R:R" });
  }

  if (inputs.isLateEntry) {
    penalties.push({ code: "LATE_ENTRY", scoreReduction: 0.10, reason: "Entry is late relative to ideal setup trigger" });
  }

  if (inputs.isSignalExpired) {
    penalties.push({ code: "SIGNAL_EXPIRED", scoreReduction: 0.25, reason: "Signal age beyond typical validity window" });
  }

  if (inputs.mlUncertain) {
    penalties.push({ code: "ML_UNCERTAINTY", scoreReduction: 0.08, reason: "ML model has low confidence — signal weakened" });
  }

  if (!inputs.volumeAdequate) {
    penalties.push({ code: "LOW_VOLUME", scoreReduction: 0.10, reason: "Volume below adequate threshold" });
  }

  if (!inputs.structureStrong) {
    penalties.push({ code: "WEAK_STRUCTURE", scoreReduction: 0.08, reason: "Market structure quality is weak" });
  }

  if (!inputs.momentumConfirmed) {
    penalties.push({ code: "WEAK_MOMENTUM", scoreReduction: 0.06, reason: "Momentum not confirmed" });
  }

  if (inputs.slippageRisk === "HIGH") {
    penalties.push({ code: "HIGH_SLIPPAGE_RISK", scoreReduction: 0.08, reason: "High slippage risk may erode edge" });
  }

  if (inputs.timeOfDayRecommendation === "CAUTION") {
    penalties.push({ code: "POOR_TIME_OF_DAY", scoreReduction: 0.05, reason: "Time-of-day historically weaker for this strategy" });
  }

  if (inputs.timeOfDayRecommendation === "AVOID") {
    penalties.push({ code: "POOR_TIME_OF_DAY", scoreReduction: 0.15, reason: "Time-of-day historically poor — recommend avoiding" });
  }

  if (inputs.mtfConflict) {
    penalties.push({ code: "CONFLICTING_TIMEFRAMES", scoreReduction: 0.12, reason: "Major timeframes disagree on direction" });
  }

  if (inputs.sectorBreadthMixed) {
    penalties.push({ code: "MIXED_SECTOR_BREADTH", scoreReduction: 0.05, reason: "Sector breadth is mixed" });
  }

  if (inputs.highCorrelationPenalty) {
    penalties.push({ code: "HIGH_CORRELATION_PENALTY", scoreReduction: 0.07, reason: "Elevated correlation with existing positions" });
  }

  const totalScoreReduction = Math.min(0.60, penalties.reduce((s, p) => s + p.scoreReduction, 0));

  return { penalties, totalScoreReduction };
}
