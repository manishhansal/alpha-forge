/**
 * Pure walk-forward backtester for the India price strategies. Mirrors the
 * crypto `backtestStrategy` algorithm (bar-by-bar replay, conservative
 * touch-both → stop tie-break) but typed to India candles + the candle-fed
 * `IndiaPriceStrategyModule`s, and free of any I/O so it's unit-testable.
 *
 * The trade summary feeds the SAME `scoreIndiaStrategy` engine the live
 * paper-trade scorer uses — so a backtested price strategy and a
 * paper-traded option-chain strategy are graded on one consistent scale.
 */

import type { IndiaPriceStrategyModule } from "@/features/india/scalping/strategies/price-modules";
import type {
  IndiaStrategyScoreInput,
  IndiaStrategyScoreSource,
} from "@/features/india/scalping/strategy-score";
import type { IndiaScalpDirection, IndiaScalpStrategyId } from "@/features/india/scalping/types";
import type { Candle } from "@/types/india";

export type IndiaBacktestExitReason = "TARGET" | "STOP" | "EXPIRED" | "EOD";

export interface IndiaBacktestTrade {
  side: IndiaScalpDirection;
  entry: number;
  exit: number;
  reason: IndiaBacktestExitReason;
  pnlPct: number;
  bars: number;
  openedAtSec: number;
  closedAtSec: number;
}

export interface IndiaTradeSummary {
  totalTrades: number;
  wins: number;
  losses: number;
  expired: number;
  winRate: number;
  profitFactor: number;
  avgPnlPct: number;
  totalReturnPct: number;
  maxDrawdownPct: number;
  sharpe: number;
  totalPnlUsd: number;
}

export interface BacktestInput {
  candles: ReadonlyArray<Candle>;
  mod: IndiaPriceStrategyModule;
  /** Force-close trades that haven't hit SL/TP after this many bars. */
  maxHoldBars?: number;
  /** Notional per trade for the ₹ P&L column (cosmetic — % is the metric). */
  notional?: number;
}

const DEFAULT_NOTIONAL = 100_000;
/** Daily bars → ~252 trading days a year for the Sharpe annualisation. */
const TRADING_DAYS = 252;

function pnlPercent(entry: number, exit: number, isLong: boolean): number {
  if (entry <= 0) return 0;
  const raw = (exit - entry) / entry;
  return (isLong ? raw : -raw) * 100;
}

export function backtestIndiaPriceStrategy(
  input: BacktestInput,
): IndiaBacktestTrade[] {
  const { candles, mod, maxHoldBars = 20 } = input;
  const n = candles.length;
  const windowBars = mod.warmup;
  const trades: IndiaBacktestTrade[] = [];
  if (n < windowBars + 1) return trades;

  interface Position {
    side: IndiaScalpDirection;
    entry: number;
    stop: number;
    target: number;
    openedBar: number;
    openedAtSec: number;
  }
  let pos: Position | null = null;

  for (let i = windowBars - 1; i < n; i += 1) {
    const c = candles[i];

    if (pos) {
      const isLong = pos.side === "LONG";
      let exit: number | null = null;
      let reason: IndiaBacktestExitReason | null = null;

      const hitStop = isLong ? c.low <= pos.stop : c.high >= pos.stop;
      const hitTarget = isLong ? c.high >= pos.target : c.low <= pos.target;
      if (hitStop) {
        exit = pos.stop;
        reason = "STOP";
      } else if (hitTarget) {
        exit = pos.target;
        reason = "TARGET";
      } else if (i - pos.openedBar >= maxHoldBars) {
        exit = c.close;
        reason = "EXPIRED";
      } else if (i === n - 1) {
        exit = c.close;
        reason = "EOD";
      }

      if (exit !== null && reason) {
        trades.push({
          side: pos.side,
          entry: pos.entry,
          exit,
          reason,
          pnlPct: pnlPercent(pos.entry, exit, isLong),
          bars: i - pos.openedBar,
          openedAtSec: pos.openedAtSec,
          closedAtSec: c.time,
        });
        pos = null;
      }
    }

    if (!pos) {
      const slice = candles.slice(i - windowBars + 1, i + 1);
      let sig = null;
      try {
        sig = mod.run(slice);
      } catch {
        sig = null;
      }
      if (sig && sig.triggeredAtSec === c.time) {
        const stopDist = Math.abs(sig.entry - sig.stopLoss);
        const targetDist = Math.abs(sig.target - sig.entry);
        if (stopDist > 0 && targetDist > 0) {
          pos = {
            side: sig.direction,
            entry: sig.entry,
            stop: sig.stopLoss,
            target: sig.target,
            openedBar: i,
            openedAtSec: c.time,
          };
        }
      }
    }
  }

  return trades;
}

