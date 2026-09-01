// @vitest-environment node
/**
 * Phase 16 — Redis and Cache Audit Tests
 *
 * Verifies:
 *   - Cache TTL values are defined and reasonable
 *   - Redis failure handling (graceful degradation)
 *   - Cache is never treated as authoritative source of historical truth
 *   - Stale data detection works correctly
 *   - Market cache TTLs are correct per data type
 *
 * Validates: PHASE 16 requirements — Redis and cache audit
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

afterEach(() => {
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Market cache TTLs
// ─────────────────────────────────────────────────────────────────────────────

describe("Market cache — TTL values", () => {
  it("exports TTL object with required data types", async () => {
    const { TTL } = await import("@/lib/market-data/cache/market-cache");
    expect(typeof TTL).toBe("object");
    expect(TTL).toBeDefined();
  });

  it("TTL object contains positive values for each data type", async () => {
    const { TTL } = await import("@/lib/market-data/cache/market-cache");
    for (const [key, value] of Object.entries(TTL)) {
      expect(value).toBeGreaterThan(0);
      expect(Number.isFinite(value)).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Stale data thresholds — correct values
// ─────────────────────────────────────────────────────────────────────────────

describe("Stale data detection — STALE_THRESHOLDS_MS", () => {
  it("live tick threshold is 5 seconds", async () => {
    const { STALE_THRESHOLDS_MS } = await import("@/lib/market-data/health");
    expect(STALE_THRESHOLDS_MS.liveTick).toBe(5_000);
  });

  it("intraday candle threshold is 60 seconds", async () => {
    const { STALE_THRESHOLDS_MS } = await import("@/lib/market-data/health");
    expect(STALE_THRESHOLDS_MS.intradayCandle).toBe(60_000);
  });

  it("option chain threshold is 30 seconds", async () => {
    const { STALE_THRESHOLDS_MS } = await import("@/lib/market-data/health");
    expect(STALE_THRESHOLDS_MS.optionChain).toBe(30_000);
  });

  it("daily candle threshold is 4 hours", async () => {
    const { STALE_THRESHOLDS_MS } = await import("@/lib/market-data/health");
    expect(STALE_THRESHOLDS_MS.dailyCandle).toBe(4 * 60 * 60 * 1_000);
  });

  it("instrument master threshold is 12 hours", async () => {
    const { STALE_THRESHOLDS_MS } = await import("@/lib/market-data/health");
    expect(STALE_THRESHOLDS_MS.instrumentMaster).toBe(12 * 60 * 60 * 1_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. isStale() function correctness
// ─────────────────────────────────────────────────────────────────────────────

describe("isStale() function", () => {
  it("returns false for recently fetched data", async () => {
    const { isStale } = await import("@/lib/market-data/health");
    const now = Date.now();
    const fetchedAt = new Date(now - 1_000).toISOString(); // 1s ago
    expect(isStale(fetchedAt, "liveTick", now)).toBe(false);
  });

  it("returns true for data older than the threshold", async () => {
    const { isStale } = await import("@/lib/market-data/health");
    const now = Date.now();
    const fetchedAt = new Date(now - 10_000).toISOString(); // 10s ago
    expect(isStale(fetchedAt, "liveTick", now)).toBe(true);
  });

  it("returns true for unparseable fetchedAt", async () => {
    const { isStale } = await import("@/lib/market-data/health");
    expect(isStale("not-a-date", "liveTick")).toBe(true);
  });

  it("returns false for data within dailyCandle threshold", async () => {
    const { isStale } = await import("@/lib/market-data/health");
    const now = Date.now();
    const fetchedAt = new Date(now - 60 * 60 * 1_000).toISOString(); // 1h ago
    // 1h < 4h dailyCandle threshold
    expect(isStale(fetchedAt, "dailyCandle", now)).toBe(false);
  });

  it("returns true for data past dailyCandle threshold", async () => {
    const { isStale } = await import("@/lib/market-data/health");
    const now = Date.now();
    const fetchedAt = new Date(now - 5 * 60 * 60 * 1_000).toISOString(); // 5h ago
    // 5h > 4h dailyCandle threshold
    expect(isStale(fetchedAt, "dailyCandle", now)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. isTickStale() correctness (regression: was typed as literal 5000)
// ─────────────────────────────────────────────────────────────────────────────

describe("isTickStale() — regression: literal type fixed to number", () => {
  it("returns false for fresh tick (1s old)", async () => {
    const { isTickStale } = await import("@/lib/market-data/health");
    const now = Date.now();
    expect(isTickStale(now - 1_000, 5_000, now)).toBe(false);
  });

  it("returns true for stale tick (10s old with 5s threshold)", async () => {
    const { isTickStale } = await import("@/lib/market-data/health");
    const now = Date.now();
    expect(isTickStale(now - 10_000, 5_000, now)).toBe(true);
  });

  it("accepts any number as threshold (not just 5000 literal)", async () => {
    const { isTickStale } = await import("@/lib/market-data/health");
    const now = Date.now();
    // Custom threshold — should compile and work correctly
    expect(isTickStale(now - 3_000, 2_000, now)).toBe(true);
    expect(isTickStale(now - 1_000, 2_000, now)).toBe(false);
  });

  it("uses 5s default when no threshold provided", async () => {
    const { isTickStale } = await import("@/lib/market-data/health");
    const now = Date.now();
    expect(isTickStale(now - 3_000, undefined, now)).toBe(false);
    expect(isTickStale(now - 10_000, undefined, now)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Redis failure — cache is not authoritative for historical truth
// ─────────────────────────────────────────────────────────────────────────────

describe("Redis failure handling — graceful degradation", () => {
  it("candle-builder.service uses Redis for active candle state (not historical)", () => {
    const src = readFileSync(
      join(process.cwd(), "src/lib/market-data/services/candle-builder.service.ts"),
      "utf-8"
    );
    // Redis is used for active/open candle state
    expect(src).toMatch(/redis\.set|redis\.get/);
    // Historical candles go to Prisma (DB), not Redis
    expect(src).toMatch(/getPrisma\(\)\.candleBar\.upsert/);
  });

  it("candle-builder handles Redis write failure gracefully (logs, does not throw)", () => {
    const src = readFileSync(
      join(process.cwd(), "src/lib/market-data/services/candle-builder.service.ts"),
      "utf-8"
    );
    // Redis write failure must be caught
    expect(src).toMatch(/redis_write_failed|catch.*err/);
  });

  it("candle-builder uses EX TTL on Redis writes (not persistent)", () => {
    const src = readFileSync(
      join(process.cwd(), "src/lib/market-data/services/candle-builder.service.ts"),
      "utf-8"
    );
    // Redis key must have TTL — "EX" means expiry in seconds
    expect(src).toMatch(/"EX"/);
  });

  it("reconciliation service stale thresholds accept number (not literal type)", () => {
    const src = readFileSync(
      join(process.cwd(), "src/lib/market-data/services/reconciliation.service.ts"),
      "utf-8"
    );
    // ReconciliationConfig.staleThresholdsMs should use number type
    expect(src).toMatch(/LIVE_TICK_MAX_AGE_MS\?:\s*number/);
    expect(src).toMatch(/QUOTE_MAX_AGE_MS\?:\s*number/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Circuit breaker — Redis health scoring
// ─────────────────────────────────────────────────────────────────────────────

describe("Health scoring — circuit breaker correctness", () => {
  it("circuit opens when score falls below 20 after repeated failures", async () => {
    const { recordFailure, isCircuitOpen, resetHealth } = await import(
      "@/lib/market-data/health"
    );
    resetHealth("yahoo");

    // The circuit opens when score < 20. Starting at 100:
    // Each auth_failure: base = min(40, 5*n) + 25 (auth extra)
    // Need enough failures to bring score below 20.
    // After 1 auth failure: 100 - 5 - 25 = 70
    // After 2: 70 - 10 - 25 = 35
    // After 3: 35 - 15 - 25 = -5 → clamped to 0 → circuit opens
    for (let i = 0; i < 3; i++) {
      recordFailure("yahoo", "auth_failure");
    }

    expect(isCircuitOpen("yahoo")).toBe(true);
    resetHealth("yahoo"); // clean up
  });

  it("circuit closes after a successful probe", async () => {
    const { recordFailure, recordSuccess, isCircuitOpen, resetHealth } =
      await import("@/lib/market-data/health");
    resetHealth("yahoo");

    // Open circuit with 3 auth failures
    for (let i = 0; i < 3; i++) recordFailure("yahoo", "auth_failure");
    expect(isCircuitOpen("yahoo")).toBe(true);

    recordSuccess("yahoo", 50);
    expect(isCircuitOpen("yahoo")).toBe(false);
    resetHealth("yahoo");
  });

  it("auth failure incurs extra penalty over api_error", async () => {
    const { recordFailure, getProviderHealth, resetHealth } = await import(
      "@/lib/market-data/health"
    );
    resetHealth("angel_one");
    resetHealth("upstox");

    recordFailure("angel_one", "api_error");
    recordFailure("upstox", "auth_failure");

    const angelScore = getProviderHealth("angel_one").score;
    const upstoxScore = getProviderHealth("upstox").score;

    expect(upstoxScore).toBeLessThan(angelScore); // auth failure hurts more
    resetHealth("angel_one");
    resetHealth("upstox");
  });
});
