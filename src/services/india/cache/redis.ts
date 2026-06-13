// Redis-backed implementation of CacheBackend. Activates when REDIS_URL is
// set in the environment — keeps the option-chain / historical / scanner
// caches warm across deploys and shared between multiple Next.js instances.
//
// Values are JSON-serialised. Everything we cache today (Quote[], Candle[],
// OptionChain, ScannerResult) round-trips through JSON cleanly.

import type Redis from "ioredis";
import type { CacheBackend } from "./backend";

type LazyRedis = {
  client: Redis | null;
  ready: boolean;
  failed: boolean;
};

// Namespace this cache distinctly from any crypto-side Redis prefix so the
// two markets can coexist in a single shared Redis without colliding.
const KEY_PREFIX =
  process.env.INDIA_REDIS_PREFIX ?? process.env.REDIS_PREFIX ?? "fno-pulse:";

// Lazy singleton across hot reloads.
declare global {
   
  var __indiaRedisCache: LazyRedis | undefined;
}

const state: LazyRedis = globalThis.__indiaRedisCache ?? {
  client: null,
  ready: false,
  failed: false,
};
if (!globalThis.__indiaRedisCache) globalThis.__indiaRedisCache = state;

async function getClient(): Promise<Redis | null> {
  if (state.failed) return null;
  if (state.client && state.ready) return state.client;
  if (state.client && !state.ready) return state.client;

  const url = process.env.REDIS_URL;
  if (!url) {
    state.failed = true;
    return null;
  }

  try {
    const mod = await import("ioredis");
    const RedisCtor = (mod.default ?? mod) as unknown as typeof Redis;

    const client = new RedisCtor(url, {
      lazyConnect: false,
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
    });

    client.on("error", (err: Error) => {
      console.warn(`[india-redis] ${err.message}`);
      state.ready = false;
    });
    client.on("ready", () => {
      state.ready = true;
    });
    client.on("end", () => {
      state.ready = false;
    });

    state.client = client;
    return client;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[india-redis] disabled — ${msg}`);
    state.failed = true;
    return null;
  }
}

class RedisBackend implements CacheBackend {
  readonly id = "redis" as const;

  async get<T>(key: string): Promise<T | undefined> {
    const client = await getClient();
    if (!client || !state.ready) return undefined;
    try {
      const raw = await client.get(KEY_PREFIX + key);
      if (raw == null) return undefined;
      return JSON.parse(raw) as T;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[india-redis] get(${key}) — ${msg}`);
      return undefined;
    }
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    const client = await getClient();
    if (!client || !state.ready) return;
    try {
      await client.set(
        KEY_PREFIX + key,
        JSON.stringify(value),
        "PX",
        Math.max(1, Math.floor(ttlMs)),
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[india-redis] set(${key}) — ${msg}`);
    }
  }

  async invalidate(key: string): Promise<void> {
    const client = await getClient();
    if (!client || !state.ready) return;
    try {
      await client.del(KEY_PREFIX + key);
    } catch {
      // ignore
    }
  }

  async clear(): Promise<void> {
    const client = await getClient();
    if (!client || !state.ready) return;
    try {
      const stream = client.scanStream({ match: `${KEY_PREFIX}*`, count: 200 });
      const pipeline = client.pipeline();
      let queued = 0;
      for await (const keys of stream) {
        for (const k of keys as string[]) {
          pipeline.del(k);
          queued++;
        }
      }
      if (queued > 0) await pipeline.exec();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[india-redis] clear — ${msg}`);
    }
  }

  async dispose(): Promise<void> {
    if (state.client) {
      try {
        await state.client.quit();
      } catch {
        state.client.disconnect();
      }
      state.client = null;
      state.ready = false;
    }
  }
}

export const redisBackend: CacheBackend = new RedisBackend();

/** True when REDIS_URL is set (regardless of current connection health). */
export function redisConfigured(): boolean {
  return Boolean(process.env.REDIS_URL);
}
