/**
 * candle-persist.service.ts
 *
 * Standalone CandleBar persistence helpers.
 *
 * The RealTimeCandleBuilder persists candles via its internal `persistConfirmed()`
 * method (only when `persistToDb=true`). For historical candle batches fetched from
 * Angel One / Yahoo during replay or the india-scalper intraday refresh, we need a
 * direct upsert path that does NOT require a running candle-builder instance.
 *
 * Fix for: RCA-001 — CandleBar DB persistence not wired
 *
 * Usage:
 *   import { persistCandles } from "@/lib/market-data/services/candle-persist.service";
 *   await persistCandles(candles, "NIFTY", "NSE", "5m");
 */

import "server-only";

import type { PrismaClient } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { mdLog } from "../health";
import type { Interval, OHLCVCandle } from "../types";

export interface PersistCandlesOptions {
  /** Prisma client — defaults to the global singleton. */
  prisma?: PrismaClient;
  /** Skip records that already exist (default: false — upsert updates). */
  skipExisting?: boolean;
}

export interface PersistCandlesResult {
  /** Number of rows successfully upserted. */
  upserted: number;
  /** Number of rows that failed (individual errors are logged). */
  errors: number;
}

/**
 * Upsert a batch of `OHLCVCandle` objects into the `CandleBar` table.
 *
 * Each upsert uses the composite unique key (instrumentId, exchange, intervalStr, time)
 * so repeated calls are idempotent — the same candle will not be duplicated.
 *
 * Candles with invalid OHLC (non-finite values, open/close ≤ 0) are silently
 * skipped to protect the data integrity of the table.
 *
 * @param candles    The candles to persist. `time` is UTC epoch SECONDS (candle open).
 * @param instrumentId  NSE instrument symbol (e.g. "NIFTY", "RELIANCE").
 * @param exchange   Exchange identifier ("NSE").
 * @param interval   Candle width string matching Prisma schema (e.g. "1m", "5m").
 */
export async function persistCandles(
  candles: ReadonlyArray<OHLCVCandle>,
  instrumentId: string,
  exchange: string,
  interval: Interval,
  opts: PersistCandlesOptions = {},
): Promise<PersistCandlesResult> {
  const prisma = opts.prisma ?? getPrisma();
  const result: PersistCandlesResult = { upserted: 0, errors: 0 };

  for (const candle of candles) {
    // Guard: skip structurally invalid candles.
    if (
      !Number.isFinite(candle.open) || candle.open <= 0 ||
      !Number.isFinite(candle.high) || candle.high <= 0 ||
      !Number.isFinite(candle.low) || candle.low <= 0 ||
      !Number.isFinite(candle.close) || candle.close <= 0 ||
      !Number.isFinite(candle.time) || candle.time <= 0
    ) {
      continue;
    }

    try {
      await prisma.candleBar.upsert({
        where: {
          instrumentId_exchange_intervalStr_time: {
            instrumentId,
            exchange,
            intervalStr: interval,
            time: candle.time,
          },
        },
        update: {
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
          volume: candle.volume ?? 0,
          oi: candle.oi ?? null,
        },
        create: {
          instrumentId,
          exchange,
          intervalStr: interval,
          time: candle.time,
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
          volume: candle.volume ?? 0,
          oi: candle.oi ?? null,
        },
      });
      result.upserted += 1;
    } catch (err) {
      result.errors += 1;
      mdLog("stale_data", {
        reason: "candle_persist_failed",
        instrumentId,
        exchange,
        interval,
        candleTime: candle.time,
        error: (err as Error).message,
      });
    }
  }
  return result;
}

/**
 * Persist candles for multiple instruments in parallel.
 * Failures on one instrument do not abort the others.
 */
export async function persistCandlesBatch(
  entries: ReadonlyArray<{
    candles: ReadonlyArray<OHLCVCandle>;
    instrumentId: string;
    exchange: string;
    interval: Interval;
  }>,
  opts: PersistCandlesOptions = {},
): Promise<{ totalUpserted: number; totalErrors: number }> {
  const prisma = opts.prisma ?? getPrisma();
  const results = await Promise.allSettled(
    entries.map((e) =>
      persistCandles(e.candles, e.instrumentId, e.exchange, e.interval, {
        ...opts,
        prisma,
      }),
    ),
  );

  let totalUpserted = 0;
  let totalErrors = 0;
  for (const r of results) {
    if (r.status === "fulfilled") {
      totalUpserted += r.value.upserted;
      totalErrors += r.value.errors;
    } else {
      totalErrors += 1;
    }
  }
  return { totalUpserted, totalErrors };
}
