/**
 * Pure helpers for the India F&O paper-trader. Kept free of `server-only`
 * / Prisma / network imports so the sizing + resolution math is fully
 * unit-testable with fixed inputs. The DB + data-fetching orchestration
 * lives in `paper-trader.ts`.
 */

import { roundToNseTick } from "@/lib/india/format";
import type { IndiaScalpDirection } from "@/features/india/scalping/types";
import type { Candle } from "@/types/india";

/** Notional booked per India paper trade (₹). Cosmetic — P&L % is the
 *  meaningful metric; the notional just scales the ₹ column. */
export const INDIA_DEFAULT_NOTIONAL = 100_000;
/** ATR-multiple for the stop (the strategy RR then drives the target). */
export const INDIA_SL_ATR_MULT = 1.0;
/** Auto-close an unresolved trade after this many ms (covers a session). */
export const INDIA_MAX_TRADE_AGE_MS = 6 * 60 * 60 * 1000;

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export interface IndiaTradeLevelsInput {
  entry: number;
  direction: IndiaScalpDirection;
  /** ATR at signal time (price units). */
  atr: number;
  /** Stop distance as a multiple of ATR. */
  slMult?: number;
  /** Reward:risk the strategy intends — drives the target distance. */
  riskReward: number;
  /** NSE tick to snap levels to (defaults to 0.05). */
  tick?: number;
}

export interface IndiaTradeLevels {
  stopLoss: number;
  target: number;
  riskReward: number;
}

/**
 * Build ATR-sized stop / target levels around `entry`, snapped to the NSE
 * tick. Returns null when the ATR is unusable so the caller can fall back
 * to the signal's own (synthetic) levels.
 */
export function buildIndiaTradeLevels(
  input: IndiaTradeLevelsInput,
): IndiaTradeLevels | null {
  const { entry, direction, atr, riskReward } = input;
  const slMult = input.slMult ?? INDIA_SL_ATR_MULT;
  const tick = input.tick ?? 0.05;
  if (!Number.isFinite(entry) || entry <= 0) return null;
  if (!Number.isFinite(atr) || atr <= 0) return null;
  if (!Number.isFinite(riskReward) || riskReward <= 0) return null;

  const risk = atr * slMult;
  const reward = risk * riskReward;
  const isLong = direction === "LONG";

  const stopLoss = roundToNseTick(isLong ? entry - risk : entry + risk, tick);
  const target = roundToNseTick(isLong ? entry + reward : entry - reward, tick);
  return { stopLoss, target, riskReward };
}

/**
 * Wilder-free simple ATR — average true range over the last `period`
 * candles. Returns null when there aren't enough candles to form a window.
 */
export function atrFromCandles(
  candles: ReadonlyArray<Candle>,
  period = 14,
): number | null {
  if (candles.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - prev.close),
      Math.abs(c.low - prev.close),
    );
    trs.push(tr);
  }
  const window = trs.slice(-period);
  if (window.length === 0) return null;
  return window.reduce((a, b) => a + b, 0) / window.length;
}

export interface ResolveInput {
  direction: IndiaScalpDirection;
  stopLoss: number;
  target: number;
}

export interface ResolveOutcome {
  outcome: "WIN" | "LOSS";
  exitPrice: number;
  /** Candle `time` (seconds) the trade resolved on. */
  closedAtSec: number;
}

/**
 * Walk candles in order and resolve a trade. Conservative tie-break: a
 * candle that touches BOTH stop and target is recorded as a stop (LOSS) —
 * the same rule the crypto paper-trader + signal-outcome jobs use.
 */
export function resolveAgainstCandles(
  candles: ReadonlyArray<Candle>,
  trade: ResolveInput,
): ResolveOutcome | null {
  const isLong = trade.direction === "LONG";
  for (const c of candles) {
    let hitStop = false;
    let hitTarget = false;
    if (isLong) {
      if (c.low <= trade.stopLoss) hitStop = true;
      if (c.high >= trade.target) hitTarget = true;
    } else {
      if (c.high >= trade.stopLoss) hitStop = true;
      if (c.low <= trade.target) hitTarget = true;
    }
    if (hitStop) {
      return { outcome: "LOSS", exitPrice: trade.stopLoss, closedAtSec: c.time };
    }
    if (hitTarget) {
      return { outcome: "WIN", exitPrice: trade.target, closedAtSec: c.time };
    }
  }
  return null;
}

/**
 * Expiry-day cooldown — true on the weekly-expiry day (Thursday) once the
 * gamma-heavy back half of the session begins (≥ 14:30 IST), so the
 * paper-trader stops opening fresh directional trades into the pin. The
 * monthly expiry (last Thursday) is covered by the same Thursday gate.
 */
export function isExpiryCooldownIST(at: Date): boolean {
  const ist = new Date(at.getTime() + IST_OFFSET_MS);
  const isThursday = ist.getUTCDay() === 4;
  if (!isThursday) return false;
  const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return minutes >= 14 * 60 + 30;
}

export function indiaPnlPercent(
  entry: number,
  exit: number,
  isLong: boolean,
): number {
  if (entry <= 0) return 0;
  const raw = (exit - entry) / entry;
  return (isLong ? raw : -raw) * 100;
}
