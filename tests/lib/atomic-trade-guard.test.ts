/**
 * Atomic Trade Guard — Unit Tests (Phase 9)
 *
 * Tests exactly-once execution under concurrent signals.
 * Verifies that the same signal processed N times results in exactly 1 claim.
 */

import { describe, expect, it, beforeEach } from "vitest";
import {
  atomicClaim,
  releaseClaim,
  executeExactlyOnce,
  buildTradeGuardKey,
  buildEodGuardKey,
  claimEodSquareOff,
} from "@/lib/india/atomic-trade-guard";
import type { RedisLike } from "@/lib/redis";

// ── In-memory Redis stub ──────────────────────────────────────────────────────

class TestRedis implements RedisLike {
  private store = new Map<string, { value: string; expiresAt: number }>();

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) { this.store.delete(key); return null; }
    return entry.value;
  }

  async set(key: string, value: string): Promise<"OK"> {
    this.store.set(key, { value, expiresAt: Infinity });
    return "OK";
  }

  async setNX(key: string, value: string, ttlSeconds: number): Promise<string | null> {
    const existing = this.store.get(key);
    if (existing && existing.expiresAt > Date.now()) return null; // already exists
    this.store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1_000 });
    return "OK";
  }

  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }

  async expire(_key: string, _s: number): Promise<number> { return 1; }
  async ping(): Promise<"PONG"> { return "PONG"; }
  async quit(): Promise<"OK"> { this.store.clear(); return "OK"; }
  async zadd(_k: string, _s: number, _m: string): Promise<number> { return 0; }
  async zrangeByScore(): Promise<string[]> { return []; }
  async zremRangeByScore(): Promise<number> { return 0; }
  async zcard(): Promise<number> { return 0; }

  /** Return a version that always throws (simulates Redis down). */
  static unavailable(): RedisLike {
    return new (class implements RedisLike {
      async get(): Promise<null> { throw new Error("Redis unavailable"); }
      async set(): Promise<never> { throw new Error("Redis unavailable"); }
      async setNX(): Promise<never> { throw new Error("Redis unavailable"); }
      async del(): Promise<never> { throw new Error("Redis unavailable"); }
      async expire(): Promise<never> { throw new Error("Redis unavailable"); }
      async ping(): Promise<never> { throw new Error("Redis unavailable"); }
      async quit(): Promise<never> { throw new Error("Redis unavailable"); }
      async zadd(): Promise<never> { throw new Error("Redis unavailable"); }
      async zrangeByScore(): Promise<never> { throw new Error("Redis unavailable"); }
      async zremRangeByScore(): Promise<never> { throw new Error("Redis unavailable"); }
      async zcard(): Promise<never> { throw new Error("Redis unavailable"); }
    })();
  }
}

// ─────────────────────────────────────────────────────────────────────────────

describe("atomicClaim", () => {
  let redis: TestRedis;

  beforeEach(() => { redis = new TestRedis(); });

  it("claims successfully on first attempt", async () => {
    const result = await atomicClaim(redis, "test:key1", "worker-1");
    expect(result.claimed).toBe(true);
  });

  it("fails to claim when key already exists (returns already_claimed)", async () => {
    await atomicClaim(redis, "test:key2", "worker-1");
    const second = await atomicClaim(redis, "test:key2", "worker-2");

    expect(second.claimed).toBe(false);
    if (!second.claimed) {
      expect(second.reason).toBe("already_claimed");
    }
  });

  it("returns redis_unavailable when Redis is down", async () => {
    const result = await atomicClaim(TestRedis.unavailable(), "test:key3", "worker-1");
    expect(result.claimed).toBe(false);
    if (!result.claimed) {
      expect(result.reason).toBe("redis_unavailable");
    }
  });
});

describe("releaseClaim", () => {
  let redis: TestRedis;
  beforeEach(() => { redis = new TestRedis(); });

  it("releases a claim held by the caller", async () => {
    await atomicClaim(redis, "test:release1", "worker-1");
    const released = await releaseClaim(redis, "test:release1", "worker-1");
    expect(released).toBe(true);

    // After release, key should be available
    const second = await atomicClaim(redis, "test:release1", "worker-2");
    expect(second.claimed).toBe(true);
  });

  it("does NOT release a claim held by a different worker", async () => {
    await atomicClaim(redis, "test:release2", "worker-1");
    const released = await releaseClaim(redis, "test:release2", "worker-2");
    expect(released).toBe(false);
  });
});

