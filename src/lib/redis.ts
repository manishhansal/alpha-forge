import "server-only";

import { Redis } from "ioredis";

import { env } from "@/lib/env";

export interface SortedSetEntry {
  member: string;
  score: number;
}

export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode?: "EX" | "PX", ttl?: number): Promise<unknown>;
  del(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  ping(): Promise<unknown>;
  quit(): Promise<unknown>;

  // Sorted-set ops used by the liquidation rolling buffer and any future
  // time-series-style aggregates.
  zadd(key: string, score: number, member: string): Promise<number>;
  zrangeByScore(key: string, min: number | "-inf", max: number | "+inf"): Promise<string[]>;
  zremRangeByScore(key: string, min: number | "-inf", max: number | "+inf"): Promise<number>;
  zcard(key: string): Promise<number>;
}

interface MemoryEntry {
  value: string;
  expiresAt: number | null;
}

interface MemoryZSet {
  entries: SortedSetEntry[];
  expiresAt: number | null;
}

function numericBound(b: number | "-inf" | "+inf"): number {
  if (b === "-inf") return Number.NEGATIVE_INFINITY;
  if (b === "+inf") return Number.POSITIVE_INFINITY;
  return b;
}

class MemoryRedis implements RedisLike {
  private store = new Map<string, MemoryEntry>();
  private zsets = new Map<string, MemoryZSet>();

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt < Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, mode?: "EX" | "PX", ttl?: number): Promise<"OK"> {
    let expiresAt: number | null = null;
    if (mode === "EX" && typeof ttl === "number") {
      expiresAt = Date.now() + ttl * 1000;
    } else if (mode === "PX" && typeof ttl === "number") {
      expiresAt = Date.now() + ttl;
    }
    this.store.set(key, { value, expiresAt });
    return "OK";
  }

  async del(key: string): Promise<number> {
    const had = this.store.delete(key) || this.zsets.delete(key);
    return had ? 1 : 0;
  }

  async expire(key: string, seconds: number): Promise<number> {
    const entry = this.store.get(key);
    if (entry) {
      entry.expiresAt = Date.now() + seconds * 1000;
      return 1;
    }
    const z = this.zsets.get(key);
    if (z) {
      z.expiresAt = Date.now() + seconds * 1000;
      return 1;
    }
    return 0;
  }

  async ping(): Promise<"PONG"> {
    return "PONG";
  }

  async quit(): Promise<"OK"> {
    this.store.clear();
    this.zsets.clear();
    return "OK";
  }

  private gc(key: string): MemoryZSet | null {
    const z = this.zsets.get(key);
    if (!z) return null;
    if (z.expiresAt !== null && z.expiresAt < Date.now()) {
      this.zsets.delete(key);
      return null;
    }
    return z;
  }

  async zadd(key: string, score: number, member: string): Promise<number> {
    let z = this.gc(key);
    if (!z) {
      z = { entries: [], expiresAt: null };
      this.zsets.set(key, z);
    }
    const existingIdx = z.entries.findIndex((e) => e.member === member);
    if (existingIdx >= 0) {
      z.entries[existingIdx] = { member, score };
      return 0;
    }
    z.entries.push({ member, score });
    return 1;
  }

  async zrangeByScore(
    key: string,
    min: number | "-inf",
    max: number | "+inf",
  ): Promise<string[]> {
    const z = this.gc(key);
    if (!z) return [];
    const lo = numericBound(min);
    const hi = numericBound(max);
    return z.entries
      .filter((e) => e.score >= lo && e.score <= hi)
      .sort((a, b) => a.score - b.score)
      .map((e) => e.member);
  }

  async zremRangeByScore(
    key: string,
    min: number | "-inf",
    max: number | "+inf",
  ): Promise<number> {
    const z = this.gc(key);
    if (!z) return 0;
    const lo = numericBound(min);
    const hi = numericBound(max);
    const before = z.entries.length;
    z.entries = z.entries.filter((e) => e.score < lo || e.score > hi);
    return before - z.entries.length;
  }

  async zcard(key: string): Promise<number> {
    const z = this.gc(key);
    return z ? z.entries.length : 0;
  }
}

export class IoredisAdapter implements RedisLike {
  constructor(private readonly client: Redis) {}

  get(key: string) {
    return this.client.get(key);
  }
  set(key: string, value: string, mode?: "EX" | "PX", ttl?: number) {
    if (mode === "EX" && typeof ttl === "number") {
      return this.client.set(key, value, "EX", ttl);
    }
    if (mode === "PX" && typeof ttl === "number") {
      return this.client.set(key, value, "PX", ttl);
    }
    return this.client.set(key, value);
  }
  del(key: string) {
    return this.client.del(key);
  }
  expire(key: string, seconds: number) {
    return this.client.expire(key, seconds);
  }
  ping() {
    return this.client.ping();
  }
  quit() {
    return this.client.quit();
  }
  zadd(key: string, score: number, member: string) {
    return this.client.zadd(key, score, member);
  }
  async zrangeByScore(key: string, min: number | "-inf", max: number | "+inf") {
    return this.client.zrangebyscore(key, String(min), String(max));
  }
  async zremRangeByScore(key: string, min: number | "-inf", max: number | "+inf") {
    return this.client.zremrangebyscore(key, String(min), String(max));
  }
  zcard(key: string) {
    return this.client.zcard(key);
  }
}

const globalForRedis = globalThis as unknown as { __redis?: RedisLike };

function createClient(): RedisLike {
  if (!env.REDIS_URL) {
    if (env.NODE_ENV !== "production") {
      console.warn("[redis] REDIS_URL not set — using in-memory fallback (dev only)");
    }
    return new MemoryRedis();
  }
  const client = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: 2,
    enableReadyCheck: false,
    lazyConnect: false,
  });
  client.on("error", (err) => {
    console.error("[redis] error:", err.message);
  });
  return new IoredisAdapter(client);
}

export const redis: RedisLike = globalForRedis.__redis ?? createClient();
if (env.NODE_ENV !== "production") globalForRedis.__redis = redis;

export async function cached<T>(
  key: string,
  ttlSeconds: number,
  loader: () => Promise<T>,
): Promise<T> {
  try {
    const hit = await redis.get(key);
    if (hit) return JSON.parse(hit) as T;
  } catch (err) {
    console.warn("[redis] cache read failed:", (err as Error).message);
  }
  const fresh = await loader();
  try {
    await redis.set(key, JSON.stringify(fresh), "EX", ttlSeconds);
  } catch (err) {
    console.warn("[redis] cache write failed:", (err as Error).message);
  }
  return fresh;
}
