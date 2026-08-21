/**
 * Failing tests for the /api/in/order-flow route.
 *
 * Written BEFORE the implementation exists (Task 9.1 — TDD).
 * These will fail with a module-not-found error until Task 9.3 is complete.
 *
 * Validates: Requirements 7.5, 7.6, 13.1
 */

import { describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock the ML service client so the route never touches the real network.
// The route is expected to call the ML service at the /analytics/vpin endpoint.
// We drive two cases:
//   1. Network error (ML service unreachable) → { available: false }, HTTP 200
//   2. (Future: successful response — covered in integration tests)
//
// The actual client lives at @/lib/india/ml-client — mock both the health
// check and any fetch helpers it exposes.
// ---------------------------------------------------------------------------

const mlFetchMock = vi.fn();
const isMLServiceHealthyMock = vi.fn();

vi.mock("@/lib/india/ml-client", () => ({
  isMLServiceHealthy: () => isMLServiceHealthyMock(),
  mlFetch: (...args: unknown[]) => mlFetchMock(...args),
}));

// Also mock the cache so tests are deterministic and never hit Redis.
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

import { GET } from "@/app/api/in/order-flow/route";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(symbol = "NIFTY"): Request {
  return new Request(`http://localhost/api/in/order-flow?symbol=${symbol}`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/in/order-flow", () => {
  it("returns { available: false } with HTTP 200 when ML service throws a network error", async () => {
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

  it("returns HTTP 200 (not 5xx) even when the ML service throws", async () => {
    mlFetchMock.mockReset();
    isMLServiceHealthyMock.mockReset();
    isMLServiceHealthyMock.mockResolvedValueOnce(false);
    mlFetchMock.mockRejectedValueOnce(new Error("timeout after 5000 ms"));

    const res = await GET(makeRequest("BANKNIFTY"));

    // Must never be a 5xx — graceful degradation contract
    expect(res.status).toBeLessThan(500);
    expect(res.status).toBe(200);
  });

  it("does not throw or crash the process when ML service is down", async () => {
    mlFetchMock.mockReset();
    isMLServiceHealthyMock.mockReset();
    isMLServiceHealthyMock.mockResolvedValueOnce(false);
    mlFetchMock.mockRejectedValueOnce(new Error("connection refused"));

    await expect(GET(makeRequest("NIFTY"))).resolves.toBeDefined();
  });
});
