import "server-only";

import type { PrismaClient } from "@prisma/client";

import { getPrisma } from "@/lib/prisma";
import { isNseMarketOpenIST } from "@/lib/india/market-hours";
import { getHistoricalCandlesByRange } from "@/lib/market-data/services/historical.service";
import { bootstrapRegistry } from "@/lib/market-data/registry";
import {
  executeExactlyOnce,
  buildTradeGuardKey,
} from "@/lib/india/atomic-trade-guard";
import { getRedis } from "@/lib/redis";

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
  | "expiry-cooldown"
  | "market-closed";

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

  // All India paper trades are strictly intraday — refuse to open outside
  // the NSE session (09:15–15:30 IST, Mon–Fri), even if the caller forgot
  // to check. This is a second line of defence after the worker-level guard.
  if (!isNseMarketOpenIST(now)) {
    return { opened: false, reason: "market-closed" };
  }

  if (isExpiryCooldownIST(now)) {
    return { opened: false, reason: "expiry-cooldown" };
  }

  const source = buildIndiaTradeSource(signal.strategyId, signal.timeframe);

  // ── Atomic Redis claim (Phase 9) ─────────────────────────────────────────
  // Build a 5-minute-bucketed idempotency key. The atomic SET NX EX ensures
  // exactly one worker among any number of concurrent ticks can proceed.
  // When Redis is unavailable the DB dedup queries below act as the fallback.
  let redis: ReturnType<typeof getRedis> | undefined;
  try { redis = getRedis(); } catch { /* Redis unavailable — DB dedup covers it */ }

  const guardKey = buildTradeGuardKey({
    symbol: signal.symbol,
    strategyId: signal.strategyId,
    timeframe: signal.timeframe,
    triggeredAtMs: signal.triggeredAt,
  });

  if (redis) {
    const claim = await (async () => {
      try {
        const { atomicClaim } = await import("@/lib/india/atomic-trade-guard");
        return atomicClaim(redis!, guardKey, `pt:${signal.symbol}:${signal.triggeredAt}`);
      } catch {
        return { claimed: true, key: guardKey } as const;
      }
    })();
    if (!claim.claimed && "reason" in claim && claim.reason === "already_claimed") {
      return { opened: false, reason: "duplicate-signal" };
    }
  }

  // ── DB-level dedup (fallback when Redis unavailable) ─────────────────────
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

/**
 * Minimal resolved-trade record returned by `resolveIndiaOpenTrades` so
 * callers (e.g. the india-scalper worker job) can build notification
 * snapshots without a second DB read.
 */
export interface IndiaResolvedTrade {
  id: string;
  symbol: string;
  /** Always "NSE" for India scalper trades — kept in the record for the
   *  `IndiaPaperTradeSnapshot.exchange` field the notifier expects. */
  exchange: "NSE";
  direction: "LONG" | "SHORT";
  source: string;
  entry: number;
  stopLoss: number;
  target: number;
  riskReward: number;
  openedAt: number;  // Unix ms
  exitPrice: number;
  pnlPct: number;
  resolvedAt: number; // Unix ms
  outcome: "WIN" | "LOSS" | "EXPIRED";
}

interface OpenRow {
  id: string;
  symbol: string;
  direction: string;
  source: string;
  entry: number;
  stopLoss: number;
  target: number;
  riskReward: number;
  notional: number;
  openedAt: Date;
}

export interface IndiaResolveResult {
  stats: IndiaResolveStats;
  /** Every trade that transitioned out of OPEN this tick, with full snapshot
   *  data the caller can use to build `IndiaPaperTradeSnapshot` without a
   *  second DB read. */
  resolved: IndiaResolvedTrade[];
}

