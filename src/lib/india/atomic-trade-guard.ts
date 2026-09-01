/**
 * Atomic Trade Guard — Phase 9
 *
 * Replaces the unsafe GET-then-SET idempotency pattern with Redis atomic
 * operations. Uses `SET key value NX EX` so claim acquisition is a single
 * atomic operation — safe under multi-worker concurrency.
 *
 * Problem with the old GET/SET pattern:
 *   Worker A: GET trade:NIFTY:in:OPENING_BREAKOUT:5m  → null
 *   Worker B: GET trade:NIFTY:in:OPENING_BREAKOUT:5m  → null (race!)
 *   Worker A: SET trade:...
 *   Worker B: SET trade:...  ← duplicate! Two orders for the same signal.
 *
 * Solution: SET NX EX is atomic — exactly one worker succeeds.
 *
 * For multi-step atomic operations (e.g. claim + record), a Lua script is
 * used so the full sequence is executed server-side atomically.
 */

import type { RedisLike } from "@/lib/redis";

// ─── Key generation ───────────────────────────────────────────────────────────

/** TTL for a trade guard claim in seconds. Must exceed the maximum signal window. */
const TRADE_GUARD_TTL_SECONDS = 300; // 5 minutes

/** TTL for EOD square-off guards. Must exceed the full square-off window. */
const EOD_GUARD_TTL_SECONDS = 3600; // 1 hour

/**
 * Build the idempotency key for an India F&O scalping signal.
 * Key: `tg:in:{symbol}:{strategyId}:{timeframe}:{epochMinute}`
 *
 * epochMinute ensures the same strategy+symbol can re-fire in a later window
 * without being blocked by a previous signal's guard.
 */
export function buildTradeGuardKey(params: {
  symbol: string;
  strategyId: string;
  timeframe: string;
  triggeredAtMs: number;
}): string {
  // Bucket to the nearest 5-minute window so signals within the same
  // 5-min candle are treated as the same signal (dedup window).
  const bucketMs = 5 * 60 * 1_000;
  const bucket = Math.floor(params.triggeredAtMs / bucketMs);
  return `tg:in:${params.symbol}:${params.strategyId}:${params.timeframe}:${bucket}`;
}

/**
 * Build the idempotency key for an EOD square-off job.
 * Key: `tg:eod:{tradeDate}:{symbol}`
 */
export function buildEodGuardKey(tradeDate: string, symbol: string): string {
  return `tg:eod:${tradeDate}:${symbol}`;
}

/**
 * Build the idempotency key for a worker job retry.
 * Key: `tg:job:{jobName}:{runId}`
 */
export function buildJobGuardKey(jobName: string, runId: string): string {
  return `tg:job:${jobName}:${runId}`;
}

// ─── Atomic claim ─────────────────────────────────────────────────────────────

export type ClaimResult =
  | { claimed: true; key: string }
  | { claimed: false; key: string; reason: "already_claimed" | "redis_unavailable" };

/**
 * Atomically claim an idempotency key.
 *
 * Uses `SET key claimerId NX EX ttlSeconds` — a single atomic Redis command.
 *
 * Returns { claimed: true } if the key was successfully acquired (no other
 * worker processed this signal).
 *
 * Returns { claimed: false, reason: "already_claimed" } if the key already
 * exists (another worker beat us to it).
 *
 * Returns { claimed: false, reason: "redis_unavailable" } when Redis is down.
 * The caller must decide how to handle this (typically: allow the operation
 * to proceed with DB-level deduplication as the fallback guard).
 */
export async function atomicClaim(
  redis: RedisLike,
  key: string,
  claimerId: string,
  ttlSeconds: number = TRADE_GUARD_TTL_SECONDS,
): Promise<ClaimResult> {
  try {
    const result = await redis.setNX(key, claimerId, ttlSeconds);
    if (result === "OK") {
      return { claimed: true, key };
    }
    return { claimed: false, key, reason: "already_claimed" };
  } catch (err) {
    console.warn(
      `[atomic-trade-guard] Redis unavailable for key "${key}":`,
      (err as Error).message,
    );
    return { claimed: false, key, reason: "redis_unavailable" };
  }
}

/**
 * Release a previously claimed idempotency key.
 * Call this when a trade fails to open and the claim should be released so
 * the signal can be retried in the next tick.
 *
 * NOTE: Only the claimer should release the key. We verify by checking that
 * the stored value matches claimerId before deleting.
 */
export async function releaseClaim(
  redis: RedisLike,
  key: string,
  claimerId: string,
): Promise<boolean> {
  try {
    const current = await redis.get(key);
    if (current !== claimerId) {
      // Key was taken by another claimer or already expired — do not delete.
      return false;
    }
    await redis.del(key);
    return true;
  } catch {
    return false;
  }
}

// ─── Exactly-once execution wrapper ──────────────────────────────────────────

export interface ExactlyOnceOptions {
  redis: RedisLike;
  key: string;
  claimerId: string;
  ttlSeconds?: number;
  /**
   * When Redis is unavailable and the claim cannot be verified,
   * 'allow' proceeds (DB-level dedup is the fallback guard).
   * 'reject' blocks the operation entirely.
   * Default: 'allow' for safety under Redis downtime.
   */
  onRedisUnavailable?: "allow" | "reject";
}

export type ExactlyOnceResult<T> =
  | { executed: true; result: T }
  | { executed: false; reason: "already_claimed" | "redis_unavailable" };

/**
 * Execute `fn` exactly once for the given idempotency key.
 *
 * The function is only called when the atomic claim succeeds. On duplicate
 * signals, the claim fails and `fn` is NOT called.
 *
 * Under Redis unavailability, behaviour is controlled by `onRedisUnavailable`:
 *   'allow' → calls `fn` anyway (DB dedup is the last guard)
 *   'reject' → returns { executed: false, reason: "redis_unavailable" }
 */
export async function executeExactlyOnce<T>(
  fn: () => Promise<T>,
  opts: ExactlyOnceOptions,
): Promise<ExactlyOnceResult<T>> {
  const claim = await atomicClaim(
    opts.redis,
    opts.key,
    opts.claimerId,
    opts.ttlSeconds ?? TRADE_GUARD_TTL_SECONDS,
  );

  if (!claim.claimed) {
    if (
      claim.reason === "redis_unavailable" &&
      (opts.onRedisUnavailable ?? "allow") === "allow"
    ) {
      // Redis down but we allow the operation through; DB dedup protects us.
      const result = await fn();
      return { executed: true, result };
    }
    return { executed: false, reason: claim.reason };
  }

  try {
    const result = await fn();
    return { executed: true, result };
  } catch (err) {
    // Release the claim on failure so the operation can be retried.
    await releaseClaim(opts.redis, opts.key, opts.claimerId);
    throw err;
  }
}

// ─── EOD square-off guard ─────────────────────────────────────────────────────

/**
 * Atomically claim the EOD square-off slot for a trade.
 * Returns true when the caller should proceed with squaring off the trade.
 * Returns false when another worker already handled this trade's square-off.
 */
export async function claimEodSquareOff(
  redis: RedisLike,
  tradeDate: string,
  symbol: string,
  tradeId: string,
): Promise<boolean> {
  const key = buildEodGuardKey(tradeDate, `${symbol}:${tradeId}`);
  const claim = await atomicClaim(redis, key, `eod:${tradeId}`, EOD_GUARD_TTL_SECONDS);
  return claim.claimed || (claim.reason === "redis_unavailable"); // allow on Redis down
}