export function summariseTrades(
  trades: ReadonlyArray<Pick<IndiaBacktestTrade, "pnlPct" | "reason">>,
  notional = DEFAULT_NOTIONAL,
): IndiaTradeSummary {
  const empty: IndiaTradeSummary = {
    totalTrades: 0,
    wins: 0,
    losses: 0,
    expired: 0,
    winRate: 0,
    profitFactor: 0,
    avgPnlPct: 0,
    totalReturnPct: 0,
    maxDrawdownPct: 0,
    sharpe: 0,
    totalPnlUsd: 0,
  };
  if (trades.length === 0) return empty;

  let wins = 0;
  let losses = 0;
  let expired = 0;
  let grossWinPct = 0;
  let grossLossPct = 0;
  let sumPnlPct = 0;

  // Equity curve (₹) for drawdown; per-trade returns for Sharpe.
  let equity = notional;
  let peak = notional;
  let maxDrawdownPct = 0;
  const returns: number[] = [];

  for (const t of trades) {
    sumPnlPct += t.pnlPct;
    if (t.pnlPct > 0) {
      wins += 1;
      grossWinPct += t.pnlPct;
    } else if (t.pnlPct < 0) {
      losses += 1;
      grossLossPct += Math.abs(t.pnlPct);
    }
    if (t.reason === "EXPIRED" || t.reason === "EOD") expired += 1;

    const r = t.pnlPct / 100;
    returns.push(r);
    equity += r * notional;
    if (equity > peak) peak = equity;
    if (peak > 0) {
      const dd = (peak - equity) / peak;
      if (dd > maxDrawdownPct) maxDrawdownPct = dd;
    }
  }

  const total = trades.length;
  const profitFactor =
    grossLossPct === 0
      ? grossWinPct > 0
        ? Number.POSITIVE_INFINITY
        : 0
      : grossWinPct / grossLossPct;

  return {
    totalTrades: total,
    wins,
    losses,
    expired,
    winRate: total > 0 ? wins / total : 0,
    profitFactor,
    avgPnlPct: sumPnlPct / total,
    totalReturnPct: ((equity - notional) / notional) * 100,
    maxDrawdownPct,
    sharpe: sharpeOf(returns),
    totalPnlUsd: equity - notional,
  };
}

function sharpeOf(returns: number[]): number {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance =
    returns.reduce((a, r) => a + (r - mean) ** 2, 0) / returns.length;
  const stdev = Math.sqrt(variance);
  if (stdev === 0) return 0;
  return (mean / stdev) * Math.sqrt(TRADING_DAYS);
}

export function summaryToScoreInput(
  strategyId: IndiaScalpStrategyId,
  summary: IndiaTradeSummary,
  source: IndiaStrategyScoreSource,
): IndiaStrategyScoreInput {
  return {
    strategyId,
    wins: summary.wins,
    losses: summary.losses,
    expired: summary.expired,
    winRate: summary.winRate,
    profitFactor: summary.profitFactor,
    avgPnlPct: summary.avgPnlPct,
    totalPnlUsd: summary.totalPnlUsd,
    maxDrawdownPct: summary.maxDrawdownPct,
    sharpe: summary.sharpe,
    source,
  };
}
