/**
 * candle-persist.service.ts
 *
 * Standalone CandleBar persistence helpers.
 *
 * The RealTimeCandleBuilder persists candles via its internal `persistConfirmed()`
 * method (only when `persistToDb=true`). For historical candle batches fetched from
 * providers during replay or the india-scalper intraday refresh, we need a
 * direct upsert path that does NOT require a running candle-builder instance.
 *
 * Fix for: RCA-001 — CandleBar DB persistence not wired
 * V9: Bulk-write path added — `persistCandles` now uses a single PostgreSQL
 *     INSERT … ON CONFLICT DO UPDATE batching all rows in one round-trip instead
 *     of N individual Prisma upserts. This satisfies the prompt §17/§38 requirement:
 *     "Do NOT perform for-each INSERT — use batch operations."
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

// ── Bulk-write chunk size ─────────────────────────────────────────────────────
// PostgreSQL allows up to 65535 bind parameters per statement.  We send up to
// BULK_CHUNK_SIZE candles per INSERT, each occupying 13 parameters.
// 65535 / 13 = 5041; we stay well within that with 500 rows/chunk.
const BULK_CHUNK_SIZE = 500;

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
 * V9 BULK PATH (default): All valid candles are sent in a single
 *   INSERT … ON CONFLICT DO UPDATE statement via `prisma.$executeRaw`.
 *   Up to BULK_CHUNK_SIZE rows per round-trip; chunked automatically.
 *   This avoids N × round-trip overhead for large backfills.
 *
 * FALLBACK: if the bulk insert throws (e.g. unexpected type mismatch in
 *   development), the function falls back to individual upserts row-by-row so
 *   the hot path remains resilient.
 *
 * Candles with invalid OHLC (non-finite values, open/close ≤ 0) are
 * validated and skipped before any DB call.
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

  // ── Validation pass — filter before any DB call ───────────────────────────
  const valid: OHLCVCandle[] = [];
  for (const candle of candles) {
    if (
      !Number.isFinite(candle.open) || candle.open <= 0 ||
      !Number.isFinite(candle.high) || candle.high <= 0 ||
      !Number.isFinite(candle.low) || candle.low <= 0 ||
      !Number.isFinite(candle.close) || candle.close <= 0 ||
      !Number.isFinite(candle.time) || candle.time <= 0
    ) {
      continue;
    }
    if (!isOhlcConsistent(candle)) {
      if (opts.strictOhlc) result.errors += 1;
      continue;
    }
    valid.push(candle);
  }

  if (valid.length === 0) return result;

  // ── Bulk insert path ──────────────────────────────────────────────────────
  // Chunk to stay within PostgreSQL's 65535-parameter limit.
  // Each row occupies 13 bind parameters.
  const chunks: OHLCVCandle[][] = [];
  for (let i = 0; i < valid.length; i += BULK_CHUNK_SIZE) {
    chunks.push(valid.slice(i, i + BULK_CHUNK_SIZE));
  }

  let persistFailures = 0;
  let bulkFailed = false;

  for (const chunk of chunks) {
    try {
      const written = await _bulkUpsertChunk(prisma, chunk, instrumentId, exchange, interval, opts);
      result.upserted += written;
    } catch (bulkErr) {
      // Bulk insert failed for this chunk — fall back to row-by-row.
      bulkFailed = true;
      mdLog("provider_degraded", {
        event: "BULK_UPSERT_FALLBACK",
        instrumentId,
        interval,
        chunkSize: chunk.length,
        error: (bulkErr as Error).message.slice(0, 200),
      });
      for (const candle of chunk) {
        try {
          await _singleUpsert(prisma, candle, instrumentId, exchange, interval, opts);
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
    }
  }

  if (bulkFailed) {
    mdLog("provider_degraded", {
      event: "BULK_UPSERT_FALLBACK_COMPLETE",
      instrumentId,
      interval,
      upserted: result.upserted,
      errors: result.errors,
    });
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

// ── Bulk helper ───────────────────────────────────────────────────────────────

/**
 * Execute one INSERT … ON CONFLICT DO UPDATE for a chunk of candles.
 * Returns the number of rows affected (inserted or updated).
 *
 * Uses raw SQL because Prisma's `createMany` does not support partial update
 * on conflict, and the existing unique key is on all four columns.
 */
