// In-process TTL cache. Lives only inside the Node process — gracefully
// resets on redeploy, which is fine for short-lived market data.

import type { CacheBackend } from "./backend";

type Entry<T> = { value: T; expiresAt: number };

class MemoryBackend implements CacheBackend {
  readonly id = "memory" as const;
  private store = new Map<string, Entry<unknown>>();

  async get<T>(key: string): Promise<T | undefined> {
    const e = this.store.get(key);
    if (!e) return undefined;
    if (Date.now() > e.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return e.value as T;
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  async invalidate(key: string): Promise<void> {
    this.store.delete(key);
  }

  async clear(): Promise<void> {
    this.store.clear();
  }
}

// Singleton across hot reloads (Next.js re-imports modules in dev).
declare global {
   
  var __indiaMemoryCache: MemoryBackend | undefined;
}

export const memoryBackend: CacheBackend =
  globalThis.__indiaMemoryCache ?? new MemoryBackend();
if (!globalThis.__indiaMemoryCache)
  globalThis.__indiaMemoryCache = memoryBackend as MemoryBackend;
