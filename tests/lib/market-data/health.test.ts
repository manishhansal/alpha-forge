// @vitest-environment node
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

import {
  recordSuccess,
  recordFailure,
  recordStaleData,
  getProviderHealth,
  resetHealth,
  resetAllHealth,
  isCircuitOpen,
  isStale,
  isTickStale,
  STALE_THRESHOLDS_MS,
} from "@/lib/market-data/health";
import type { ProviderId } from "@/lib/market-data/types";

const ID: ProviderId = "angel_one";
const ID2: ProviderId = "upstox";

beforeEach(() => {
  resetAllHealth();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Initial state ─────────────────────────────────────────────────────────────

describe("initial health state", () => {
  it("starts healthy with score 100", () => {
    const h = getProviderHealth(ID);
    expect(h.status).toBe("healthy");
    expect(h.score).toBe(100);
    expect(h.circuitOpen).toBe(false);
    expect(h.consecutiveFailures).toBe(0);
    expect(h.consecutiveSuccesses).toBe(0);
    expect(h.lastSuccessAt).toBeNull();
    expect(h.lastFailureAt).toBeNull();
  });

  it("does not open circuit on fresh state", () => {
    expect(isCircuitOpen(ID)).toBe(false);
  });
});

// ── recordSuccess ─────────────────────────────────────────────────────────────

describe("recordSuccess()", () => {
  it("resets consecutive failures to 0", () => {
    recordFailure(ID, "api_error");
    recordFailure(ID, "api_error");
    recordSuccess(ID, 50);
    expect(getProviderHealth(ID).consecutiveFailures).toBe(0);
  });

  it("increments consecutive successes", () => {
    recordSuccess(ID, 10);
    recordSuccess(ID, 10);
    expect(getProviderHealth(ID).consecutiveSuccesses).toBe(2);
  });

  it("recovers score by RECOVERY_PER_SUCCESS (10) per call", () => {
    // Drive score down first
    for (let i = 0; i < 3; i++) recordFailure(ID, "api_error");
    const scoreBefore = getProviderHealth(ID).score;
    recordSuccess(ID, 20);
    const scoreAfter = getProviderHealth(ID).score;
    expect(scoreAfter).toBeGreaterThan(scoreBefore);
    expect(scoreAfter).toBeLessThanOrEqual(100);
  });

  it("does not exceed score 100", () => {
    for (let i = 0; i < 20; i++) recordSuccess(ID, 5);
    expect(getProviderHealth(ID).score).toBe(100);
  });

  it("records lastSuccessAt as an ISO string", () => {
    const before = Date.now();
    recordSuccess(ID, 30);
    const h = getProviderHealth(ID);
    expect(h.lastSuccessAt).not.toBeNull();
    expect(Date.parse(h.lastSuccessAt!)).toBeGreaterThanOrEqual(before);
  });

  it("tracks latency samples for percentile estimation", () => {
    for (const ms of [10, 20, 100, 200, 300]) recordSuccess(ID, ms);
    const h = getProviderHealth(ID);
    expect(h.latencyP50Ms).not.toBeNull();
    expect(h.latencyP99Ms).not.toBeNull();
    // P99 should be >= P50 when samples span a range
    expect(h.latencyP99Ms!).toBeGreaterThanOrEqual(h.latencyP50Ms!);
  });
});

// ── recordFailure ─────────────────────────────────────────────────────────────

describe("recordFailure()", () => {
  it("increments consecutive failures", () => {
    recordFailure(ID, "api_error");
    expect(getProviderHealth(ID).consecutiveFailures).toBe(1);
    recordFailure(ID, "api_error");
    expect(getProviderHealth(ID).consecutiveFailures).toBe(2);
  });

  it("resets consecutive successes to 0", () => {
    recordSuccess(ID, 10);
    recordSuccess(ID, 10);
    recordFailure(ID, "api_error");
    expect(getProviderHealth(ID).consecutiveSuccesses).toBe(0);
  });

  it("progressively penalises the score (each failure hurts more)", () => {
    const scores: number[] = [100];
    for (let i = 0; i < 5; i++) {
      recordFailure(ID, "api_error");
      scores.push(getProviderHealth(ID).score);
    }
    // Each step should reduce the score
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeLessThan(scores[i - 1]!);
    }
  });

  it("applies extra AUTH_FAILURE_PENALTY for auth_failure kind", () => {
    resetHealth(ID);
    const idA: ProviderId = "angel_one";
    const idB: ProviderId = "upstox";

    recordFailure(idA, "api_error");
    recordFailure(idB, "auth_failure");

    // Auth failure should have a lower score than generic API error
    const scoreA = getProviderHealth(idA).score;
    const scoreB = getProviderHealth(idB).score;
    expect(scoreB).toBeLessThan(scoreA);
  });

  it("records lastFailureAt", () => {
    const before = Date.now();
    recordFailure(ID, "timeout");
    const h = getProviderHealth(ID);
    expect(h.lastFailureAt).not.toBeNull();
    expect(Date.parse(h.lastFailureAt!)).toBeGreaterThanOrEqual(before);
  });
});

// ── Circuit breaker ───────────────────────────────────────────────────────────

describe("circuit breaker", () => {
  it("opens the circuit when score drops below 20", () => {
    // Each auth_failure = -5 (base for 1st failure) + -25 (auth extra) = -30 per call
    // Start 100. After 1st: 100 - (5+25) = 70. After 2nd: 70 - (10+25) = 35.
    // After 3rd: 35 - (15+25) = -5 → clamped to 0 → circuit opens.
    for (let i = 0; i < 3; i++) recordFailure(ID, "auth_failure");
    const h = getProviderHealth(ID);
    expect(h.circuitOpen).toBe(true);
    expect(h.status).toBe("unhealthy");
    expect(isCircuitOpen(ID)).toBe(true);
  });

  it("isCircuitOpen returns false during the half-open window", () => {
    // Drive circuit open
    for (let i = 0; i < 3; i++) recordFailure(ID, "auth_failure");
    expect(isCircuitOpen(ID)).toBe(true);

    // Simulate time advancing past the retry window (30s)
    const future = Date.now() + 31_000;
    expect(isCircuitOpen(ID, future)).toBe(false);
  });

  it("closes the circuit on a successful probe call", () => {
    for (let i = 0; i < 3; i++) recordFailure(ID, "auth_failure");
    expect(getProviderHealth(ID).circuitOpen).toBe(true);

    recordSuccess(ID, 50);
    expect(getProviderHealth(ID).circuitOpen).toBe(false);
    expect(isCircuitOpen(ID)).toBe(false);
  });

  it("sets circuitRetryAt ~30s after opening", () => {
    const before = Date.now();
    for (let i = 0; i < 3; i++) recordFailure(ID, "auth_failure");
    const h = getProviderHealth(ID);
    expect(h.circuitRetryAt).not.toBeNull();
    const retryMs = Date.parse(h.circuitRetryAt!);
    expect(retryMs).toBeGreaterThan(before + 25_000);
    expect(retryMs).toBeLessThan(before + 35_000);
  });
});

// ── Health status thresholds ──────────────────────────────────────────────────

describe("health status", () => {
  it("is 'healthy' when score >= 60", () => {
    expect(getProviderHealth(ID).status).toBe("healthy");
  });

  it("is 'degraded' when score is between 20 and 59", () => {
    // 4 api_error failures: 100 - 5 - 10 - 15 - 20 = 50
    for (let i = 0; i < 4; i++) recordFailure(ID, "api_error");
    const h = getProviderHealth(ID);
    expect(h.score).toBeLessThan(60);
    expect(h.score).toBeGreaterThan(20);
    expect(h.status).toBe("degraded");
  });

  it("is 'unhealthy' when circuit is open", () => {
    for (let i = 0; i < 3; i++) recordFailure(ID, "auth_failure");
    expect(getProviderHealth(ID).status).toBe("unhealthy");
  });
});

// ── resetHealth ───────────────────────────────────────────────────────────────

describe("resetHealth()", () => {
  it("restores a provider to perfect health", () => {
    for (let i = 0; i < 5; i++) recordFailure(ID, "auth_failure");
    resetHealth(ID);
    const h = getProviderHealth(ID);
    expect(h.score).toBe(100);
    expect(h.circuitOpen).toBe(false);
    expect(h.consecutiveFailures).toBe(0);
  });

  it("only resets the specified provider", () => {
    recordFailure(ID, "api_error");
    recordFailure(ID2, "api_error");
    resetHealth(ID);
    expect(getProviderHealth(ID).score).toBe(100);
    expect(getProviderHealth(ID2).score).toBeLessThan(100);
  });
});

// ── recordStaleData ───────────────────────────────────────────────────────────

describe("recordStaleData()", () => {
  it("reduces score by 15 per stale event", () => {
    recordStaleData(ID, 10_000, 5_000);
    expect(getProviderHealth(ID).score).toBe(85);
  });

  it("does not immediately open the circuit on stale data", () => {
    recordStaleData(ID, 10_000, 5_000);
    expect(getProviderHealth(ID).circuitOpen).toBe(false);
  });
});

// ── isStale() ─────────────────────────────────────────────────────────────────

describe("isStale()", () => {
  it("returns false for a fetchedAt within the threshold", () => {
    const recent = new Date(Date.now() - 1_000).toISOString();
    expect(isStale(recent, "liveTick")).toBe(false);
  });

  it("returns true for a fetchedAt beyond the threshold", () => {
    const old = new Date(Date.now() - 10_000).toISOString();
    expect(isStale(old, "liveTick")).toBe(true); // 10s > 5s threshold
  });

  it("returns true for an unparseable fetchedAt", () => {
    expect(isStale("not-a-date", "liveTick")).toBe(true);
  });

  it("uses the correct threshold per data type", () => {
    const almostStale = new Date(Date.now() - STALE_THRESHOLDS_MS.dailyCandle + 1_000).toISOString();
    expect(isStale(almostStale, "dailyCandle")).toBe(false);
    const stale = new Date(Date.now() - STALE_THRESHOLDS_MS.dailyCandle - 1_000).toISOString();
    expect(isStale(stale, "dailyCandle")).toBe(true);
  });
});

// ── isTickStale() ─────────────────────────────────────────────────────────────

describe("isTickStale()", () => {
  it("returns false when tick is within threshold", () => {
    expect(isTickStale(Date.now() - 2_000)).toBe(false);
  });

  it("returns true when tick is older than threshold", () => {
    expect(isTickStale(Date.now() - 10_000)).toBe(true);
  });

  it("respects a custom threshold", () => {
    const ts = Date.now() - 3_000;
    expect(isTickStale(ts, 2_000)).toBe(true);
    expect(isTickStale(ts, 5_000)).toBe(false);
  });
});
