import "server-only";

import type { PrismaClient } from "@prisma/client";

import { getPrisma } from "@/lib/prisma";
import { yahoo } from "@/services/india/yahoo";

import {
  INDIA_DEFAULT_NOTIONAL,
  INDIA_MAX_TRADE_AGE_MS,
  atrFromCandles,
  buildIndiaTradeLevels,
  indiaPnlPercent,
  isExpiryCooldownIST,
  resolveAgainstCandles,
} from "@/features/india/scalping/paper-trader-core";
import {
  buildIndiaTradeSource,
  type IndiaScalpSignal,
} from "@/features/india/scalping/types";

/**
 * India F&O paper-trader. Mirrors the crypto
 * `src/features/scalping/paper-trader.ts` but:
 *   - tags every row with the canonical `in:<id>:<tf>` source so the
 *     India journal stays segregated in the shared `PaperTrade` table;
 *   - sizes the stop / target off a real intraday ATR (NSE tick-rounded)
 *     when one is supplied, instead of the synthetic 0.5% / 1% band;
 *   - skips opening into the expiry-day gamma cooldown (Thursday close).
 *
 * Trade resolution walks intraday (5m) NSE candles from Yahoo since
 * `openedAt` with the same conservative tie-break (touch-both → stop) the
 * crypto resolver uses.
 */

export type OpenIndiaTradeReason =
  | "fired"
  | "duplicate-signal"
  | "already-open"
  | "expiry-cooldown";

export interface OpenIndiaTradeResult {
  opened: boolean;
  reason: OpenIndiaTradeReason;
  tradeId?: string;
}

export interface OpenIndiaTradeOpts {
  prisma?: PrismaClient;
  notional?: number;
  /** Real intraday ATR (price units) — drives ATR-sized SL/TP when > 0. */
  atr?: number;
  /** Stop distance as an ATR multiple (defaults to the core constant). */
  slMult?: number;
  /** NSE tick for level rounding (defaults to 0.05). */
  tick?: number;
  /** Wall-clock used for the expiry cooldown check (defaults to now). */
  now?: Date;
}

export async function openIndiaPaperTrade(
  signal: IndiaScalpSignal,
  opts: OpenIndiaTradeOpts = {},
): Promise<OpenIndiaTradeResult> {
  const prisma = opts.prisma ?? getPrisma();
  const now = opts.now ?? new Date();

  if (isExpiryCooldownIST(now)) {
    return { opened: false, reason: "expiry-cooldown" };
  }

  const source = buildIndiaTradeSource(signal.strategyId, signal.timeframe);

  const existingOpen = await prisma.paperTrade.findFirst({
    where: { symbol: signal.symbol, status: "OPEN", source },
    select: { id: true },
  });
  if (existingOpen) return { opened: false, reason: "already-open" };

  const dup = await prisma.paperTrade.findFirst({
    where: {
      symbol: signal.symbol,
      source,
      openedAt: {
        gte: new Date(signal.triggeredAt - 60_000),
        lte: new Date(signal.triggeredAt + 60_000),
      },
    },
    select: { id: true },
  });
  if (dup) return { opened: false, reason: "duplicate-signal", tradeId: dup.id };

  // Prefer real ATR-sized levels; fall back to the signal's own levels.
  const atr = typeof opts.atr === "number" && opts.atr > 0 ? opts.atr : null;
  const levels =
    atr != null
      ? buildIndiaTradeLevels({
          entry: signal.entry,
          direction: signal.direction,
          atr,
          slMult: opts.slMult,
          riskReward: signal.riskReward,
          tick: opts.tick,
        })
      : null;

  const stopLoss = levels?.stopLoss ?? signal.stopLoss;
  const target = levels?.target ?? signal.target;
  const riskReward = levels?.riskReward ?? signal.riskReward;

  const trade = await prisma.paperTrade.create({
    data: {
      symbol: signal.symbol,
      direction: signal.direction,
      status: "OPEN",
      source,
      rationale: signal.rationale,
      meta: {
        strategyId: signal.strategyId,
        confirmed: signal.confirmed,
        triggeredAt: signal.triggeredAt,
        confidence: signal.confidence,
        triggeredAtPrice: signal.price,
        symbolName: signal.symbolName,
        atrSized: atr != null,
        extras: signal.extras ?? null,
      },
      notional: opts.notional ?? INDIA_DEFAULT_NOTIONAL,
      entry: signal.entry,
      stopLoss,
      target,
      riskReward,
      atr: atr ?? signal.atr,
      openedAt: new Date(signal.triggeredAt),
    },
    select: { id: true },
  });

  return { opened: true, reason: "fired", tradeId: trade.id };
}

