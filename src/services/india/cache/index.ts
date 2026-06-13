// Unified cache facade for the Indian-market surface. Every server module
// that wants caching imports `cache` from here; it transparently uses Redis
// when REDIS_URL is set, otherwise the in-process Memory backend.
//
// To keep latency-sensitive paths resilient, the Redis backend is wrapped
// in a "fallback" backend that:
//   1. Tries Redis first (so multiple Next.js workers share state).
//   2. On miss / Redis hiccup, also writes to a tiny memory mirror.
//   3. Reads from memory if Redis is unreachable at the moment.
//
// This means a degraded Redis never blocks the dashboard.

import type { CacheBackend } from "./backend";
import { memoryBackend } from "./memory";
import { redisBackend, redisConfigured } from "./redis";

class FallbackBackend implements CacheBackend {
  readonly id: "memory" | "redis";
  constructor(
    private primary: CacheBackend,
    private mirror: CacheBackend,
  ) {
    this.id = primary.id;
  }
  async get<T>(key: string): Promise<T | undefined> {
    const hit = await this.primary.get<T>(key);
    if (hit !== undefined) return hit;
    return this.mirror.get<T>(key);
  }
  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    await Promise.all([
      this.primary.set(key, value, ttlMs),
      this.mirror.set(key, value, ttlMs),
    ]);
  }
  async invalidate(key: string): Promise<void> {
    await Promise.all([
      this.primary.invalidate(key),
      this.mirror.invalidate(key),
    ]);
  }
  async clear(): Promise<void> {
    await Promise.all([this.primary.clear(), this.mirror.clear()]);
  }
  async dispose(): Promise<void> {
    await this.primary.dispose?.();
    await this.mirror.dispose?.();
  }
}

class TtlCache {
  constructor(private backend: CacheBackend) {}

  /** Backend identifier — handy in /api/health responses. */
  get backendId(): "memory" | "redis" {
    return this.backend.id;
  }

  async get<T>(key: string): Promise<T | undefined> {
    return this.backend.get<T>(key);
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    return this.backend.set(key, value, ttlMs);
  }

  /**
   * Memoise an async loader behind a TTL. Single source of truth used by
   * every adapter (Yahoo, NSE, Scanner) — change the cache strategy here
   * and the whole app picks it up.
   *
   * Concurrent calls for the same key share one in-flight promise so we
   * never hit upstream twice for the same miss (request coalescing).
   */
  async memo<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
    const hit = await this.backend.get<T>(key);
    if (hit !== undefined) return hit;

    let pending = inflight.get(key) as Promise<T> | undefined;
    if (!pending) {
      pending = (async () => {
        try {
          const value = await loader();
          await this.backend.set(key, value, ttlMs);
          return value;
        } finally {
          inflight.delete(key);
        }
      })();
      inflight.set(key, pending);
    }
    return pending;
  }

  async invalidate(key: string): Promise<void> {
    return this.backend.invalidate(key);
  }

  async clear(): Promise<void> {
    return this.backend.clear();
  }
}

declare global {
   
  var __indiaCacheInflight: Map<string, Promise<unknown>> | undefined;
   
  var __indiaCacheInstance: TtlCache | undefined;
}
const inflight =
  globalThis.__indiaCacheInflight ?? new Map<string, Promise<unknown>>();
if (!globalThis.__indiaCacheInflight) globalThis.__indiaCacheInflight = inflight;

function pickBackend(): CacheBackend {
  if (redisConfigured()) {
    console.log(`[india-cache] using Redis backend (REDIS_URL set)`);
    return new FallbackBackend(redisBackend, memoryBackend);
  }
  console.log(`[india-cache] using in-memory backend`);
  return memoryBackend;
}

export const cache: TtlCache =
  globalThis.__indiaCacheInstance ?? new TtlCache(pickBackend());
if (!globalThis.__indiaCacheInstance) globalThis.__indiaCacheInstance = cache;

export type { CacheBackend } from "./backend";
