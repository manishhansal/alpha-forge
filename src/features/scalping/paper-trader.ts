import "server-only";

import type { PrismaClient } from "@prisma/client";

import { getPrisma } from "@/lib/prisma";
import { getServerBroker } from "@/services/brokers/registry";
import { buildTradeSource, type ScalpSignal } from "@/features/scalping/types";
import type { SymbolId } from "@/types/market";

const DEFAULT_NOTIONAL = 1000;
/** Trades older than this with no fill are auto-closed as EXPIRED. */
const MAX_TRADE_AGE_MS = 6 * 60 * 60 * 1000;

export interface OpenTradeResult {
  opened: boolean;
  reason: "fired" | "duplicate-signal" | "already-open" | "filtered";
  tradeId?: string;
}

interface OpenTradeOpts {
  notional?: number;
  /** Optional override of the source string written to the trade row. */
  source?: string;
  prisma?: PrismaClient;
}

/**
 * Open a paper trade for `signal` if no other OPEN trade exists for the same
 * symbol/strategy AND the same trigger bar hasn't already been recorded.
 *
 * Source string is `${strategyId}:${timeframe}` so each strategy gets its
 * own "lane" — multiple strategies can hold an open position on the same
 * symbol at the same time without colliding on the dedupe key.
 *
 * Returns a structured result so the caller (worker tick) can log meaningful
 * stats without re-querying.
 */
export async function openPaperTrade(
  signal: ScalpSignal,
  opts: OpenTradeOpts = {},
): Promise<OpenTradeResult> {
  const prisma = opts.prisma ?? getPrisma();
  const source = opts.source ?? buildTradeSource(signal.strategyId, signal.timeframe);

  const existingOpen = await prisma.paperTrade.findFirst({
    where: { symbol: signal.symbol, status: "OPEN", source },
    select: { id: true },
  });
  if (existingOpen) {
    return { opened: false, reason: "already-open" };
  }

  // Dedupe against the same trigger bar — even if the engine re-runs every
  // 30s, the same signal closeTime should never produce two trades.
  const triggerDate = new Date(signal.triggeredAt);
  const dup = await prisma.paperTrade.findFirst({
    where: {
      symbol: signal.symbol,
      source,
      openedAt: { gte: new Date(signal.triggeredAt - 60_000), lte: new Date(signal.triggeredAt + 60_000) },
    },
    select: { id: true },
  });
  if (dup) return { opened: false, reason: "duplicate-signal", tradeId: dup.id };

  const trade = await prisma.paperTrade.create({
    data: {
      symbol: signal.symbol,
      direction: signal.direction,
      status: "OPEN",
      source,
      rationale: signal.rationale,
      meta: {
        strategyId: signal.strategyId,
        trail: signal.trail,
        smcBias: signal.smcBias,
        confirmed: signal.confirmed,
        triggeredAt: signal.triggeredAt,
        confidence: signal.confidence,
        triggeredAtPrice: signal.price,
        extras: signal.extras ?? null,
      },
      notional: opts.notional ?? DEFAULT_NOTIONAL,
      entry: signal.entry,
      stopLoss: signal.stopLoss,
      target: signal.target,
      riskReward: signal.riskReward,
      atr: signal.atr,
      openedAt: triggerDate,
    },
    select: { id: true },
  });

  return { opened: true, reason: "fired", tradeId: trade.id };
}

export interface ResolveStats {
  scanned: number;
  wins: number;
  losses: number;
  expired: number;
  errors: number;
}

/**
 * Walk every OPEN trade, fetch 1m klines from `openedAt` → now, and decide:
 *   - WIN  : a candle's high (long) / low (short) crossed `target`
 *   - LOSS : a candle's low (long) / high (short) crossed `stopLoss`
 *   - EXPIRED: open longer than MAX_TRADE_AGE_MS without either being hit
 *
 * Conservative tie-break (same as `evaluateSignal`): if a candle touches
 * both target and stop, the stop wins.
 */
export async function resolveOpenTrades(prisma?: PrismaClient): Promise<ResolveStats> {
  const db = prisma ?? getPrisma();
  const stats: ResolveStats = { scanned: 0, wins: 0, losses: 0, expired: 0, errors: 0 };

  const open = await db.paperTrade.findMany({
    where: { status: "OPEN" },
    orderBy: { openedAt: "asc" },
    take: 100,
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

  const now = Date.now();
  stats.scanned = open.length;
  const broker = getServerBroker();

  for (const t of open) {
    const pair = broker.pairs.spot[t.symbol as SymbolId];
    if (!pair) continue;

    let candles;
    try {
      candles = await broker.fetchKlinesRange(pair, "1m", t.openedAt.getTime(), now);
    } catch (err) {
      console.warn(
        `[paper-trader] kline fetch failed for ${pair}:`,
        (err as Error).message,
      );
      stats.errors += 1;
      continue;
    }

    const isLong = t.direction === "LONG";
    let exitPrice: number | null = null;
    let outcome: "WIN" | "LOSS" | null = null;
    let closedAt: Date | null = null;

    for (const c of candles) {
      let hitStop = false;
      let hitTarget = false;
      if (isLong) {
        if (c.low <= t.stopLoss) hitStop = true;
        if (c.high >= t.target) hitTarget = true;
      } else {
        if (c.high >= t.stopLoss) hitStop = true;
        if (c.low <= t.target) hitTarget = true;
      }
      if (hitStop) {
        exitPrice = t.stopLoss;
        outcome = "LOSS";
        closedAt = new Date(c.closeTime);
        break;
      }
      if (hitTarget) {
        exitPrice = t.target;
        outcome = "WIN";
        closedAt = new Date(c.closeTime);
        break;
      }
    }

    if (outcome && exitPrice !== null && closedAt) {
      const pnlPct = pnlPercent(t.entry, exitPrice, isLong);
      const pnlUsd = (pnlPct / 100) * t.notional;
      await db.paperTrade.update({
        where: { id: t.id },
        data: {
          status: outcome,
          exitPrice,
          pnlPct,
          pnlUsd,
          closedAt,
        },
      });
      if (outcome === "WIN") stats.wins += 1;
      else stats.losses += 1;
      continue;
    }

    const ageMs = now - t.openedAt.getTime();
    if (ageMs >= MAX_TRADE_AGE_MS) {
      const last = candles[candles.length - 1];
      const exit = last?.close ?? t.entry;
      const pnlPct = pnlPercent(t.entry, exit, isLong);
      const pnlUsd = (pnlPct / 100) * t.notional;
      await db.paperTrade.update({
        where: { id: t.id },
        data: {
          status: "EXPIRED",
          exitPrice: exit,
          pnlPct,
          pnlUsd,
          closedAt: new Date(now),
        },
      });
      stats.expired += 1;
    }
  }

  return stats;
}

function pnlPercent(entry: number, exit: number, isLong: boolean): number {
  if (entry <= 0) return 0;
  const raw = (exit - entry) / entry;
  return (isLong ? raw : -raw) * 100;
}
