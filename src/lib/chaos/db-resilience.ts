/**
 * chaos/db-resilience.ts
 *
 * Chaos Engineering – Scenario 2: PostgreSQL Unavailable During Order Persistence
 *
 * Provides:
 *  - withDbRetry()       : exponential-backoff retry wrapper for Prisma ops
 *  - withDbTransaction() : typed $transaction helper with retry on serialization
 *                          failure (Postgres error code 40001)
 *  - DbDeadLetterQueue   : in-memory (or Redis-backed) dead-letter queue for
 *                          failed DB writes that must not be silently dropped
 *  - isRetryableDbError(): classify Postgres/Prisma errors as retryable
 *
 * Design decisions
 * ────────────────
 * • Paper trade creation and resolution are the two paths where a DB failure
 *   can corrupt position state.  Both are wrapped here.
 * • "Dead-letter" writes are flushed in the next worker tick so a transient
 *   Postgres outage doesn't lose the record — it only delays it.
 * • We do NOT add Prisma.$transaction() to hot paths that are already safe
 *   by idempotency keys (unique constraints); we add it only where multiple
 *   writes must be atomic (e.g. create notification + update alert count).
 */

import type { PrismaClient } from "@prisma/client";

// ─── Error classification ─────────────────────────────────────────────────────

/** Postgres error codes that are safe to retry. */
const RETRYABLE_PG_CODES = new Set([
  "40001", // serialization_failure
  "40P01", // deadlock_detected
  "08006", // connection_failure
  "08001", // sqlclient_unable_to_establish_sqlconnection
  "53300", // too_many_connections
  "57P03", // cannot_connect_now
  "08P01", // protocol_violation (sometimes transient)
]);

export function isRetryableDbError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();

  // Prisma connection errors
  if (
    msg.includes("connection refused") ||
    msg.includes("connection reset") ||
    msg.includes("econnrefused") ||
    msg.includes("econnreset") ||
    msg.includes("socket hang up") ||
    msg.includes("failed to connect") ||
    msg.includes("prisma client") && msg.includes("panic")
  ) {
    return true;
  }

  // Postgres error codes embedded in Prisma error message
  const pgCode = (err as { code?: string }).code;
  if (pgCode && RETRYABLE_PG_CODES.has(pgCode)) return true;

  // Prisma meta.code
  const meta = (err as { meta?: { code?: string } }).meta;
  if (meta?.code && RETRYABLE_PG_CODES.has(meta.code)) return true;

  return false;
}

// ─── Retry wrapper ────────────────────────────────────────────────────────────

export interface DbRetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  label?: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Execute `op` with exponential-backoff retries, but ONLY when the error is
 * classified as retryable. Non-retryable errors (e.g. unique constraint
 * violations) are rethrown immediately.
 */
