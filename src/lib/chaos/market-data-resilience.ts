/**
 * chaos/market-data-resilience.ts
 *
 * Chaos Engineering – Scenarios 4–8:
 *   4. Stale data detection
 *   5. Duplicate tick deduplication
 *   6. Out-of-order tick handling
 *   7. Provider failover with price-divergence detection
 *   17. Stale Redis cache detection and invalidation
 *
 * Provides:
 *  - isTickStale()          : compare tick timestamp against wall-clock max age
 *  - TickDeduplicator       : sliding-window seen-set using a Bloom-filter
 *                             approximation (Map-based for determinism)
 *  - TickSequenceBuffer     : reorder buffer that holds out-of-order ticks
 *                             and releases them in timestamp order
 *  - checkProviderDivergence: compare primary vs secondary price; return
 *                             divergence info when above threshold
 *  - isCacheStale()         : compare a cached snapshot's generatedAt field
 *                             against a configurable max-age
 *  - invalidateRedisCache() : delete one or more Redis keys with logging
 */

import type { RedisLike } from "@/lib/redis";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MarketTick {
  symbol: string;
  /** Millisecond epoch. */
  ts: number;
  price: number;
  volume?: number | null;
  /** Optional monotonic sequence number from the provider. */
  seq?: number;
}

// ─── Scenario 4: Stale data detection ────────────────────────────────────────

/** Default maximum age before a tick is considered stale. */
const DEFAULT_STALE_MS = 30_000; // 30 seconds

/**
 * Returns true when the tick's `ts` field is older than `maxAgeMs` relative
 * to the current wall clock, or when `ts` is in the future beyond a 5s
 * tolerance (clock skew guard).
 */
export function isTickStale(
  tick: Pick<MarketTick, "ts" | "symbol">,
  opts: { maxAgeMs?: number; label?: string } = {},
): boolean {
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_STALE_MS;
  const now = Date.now();
  const age = now - tick.ts;

  if (age > maxAgeMs) {
    console.warn(
      `[market-data] stale tick detected for ${tick.symbol}: age=${age}ms (max ${maxAgeMs}ms)`,
      { ts: tick.ts, now, label: opts.label },
    );
    return true;
  }

  if (tick.ts > now + 5_000) {
    console.warn(
      `[market-data] future tick detected for ${tick.symbol}: ts=${tick.ts} is ${tick.ts - now}ms ahead of wall-clock`,
      { label: opts.label },
    );
    return true;
  }

  return false;
}

/**
 * Assert that a cached response object's `generatedAt` field is within
 * `maxAgeMs` of wall-clock time.  When stale, logs a structured warning.
 */
export function isCacheStale(
  snapshot: { generatedAt?: number | Date } | null | undefined,
  maxAgeMs: number,
  label = "cache",
): boolean {
  if (!snapshot) return true;

  const ts =
    snapshot.generatedAt instanceof Date
      ? snapshot.generatedAt.getTime()
      : typeof snapshot.generatedAt === "number"
        ? snapshot.generatedAt
        : null;

  if (ts === null) return true;

  const age = Date.now() - ts;
  if (age > maxAgeMs) {
    console.warn(`[market-data] ${label} snapshot is stale: age=${age}ms (max ${maxAgeMs}ms)`, {
      generatedAt: ts,
    });
    return true;
  }
  return false;
}

/**
 * Delete one or more Redis cache keys, logging each deletion.
 * Best-effort — errors are logged but not thrown.
 */
export async function invalidateRedisCache(
  redis: RedisLike,
  keys: string[],
  label = "cache-invalidation",
): Promise<void> {
  for (const key of keys) {
    try {
      await redis.del(key);
      console.info(`[market-data] ${label} invalidated key: ${key}`);
    } catch (err) {
      console.warn(`[market-data] ${label} failed to invalidate key "${key}": ${(err as Error).message}`);
    }
  }
}

// ─── Scenario 5: Duplicate tick deduplication ─────────────────────────────────

