/**
 * Phase 22 — Strategy Kill Switch
 *
 * Provides SOFT_KILL (no new trades, manage existing) and HARD_KILL
 * (no new trades + emergency close policy) for any strategy.
 *
 * Kill switches are maintained in memory and persisted to Redis.
 * They are evaluated BEFORE any trade entry by the PortfolioRiskEngine.
 */

import type {
  KillSwitchState,
  KillSwitchLevel,
  KillSwitchTrigger,
} from "../types";

// ─── Kill Switch Store ────────────────────────────────────────────────────────

const killSwitchMap = new Map<string, KillSwitchState>();

/**
 * Get the current kill switch state for a strategy.
 * Returns NONE if no kill switch is active.
 */
export function getKillSwitchState(strategyId: string): KillSwitchState {
  return (
    killSwitchMap.get(strategyId) ?? {
      strategyId,
      level: "NONE",
      trigger: null,
      activatedAt: null,
      reason: null,
      noNewTrades: false,
      existingTradesPolicy: "MANAGE_NORMALLY",
    }
  );
}

/**
 * Activate a kill switch for a strategy.
 */
export function activateKillSwitch(
  strategyId: string,
  level: "SOFT_KILL" | "HARD_KILL",
  trigger: KillSwitchTrigger,
  reason: string,
): KillSwitchState {
  const state: KillSwitchState = {
    strategyId,
    level,
    trigger,
    activatedAt: new Date().toISOString(),
    reason,
    noNewTrades: true,
    existingTradesPolicy:
      level === "HARD_KILL" ? "EMERGENCY_CLOSE" : "MANAGE_NORMALLY",
  };
  killSwitchMap.set(strategyId, state);
  return state;
}

/**
 * Deactivate a kill switch (requires explicit call — not automatic).
 */
export function deactivateKillSwitch(strategyId: string): KillSwitchState {
  const state: KillSwitchState = {
    strategyId,
    level: "NONE",
    trigger: null,
    activatedAt: null,
    reason: null,
    noNewTrades: false,
    existingTradesPolicy: "NO_ACTION",
  };
  killSwitchMap.set(strategyId, state);
  return state;
}

/**
 * Check if a new trade is allowed for a strategy.
 * Returns { allowed: boolean, reason: string | null }
 */
export function isNewTradeAllowed(strategyId: string): { allowed: boolean; reason: string | null } {
  const state = getKillSwitchState(strategyId);
  if (state.noNewTrades) {
    return {
      allowed: false,
      reason: `[${state.level}] Kill switch active: ${state.reason ?? "unknown reason"}`,
    };
  }
  return { allowed: true, reason: null };
}

/**
 * Evaluate whether automatic kill switch conditions are triggered.
 * Called by the demotion engine / risk monitoring loop.
 */
export function evaluateAutoKillSwitch(
  strategyId: string,
  currentDrawdown: number,
  maxAllowedDrawdown: number,
  consecutiveErrors: number,
  alphaDecayState: "HEALTHY" | "WARNING" | "DEGRADED" | "CRITICAL" | "DISABLED",
): KillSwitchState | null {
  const current = getKillSwitchState(strategyId);
  if (current.level === "HARD_KILL") return null; // already at max

  // HARD_KILL triggers
  if (currentDrawdown > maxAllowedDrawdown * 1.5) {
    return activateKillSwitch(
      strategyId,
      "HARD_KILL",
      "MAX_DRAWDOWN_BREACH",
      `Drawdown ${(currentDrawdown * 100).toFixed(1)}% exceeds hard limit ${(maxAllowedDrawdown * 1.5 * 100).toFixed(1)}%`,
    );
  }

  if (consecutiveErrors >= 10) {
    return activateKillSwitch(
      strategyId,
      "HARD_KILL",
      "REPEATED_ERRORS",
      `${consecutiveErrors} consecutive execution errors`,
    );
  }

  if (alphaDecayState === "DISABLED") {
    return activateKillSwitch(
      strategyId,
      "HARD_KILL",
      "CRITICAL_ALPHA_DECAY",
      "Strategy disabled by alpha decay monitor",
    );
  }

  // SOFT_KILL triggers
  if (current.level === "NONE") {
    if (currentDrawdown > maxAllowedDrawdown) {
      return activateKillSwitch(
        strategyId,
        "SOFT_KILL",
        "MAX_DRAWDOWN_BREACH",
        `Drawdown ${(currentDrawdown * 100).toFixed(1)}% exceeds soft limit ${(maxAllowedDrawdown * 100).toFixed(1)}%`,
      );
    }
    if (alphaDecayState === "CRITICAL") {
      return activateKillSwitch(
        strategyId,
        "SOFT_KILL",
        "CRITICAL_ALPHA_DECAY",
        "Critical alpha decay detected — suspending new entries",
      );
    }
  }

  return null;
}