export async function withDbRetry<T>(
  op: () => Promise<T>,
  opts: DbRetryOptions = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 200;
  const maxDelayMs = opts.maxDelayMs ?? 5_000;
  const label = opts.label ?? "db-op";

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await op();
    } catch (err) {
      lastErr = err;
      if (!isRetryableDbError(err)) {
        // Non-retryable: throw immediately (e.g. unique violation → caller
        // handles as expected idempotency outcome)
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[db-resilience] ${label} retryable error (attempt ${attempt}/${maxAttempts}): ${msg}`,
      );
      if (attempt < maxAttempts) {
        const jitter = Math.random() * 100;
        const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1)) + jitter;
        await sleep(delay);
      }
    }
  }
  throw lastErr;
}

// ─── Transaction helper ───────────────────────────────────────────────────────

export type TransactionFn<T> = (
  tx: Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0],
) => Promise<T>;

/**
 * Run `fn` inside a Prisma interactive transaction with serializable isolation
 * and automatic retry on serialization failures (Postgres 40001).
 *
 * Use this for any multi-write sequence where partial failure would leave
 * inconsistent state (e.g. create notification + update alert triggerCount).
 */
export async function withDbTransaction<T>(
  prisma: PrismaClient,
  fn: TransactionFn<T>,
  opts: DbRetryOptions = {},
): Promise<T> {
  return withDbRetry(
    () =>
      prisma.$transaction(fn, {
        isolationLevel: "Serializable",
        maxWait: 5_000,
        timeout: 10_000,
      }),
    { ...opts, label: opts.label ?? "db-transaction" },
  );
}

// ─── Dead-Letter Queue ────────────────────────────────────────────────────────

export interface DLQEntry<T = unknown> {
  id: string;
  type: string;
  payload: T;
  enqueuedAt: number;
  attempts: number;
  lastError: string;
}

/**
 * In-memory dead-letter queue for DB write failures.
 *
 * When a paper trade create/update fails after all retries, the write
 * descriptor is enqueued here.  The worker's next tick calls `flush()` to
 * drain entries using a supplied retry function.  This ensures:
 *   - No silent data loss on transient Postgres outage.
 *   - No duplicate write: the flush function itself uses idempotent upsert
 *     patterns (unique constraints) so replaying an entry is safe.
 *
 * Entries older than MAX_AGE_MS are dropped with a structured error log
 * so operators can investigate root cause.
 */
export class DbDeadLetterQueue<T = unknown> {
  private readonly queue: DLQEntry<T>[] = [];
  private readonly maxEntries: number;
  private readonly maxAgeMs: number;
  private readonly label: string;

  constructor(opts: { maxEntries?: number; maxAgeMs?: number; label?: string } = {}) {
    this.maxEntries = opts.maxEntries ?? 500;
    this.maxAgeMs = opts.maxAgeMs ?? 30 * 60 * 1_000; // 30 min
    this.label = opts.label ?? "dlq";
  }

  enqueue(type: string, payload: T, error: string): void {
    if (this.queue.length >= this.maxEntries) {
      const dropped = this.queue.shift()!;
      console.error(
        `[${this.label}] queue full — dropped oldest entry`,
        { id: dropped.id, type: dropped.type, enqueuedAt: dropped.enqueuedAt },
      );
    }
    const entry: DLQEntry<T> = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      type,
      payload,
      enqueuedAt: Date.now(),
      attempts: 1,
      lastError: error,
    };
    this.queue.push(entry);
    console.warn(`[${this.label}] enqueued failed write`, {
      id: entry.id,
      type,
      attempts: entry.attempts,
      error,
    });
  }

  get size(): number {
    return this.queue.length;
  }

  /**
   * Attempt to replay all queued entries by calling `replayFn(entry)`.
   * Successful entries are removed; failed entries have their `attempts`
   * counter incremented.  Entries older than `maxAgeMs` are dropped.
   */
  async flush(replayFn: (entry: DLQEntry<T>) => Promise<void>): Promise<void> {
    const now = Date.now();
    const pending = [...this.queue];
    this.queue.length = 0;

    for (const entry of pending) {
      if (now - entry.enqueuedAt > this.maxAgeMs) {
        console.error(`[${this.label}] dropping stale entry (age=${now - entry.enqueuedAt}ms)`, {
          id: entry.id,
          type: entry.type,
          payload: entry.payload,
        });
        continue;
      }
      try {
        await replayFn(entry);
        console.info(`[${this.label}] replayed entry successfully`, { id: entry.id, type: entry.type });
      } catch (err) {
        entry.attempts++;
        entry.lastError = err instanceof Error ? err.message : String(err);
        console.warn(`[${this.label}] replay failed (attempt ${entry.attempts})`, {
          id: entry.id,
          type: entry.type,
          error: entry.lastError,
        });
        this.queue.push(entry);
      }
    }
  }
}

/** Singleton DLQ for paper trade write failures. */
export const paperTradeDLQ = new DbDeadLetterQueue({
  label: "paper-trade-dlq",
  maxEntries: 200,
  maxAgeMs: 60 * 60 * 1_000, // 1 hour (full trading session)
});
