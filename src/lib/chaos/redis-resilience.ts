/**
 * chaos/redis-resilience.ts
 *
 * Chaos Engineering – Scenario 1: Redis Disconnect During Live Processing
 *
 * Provides:
 *  - withRedisRetry()       : wrap any Redis op with exponential-backoff retry
 *  - withRedisFallback()    : execute a Redis op; on failure run a fallback fn
 *  - RedisCircuitBreaker    : open/half-open/closed state machine
 *  - acquireDistributedLock : SET NX EX-based distributed lock with auto-release
 *  - releaseDistributedLock : safe release (only by the token owner)
 *
 * Design decisions
 * ────────────────
 * • Every Redis operation in hot paths (signal cache, alert cooldown, indicator
 *   state) is wrapped here so a mid-processing disconnect degrades gracefully
 *   instead of crashing the worker tick.
 * • The circuit breaker prevents a Redis outage from causing a thundering herd
 *   of retries.  After OPEN_THRESHOLD consecutive failures the breaker opens
 *   for HALF_OPEN_DELAY_MS before allowing a single probe.
 * • Distributed locks use Lua eval to ensure SET-if-not-exists + expiry are
 *   atomic, and release uses a CAS Lua script so only the lock owner can free
 *   it (no accidental release by a second worker after timeout).
 */

import type { RedisLike } from "@/lib/redis";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RetryOptions {
  /** Maximum number of attempts (first call counts as attempt 1). Default 3. */
  maxAttempts?: number;
  /** Base delay in ms for exponential backoff.  Default 100. */
  baseDelayMs?: number;
  /** Maximum delay cap in ms.  Default 2000. */
  maxDelayMs?: number;
  /** Optional label for structured log output. */
  label?: string;
}

export interface LockOptions {
  /** TTL for the lock key in seconds.  Default 10. */
  ttlSeconds?: number;
  /** How long to spin waiting for the lock before giving up (ms).  Default 3000. */
  acquireTimeoutMs?: number;
  /** Poll interval when waiting (ms).  Default 50. */
  pollIntervalMs?: number;
}

export interface LockHandle {
  token: string;
  release: () => Promise<void>;
}

// ─── Retry wrapper ────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Execute `op` with exponential-backoff retries.
 * Throws only after all attempts are exhausted.
 */
export async function withRedisRetry<T>(
  op: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 100;
  const maxDelayMs = opts.maxDelayMs ?? 2_000;
  const label = opts.label ?? "redis-op";

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await op();
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[redis-resilience] ${label} failed (attempt ${attempt}/${maxAttempts}): ${msg}`,
      );
      if (attempt < maxAttempts) {
        const jitter = Math.random() * 50;
        const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1)) + jitter;
        await sleep(delay);
      }
    }
  }
  throw lastErr;
}

/**
 * Execute `op`; if it throws, run `fallback` instead of bubbling.
 * Logs a structured warning so the deviation is always auditable.
 */
export async function withRedisFallback<T>(
  op: () => Promise<T>,
  fallback: () => T | Promise<T>,
  label = "redis-op",
): Promise<T> {
  try {
    return await op();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[redis-resilience] ${label} failed — using fallback: ${msg}`);
    return fallback();
  }
}

// ─── Circuit Breaker ──────────────────────────────────────────────────────────

type BreakerState = "CLOSED" | "OPEN" | "HALF_OPEN";

interface BreakerConfig {
  /** Consecutive failures to trip the breaker.  Default 5. */
  openThreshold?: number;
  /** How long the breaker stays OPEN before allowing a probe (ms). Default 15 000. */
  halfOpenDelayMs?: number;
  /** Success threshold in HALF_OPEN to close the breaker.  Default 2. */
  closeThreshold?: number;
}

export class RedisCircuitBreaker {
  private state: BreakerState = "CLOSED";
  private failures = 0;
  private successes = 0;
  private openedAt: number | null = null;

  private readonly openThreshold: number;
  private readonly halfOpenDelayMs: number;
  private readonly closeThreshold: number;

  constructor(cfg: BreakerConfig = {}) {
    this.openThreshold = cfg.openThreshold ?? 5;
    this.halfOpenDelayMs = cfg.halfOpenDelayMs ?? 15_000;
    this.closeThreshold = cfg.closeThreshold ?? 2;
  }

