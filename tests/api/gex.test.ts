/**
 * Failing tests for the GET /api/in/gex route.
 *
 * Written BEFORE the implementation exists (Task 5.1 — TDD red phase).
 * These will fail with a module-not-found error until Task 5.2 is complete.
 *
 * Key contract under test:
 *   - When the ML service mock throws (any error), the route returns HTTP 200
 *     with body { available: false, reason: string } — graceful degradation.
 *   - The route must never return a 5xx status (Requirement 13.1).
 *
 * Validates: Requirements 4.6, 13.1
 */

import { describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock the ML service client so the route never touches the real network.
// The GEX route is expected to call the ML service via the mlFetch helper
// and check health via isMLServiceHealthy — both live at @/lib/india/ml-client.
//
// We drive one primary case:
//   ML service mock throws (network error / ECONNREFUSED)
//   → route must return { available: false }, HTTP 200
// ---------------------------------------------------------------------------

const mlFetchMock = vi.fn();
const isMLServiceHealthyMock = vi.fn();

vi.mock("@/lib/india/ml-client", () => ({
  isMLServiceHealthy: () => isMLServiceHealthyMock(),
  mlFetch: (...args: unknown[]) => mlFetchMock(...args),
}));

// ---------------------------------------------------------------------------
// Mock the Redis cache so tests are deterministic and never hit a real store.
// The GEX route caches results for 5 minutes (Requirement 4.5).
// ---------------------------------------------------------------------------
vi.mock("@/services/india/cache", () => {
  const store = new Map<string, unknown>();
  return {
    cache: {
      backendId: "memory",
      get: vi.fn(async (k: string) => store.get(k) ?? null),
      set: vi.fn(async (k: string, v: unknown) => {
        store.set(k, v);
      }),
      invalidate: vi.fn(async (k: string) => {
        store.delete(k);
      }),
      clear: vi.fn(async () => {
        store.clear();
      }),
    },
  };
});

// ---------------------------------------------------------------------------
// Import the route handler AFTER mocks are registered.
// This import will fail with MODULE_NOT_FOUND until the route is created at
// src/app/api/in/gex/route.ts — that is expected in the TDD red phase.
// ---------------------------------------------------------------------------
import { GET } from "@/app/api/in/gex/route";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(symbol = "NIFTY"): Request {
  return new Request(`http://localhost/api/in/gex?symbol=${symbol}`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/in/gex", () => {
  it("returns { available: false } with HTTP 200 when ML service mock throws", async () => {
    // This is the primary test specified by the task.
    mlFetchMock.mockReset();
    isMLServiceHealthyMock.mockReset();
    isMLServiceHealthyMock.mockResolvedValueOnce(false);
    mlFetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));

    const res = await GET(makeRequest("NIFTY"));

    expect(res.status).toBe(200);

    const body = (await res.json()) as { available: boolean; reason?: string };
    expect(body.available).toBe(false);
  });

  it("includes a reason string when the ML service is unreachable", async () => {
    mlFetchMock.mockReset();
    isMLServiceHealthyMock.mockReset();
    isMLServiceHealthyMock.mockResolvedValueOnce(false);
    mlFetchMock.mockRejectedValueOnce(new TypeError("ECONNREFUSED"));

    const res = await GET(makeRequest("NIFTY"));
    const body = (await res.json()) as { available: boolean; reason: string };

    expect(body.available).toBe(false);
    expect(typeof body.reason).toBe("string");
    expect(body.reason.length).toBeGreaterThan(0);
  });

  it("returns HTTP 200 (not 5xx) even when the ML service throws a generic error", async () => {
    mlFetchMock.mockReset();
    isMLServiceHealthyMock.mockReset();
    isMLServiceHealthyMock.mockResolvedValueOnce(false);
    mlFetchMock.mockRejectedValueOnce(new Error("timeout after 5000 ms"));

    const res = await GET(makeRequest("BANKNIFTY"));

    // Graceful degradation contract — must never be 5xx
    expect(res.status).toBeLessThan(500);
    expect(res.status).toBe(200);
  });

  it("returns HTTP 200 when ML service returns a 500 response body", async () => {
    mlFetchMock.mockReset();
    isMLServiceHealthyMock.mockReset();
    isMLServiceHealthyMock.mockResolvedValueOnce(false);
    mlFetchMock.mockRejectedValueOnce(
      Object.assign(new Error("ML service returned 500"), { status: 500 }),
    );

    const res = await GET(makeRequest("NIFTY"));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { available: boolean };
    expect(body.available).toBe(false);
  });

  it("does not throw or crash the process when the ML service is down", async () => {
    mlFetchMock.mockReset();
    isMLServiceHealthyMock.mockReset();
    isMLServiceHealthyMock.mockResolvedValueOnce(false);
    mlFetchMock.mockRejectedValueOnce(new Error("connection refused"));

    // The route must resolve — never reject with an unhandled exception
    await expect(GET(makeRequest("NIFTY"))).resolves.toBeDefined();
  });

  it("returns HTTP 200 for BANKNIFTY when ML service is unreachable", async () => {
    mlFetchMock.mockReset();
    isMLServiceHealthyMock.mockReset();
    isMLServiceHealthyMock.mockResolvedValueOnce(false);
    mlFetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));

    const res = await GET(makeRequest("BANKNIFTY"));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { available: boolean };
    expect(body.available).toBe(false);
  });
});
