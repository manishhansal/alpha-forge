/**
 * risk-limits.ts — Risk Budgets and Kill Switch
 *
 * Manages risk budgets at four levels:
 *   1. Per-trade   — max loss per single trade.
 *   2. Per-strategy — max combined open risk across all trades from a strategy.
 *   3. Per-sector   — max combined open risk from one sector.
 *   4. Total portfolio — max combined open risk across everything.
 *
 * Also implements a two-level kill switch:
 *   SOFT_KILL — reduce all new position sizes to the soft-kill multiplier (e.g. 50%).
 *   HARD_KILL — block ALL new trades until manually reset.
 *
 * "Risk" for a position is defined as the potential loss to stop:
 *   risk = qty × |entry - stopLoss| × lotSize
 */

import type { Position } from "../backtesting-v2/models/position";
import { getSector } from "./exposure";

// ── Kill Switch ───────────────────────────────────────────────────────────────

export type KillSwitchState = "NONE" | "SOFT_KILL" | "HARD_KILL";

export interface KillSwitch {
  state: KillSwitchState;
  /** UTC ms when the kill switch was activated. */
  activatedAtMs: number | null;
  /** Human-readable reason for activation. */
  reason: string | null;
  /** For SOFT_KILL: fraction of normal size to allow. Default 0.50. */
  softKillSizeMultiplier: number;
}

export function createKillSwitch(softKillSizeMultiplier = 0.50): KillSwitch {
  return {
    state: "NONE",
    activatedAtMs: null,
    reason: null,
    softKillSizeMultiplier,
  };
}

export function activateSoftKill(
  ks: KillSwitch,
  reason: string,
  nowMs: number = Date.now(),
): KillSwitch {
  return { ...ks, state: "SOFT_KILL", activatedAtMs: nowMs, reason };
}

export function activateHardKill(
  ks: KillSwitch,
  reason: string,
  nowMs: number = Date.now(),
): KillSwitch {
  return { ...ks, state: "HARD_KILL", activatedAtMs: nowMs, reason };
}

/** Reset the kill switch to NONE (requires manual operator action). */
export function resetKillSwitch(ks: KillSwitch): KillSwitch {
  return { ...ks, state: "NONE", activatedAtMs: null, reason: null };
}

// ── Risk Budget Config ────────────────────────────────────────────────────────

export interface RiskBudgetConfig {
  /**
   * Max risk per trade as fraction of equity (entry-to-stop × qty × lotSize).
   * Default 0.02 (2%).
   */
  maxTradeRiskFraction: number;
  /**
   * Max total open risk for a single strategy as fraction of equity.
   * Default 0.10 (10%).
   */
  maxStrategyRiskFraction: number;
  /**
   * Max total open risk in a sector as fraction of equity.
   * Default 0.15 (15%).
   */
  maxSectorRiskFraction: number;
  /**
   * Max total portfolio open risk as fraction of equity.
   * Default 0.25 (25%).
   */
  maxPortfolioRiskFraction: number;
  /**
   * Daily P&L loss that automatically triggers SOFT_KILL.
   * Fraction of equity. Default 0.025 (2.5%).
   */
  softKillDailyLossFraction: number;
  /**
   * Daily P&L loss that automatically triggers HARD_KILL.
   * Fraction of equity. Default 0.04 (4%).
   */
  hardKillDailyLossFraction: number;
}

export const DEFAULT_RISK_BUDGET_CONFIG: RiskBudgetConfig = {
  maxTradeRiskFraction: 0.02,
  maxStrategyRiskFraction: 0.10,
  maxSectorRiskFraction: 0.15,
  maxPortfolioRiskFraction: 0.25,
  softKillDailyLossFraction: 0.025,
  hardKillDailyLossFraction: 0.04,
};

// ── Open risk calculator ──────────────────────────────────────────────────────

/**
 * Open risk (INR) of a single open position = qty × |entry − stop| × lotSize.
 * This is the maximum loss on this position if the stop is hit.
 */
export function openRisk(pos: Position): number {
  return pos.qty * Math.abs(pos.avgEntryPrice - pos.stopLoss) * pos.instrument.lotSize;
}

export interface PortfolioRiskBudget {
  /** Total open risk (INR) across all positions. */
  totalOpenRisk: number;
  /** Open risk per strategy (INR). */
  strategyOpenRisk: Map<string, number>;
  /** Open risk per sector (INR). */
  sectorOpenRisk: Map<string, number>;
}

/**
 * Compute the current portfolio risk budget utilisation from open positions.
 */
export function computePortfolioRiskBudget(positions: Position[]): PortfolioRiskBudget {
  let totalOpenRisk = 0;
  const strategyOpenRisk = new Map<string, number>();
  const sectorOpenRisk = new Map<string, number>();

  for (const pos of positions) {
    if (pos.status !== "OPEN") continue;
    const risk = openRisk(pos);
    totalOpenRisk += risk;

    const strat = pos.attribution.strategyId;
    strategyOpenRisk.set(strat, (strategyOpenRisk.get(strat) ?? 0) + risk);

    const sector = getSector(pos.instrument.symbol);
    sectorOpenRisk.set(sector, (sectorOpenRisk.get(sector) ?? 0) + risk);
  }

  return { totalOpenRisk, strategyOpenRisk, sectorOpenRisk };
}

// ── Pre-trade risk budget check ───────────────────────────────────────────────

export interface ProposedTradeRisk {
  symbol: string;
  strategyId: string;
  /** Proposed open risk = qty × |entry − stop| × lotSize. */
  tradeRisk: number;
}

