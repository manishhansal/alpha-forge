/**
 * Failing tests for the GET /api/in/vol-surface route.
 *
 * Written BEFORE the implementation exists at
 * `src/app/api/in/vol-surface/route.ts` (Task 6.2 — TDD red phase).
 * These tests will fail with a module-not-found error until the route is
 * created.
 *
 * Route contract:
 *   GET /api/in/vol-surface?symbol=NIFTY
 *
 *   Happy path (ML service reachable):
 *     HTTP 200, body matches VolSurfaceResponse shape
 *
 *   Graceful degradation (ML service unreachable):
 *     HTTP 200, body = { available: false, reason: string }
 *
 * Validates: Requirements 5.3, 5.4, 13.1
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";

// ---------------------------------------------------------------------------
// Sample ML service response — what the Python /vol-surface endpoint returns.
// Matches VolSurfaceResponse shape defined in the design doc.
// ---------------------------------------------------------------------------

const SAMPLE_ML_RESPONSE = {
  symbol: "NIFTY",
  expiries: ["2025-07-10", "2025-07-24"],
  ivByExpiry: {
    "2025-07-10": [
      { strike: 22500, iv: 0.17 },
      { strike: 22800, iv: 0.155 },
      { strike: 23000, iv: 0.15 },
      { strike: 23200, iv: 0.153 },
      { strike: 23500, iv: 0.162 },
    ],
    "2025-07-24": [
      { strike: 22500, iv: 0.175 },
      { strike: 22800, iv: 0.162 },
      { strike: 23000, iv: 0.16 },
      { strike: 23200, iv: 0.163 },
      { strike: 23500, iv: 0.172 },
    ],
  },
  termStructure: [
    { daysToExpiry: 7, atmIv: 0.15 },
    { daysToExpiry: 21, atmIv: 0.16 },
  ],
  sviParams: {
    "2025-07-10": { a: 0.01, b: 0.05, rho: -0.3, m: 0.0, sigma: 0.2 },
    "2025-07-24": { a: 0.012, b: 0.06, rho: -0.28, m: 0.0, sigma: 0.21 },
  },
  available: true,
};

// ---------------------------------------------------------------------------
// Helpers to stub global `fetch` used by the route to call the ML service.
// Mirrors the pattern used in tests/api/portfolio.test.ts.
// ---------------------------------------------------------------------------

/**
 * Stub fetch: any request to port 8100 returns `mlResponse`.
 */
function stubMlFetch(mlResponse: unknown, status = 200): MockInstance {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    if (url.includes(":8100")) {
      return new Response(JSON.stringify(mlResponse), { status });
    }
    return new Response("{}", { status: 200 });
  });
}

/**
 * Stub fetch: any request to port 8100 throws a network error (service down).
 */
function stubMlNetworkError(): MockInstance {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    if (url.includes(":8100")) {
      throw new TypeError("fetch failed: connect ECONNREFUSED 127.0.0.1:8100");
    }
    return new Response("{}", { status: 200 });
  });
}

/**
 * Helper to build a GET request for the route.
 */
function makeRequest(symbol = "NIFTY"): Request {
  return new Request(`http://localhost/api/in/vol-surface?symbol=${symbol}`);
}

// ---------------------------------------------------------------------------
// Import-under-test.
// This import will throw a module-not-found error until the route is created.
// That is intentional — the TDD red phase requires failing tests.
// ---------------------------------------------------------------------------

