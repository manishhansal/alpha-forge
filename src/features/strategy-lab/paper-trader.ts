import "server-only";

import type { PrismaClient } from "@prisma/client";

import { getPrisma } from "@/lib/prisma";
import { runBacktest } from "@/features/strategy-lab/engine";
import { listUserStrategies } from "@/features/strategy-lab/storage";
import {
  PERIOD_INTERVAL,
  type ParsedStrategy,
  type StrategyPeriod,
} from "@/features/strategy-lab/types";
import { getServerBroker } from "@/services/brokers/registry";
import type { KlineInterval } from "@/services/binance/klines";
import type { KlineCandle, SymbolId } from "@/types/market";

/**
 * Live forward-test for an active Strategy.
 *
 * Each worker tick:
 *  1. Pulls the most-recent N closed candles for the strategy's symbol(s).
 *  2. Re-runs the rule evaluation on the last bar to detect a fresh entry.
 *  3. For OPEN trades, walks 1m candles since opening to see if SL/TP hit.
 *
 * Compared to the backtester this path is intentionally idempotent — re-
 * running the engine on the same closed bar should never open a duplicate
 * trade because we dedupe against the most recent OPEN row.
 */

const REQUIRED_BARS = 200;
const LIVE_PERIOD: StrategyPeriod = "1M"; // arbitrary — only used to pick interval
const DEFAULT_INTERVAL: KlineInterval = PERIOD_INTERVAL[LIVE_PERIOD];
const MAX_TRADE_AGE_MS = 24 * 60 * 60 * 1000;

export interface StrategyTickStats {
  scanned: number;
  opened: number;
  closed: number;
  errors: number;
}

export async function tickActiveStrategies(prisma?: PrismaClient): Promise<StrategyTickStats> {
  const db = prisma ?? getPrisma();
  const stats: StrategyTickStats = { scanned: 0, opened: 0, closed: 0, errors: 0 };

  const active = await db.strategy.findMany({
    where: { liveEnabled: true },
    take: 100,
    select: {
      id: true,
      userId: true,
      prompt: true,
      parsed: true,
      symbols: true,
    },
  });
  stats.scanned = active.length;
  if (active.length === 0) {
    return stats;
  }

  const broker = getServerBroker();

  // Group symbol fetches so we don't hit the broker once per (strategy ×
  // symbol). Many strategies will share BTC/ETH/SOL.
  const symbolCache = new Map<SymbolId, KlineCandle[]>();
  const fetchCandles = async (symbol: SymbolId): Promise<KlineCandle[]> => {
    if (symbolCache.has(symbol)) return symbolCache.get(symbol) ?? [];
    const pair = broker.pairs.spot[symbol];
    if (!pair) return [];
    try {
      const candles = await broker.fetchKlines(pair, DEFAULT_INTERVAL, REQUIRED_BARS);
      const closed = candles.length > 1 ? candles.slice(0, -1) : candles;
      symbolCache.set(symbol, closed);
      return closed;
    } catch (err) {
      console.warn("[strategy-lab] kline fetch failed:", (err as Error).message);
      symbolCache.set(symbol, []);
      stats.errors += 1;
      return [];
    }
  };

  for (const strat of active) {
    const parsed = strat.parsed as ParsedStrategy | null;
    if (!parsed || !parsed.entry || parsed.entry.conditions.length === 0) continue;
    for (const symbol of strat.symbols as SymbolId[]) {
      const candles = await fetchCandles(symbol);
      if (candles.length < 60) continue;
      try {
        const opened = await maybeOpenTrade(strat.id, symbol, parsed, candles, db);
        if (opened) stats.opened += 1;
      } catch (err) {
        console.warn("[strategy-lab] open-trade failed:", (err as Error).message);
        stats.errors += 1;
      }
    }
  }

  // Resolve outstanding open trades regardless of whether the strategy is
  // still active — pausing should not freeze in-flight positions.
  try {
    const closed = await resolveOpenTrades(db);
    stats.closed += closed;
  } catch (err) {
    console.warn("[strategy-lab] resolve failed:", (err as Error).message);
    stats.errors += 1;
  }

  return stats;
}

/**
 * Run the entry rule on the latest closed bar; if it fires and no OPEN
 * trade already exists for this (strategy, symbol), open one.
 */