/**
 * Sliding-window deduplicator for market ticks.
 *
 * Uses a Map keyed by `${symbol}:${ts}` with a bounded window (evicts entries
 * older than `windowMs` on each check).  This is an exact deduplicator — no
 * false positives.  For high-throughput use cases a Bloom filter would be
 * more memory-efficient but this keeps the implementation dependency-free.
 */
export class TickDeduplicator {
  private readonly seen = new Map<string, number>();
  private readonly windowMs: number;

  constructor(windowMs = 5_000) {
    this.windowMs = windowMs;
  }

  /**
   * Returns true if `tick` is a duplicate (already seen within the window).
   * Registers the tick as seen if it is not a duplicate.
   */
  isDuplicate(tick: Pick<MarketTick, "symbol" | "ts">): boolean {
    this._evict();
    const key = `${tick.symbol}:${tick.ts}`;
    if (this.seen.has(key)) {
      console.warn(`[market-data] duplicate tick dropped: ${key}`);
      return true;
    }
    this.seen.set(key, tick.ts);
    return false;
  }

  private _evict(): void {
    const cutoff = Date.now() - this.windowMs;
    for (const [key, ts] of this.seen) {
      if (ts < cutoff) this.seen.delete(key);
    }
  }

  /** For testing — number of entries currently in the window. */
  get size(): number {
    return this.seen.size;
  }

  reset(): void {
    this.seen.clear();
  }
}

// ─── Scenario 6: Out-of-order tick handling ───────────────────────────────────

/**
 * Per-symbol reorder buffer.
 *
 * Ticks that arrive out of timestamp order are held until either:
 *   a) `flushDelayMs` has elapsed since the latest in-order tick, OR
 *   b) A tick arrives with `ts > buffer_head + maxGapMs` (hard flush).
 *
 * The buffer emits ticks in ascending `ts` order so downstream consumers
 * always receive a monotonically increasing stream.
 */
export class TickSequenceBuffer {
  private readonly buffers = new Map<string, MarketTick[]>();
  private readonly lastEmittedTs = new Map<string, number>();
  private readonly flushDelayMs: number;
  private readonly maxGapMs: number;

  constructor(opts: { flushDelayMs?: number; maxGapMs?: number } = {}) {
    this.flushDelayMs = opts.flushDelayMs ?? 2_000;
    this.maxGapMs = opts.maxGapMs ?? 10_000;
  }

  /**
   * Accept a tick.  Returns a (possibly empty) list of ticks to emit now,
   * in ascending timestamp order.
   */
  push(tick: MarketTick): MarketTick[] {
    const sym = tick.symbol;
    if (!this.buffers.has(sym)) this.buffers.set(sym, []);
    const buf = this.buffers.get(sym)!;
    const lastTs = this.lastEmittedTs.get(sym) ?? 0;

    if (tick.ts < lastTs) {
      // Tick is behind already-emitted timestamp — drop it
      console.warn(
        `[market-data] out-of-order tick dropped for ${sym}: ts=${tick.ts} < lastEmitted=${lastTs}`,
      );
      return [];
    }

    buf.push(tick);
    buf.sort((a, b) => a.ts - b.ts);

    const now = Date.now();
    const toEmit: MarketTick[] = [];

    while (buf.length > 0) {
      const head = buf[0]!;

      // Force flush when the gap from head to now exceeds maxGapMs
      const forceFlush = now - head.ts > this.maxGapMs;
      // Flush when the head is the globally earliest item and the delay has passed
      const delayFlush = buf.length === 1 && now - head.ts >= this.flushDelayMs;
      // Always emit in-order ticks immediately (head.ts >= lastEmitted)
      const inOrder = head.ts >= lastTs;

      if (forceFlush) {
        console.warn(
          `[market-data] force-flushing out-of-order buffer for ${sym}: head.ts=${head.ts}, gap=${now - head.ts}ms`,
        );
      }

      if (inOrder && (forceFlush || delayFlush || buf.length > 1)) {
        buf.shift();
        this.lastEmittedTs.set(sym, head.ts);
        toEmit.push(head);
      } else if (inOrder && buf.length === 1 && now - head.ts < this.flushDelayMs) {
        // Single tick still within hold window — defer
        break;
      } else {
        break;
      }
    }

    return toEmit;
  }