async function _bulkUpsertChunk(
  prisma: PrismaClient,
  chunk: OHLCVCandle[],
  instrumentId: string,
  exchange: string,
  interval: Interval,
  opts: PersistCandlesOptions,
): Promise<number> {
  const now = new Date();
  const provider = opts.provider ?? null;
  const datasetVersion = opts.datasetVersion ?? null;

  // Build VALUES rows and flat bind-parameter array.
  // Row columns (13): instrumentId, exchange, intervalStr, time, open, high,
  //   low, close, volume, volumeUnavailable, oi, provider, datasetVersion,
  //   sessionDate, receivedAt  — 15 total
  const placeholders: string[] = [];
  const params: unknown[] = [];
  let p = 1;

  for (const c of chunk) {
    const sessionDate = sessionDateForTime(c.time);
    const oi = c.oi ?? null;
    const volumeUnavailable = c.volumeUnavailable ?? false;
    const sourceTs = c.sourceTimestamp
      ? new Date(typeof c.sourceTimestamp === "number" ? c.sourceTimestamp : c.sourceTimestamp)
      : null;

    placeholders.push(
      `($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++})`,
    );
    params.push(
      instrumentId, exchange, interval, c.time,
      c.open, c.high, c.low, c.close,
      c.volume ?? 0, volumeUnavailable, oi,
      provider, datasetVersion, sessionDate, sourceTs, now,
    );
  }

  const sql = `
    INSERT INTO candle_bar
      ("instrumentId","exchange","intervalStr","time",
       "open","high","low","close",
       "volume","volumeUnavailable","oi",
       "provider","datasetVersion","sessionDate","sourceTimestamp","receivedAt")
    VALUES ${placeholders.join(",")}
    ON CONFLICT ("instrumentId","exchange","intervalStr","time")
    DO UPDATE SET
      "open"               = EXCLUDED."open",
      "high"               = EXCLUDED."high",
      "low"                = EXCLUDED."low",
      "close"              = EXCLUDED."close",
      "volume"             = EXCLUDED."volume",
      "volumeUnavailable"  = EXCLUDED."volumeUnavailable",
      "oi"                 = EXCLUDED."oi",
      "sessionDate"        = EXCLUDED."sessionDate",
      "receivedAt"         = EXCLUDED."receivedAt",
      "provider"           = COALESCE(EXCLUDED."provider", candle_bar."provider"),
      "datasetVersion"     = COALESCE(EXCLUDED."datasetVersion", candle_bar."datasetVersion"),
      "sourceTimestamp"    = COALESCE(EXCLUDED."sourceTimestamp", candle_bar."sourceTimestamp")
  `;

  // prisma.$executeRaw requires a tagged-template — use $executeRawUnsafe
  // since we are constructing the SQL ourselves with positional parameters.
  // Parameters are passed separately (never interpolated into the string).
  const affected = await (prisma as unknown as {
    $executeRawUnsafe(sql: string, ...params: unknown[]): Promise<number>;
  }).$executeRawUnsafe(sql, ...params);

  return affected ?? chunk.length;
}

// ── Single-row upsert (fallback) ──────────────────────────────────────────────

async function _singleUpsert(
  prisma: PrismaClient,
  candle: OHLCVCandle,
  instrumentId: string,
  exchange: string,
  interval: Interval,
  opts: PersistCandlesOptions,
): Promise<void> {
  const sessionDate = sessionDateForTime(candle.time);
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
      volumeUnavailable: candle.volumeUnavailable ?? false,
      oi: candle.oi ?? null,
      ...(opts.provider ? { provider: opts.provider } : {}),
      ...(opts.datasetVersion ? { datasetVersion: opts.datasetVersion } : {}),
      ...(candle.sourceTimestamp ? { sourceTimestamp: new Date(candle.sourceTimestamp as string) } : {}),
      sessionDate,
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
      ...(candle.sourceTimestamp ? { sourceTimestamp: new Date(candle.sourceTimestamp as string) } : {}),
      sessionDate,
      receivedAt: new Date(),
    },
  });
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