import { GET } from "@/app/api/in/vol-surface/route";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/in/vol-surface", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── 5.4 / 13.1 — Graceful degradation: ML service unreachable ─────────────

  describe("graceful degradation — ML service unreachable", () => {
    it("returns { available: false } with HTTP 200 when ML service throws a network error", async () => {
      vi.stubGlobal("fetch", stubMlNetworkError());

      const res = await GET(makeRequest("NIFTY"));

      expect(res.status).toBe(200);

      const body = (await res.json()) as { available: boolean; reason?: string };
      expect(body.available).toBe(false);
    });

    it("includes a non-empty reason string when the ML service is unreachable", async () => {
      vi.stubGlobal("fetch", stubMlNetworkError());

      const res = await GET(makeRequest("NIFTY"));
      const body = (await res.json()) as { available: boolean; reason: string };

      expect(body.available).toBe(false);
      expect(typeof body.reason).toBe("string");
      expect(body.reason.length).toBeGreaterThan(0);
    });

    it("returns HTTP 200 (never 5xx) even when the ML service throws", async () => {
      vi.stubGlobal("fetch", stubMlNetworkError());

      const res = await GET(makeRequest("BANKNIFTY"));

      // Graceful degradation contract: never 5xx
      expect(res.status).toBeLessThan(500);
      expect(res.status).toBe(200);
    });

    it("does not throw or crash when the ML service is down", async () => {
      vi.stubGlobal("fetch", stubMlNetworkError());

      await expect(GET(makeRequest("NIFTY"))).resolves.toBeDefined();
    });

    it("returns HTTP 200 when ML service returns HTTP 500", async () => {
      vi.stubGlobal("fetch", stubMlFetch({ error: "Internal Server Error" }, 500));

      const res = await GET(makeRequest("NIFTY"));

      expect(res.status).toBe(200);
      const body = (await res.json()) as { available: boolean };
      expect(body.available).toBe(false);
    });
  });

  // ── 5.3 — Happy path: ML service reachable ────────────────────────────────

  describe("happy path — ML service reachable", () => {
    it("returns HTTP 200 when the ML service responds successfully", async () => {
      vi.stubGlobal("fetch", stubMlFetch(SAMPLE_ML_RESPONSE));

      const res = await GET(makeRequest("NIFTY"));

      expect(res.status).toBe(200);
    });

    it("response body has `available: true` when the ML service succeeds", async () => {
      vi.stubGlobal("fetch", stubMlFetch(SAMPLE_ML_RESPONSE));

      const res = await GET(makeRequest("NIFTY"));
      const body = (await res.json()) as { available: boolean };

      expect(body.available).toBe(true);
    });

    it("response body includes `expiries` as a non-empty array", async () => {
      vi.stubGlobal("fetch", stubMlFetch(SAMPLE_ML_RESPONSE));

      const res = await GET(makeRequest("NIFTY"));
      const body = (await res.json()) as { expiries: string[] };

      expect(body).toHaveProperty("expiries");
      expect(Array.isArray(body.expiries)).toBe(true);
      expect(body.expiries.length).toBeGreaterThan(0);
    });

    it("response body includes `ivByExpiry` keyed by expiry date strings", async () => {
      vi.stubGlobal("fetch", stubMlFetch(SAMPLE_ML_RESPONSE));

      const res = await GET(makeRequest("NIFTY"));
      const body = (await res.json()) as {
        ivByExpiry: Record<string, { strike: number; iv: number }[]>;
      };

      expect(body).toHaveProperty("ivByExpiry");
      expect(typeof body.ivByExpiry).toBe("object");
      expect(body.ivByExpiry).not.toBeNull();
      expect(Object.keys(body.ivByExpiry).length).toBeGreaterThan(0);
    });

    it("response body includes `termStructure` as an array", async () => {
      vi.stubGlobal("fetch", stubMlFetch(SAMPLE_ML_RESPONSE));

      const res = await GET(makeRequest("NIFTY"));
      const body = (await res.json()) as {
        termStructure: { daysToExpiry: number; atmIv: number }[];
      };

      expect(body).toHaveProperty("termStructure");
      expect(Array.isArray(body.termStructure)).toBe(true);
    });

    it("conforms to the full VolSurfaceResponse shape", async () => {
      vi.stubGlobal("fetch", stubMlFetch(SAMPLE_ML_RESPONSE));

      const res = await GET(makeRequest("NIFTY"));
      const body = (await res.json()) as Record<string, unknown>;

      // All required top-level fields from VolSurfaceResponse (design doc Model 2)
      expect(body).toHaveProperty("symbol");
      expect(body).toHaveProperty("expiries");
      expect(body).toHaveProperty("ivByExpiry");
      expect(body).toHaveProperty("termStructure");
      expect(body).toHaveProperty("sviParams");
      expect(body).toHaveProperty("available");
    });
  });
});