  /** Force-flush all buffered ticks for a symbol (e.g. on stream reconnect). */
  flushAll(symbol: string): MarketTick[] {
    const buf = this.buffers.get(symbol) ?? [];
    this.buffers.set(symbol, []);
    buf.sort((a, b) => a.ts - b.ts);
    if (buf.length > 0) {
      this.lastEmittedTs.set(symbol, buf[buf.length - 1]!.ts);
    }
    return buf;
  }

  reset(symbol?: string): void {
    if (symbol) {
      this.buffers.delete(symbol);
      this.lastEmittedTs.delete(symbol);
    } else {
      this.buffers.clear();
      this.lastEmittedTs.clear();
    }
  }
}

// ─── Scenario 7: Provider failover / price-divergence ────────────────────────

export interface ProviderPrice {
  provider: string;
  symbol: string;
  price: number;
  ts: number;
}

export interface DivergenceResult {
  diverged: boolean;
  pctDiff: number;
  primary: ProviderPrice;
  secondary: ProviderPrice;
  chosen: ProviderPrice;
  reason: string;
}

/**
 * Compare the primary and secondary provider prices for `symbol`.
 * When the percentage difference exceeds `thresholdPct`:
 *  - Logs a structured warning with both prices.
 *  - Returns `diverged: true` with the chosen price (primary wins by default;
 *    secondary wins when primary tick is stale and secondary is fresh).
 *
 * Callers should treat `diverged: true` as a soft signal to log and monitor,
 * but not to block the trade — we don't want a provider disagreement to
 * prevent EOD square-off.
 */
export function checkProviderDivergence(
  primary: ProviderPrice,
  secondary: ProviderPrice,
  opts: {
    thresholdPct?: number;
    staleMs?: number;
  } = {},
): DivergenceResult {
  const thresholdPct = opts.thresholdPct ?? 0.5; // 0.5% default
  const staleMs = opts.staleMs ?? 30_000;

  const pctDiff =
    Math.abs(primary.price - secondary.price) /
    (Math.max(primary.price, secondary.price) || 1) *
    100;

  const now = Date.now();
  const primaryStale = now - primary.ts > staleMs;
  const secondaryStale = now - secondary.ts > staleMs;

  if (pctDiff <= thresholdPct) {
    // Prices agree — always prefer primary
    return {
      diverged: false,
      pctDiff,
      primary,
      secondary,
      chosen: primary,
      reason: "prices_agree",
    };
  }

  // Prices diverge — log and decide
  const base: Omit<DivergenceResult, "chosen" | "reason"> = {
    diverged: true,
    pctDiff,
    primary,
    secondary,
  };

  console.error("[market-data] provider price divergence detected", {
    symbol: primary.symbol,
    primaryPrice: primary.price,
    secondaryPrice: secondary.price,
    pctDiff: pctDiff.toFixed(3),
    primaryStale,
    secondaryStale,
  });

  if (!primaryStale && secondaryStale) {
    return { ...base, chosen: primary, reason: "secondary_stale" };
  }
  if (primaryStale && !secondaryStale) {
    return { ...base, chosen: secondary, reason: "primary_stale_secondary_fresh" };
  }
  if (primaryStale && secondaryStale) {
    // Both stale — this is a bigger problem; prefer primary but flag loudly
    console.error("[market-data] BOTH providers returning stale prices — potential feed outage", {
      symbol: primary.symbol,
    });
    return { ...base, chosen: primary, reason: "both_stale_fallback_primary" };
  }

  // Both fresh, prices diverge — primary wins (it is the configured source of truth)
  return { ...base, chosen: primary, reason: "primary_wins_divergence" };
}
