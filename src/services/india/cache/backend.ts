// Cache backend contract. Both `MemoryBackend` and `RedisBackend` implement
// this — the `TtlCache` wrapper in `index.ts` owns the `memo` helper and is
// agnostic to where values actually live.

export interface CacheBackend {
  /** Backend identifier (used in logs). */
  readonly id: "memory" | "redis";

  /** Returns `undefined` for misses or expired entries. */
  get<T>(key: string): Promise<T | undefined>;

  /** Stores `value` with a TTL in milliseconds. */
  set<T>(key: string, value: T, ttlMs: number): Promise<void>;

  invalidate(key: string): Promise<void>;
  clear(): Promise<void>;

  /** Optional graceful-shutdown hook (Redis closes its socket here). */
  dispose?(): Promise<void>;
}
