/**
 * position-sizing.ts — Dynamic Position Sizing
 *
 * Calculates position size (in lots / shares) based on:
 *   1. Confidence     — higher confidence → larger position.
 *   2. Stop distance  — fixed-fraction risk: risk a fixed % of equity per stop-unit.
 *   3. ATR            — volatility-adjusted: don't risk more than X ATRs per lot.
 *   4. Portfolio vol  — scale down when portfolio is already volatile.
 *   5. Correlation    — penalise when the new trade is highly correlated to existing book.
 *   6. Drawdown tier  — apply DrawdownCheck multiplier.
 *
 * Final qty = base_qty × confidence_factor × vol_factor × correlation_factor × drawdown_factor
 * Capped by max notional fraction of equity.
 *
 * All monetary values in INR.
 */

import type { DrawdownCheck } from "./drawdown";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SizingInputs {
  /** Proposed entry price (INR). */
  entryPrice: number;
  /** Stop-loss price (INR). */
  stopLoss: number;
  /** Current ATR of the instrument (INR per lot). */
  atr: number;
  /** Lot size (shares per lot). 1 for cash equities. */
  lotSize: number;

  /** Signal confidence [0, 1]. */
  confidence: number;

  /** Current portfolio equity (INR). */
  equity: number;

  /**
   * Daily P&L volatility of the portfolio, expressed as a fraction of equity.
   * e.g. 0.01 = portfolio moves ±1% per day on average.
   * Pass 0 if unavailable.
   */
  portfolioDailyVolFraction: number;

  /**
   * Highest pairwise correlation between the proposed symbol and any
   * existing open position in the same direction. [0, 1].
   * Pass 0 if unavailable or no open positions.
   */
  maxPairwiseCorrelation: number;

  /** Drawdown check from drawdown.ts. */
  drawdownCheck: DrawdownCheck;
}

export interface SizingConfig {
  /** Fraction of equity to risk per trade (stop-distance risk). Default 0.02 (2%). */
  riskPerTradeFraction: number;
  /**
   * Max ATR multiples to risk per lot (secondary cap).
   * A trade is capped so that loss < atrRiskMultiple × ATR per lot.
   * Default 2.0.
   */
  atrRiskMultiple: number;
  /** Max notional as fraction of equity per single position. Default 0.25. */
  maxPositionFraction: number;
  /**
   * Minimum confidence below which no position is taken.
   * Default 0.40.
   */
  minConfidence: number;
  /**
   * Confidence scaling: at `confidenceFloor` the multiplier = 0.5;
   * at 1.0 the multiplier = 1.0. Linear interpolation. Default 0.40.
   */
  confidenceFloor: number;
  /**
   * Portfolio volatility target (daily, as fraction of equity).
   * If actual vol > target, scale down proportionally. Default 0.01 (1%).
   */
  portfolioVolTarget: number;
  /**
   * Correlation penalty: at maxCorr = 1.0 the multiplier = `corrMinMultiplier`.
   * Linear interpolation from 1.0 (corr=0) to `corrMinMultiplier` (corr=1).
   * Default 0.50 — highly correlated trade gets half the normal size.
   */
  corrMinMultiplier: number;
  /** Floor on the final combined multiplier (prevents trivially tiny lots). Default 0.10. */
  minCombinedMultiplier: number;
}

export const DEFAULT_SIZING_CONFIG: SizingConfig = {
  riskPerTradeFraction: 0.02,
  atrRiskMultiple: 2.0,
  maxPositionFraction: 0.25,
  minConfidence: 0.40,
  confidenceFloor: 0.40,
  portfolioVolTarget: 0.01,
  corrMinMultiplier: 0.50,
  minCombinedMultiplier: 0.10,
};

export interface SizingResult {
  /** Final recommended quantity (lots / shares). 0 = do not trade. */
  qty: number;
  /** Notional value at entry (INR). */
  notional: number;
  /** Base qty before adjustments. */
  baseQty: number;
  /** Confidence factor applied. */
  confidenceFactor: number;
  /** Volatility scaling factor. */
  volFactor: number;
  /** Correlation penalty factor. */
  correlationFactor: number;
  /** Drawdown sizing multiplier from drawdown tier. */
  drawdownFactor: number;
  /** Combined multiplier = confidence × vol × correlation × drawdown. */
  combinedMultiplier: number;
  /** Reason qty was set to 0, if applicable. */
  zeroReason?: string;
}

// ── Factors ───────────────────────────────────────────────────────────────────

/**
 * Confidence factor: linear scale from 0.5 at `floor` to 1.0 at 1.0.
 */
export function confidenceFactor(
  confidence: number,
  floor: number = DEFAULT_SIZING_CONFIG.confidenceFloor,
): number {
  if (confidence <= floor) return 0.5;
  return 0.5 + 0.5 * ((confidence - floor) / (1 - floor));
}

/**
 * Portfolio volatility factor: 1.0 when vol ≤ target; scales down linearly.
 * Returns 0 if vol is 3× target (extreme vol situation).
 */
