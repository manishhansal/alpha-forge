/**
 * India F&O Scanner WhatsApp Notification Job.
 *
 * On each tick this job runs all six F&O scanner types (momentum, oi-buildup,
 * pcr, iv-spike, volume-breakout, range-expansion) in parallel, computes the
 * delta vs. the previous tick's results (stored in Redis), and emits
 * `SCANNER_HIT_NEW` WhatsApp notification events for each new hit.
 *
 * Flooding guard (Requirement 6.5): when more than 5 new hits arrive in a
 * single tick for a scanner type, a single batch summary message is sent via
 * `sendEvolutionMessage` directly rather than one-per-hit.
 *
 * Delta storage (Requirements 6.1):
 *   Redis key: `whatsapp:scanner:prev:{scannerType}`
 *   Value: JSON array of symbol strings from the previous tick.
 *   TTL: 2 hours (ensures stale state from a worker restart is cleared).
 *
 * Requirements: 6.1, 6.5, 10.3, 12.5
 */

import { runScanner } from "@/services/india/scanner/engine";
import type { ScannerHit, ScannerType } from "@/types/india/scanner";
import { isNseMarketOpenIST } from "@/lib/india/market-hours";
import type { ScannerHitEvent, ScannerHitSnapshot } from "@/features/whatsapp/types";
import { dispatchWhatsApp } from "@/features/whatsapp/notifier";
import { sendEvolutionMessage } from "@/features/whatsapp/notifier";
import { formatScannerBatchMessage } from "@/features/whatsapp/formatters/scanner";
import { readPhone } from "@/features/whatsapp/phone";

import { workerConfig } from "../config";
import { getPrisma } from "../db";
import { createLogger } from "../log";
import { getRedis } from "../redis";
import { scheduleJob, type JobHandle } from "../scheduler";

const log = createLogger("worker:india-scanner");

/** All six F&O scanner types the job polls on each tick. */
const SCANNER_TYPES: readonly ScannerType[] = [
  "momentum",
  "oi-buildup",
  "pcr",
  "iv-spike",
  "volume-breakout",
  "range-expansion",
];

/** Default scan limit — keep it modest to reduce Yahoo/NSE round-trip time. */
const SCAN_LIMIT = 25;

/**
 * Redis key for storing the previous tick's symbols for a scanner type.
 * TTL of 2h ensures stale state is evicted if the worker is offline overnight.
 */
function prevKey(scannerType: ScannerType): string {
  return `whatsapp:scanner:prev:${scannerType}`;
}

const PREV_KEY_TTL_SECONDS = 2 * 3600; // 2 hours

/**
 * Resolve the exchange label for a scanner hit.
 * Scanner hits don't carry an exchange field — all F&O instruments are NSE.
 */
function resolveExchange(): "NSE" | "BSE" {
  return "NSE";
}

/**
 * Build the `keyMetric` string from a `ScannerHit`.
 *
 * The scanner engine stores the human-readable metric in `metricLabel`
 * (e.g. "1.23× avg", "PCR 0.92", "ATM IV 18.5%").  When a `kind` field
 * is also present (e.g. OI build-up kind: "LONG_BUILDUP"), we concatenate
 * them so the notification carries both the measurement and its category.
 */
function buildKeyMetric(hit: ScannerHit): string {
  const parts: string[] = [];
  if (hit.kind) {
    // Replace underscores for readability ("LONG_BUILDUP" → "Long Buildup")
    const kindLabel = hit.kind
      .split("_")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(" ");
    parts.push(kindLabel);
  }
  if (hit.metricLabel) {
    parts.push(hit.metricLabel);
  }
  return parts.join(" · ") || String(hit.metric);
}

/**
 * Map a `ScannerHit` to the `ScannerHitSnapshot` shape required by
 * the WhatsApp notification types.  Skips hits with null/zero price since
 * the formatter cannot render a meaningful price line without one.
 */
function toSnapshot(
  hit: ScannerHit,
  scannerType: ScannerType,
): ScannerHitSnapshot | null {
  const price = typeof hit.price === "number" && hit.price > 0 ? hit.price : null;
  if (price === null) return null;

  return {
    symbol: hit.symbol,
    exchange: resolveExchange(),
    scannerType,
    price,
    changePct: hit.changePct ?? 0,
    keyMetric: buildKeyMetric(hit),
  };
}

/**
 * Load the previous symbol set for a scanner type from Redis.
 * Returns an empty Set when the key is absent or on Redis error.
 */
async function loadPrevSymbols(
  redis: ReturnType<typeof getRedis>,
  scannerType: ScannerType,
): Promise<Set<string>> {
  try {
    const raw = await redis.get(prevKey(scannerType));
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((s): s is string => typeof s === "string"));
    }
  } catch (err) {
    log.warn("failed to load prev scanner symbols", {
      scannerType,
      err: (err as Error).message,
    });
  }
  return new Set();
}

/**
 * Persist the current symbol set for a scanner type to Redis.
 * Best-effort — errors are logged and swallowed.
 */
async function savePrevSymbols(
  redis: ReturnType<typeof getRedis>,
  scannerType: ScannerType,
  symbols: string[],
): Promise<void> {
  try {
    await redis.set(
      prevKey(scannerType),
      JSON.stringify(symbols),
      "EX",
      PREV_KEY_TTL_SECONDS,
    );
  } catch (err) {
    log.warn("failed to save prev scanner symbols", {
      scannerType,
      err: (err as Error).message,
    });
  }
}

/**
 * Process one scanner type for a single tick:
 *   1. Run the scanner.
 *   2. Load the previous symbol set from Redis.
 *   3. Compute delta (current − previous).
 *   4. Dispatch notifications for new hits.
 *   5. Update the previous symbol set in Redis.
 *
 * The `userId` and `phone` parameters are resolved once per job tick (not
 * per scanner type) to avoid repeated DB lookups.
 */
