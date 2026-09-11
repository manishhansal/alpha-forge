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

const IST_OFFSET_MS = 5.5 * 3600 * 1000;

/**
 * Canonical NSE trading SESSION date (IST `YYYY-MM-DD`) for a candle open time
 * (UTC epoch seconds). Stamped on all new daily writes so trading-day
 * uniqueness is enforced structurally (V4 §8). For intraday it records the
 * IST date the bar belongs to (still useful for coverage/gap grouping).
 */
export function sessionDateForTime(timeSec: number): string {
  const d = new Date(timeSec * 1000 + IST_OFFSET_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

export interface PersistCandlesOptions {
  /** Prisma client — defaults to the global singleton. */
  prisma?: PrismaClient;
  /** Skip records that already exist (default: false — upsert updates). */
  skipExisting?: boolean;
  /**
   * Provider that supplied these candles (V2 provenance). Stamped onto
   * `CandleBar.provider` so coverage/reconciliation can report lineage.
   */
  provider?: string;
  /** Dataset/normalization version stamped onto `CandleBar.datasetVersion`. */
  datasetVersion?: string;
  /**
   * When true, record a `DataQualityIncident` (failureType PERSISTENCE_FAILED)
   * if any candle fails to persist, so a provider-success/DB-failure never
   * looks like clean data (V3 §37). Default false to keep the hot path light;
   * the write-through + backfill callers enable it.
   */
  recordIncidentOnFailure?: boolean;
  /**
   * When true, reject candles that violate OHLC invariants
   * (high < max(open,close,low) or low > min(open,close,high)) instead of
   * skipping silently — the rejection is counted as an error (V3 §41).
   */
  strictOhlc?: boolean;
}

/** OHLC integrity check (V3 §41). Returns true when the candle is self-consistent. */
export function isOhlcConsistent(c: {
  open: number;
  high: number;
  low: number;
  close: number;
}): boolean {
  if (![c.open, c.high, c.low, c.close].every((v) => Number.isFinite(v) && v > 0)) return false;
  const hi = Math.max(c.open, c.close, c.low);
  const lo = Math.min(c.open, c.close, c.high);
  return c.high >= hi && c.low <= lo && c.high >= c.low;
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
  let persistFailures = 0;

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

    // V3 §41: OHLC integrity. In strict mode a violation is an error, not a
    // silent skip (so the caller can see rejected candles). Never "repair".
    if (!isOhlcConsistent(candle)) {
      if (opts.strictOhlc) result.errors += 1;
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
          // G-06/G-07: preserve a real 0 but flag placeholder-0 volume so a
          // synthesized bar is never mistaken for a genuine zero-volume bar.
          volume: candle.volume ?? 0,
          volumeUnavailable: candle.volumeUnavailable ?? false,
          oi: candle.oi ?? null,
          ...(opts.provider ? { provider: opts.provider } : {}),
          ...(opts.datasetVersion ? { datasetVersion: opts.datasetVersion } : {}),
          ...(candle.sourceTimestamp ? { sourceTimestamp: new Date(candle.sourceTimestamp) } : {}),
          sessionDate: sessionDateForTime(candle.time),
          receivedAt: new Date(),
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
          volumeUnavailable: candle.volumeUnavailable ?? false,
          oi: candle.oi ?? null,
          ...(opts.provider ? { provider: opts.provider } : {}),
          ...(opts.datasetVersion ? { datasetVersion: opts.datasetVersion } : {}),
          ...(candle.sourceTimestamp ? { sourceTimestamp: new Date(candle.sourceTimestamp) } : {}),
          sessionDate: sessionDateForTime(candle.time),
          receivedAt: new Date(),
        },
      });
      result.upserted += 1;
    } catch (err) {
      result.errors += 1;
      persistFailures += 1;
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

  // V3 §37: a provider-success / DB-failure must be observable, not silent.
  if (persistFailures > 0 && opts.recordIncidentOnFailure) {
    try {
      const { recordDataIncident } = await import("./data-incident.service");
      await recordDataIncident({
        severity: "ERROR",
        failureType: "PERSISTENCE_FAILED",
        provider: opts.provider ?? null,
        instrumentId,
        intervalStr: interval,
        rootCause: "one or more candles failed to persist to CandleBar",
        affectedRecords: persistFailures,
        prisma,
      });
    } catch {
      /* fail-open: incident recording must never break persistence */
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
