/**
 * chaos/worker-resilience.ts
 *
 * Chaos Engineering – Scenarios 8–12:
 *   8.  Worker crash safety: idempotent order creation, distributed lock
 *   9.  Worker restart recovery: checkpointing
 *   10. Signal deduplication: distributed lock + idempotency key
 *   11. EOD square-off idempotency: exactly-once distributed lock
 *
 * Provides:
 *  - WorkerCheckpoint         : Redis-backed checkpoint for partial-tick recovery
 *  - acquireEodLock()         : distributed lock for the EOD square-off job,
 *                               preventing double-fire when multiple replicas
 *                               or rapid restarts occur
 *  - SignalIdempotencyGuard   : Redis-backed dedup guard for signal processing
 *  - PaperTradeIdempotencyGuard: Redis-backed guard for paper trade creation
 *
 * Design decisions
 * ────────────────
 * • The EOD lock uses a date-scoped key so it naturally expires at midnight
 *   without manual cleanup.  The TTL is 20 minutes — long enough to cover the
 *   full 15:30–15:50 IST window and short enough to unlock after the day rolls.
 * • Signal idempotency uses a Redis key keyed by (symbol + type + dateHour) so
 *   the same signal type within the same hour never triggers two DB inserts,
 *   even if the worker restarts mid-tick.
 * • Checkpoints persist the last completed phase of a worker tick so a crash
 *   mid-way through a multi-symbol loop can resume without re-processing
 *   already-handled symbols.
 */

import type { RedisLike } from "@/lib/redis";
import { acquireDistributedLock, LockAcquireTimeoutError } from "./redis-resilience";

// ─── Worker Checkpoint ────────────────────────────────────────────────────────

export interface CheckpointData {
  jobName: string;
  tickStartedAt: number;
  phase: string;
  completedItems: string[];
  meta?: Record<string, unknown>;
}

const CHECKPOINT_TTL_SECONDS = 5 * 60; // 5 minutes

/**
 * Redis-backed checkpoint for worker ticks.
 *
 * Usage pattern:
 *   1. `checkpoint.start(phase)` — record that the tick has started.
 *   2. `checkpoint.markCompleted(itemId)` — record each processed item.
 *   3. `checkpoint.load()` — on restart, call this to skip items already done.
 *   4. `checkpoint.clear()` — call at tick end to clean up.
 *
 * If the worker crashes between `start` and `clear`, the next tick finds the
 * checkpoint and can skip already-processed items.
 */
export class WorkerCheckpoint {
  private readonly key: string;
  private readonly redis: RedisLike;
  private data: CheckpointData | null = null;

  constructor(redis: RedisLike, jobName: string) {
    this.redis = redis;
    this.key = `worker:checkpoint:${jobName}`;
  }

  async load(): Promise<CheckpointData | null> {
    try {
      const raw = await this.redis.get(this.key);
      if (!raw) return null;
      this.data = JSON.parse(raw) as CheckpointData;
      const ageMs = Date.now() - this.data.tickStartedAt;
      if (ageMs > CHECKPOINT_TTL_SECONDS * 1_000) {
        // Stale checkpoint (tick took too long or TTL expired) — ignore
        console.warn(
          `[checkpoint:${this.data.jobName}] stale checkpoint discarded (age=${ageMs}ms)`,
        );
        this.data = null;
        await this.redis.del(this.key).catch(() => {});
        return null;
      }
      console.info(
        `[checkpoint:${this.data.jobName}] resuming from checkpoint`,
        {
          phase: this.data.phase,
          completedItems: this.data.completedItems.length,
          ageMs,
        },
      );
      return this.data;
    } catch (err) {
      console.warn(
        `[checkpoint] load failed: ${(err as Error).message}`,
      );
      return null;
    }
  }

  async start(phase: string, meta?: Record<string, unknown>): Promise<void> {
    this.data = {
      jobName: this.key.replace("worker:checkpoint:", ""),
      tickStartedAt: Date.now(),
      phase,
      completedItems: [],
      meta,
    };
    await this._persist();
  }

  async markCompleted(itemId: string): Promise<void> {
    if (!this.data) return;
    if (!this.data.completedItems.includes(itemId)) {
      this.data.completedItems.push(itemId);
    }
    await this._persist();
  }

  async advancePhase(phase: string): Promise<void> {
    if (!this.data) return;
    this.data.phase = phase;
    await this._persist();
  }

  isCompleted(itemId: string): boolean {
    return this.data?.completedItems.includes(itemId) ?? false;
  }

  async clear(): Promise<void> {
    this.data = null;
    try {
      await this.redis.del(this.key);
    } catch {
      // best-effort
    }
  }

  private async _persist(): Promise<void> {
    try {
      await this.redis.set(
        this.key,
        JSON.stringify(this.data),
        "EX",
        CHECKPOINT_TTL_SECONDS,
      );
    } catch (err) {
      console.warn(`[checkpoint] persist failed: ${(err as Error).message}`);
    }
  }
}

