import "server-only";

import type { KlineCandle, SignalType } from "@/types/market";

export type SignalOutcome = "OPEN" | "HIT_TARGET" | "HIT_STOP" | "EXPIRED";

export interface SignalToEvaluate {
  type: SignalType;
  entry: number;
  stopLoss: number;
  target: number;
  generatedAt: Date;
}

export interface EvaluationResult {
  outcome: SignalOutcome;
  pnlPct: number | null;
  closedAt: Date | null;
}

/**
 * Walk the candles forward from `generatedAt` and decide whether the signal
 * hit its target, hit its stop, or remained open. For directional signals
 * (LONG/BUY/SHORT/SELL) we treat any candle whose high (or low for shorts)
 * touches the level as a hit.
 *
 * Conservative tie-break: if a single candle touches both stop AND target,
 * stop wins. This avoids reporting fictional wins on volatile bars.
 *
 * Candles must be in ascending time order and span the relevant range.
 */
export function evaluateSignal(
  signal: SignalToEvaluate,
  candles: KlineCandle[],
  now: Date,
  maxAgeMs: number,
): EvaluationResult {
  const ageMs = now.getTime() - signal.generatedAt.getTime();

  if (signal.type === "HOLD") {
    return { outcome: "OPEN", pnlPct: null, closedAt: null };
  }

  const isLong = signal.type === "LONG" || signal.type === "BUY";
  const stop = signal.stopLoss;
  const target = signal.target;
  const entry = signal.entry;

  // Candles before generation are irrelevant; defensive filter in case the
  // caller over-fetched.
  const relevant = candles.filter((c) => c.openTime >= signal.generatedAt.getTime());

  for (const c of relevant) {
    let hitStop = false;
    let hitTarget = false;
    if (isLong) {
      if (c.low <= stop) hitStop = true;
      if (c.high >= target) hitTarget = true;
    } else {
      if (c.high >= stop) hitStop = true;
      if (c.low <= target) hitTarget = true;
    }
    if (hitStop) {
      const pnl = pnlPercent(entry, stop, isLong);
      return { outcome: "HIT_STOP", pnlPct: pnl, closedAt: new Date(c.closeTime) };
    }
    if (hitTarget) {
      const pnl = pnlPercent(entry, target, isLong);
      return { outcome: "HIT_TARGET", pnlPct: pnl, closedAt: new Date(c.closeTime) };
    }
  }

  if (ageMs >= maxAgeMs) {
    // Mark as expired using the most recent close, if any.
    const last = relevant[relevant.length - 1];
    const closePrice = last?.close;
    const pnl = closePrice !== undefined ? pnlPercent(entry, closePrice, isLong) : null;
    return { outcome: "EXPIRED", pnlPct: pnl, closedAt: now };
  }
  return { outcome: "OPEN", pnlPct: null, closedAt: null };
}

function pnlPercent(entry: number, exit: number, isLong: boolean): number {
  if (entry <= 0) return 0;
  const raw = (exit - entry) / entry;
  return (isLong ? raw : -raw) * 100;
}