export interface IndiaResolveStats {
  scanned: number;
  wins: number;
  losses: number;
  expired: number;
  errors: number;
}

interface OpenRow {
  id: string;
  symbol: string;
  direction: string;
  entry: number;
  stopLoss: number;
  target: number;
  notional: number;
  openedAt: Date;
}

export async function resolveIndiaOpenTrades(
  prisma?: PrismaClient,
): Promise<IndiaResolveStats> {
  const db = prisma ?? getPrisma();
  const stats: IndiaResolveStats = {
    scanned: 0,
    wins: 0,
    losses: 0,
    expired: 0,
    errors: 0,
  };

  const open = (await db.paperTrade.findMany({
    where: { status: "OPEN", source: { startsWith: "in:" } },
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
  })) as OpenRow[];

  stats.scanned = open.length;
  const now = Date.now();

  for (const t of open) {
    let candles;
    try {
      candles = await yahoo.getHistorical({
        symbol: t.symbol,
        interval: "5m",
        range: "5d",
      });
    } catch (err) {
      console.warn(
        `[india/paper-trader] candle fetch failed for ${t.symbol}:`,
        (err as Error).message,
      );
      stats.errors += 1;
      continue;
    }

    const openedAtSec = Math.floor(t.openedAt.getTime() / 1000);
    const relevant = candles.filter((c) => c.time >= openedAtSec);
    const isLong = t.direction === "LONG";

    const resolved = resolveAgainstCandles(relevant, {
      direction: isLong ? "LONG" : "SHORT",
      stopLoss: t.stopLoss,
      target: t.target,
    });

    if (resolved) {
      const pnlPct = indiaPnlPercent(t.entry, resolved.exitPrice, isLong);
      await db.paperTrade.update({
        where: { id: t.id },
        data: {
          status: resolved.outcome,
          exitPrice: resolved.exitPrice,
          pnlPct,
          pnlUsd: (pnlPct / 100) * t.notional,
          closedAt: new Date(resolved.closedAtSec * 1000),
        },
      });
      if (resolved.outcome === "WIN") stats.wins += 1;
      else stats.losses += 1;
      continue;
    }

    if (now - t.openedAt.getTime() >= INDIA_MAX_TRADE_AGE_MS) {
      const last = relevant[relevant.length - 1];
      const exit = last?.close ?? t.entry;
      const pnlPct = indiaPnlPercent(t.entry, exit, isLong);
      await db.paperTrade.update({
        where: { id: t.id },
        data: {
          status: "EXPIRED",
          exitPrice: exit,
          pnlPct,
          pnlUsd: (pnlPct / 100) * t.notional,
          closedAt: new Date(now),
        },
      });
      stats.expired += 1;
    }
  }

  return stats;
}

/**
 * Intraday ATR for a single NSE symbol, used by the worker to size each
 * trade's stop / target. Yahoo memoises the candle fetch (~30s) so calling
 * this once per symbol per tick is cheap.
 */
export async function getIndiaIntradayAtr(
  symbol: string,
  period = 14,
): Promise<number | null> {
  try {
    const candles = await yahoo.getHistorical({
      symbol,
      interval: "5m",
      range: "5d",
    });
    return atrFromCandles(candles, period);
  } catch {
    return null;
  }
}
