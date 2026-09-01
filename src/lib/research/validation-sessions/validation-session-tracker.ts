/**
 * Phase 24 — Real-Market Validation Session Tracker
 *
 * Tracks individual paper/shadow trading sessions to ensure that
 * before promoting to LIVE_CANDIDATE, the strategy has been observed
 * across sufficient DIVERSE market conditions.
 *
 * Requirements for promotion:
 *   MINIMUM:   20 trading sessions
 *   PREFERRED: 40+ trading sessions
 *
 * Regime diversity requirements:
 *   At least one session in each of:
 *   - Normal volatility
 *   - High volatility
 *   - Trending (BULL or BEAR)
 *   - Range-bound
 *   - Expiry day
 */

import type {
  ValidationSession,
  ValidationSessionSummary,
  MarketRegime,
} from "../types";

// ─── Session Store ────────────────────────────────────────────────────────────

const sessionStore = new Map<string, ValidationSession[]>();

export function addValidationSession(session: ValidationSession): void {
  const existing = sessionStore.get(session.strategyId) ?? [];
  existing.push(session);
  sessionStore.set(session.strategyId, existing);
}

export function getValidationSessions(strategyId: string): ValidationSession[] {
  return sessionStore.get(strategyId) ?? [];
}

// ─── Summary Builder ──────────────────────────────────────────────────────────

export function buildValidationSessionSummary(
  strategyId: string,
  sessions?: ValidationSession[],
): ValidationSessionSummary {
  const allSessions = sessions ?? getValidationSessions(strategyId);

  if (allSessions.length === 0) {
    return {
      strategyId,
      totalSessions: 0,
      regimesCovered: [],
      minimumSessionsMet: false,
      preferredSessionsMet: false,
      hasNormalVolatility: false,
      hasHighVolatility: false,
      hasTrendingSession: false,
      hasRangeBoundSession: false,
      hasExpiryDay: false,
      readyForPromotion: false,
      sessions: [],
      computedAt: new Date().toISOString(),
    };
  }

  const regimesCovered = [...new Set(allSessions.map((s) => s.regime))] as MarketRegime[];

  const hasNormalVolatility = regimesCovered.some((r) =>
    ["NORMAL_DAY", "LOW_VOLATILITY"].includes(r),
  );
  const hasHighVolatility = regimesCovered.includes("HIGH_VOLATILITY");
  const hasTrendingSession = regimesCovered.some((r) =>
    ["BULL_TRENDING", "BEAR_TRENDING"].includes(r),
  );
  const hasRangeBoundSession = regimesCovered.includes("RANGE_BOUND");
  const hasExpiryDay = regimesCovered.includes("EXPIRY_DAY");

  const minimumSessionsMet = allSessions.length >= 20;
  const preferredSessionsMet = allSessions.length >= 40;

  const readyForPromotion =
    minimumSessionsMet &&
    hasNormalVolatility &&
    hasTrendingSession &&
    hasRangeBoundSession;

  return {
    strategyId,
    totalSessions: allSessions.length,
    regimesCovered,
    minimumSessionsMet,
    preferredSessionsMet,
    hasNormalVolatility,
    hasHighVolatility,
    hasTrendingSession,
    hasRangeBoundSession,
    hasExpiryDay,
    readyForPromotion,
    sessions: allSessions,
    computedAt: new Date().toISOString(),
  };
}