async function processScannerType(
  scannerType: ScannerType,
  redis: ReturnType<typeof getRedis>,
  userId: string,
  userPhone: string | null,
): Promise<{ scannerType: ScannerType; newHits: number; totalHits: number }> {
  // ── 1. Run scanner ────────────────────────────────────────────────────────
  const result = await runScanner(scannerType, SCAN_LIMIT);

  // ── 2. Load previous symbol set ───────────────────────────────────────────
  const prevSymbols = await loadPrevSymbols(redis, scannerType);

  // Current symbol set (only hits with a valid price)
  const currentSymbols = new Set<string>();
  for (const hit of result.hits) {
    if (typeof hit.price === "number" && hit.price > 0) {
      currentSymbols.add(hit.symbol);
    }
  }

  // ── 3. Compute delta ──────────────────────────────────────────────────────
  const newSymbols = [...currentSymbols].filter((s) => !prevSymbols.has(s));

  // ── 5. Update previous set in Redis (always, even if delta is empty) ──────
  await savePrevSymbols(redis, scannerType, [...currentSymbols]);

  if (newSymbols.length === 0) {
    return { scannerType, newHits: 0, totalHits: result.hits.length };
  }

  const newHitObjects = result.hits.filter((h) => newSymbols.includes(h.symbol));
  const snapshots = newHitObjects
    .map((h) => toSnapshot(h, scannerType))
    .filter((s): s is ScannerHitSnapshot => s !== null);

  if (snapshots.length === 0) {
    return { scannerType, newHits: 0, totalHits: result.hits.length };
  }

  // ── 4a. Batch path: > 5 new hits ─────────────────────────────────────────
  if (snapshots.length > 5) {
    // For the batch path we call sendEvolutionMessage directly (bypasses
    // per-hit cooldown). Requirement 6.5.
    // We need a phone to send to — if not available, skip.
    if (userPhone) {
      const batchMsg = formatScannerBatchMessage(snapshots, scannerType);
      void sendEvolutionMessage(userPhone, batchMsg).catch((err: unknown) =>
        log.warn("batch whatsapp dispatch error", {
          scannerType,
          err: (err as Error).message,
        }),
      );
    } else {
      log.debug("batch scanner notification skipped — no phone configured", { scannerType });
    }
  } else {
    // ── 4b. Per-hit path: ≤ 5 new hits ────────────────────────────────────
    // Fire-and-forget one ScannerHitEvent per new hit.
    // The cooldown gate in dispatchWhatsApp prevents floods.
    for (const snapshot of snapshots) {
      const event: ScannerHitEvent = {
        type: "SCANNER_HIT_NEW",
        hit: snapshot,
      };
      void dispatchWhatsApp(event, userId, { redis }).catch((err: unknown) =>
        log.warn("whatsapp dispatch error", {
          scannerType,
          symbol: snapshot.symbol,
          err: (err as Error).message,
        }),
      );
    }
  }

  return { scannerType, newHits: snapshots.length, totalHits: result.hits.length };
}

/**
 * Start the India F&O Scanner WhatsApp notification job.
 *
 * The job runs on a configurable cadence (`WORKER_INDIA_SCANNER_INTERVAL_MS`,
 * default 5 minutes). It is a no-op when WhatsApp is not configured
 * (`workerConfig.whatsapp.enabled === false`) or outside the NSE session.
 */
export function startIndiaScannerJob(): JobHandle {
  return scheduleJob(
    {
      name: "india-scanner",
      intervalMs: workerConfig.indiaScanner.intervalMs,
      runOnStart: false,
      tick: async () => {
        const child = log.child("tick");

        // Gate 1: WhatsApp must be configured.
        if (!workerConfig.whatsapp.enabled) {
          child.debug("skipped — whatsapp not enabled");
          return;
        }

        // Gate 2: Only run during the NSE session to avoid stale data
        // outside market hours (pre-market / post-market scanner results
        // are not meaningful for intraday F&O notifications).
        if (!isNseMarketOpenIST(new Date())) return;

        let redis: ReturnType<typeof getRedis>;
        try {
          redis = getRedis();
        } catch (err) {
          child.warn("redis unavailable — skipping tick", {
            err: (err as Error).message,
          });
          return;
        }

        // Resolve the system user phone once per tick (not per scanner type).
        // The worker uses a "system" userId sentinel — the phone number is
        // stored against the first configured user or the "system" sentinel,
        // same as in india-daily-picks.ts.
        let prisma: ReturnType<typeof getPrisma> | undefined;
        let userPhone: string | null = null;
        try {
          prisma = getPrisma();
          userPhone = await readPhone("system", prisma);
        } catch (err) {
          child.warn("could not resolve phone — batch path will be skipped", {
            err: (err as Error).message,
          });
        }

        // Run all scanner types in parallel for efficiency.
        const results = await Promise.allSettled(
          SCANNER_TYPES.map((type) =>
            processScannerType(type, redis, "system", userPhone),
          ),
        );

        let totalNew = 0;
        for (const r of results) {
          if (r.status === "fulfilled") {
            if (r.value.newHits > 0) {
              totalNew += r.value.newHits;
              child.info("new scanner hits", {
                scannerType: r.value.scannerType,
                newHits: r.value.newHits,
                totalHits: r.value.totalHits,
              });
            }
          } else {
            child.warn("scanner type failed", { err: r.reason?.message ?? String(r.reason) });
          }
        }

        if (totalNew > 0) {
          child.info("tick summary", { totalNewHits: totalNew });
        }
      },
    },
    log,
  );
}