export async function resolveIndiaOpenTrades(
  prisma?: PrismaClient,
): Promise<IndiaResolveResult> {
  const db = prisma ?? getPrisma();
  const stats: IndiaResolveStats = {
    scanned: 0,
    wins: 0,
    losses: 0,
    expired: 0,
    errors: 0,
  };
  const resolved: IndiaResolvedTrade[] = [];

  const open = (await db.paperTrade.findMany({
    where: { status: "OPEN", source: { startsWith: "in:" } },
    orderBy: { openedAt: "asc" },
    take: 100,
    select: {
      id: true,
      symbol: true,
      direction: true,
      source: true,
      entry: true,
      stopLoss: true,
      target: true,
      riskReward: true,
      notional: true,
      openedAt: true,
    },
  })) as OpenRow[];

  stats.scanned = open.length;
  const now = Date.now();

  for (const t of open) {
    let candles;
    try {
      // Use "1d" range for the resolver — it's sufficient for intraday trades
      // and uses a distinct cache key from the ATR fetch ("5d"), preventing
      // the resolver from re-using a pre-open candle snapshot cached by
      // getIndiaIntradayAtr earlier in the same tick.
      const ohlcv = await getHistoricalCandlesByRange(
        t.symbol,
        "5m",
        "1d",
        "NSE",
        { tolerateInvalidCandles: true },
      );
      // OHLCVCandle is a strict superset of legacy Candle.
      candles = ohlcv as unknown as typeof candles;
    } catch (err) {
      console.warn(
        `[india/paper-trader] candle fetch failed for ${t.symbol}:`,
        (err as Error).message,
      );
      stats.errors += 1;
      continue;
    }

    const openedAtSec = Math.floor(t.openedAt.getTime() / 1000);
    // A 5m candle's `time` is the bar's *open* time. Include any bar whose
    // close overlaps with the trade's open (bar_open + 5min > openedAt) so
    // a target/SL hit within the opening partial bar is never missed.
    const BAR_SEC = 5 * 60;
    const relevant = candles.filter((c) => c.time + BAR_SEC > openedAtSec);
    const isLong = t.direction === "LONG";

    const resolvedOutcome = resolveAgainstCandles(relevant, {
      direction: isLong ? "LONG" : "SHORT",
      stopLoss: t.stopLoss,
      target: t.target,
    });

    if (resolvedOutcome) {
      const pnlPct = indiaPnlPercent(t.entry, resolvedOutcome.exitPrice, isLong);
      const closedAtMs = resolvedOutcome.closedAtSec * 1000;
      await db.paperTrade.update({
        where: { id: t.id },
        data: {
          status: resolvedOutcome.outcome,
          exitPrice: resolvedOutcome.exitPrice,
          pnlPct,
          pnlUsd: (pnlPct / 100) * t.notional,
          closedAt: new Date(closedAtMs),
        },
      });
      if (resolvedOutcome.outcome === "WIN") stats.wins += 1;
      else stats.losses += 1;
      resolved.push({
        id: t.id,
        symbol: t.symbol,
        exchange: "NSE",
        direction: t.direction as "LONG" | "SHORT",
        source: t.source,
        entry: t.entry,
        stopLoss: t.stopLoss,
        target: t.target,
        riskReward: t.riskReward,
        openedAt: t.openedAt.getTime(),
        exitPrice: resolvedOutcome.exitPrice,
        pnlPct,
        resolvedAt: closedAtMs,
        outcome: resolvedOutcome.outcome,
      });
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
      resolved.push({
        id: t.id,
        symbol: t.symbol,
        exchange: "NSE",
        direction: t.direction as "LONG" | "SHORT",
        source: t.source,
        entry: t.entry,
        stopLoss: t.stopLoss,
        target: t.target,
        riskReward: t.riskReward,
        openedAt: t.openedAt.getTime(),
        exitPrice: exit,
        pnlPct,
        resolvedAt: now,
        outcome: "EXPIRED",
      });
    }
  }

  return { stats, resolved };
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
    await bootstrapRegistry();
    const ohlcv = await getHistoricalCandlesByRange(
      symbol,
      "5m",
      "5d",
      "NSE",
      { tolerateInvalidCandles: true },
    );
    return atrFromCandles(ohlcv as unknown as Parameters<typeof atrFromCandles>[0], period);
  } catch {
    return null;
  }
}