export function portfolioVolFactor(
  actualVolFraction: number,
  targetVolFraction: number = DEFAULT_SIZING_CONFIG.portfolioVolTarget,
): number {
  if (actualVolFraction <= 0 || targetVolFraction <= 0) return 1.0;
  if (actualVolFraction <= targetVolFraction) return 1.0;
  const ratio = actualVolFraction / targetVolFraction;
  return Math.max(0, 1 - (ratio - 1) / 2);
}

/**
 * Correlation penalty factor: 1.0 at corr=0; `corrMinMultiplier` at corr=1.0.
 */
export function correlationFactor(
  maxCorrelation: number,
  corrMinMultiplier: number = DEFAULT_SIZING_CONFIG.corrMinMultiplier,
): number {
  const corr = Math.max(0, Math.min(1, maxCorrelation));
  return 1 - corr * (1 - corrMinMultiplier);
}

// ── Base quantity ─────────────────────────────────────────────────────────────

/**
 * Base qty from fixed-fraction risk: risk = equity × riskFraction.
 * qty = riskAmount / (stopDist × lotSize)
 * Additionally capped by ATR risk and max notional.
 */
export function baseQtyFromRisk(
  entryPrice: number,
  stopLoss: number,
  atr: number,
  lotSize: number,
  equity: number,
  config: SizingConfig,
): number {
  const stopDist = Math.abs(entryPrice - stopLoss);
  const riskAmount = equity * config.riskPerTradeFraction;

  // Primary: fixed fraction
  let qty = stopDist > 0
    ? Math.floor(riskAmount / (stopDist * lotSize))
    : 0;

  // Secondary cap: ATR-based risk
  if (atr > 0 && lotSize > 0) {
    const atrBasedMax = Math.floor(
      (equity * config.riskPerTradeFraction) / (config.atrRiskMultiple * atr * lotSize),
    );
    qty = Math.min(qty, atrBasedMax);
  }

  // Notional cap
  if (qty > 0 && lotSize > 0 && entryPrice > 0) {
    const maxQtyByNotional = Math.floor(
      (equity * config.maxPositionFraction) / (entryPrice * lotSize),
    );
    qty = Math.min(qty, maxQtyByNotional);
  }

  return Math.max(0, qty);
}

// ── Master sizing function ────────────────────────────────────────────────────

/**
 * Compute the final position size incorporating all risk factors.
 */
export function computePositionSize(
  inputs: SizingInputs,
  config: SizingConfig = DEFAULT_SIZING_CONFIG,
): SizingResult {
  // Hard gates
  if (inputs.drawdownCheck.blocked) {
    return {
      qty: 0,
      notional: 0,
      baseQty: 0,
      confidenceFactor: 0,
      volFactor: 0,
      correlationFactor: 0,
      drawdownFactor: 0,
      combinedMultiplier: 0,
      zeroReason: inputs.drawdownCheck.reason ?? "Drawdown halt — no new positions",
    };
  }

  if (inputs.confidence < config.minConfidence) {
    return {
      qty: 0,
      notional: 0,
      baseQty: 0,
      confidenceFactor: 0,
      volFactor: 0,
      correlationFactor: 0,
      drawdownFactor: 0,
      combinedMultiplier: 0,
      zeroReason: `Confidence ${(inputs.confidence * 100).toFixed(0)}% < minimum ${(config.minConfidence * 100).toFixed(0)}%`,
    };
  }

  const baseQty = baseQtyFromRisk(
    inputs.entryPrice,
    inputs.stopLoss,
    inputs.atr,
    inputs.lotSize,
    inputs.equity,
    config,
  );

  if (baseQty === 0) {
    return {
      qty: 0,
      notional: 0,
      baseQty: 0,
      confidenceFactor: 1,
      volFactor: 1,
      correlationFactor: 1,
      drawdownFactor: inputs.drawdownCheck.sizingMultiplier,
      combinedMultiplier: 0,
      zeroReason: "Base qty is 0 (check entry/stop distance or available equity)",
    };
  }

  const cf = confidenceFactor(inputs.confidence, config.confidenceFloor);
  const vf = portfolioVolFactor(inputs.portfolioDailyVolFraction, config.portfolioVolTarget);
  const rf = correlationFactor(inputs.maxPairwiseCorrelation, config.corrMinMultiplier);
  const df = inputs.drawdownCheck.sizingMultiplier;

  const combined = Math.max(
    config.minCombinedMultiplier,
    cf * vf * rf * df,
  );

  const finalQty = Math.max(1, Math.floor(baseQty * combined));

  // Recheck notional cap after scaling
  const maxByNotional =
    inputs.equity > 0 && inputs.lotSize > 0 && inputs.entryPrice > 0
      ? Math.floor(
          (inputs.equity * config.maxPositionFraction) /
            (inputs.entryPrice * inputs.lotSize),
        )
      : finalQty;

  const qty = Math.min(finalQty, Math.max(1, maxByNotional));
  const notional = qty * inputs.entryPrice * inputs.lotSize;

  return {
    qty,
    notional,
    baseQty,
    confidenceFactor: cf,
    volFactor: vf,
    correlationFactor: rf,
    drawdownFactor: df,
    combinedMultiplier: combined,
  };
}