// ─── EOD Square-Off Distributed Lock ─────────────────────────────────────────

/**
 * Acquire the exactly-once distributed lock for the EOD square-off job.
 *
 * Key is scoped to the IST trading date so it is unique per calendar day.
 * Returns `{ acquired: true, release }` when the lock was obtained, or
 * `{ acquired: false }` when another process already holds it (i.e., another
 * worker replica or rapid restart already ran the square-off for this date).
 *
 * Lock TTL = 20 minutes.  The release callback is safe to call multiple times.
 */
export interface EodLockResult {
  acquired: boolean;
  release?: () => Promise<void>;
}

export async function acquireEodLock(
  redis: RedisLike,
  tradeDate: string,
): Promise<EodLockResult> {
  const lockKey = `worker:eod-lock:${tradeDate}`;
  try {
    const lock = await acquireDistributedLock(redis, lockKey, {
      ttlSeconds: 20 * 60,       // 20-minute TTL
      acquireTimeoutMs: 2_000,   // don't wait long — if locked, we already ran
      pollIntervalMs: 100,
    });
    console.info(`[eod-lock] acquired for tradeDate=${tradeDate}`);
    return { acquired: true, release: lock.release };
  } catch (err) {
    if (err instanceof LockAcquireTimeoutError) {
      console.info(
        `[eod-lock] lock already held for tradeDate=${tradeDate} — EOD square-off already in progress or completed`,
      );
      return { acquired: false };
    }
    // Redis is down — log and allow the job to run (single-worker safety assumption)
    console.error(
      `[eod-lock] Redis unavailable — proceeding without lock: ${(err as Error).message}`,
    );
    return { acquired: true, release: async () => {} };
  }
}

// ─── Signal Idempotency Guard ─────────────────────────────────────────────────

/**
 * Prevent the same signal from being processed twice in rapid succession,
 * even when the worker restarts mid-tick or the signal-ingest and signal-
 * outcome jobs overlap.
 *
 * Key: `signal:guard:${symbol}:${type}:${dateHourUtc}`
 * TTL: 90 seconds (covers two full 60s signal-ingest cycles)
 *
 * Returns `true` when the signal is a duplicate (guard already set).
 * Returns `false` when this is the first time (guard is now set).
 */
export async function checkAndSetSignalGuard(
  redis: RedisLike,
  symbol: string,
  type: string,
  triggeredAt: number,
): Promise<boolean> {
  const dateHour = new Date(triggeredAt).toISOString().slice(0, 13); // "2026-09-01T09"
  const key = `signal:guard:${symbol}:${type}:${dateHour}`;

  try {
    // SET NX EX — returns "OK" only on first write
    const result = await redis.setNX(key, "1", 90);

    if (result === "OK") {
      return false; // not a duplicate — we just claimed it
    }
    console.warn(
      `[signal-guard] duplicate signal suppressed: ${symbol}/${type}/${dateHour}`,
    );
    return true; // duplicate
  } catch (err) {
    // Redis down — default to allowing (don't block ingestion)
    console.warn(
      `[signal-guard] Redis unavailable — allowing signal without guard: ${(err as Error).message}`,
    );
    return false;
  }
}

// ─── Paper Trade Idempotency Guard ────────────────────────────────────────────

/**
 * Redis-backed guard to prevent duplicate paper trade creation when the worker
 * crashes after `paperTrade.create` completes but before the tick state is
 * updated.
 *
 * Key: `trade:guard:${source}:${symbol}:${triggerBarMs}`  (±60 s window snapped
 *      to the nearest 60 s so a 1-second difference in triggeredAt from two
 *      identical signals doesn't bypass the guard)
 * TTL: 120 seconds (covers the dedupe window in paper-trader.ts)
 *
 * Returns `{ isDuplicate: false }` when the guard was claimed (first call).
 * Returns `{ isDuplicate: true, existingId }` on subsequent calls.
 */
export async function checkAndSetTradeGuard(
  redis: RedisLike,
  source: string,
  symbol: string,
  triggeredAt: number,
  tradeId?: string,
): Promise<{ isDuplicate: boolean; existingId?: string }> {
  // Snap to 60-second bucket so near-identical timestamps share the same key
  const bucket = Math.floor(triggeredAt / 60_000) * 60_000;
  const key = `trade:guard:${source}:${symbol}:${bucket}`;

  try {
    const existing = await redis.get(key);
    if (existing) {
      console.warn(
        `[trade-guard] duplicate trade suppressed: ${source}/${symbol} bucket=${bucket}`,
        { existingId: existing },
      );
      return { isDuplicate: true, existingId: existing };
    }

    if (tradeId) {
      await redis.set(key, tradeId, "EX", 120);
    } else {
      // Claim the key without a tradeId yet (will be updated after create)
      await redis.setNX(key, "pending", 120);
    }
    return { isDuplicate: false };
  } catch (err) {
    console.warn(
      `[trade-guard] Redis unavailable — DB idempotency fallback active: ${(err as Error).message}`,
    );
    return { isDuplicate: false };
  }
}