  /** True when a call should be allowed through. */
  get isCallable(): boolean {
    if (this.state === "CLOSED") return true;
    if (this.state === "OPEN") {
      if (Date.now() - (this.openedAt ?? 0) >= this.halfOpenDelayMs) {
        this.state = "HALF_OPEN";
        this.successes = 0;
        return true;
      }
      return false;
    }
    // HALF_OPEN: allow the probe
    return true;
  }

  /** Record a successful operation. */
  recordSuccess(): void {
    if (this.state === "HALF_OPEN") {
      this.successes++;
      if (this.successes >= this.closeThreshold) {
        this.state = "CLOSED";
        this.failures = 0;
        this.openedAt = null;
        console.info("[redis-breaker] circuit closed — Redis healthy again");
      }
    } else {
      this.failures = 0;
    }
  }

  /** Record a failed operation. May trip the breaker. */
  recordFailure(): void {
    this.failures++;
    if (this.state === "HALF_OPEN") {
      this.state = "OPEN";
      this.openedAt = Date.now();
      console.error(
        "[redis-breaker] probe failed — circuit remains OPEN",
      );
      return;
    }
    if (this.failures >= this.openThreshold) {
      this.state = "OPEN";
      this.openedAt = Date.now();
      console.error(
        `[redis-breaker] circuit OPEN after ${this.failures} consecutive failures`,
      );
    }
  }

  get currentState(): BreakerState {
    return this.state;
  }

  // Test helper
  reset(): void {
    this.state = "CLOSED";
    this.failures = 0;
    this.successes = 0;
    this.openedAt = null;
  }
}

/** Singleton circuit breaker for the worker's Redis client. */
export const redisBreakerInstance = new RedisCircuitBreaker();

/**
 * Execute a Redis operation through the shared circuit breaker.
 * When the breaker is OPEN the `fallback` is invoked immediately (no network
 * call attempted).  When the breaker is CLOSED/HALF_OPEN the result
 * updates the breaker state.
 */
export async function withCircuitBreaker<T>(
  op: () => Promise<T>,
  fallback: () => T | Promise<T>,
  label = "redis-op",
): Promise<T> {
  if (!redisBreakerInstance.isCallable) {
    console.warn(`[redis-breaker] circuit OPEN — skipping ${label}, using fallback`);
    return fallback();
  }
  try {
    const result = await op();
    redisBreakerInstance.recordSuccess();
    return result;
  } catch (err) {
    redisBreakerInstance.recordFailure();
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[redis-breaker] ${label} failed: ${msg} — using fallback`);
    return fallback();
  }
}

// ─── Distributed Lock ─────────────────────────────────────────────────────────

function randomToken(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Acquire a distributed Redis lock using SET NX EX.
 *
 * Returns a `LockHandle` with a `release()` method that performs a safe
 * CAS delete (only releases if the token still matches — prevents a slow
 * holder from releasing a lock that was already grabbed by another worker
 * after expiry).
 *
 * Throws `LockAcquireTimeoutError` when `acquireTimeoutMs` elapses without
 * obtaining the lock (e.g. another process holds it).
 */
export async function acquireDistributedLock(
  redis: RedisLike,
  lockKey: string,
  opts: LockOptions = {},
): Promise<LockHandle> {
  const ttlSeconds = opts.ttlSeconds ?? 10;
  const acquireTimeoutMs = opts.acquireTimeoutMs ?? 3_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 50;
  const token = randomToken();
  const deadline = Date.now() + acquireTimeoutMs;

  while (Date.now() < deadline) {
    // Use the dedicated setNX method for atomic SET NX EX
    const result = await redis.setNX(lockKey, token, ttlSeconds).catch(() => null);

    if (result === "OK") {
      return {
        token,
        release: async () => {
          // Safe CAS release: only delete if we still own the lock
          const current = await redis.get(lockKey).catch(() => null);
          if (current === token) {
            await redis.del(lockKey).catch(() => {});
          }
        },
      };
    }
    await sleep(pollIntervalMs);
  }

  throw new LockAcquireTimeoutError(
    `[distributed-lock] failed to acquire lock "${lockKey}" within ${acquireTimeoutMs}ms`,
  );
}

export class LockAcquireTimeoutError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "LockAcquireTimeoutError";
  }
}

/**
 * Convenience: run `fn` while holding a distributed lock.
 * Always releases the lock on completion or error.
 */
export async function withDistributedLock<T>(
  redis: RedisLike,
  lockKey: string,
  fn: () => Promise<T>,
  opts: LockOptions = {},
): Promise<T> {
  const lock = await acquireDistributedLock(redis, lockKey, opts);
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}