export interface RiskBudgetCheck {
  approved: boolean;
  reason?: string;
  breachedLevel?: "TRADE" | "STRATEGY" | "SECTOR" | "PORTFOLIO";
  /** Kill switch sizing multiplier (1.0 if none active, 0.5 for soft, 0 for hard). */
  killSwitchMultiplier: number;
  killSwitchState: KillSwitchState;
}

/**
 * Check whether a proposed trade fits within the risk budgets.
 * Returns approved=false if any budget would be breached.
 */
export function checkRiskBudget(
  proposed: ProposedTradeRisk,
  budget: PortfolioRiskBudget,
  equity: number,
  killSwitch: KillSwitch,
  config: RiskBudgetConfig = DEFAULT_RISK_BUDGET_CONFIG,
): RiskBudgetCheck {
  // 1. Kill switch check
  if (killSwitch.state === "HARD_KILL") {
    return {
      approved: false,
      reason: `HARD KILL active: ${killSwitch.reason ?? "no new trades allowed"}`,
      killSwitchMultiplier: 0,
      killSwitchState: "HARD_KILL",
    };
  }

  const killSwitchMultiplier =
    killSwitch.state === "SOFT_KILL" ? killSwitch.softKillSizeMultiplier : 1.0;

  // 2. Per-trade risk
  const tradeRiskLimit = equity * config.maxTradeRiskFraction;
  if (proposed.tradeRisk > tradeRiskLimit) {
    return {
      approved: false,
      reason: `Trade risk ₹${proposed.tradeRisk.toFixed(0)} exceeds per-trade limit ₹${tradeRiskLimit.toFixed(0)} (${(config.maxTradeRiskFraction * 100).toFixed(0)}% of equity)`,
      breachedLevel: "TRADE",
      killSwitchMultiplier,
      killSwitchState: killSwitch.state,
    };
  }

  // 3. Per-strategy risk
  const currentStratRisk = budget.strategyOpenRisk.get(proposed.strategyId) ?? 0;
  const stratLimit = equity * config.maxStrategyRiskFraction;
  if (currentStratRisk + proposed.tradeRisk > stratLimit) {
    return {
      approved: false,
      reason: `Strategy ${proposed.strategyId} open risk ₹${(currentStratRisk + proposed.tradeRisk).toFixed(0)} would exceed limit ₹${stratLimit.toFixed(0)} (${(config.maxStrategyRiskFraction * 100).toFixed(0)}% of equity)`,
      breachedLevel: "STRATEGY",
      killSwitchMultiplier,
      killSwitchState: killSwitch.state,
    };
  }

  // 4. Per-sector risk
  const sector = getSector(proposed.symbol);
  const currentSectorRisk = budget.sectorOpenRisk.get(sector) ?? 0;
  const sectorLimit = equity * config.maxSectorRiskFraction;
  if (currentSectorRisk + proposed.tradeRisk > sectorLimit) {
    return {
      approved: false,
      reason: `Sector ${sector} open risk ₹${(currentSectorRisk + proposed.tradeRisk).toFixed(0)} would exceed limit ₹${sectorLimit.toFixed(0)} (${(config.maxSectorRiskFraction * 100).toFixed(0)}% of equity)`,
      breachedLevel: "SECTOR",
      killSwitchMultiplier,
      killSwitchState: killSwitch.state,
    };
  }

  // 5. Total portfolio risk
  const portfolioLimit = equity * config.maxPortfolioRiskFraction;
  if (budget.totalOpenRisk + proposed.tradeRisk > portfolioLimit) {
    return {
      approved: false,
      reason: `Portfolio open risk ₹${(budget.totalOpenRisk + proposed.tradeRisk).toFixed(0)} would exceed limit ₹${portfolioLimit.toFixed(0)} (${(config.maxPortfolioRiskFraction * 100).toFixed(0)}% of equity)`,
      breachedLevel: "PORTFOLIO",
      killSwitchMultiplier,
      killSwitchState: killSwitch.state,
    };
  }

  return {
    approved: true,
    killSwitchMultiplier,
    killSwitchState: killSwitch.state,
  };
}

// ── Automatic kill-switch escalation ─────────────────────────────────────────

/**
 * Evaluate whether the current daily P&L should auto-escalate the kill switch.
 * Mutates `killSwitch` in place and returns the (possibly updated) state.
 *
 * Should be called after every mark-to-market update.
 */
export function evaluateKillSwitch(
  killSwitch: KillSwitch,
  dailyPnl: number,
  equity: number,
  config: RiskBudgetConfig = DEFAULT_RISK_BUDGET_CONFIG,
  nowMs: number = Date.now(),
): KillSwitch {
  if (equity <= 0) return killSwitch;
  const dailyLossFraction = -dailyPnl / equity; // positive when losing

  if (
    dailyLossFraction >= config.hardKillDailyLossFraction &&
    killSwitch.state !== "HARD_KILL"
  ) {
    return activateHardKill(
      killSwitch,
      `Daily loss ${(dailyLossFraction * 100).toFixed(2)}% exceeded HARD KILL threshold ${(config.hardKillDailyLossFraction * 100).toFixed(0)}%`,
      nowMs,
    );
  }

  if (
    dailyLossFraction >= config.softKillDailyLossFraction &&
    killSwitch.state === "NONE"
  ) {
    return activateSoftKill(
      killSwitch,
      `Daily loss ${(dailyLossFraction * 100).toFixed(2)}% exceeded SOFT KILL threshold ${(config.softKillDailyLossFraction * 100).toFixed(0)}%`,
      nowMs,
    );
  }

  return killSwitch;
}