async function maybeOpenTrade(
  strategyId: string,
  symbol: SymbolId,
  parsed: ParsedStrategy,
  candles: KlineCandle[],
  prisma: PrismaClient,
): Promise<boolean> {
  const existing = await prisma.strategyPaperTrade.findFirst({
    where: { strategyId, symbol, status: "OPEN" },
    select: { id: true },
  });
  if (existing) return false;

  // Reuse the backtester to evaluate the *last* bar only. We pass the full
  // recent window so indicators are warm; we then inspect whether the
  // engine opened a trade *on the last bar*.
  const interval = DEFAULT_INTERVAL;
  const result = runBacktest({
    symbol,
    period: LIVE_PERIOD,
    interval,
    candles,
    parsed,
  });

  // Find the freshest "open" event — i.e. a trade opened on the last bar
  // whose closedAt is on the *next* bar (or EOD on the same bar).
  const lastBarTime = candles[candles.length - 1].closeTime;
  const tradeOnLastBar = [...result.trades]
    .reverse()
    .find((t) => t.openedAt >= lastBarTime - 1); // closeTime is the last bar's close
  // Equally, the engine may have opened a trade and force-closed at EOD on
  // the last bar; we treat that as a valid live entry.
  if (!tradeOnLastBar) return false;

  // Sanity: trade entry should map to the last-bar close.
  const last = candles[candles.length - 1];
  if (Math.abs(tradeOnLastBar.entry - last.close) / last.close > 0.005) {
    // Engine opened earlier in the window — this would have already been
    // detected on a previous tick. Don't re-open.
    return false;
  }

  await prisma.strategyPaperTrade.create({
    data: {
      strategyId,
      symbol,
      direction: parsed.side,
      status: "OPEN",
      notional: parsed.notional,
      entry: tradeOnLastBar.entry,
      stopLoss: computeStop(parsed, tradeOnLastBar.entry),
      target: computeTarget(parsed, tradeOnLastBar.entry),
      riskReward: ratio(parsed),
      rationale: parsed.summary,
      openedAt: new Date(last.closeTime),
    },
  });
  return true;
}

async function resolveOpenTrades(prisma: PrismaClient): Promise<number> {
  const broker = getServerBroker();
  const open = await prisma.strategyPaperTrade.findMany({
    where: { status: "OPEN" },
    take: 200,
    orderBy: { openedAt: "asc" },
    select: {
      id: true,
      symbol: true,
      direction: true,
      entry: true,
      stopLoss: true,
      target: true,
      notional: true,
      openedAt: true,
    },
  });
  if (open.length === 0) return 0;

  let closedCount = 0;
  const now = Date.now();
  for (const t of open) {
    const pair = broker.pairs.spot[t.symbol as SymbolId];
    if (!pair) continue;
    let candles: KlineCandle[];
    try {
      candles = await broker.fetchKlinesRange(pair, "1m", t.openedAt.getTime(), now);
    } catch (err) {
      console.warn("[strategy-lab] resolve klines failed:", (err as Error).message);
      continue;
    }
    const isLong = t.direction === "LONG";
    let exitPrice: number | null = null;
    let reason: "TARGET" | "STOP" | null = null;
    let closedAt: Date | null = null;

    for (const c of candles) {
      const hitStop = isLong ? c.low <= t.stopLoss : c.high >= t.stopLoss;
      const hitTarget = isLong ? c.high >= t.target : c.low <= t.target;
      if (hitStop) {
        exitPrice = t.stopLoss;
        reason = "STOP";
        closedAt = new Date(c.closeTime);
        break;
      }
      if (hitTarget) {
        exitPrice = t.target;
        reason = "TARGET";
        closedAt = new Date(c.closeTime);
        break;
      }
    }

    if (exitPrice !== null && reason && closedAt) {
      const pnlPct = pnlPercent(t.entry, exitPrice, isLong);
      const pnlUsd = (pnlPct / 100) * t.notional;
      await prisma.strategyPaperTrade.update({
        where: { id: t.id },
        data: {
          status: reason === "TARGET" ? "WIN" : "LOSS",
          exitPrice,
          pnlPct,
          pnlUsd,
          closeReason: reason,
          closedAt,
        },
      });
      closedCount += 1;
      continue;
    }

    // Expire after MAX_TRADE_AGE_MS using the last available close.
    const ageMs = now - t.openedAt.getTime();
    if (ageMs >= MAX_TRADE_AGE_MS && candles.length > 0) {
      const last = candles[candles.length - 1];
      const exit = last.close;
      const pnlPct = pnlPercent(t.entry, exit, isLong);
      const pnlUsd = (pnlPct / 100) * t.notional;
      await prisma.strategyPaperTrade.update({
        where: { id: t.id },
        data: {
          status: "EXPIRED",
          exitPrice: exit,
          pnlPct,
          pnlUsd,
          closeReason: "EXPIRED",
          closedAt: new Date(now),
        },
      });
      closedCount += 1;
    }
  }
  return closedCount;
}

function computeStop(parsed: ParsedStrategy, entry: number): number {
  const isLong = parsed.side === "LONG";
  if (parsed.risk.stopLossPct) {
    return isLong ? entry * (1 - parsed.risk.stopLossPct) : entry * (1 + parsed.risk.stopLossPct);
  }
  return isLong ? entry * 0.98 : entry * 1.02;
}

function computeTarget(parsed: ParsedStrategy, entry: number): number {
  const isLong = parsed.side === "LONG";
  if (parsed.risk.takeProfitPct) {
    return isLong ? entry * (1 + parsed.risk.takeProfitPct) : entry * (1 - parsed.risk.takeProfitPct);
  }
  return isLong ? entry * 1.04 : entry * 0.96;
}

function ratio(parsed: ParsedStrategy): number {
  const sl = parsed.risk.stopLossPct ?? 0.02;
  const tp = parsed.risk.takeProfitPct ?? 0.04;
  return sl > 0 ? tp / sl : 0;
}

function pnlPercent(entry: number, exit: number, isLong: boolean): number {
  if (entry <= 0) return 0;
  const raw = (exit - entry) / entry;
  return (isLong ? raw : -raw) * 100;
}

// Re-export for convenience.
export { listUserStrategies };