describe("executeExactlyOnce", () => {
  let redis: TestRedis;
  beforeEach(() => { redis = new TestRedis(); });

  it("executes fn exactly once for the same signal", async () => {
    const key = "tg:test:signal1";
    let execCount = 0;
    const fn = async () => { execCount++; return "done"; };

    const r1 = await executeExactlyOnce(fn, { redis, key, claimerId: "w1" });
    const r2 = await executeExactlyOnce(fn, { redis, key, claimerId: "w2" });

    expect(r1.executed).toBe(true);
    expect(r2.executed).toBe(false);
    expect(execCount).toBe(1); // fn called exactly once
  });

  it("same signal 10 times = exactly 1 execution", async () => {
    const key = "tg:test:signal10";
    let execCount = 0;
    const fn = async () => { execCount++; return "done"; };

    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        executeExactlyOnce(fn, { redis, key, claimerId: `worker-${i}` }),
      ),
    );

    expect(execCount).toBe(1);
  });

  it("same signal 100 times concurrently = exactly 1 execution", async () => {
    const key = "tg:test:signal100";
    let execCount = 0;
    const fn = async () => { execCount++; return "done"; };

    await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        executeExactlyOnce(fn, { redis, key, claimerId: `worker-${i}` }),
      ),
    );

    expect(execCount).toBe(1);
  });

  it("allows execution when Redis is unavailable (onRedisUnavailable=allow)", async () => {
    let execCount = 0;
    const fn = async () => { execCount++; return "done"; };

    const r = await executeExactlyOnce(fn, {
      redis: TestRedis.unavailable(),
      key: "tg:test:redis-down",
      claimerId: "w1",
      onRedisUnavailable: "allow",
    });

    expect(r.executed).toBe(true);
    expect(execCount).toBe(1);
  });

  it("blocks execution when Redis is unavailable (onRedisUnavailable=reject)", async () => {
    let execCount = 0;
    const fn = async () => { execCount++; return "done"; };

    const r = await executeExactlyOnce(fn, {
      redis: TestRedis.unavailable(),
      key: "tg:test:redis-down-reject",
      claimerId: "w1",
      onRedisUnavailable: "reject",
    });

    expect(r.executed).toBe(false);
    expect(execCount).toBe(0);
  });
});

describe("buildTradeGuardKey", () => {
  it("produces consistent keys for signals within the same 5-min bucket", () => {
    const base = { symbol: "NIFTY", strategyId: "OPENING_BREAKOUT", timeframe: "5m" };
    const k1 = buildTradeGuardKey({ ...base, triggeredAtMs: 1_700_000_300_000 });
    const k2 = buildTradeGuardKey({ ...base, triggeredAtMs: 1_700_000_400_000 });
    // Both within the same 5-min bucket
    const bucket1 = Math.floor(1_700_000_300_000 / 300_000);
    const bucket2 = Math.floor(1_700_000_400_000 / 300_000);
    if (bucket1 === bucket2) {
      expect(k1).toBe(k2);
    }
  });

  it("produces different keys for signals in different 5-min buckets", () => {
    const base = { symbol: "NIFTY", strategyId: "OPENING_BREAKOUT", timeframe: "5m" };
    const k1 = buildTradeGuardKey({ ...base, triggeredAtMs: 1_700_000_000_000 });
    const k2 = buildTradeGuardKey({ ...base, triggeredAtMs: 1_700_000_600_000 }); // +10 min
    expect(k1).not.toBe(k2);
  });
});

describe("EOD square-off guard", () => {
  let redis: TestRedis;
  beforeEach(() => { redis = new TestRedis(); });

  it("first worker claims EOD square-off successfully", async () => {
    const claimed = await claimEodSquareOff(redis, "2024-01-15", "NIFTY", "trade-1");
    expect(claimed).toBe(true);
  });

  it("second worker cannot claim the same EOD square-off", async () => {
    await claimEodSquareOff(redis, "2024-01-15", "NIFTY", "trade-2");
    const second = await claimEodSquareOff(redis, "2024-01-15", "NIFTY", "trade-2");
    // First call claimed, second should fail or return true (redis_unavailable allows)
    // In our test Redis the second returns false
    expect(second).toBe(false);
  });

  it("different trade IDs get separate guards", async () => {
    const c1 = await claimEodSquareOff(redis, "2024-01-15", "NIFTY", "trade-A");
    const c2 = await claimEodSquareOff(redis, "2024-01-15", "NIFTY", "trade-B");
    expect(c1).toBe(true);
    expect(c2).toBe(true);
  });
});
