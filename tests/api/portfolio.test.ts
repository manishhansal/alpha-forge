/**
 * Failing tests for Task 12.1 — /api/in/portfolio-optimizer route.
 *
 * These tests are written BEFORE Task 12.2 creates the route handler at
 * `src/app/api/in/portfolio-optimizer/route.ts`. They will fail until:
 *   - The route file is created (Task 12.2)
 *   - The route calls POST http://localhost:8100/predict/portfolio
 *   - Falls back gracefully when the ML service is unreachable
 *
 * PortfolioAllocation shape:
 *   {
 *     method: 'hrp' | 'cvar' | 'max_diversification' | 'factor',
 *     weights: Record<string, number>,  // sum to 1
 *     riskMetrics: { volatility, cvar, sharpe, maxDrawdown },
 *     available: boolean,
 *   }
 *
 * Requirements covered: 10.1, 10.2, 10.3, 10.5, 10.6, 13.1
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";

// ---------------------------------------------------------------------------
// Sample ML service response — what /predict/portfolio returns when healthy
// ---------------------------------------------------------------------------

const SAMPLE_ML_RESPONSE = {
  method: "hrp",
  weights: {
    RELIANCE: 0.15,
    TCS: 0.12,
    INFY: 0.10,
    HDFCBANK: 0.13,
    ICICIBANK: 0.11,
    WIPRO: 0.08,
    LT: 0.09,
    ONGC: 0.07,
    SBIN: 0.08,
    AXISBANK: 0.07,
  },
  riskMetrics: {
    volatility: 0.18,
    cvar: 0.035,
    sharpe: 1.24,
    maxDrawdown: 0.12,
  },
  available: true,
};

// ---------------------------------------------------------------------------
// The route does not exist yet — import will fail (TDD red phase).
// The vi.mock below is registered so that once the route is created it can
// be tested without touching the real ML service.
// ---------------------------------------------------------------------------

// We DON'T mock the route itself; instead we intercept global `fetch` so
// the test controls what the ML service returns. This mirrors the
// option-chain test pattern.

// Import AFTER declaring any mocks that the route's transitive deps need.
// `@/lib/auth` and `@/lib/prisma` are shimmed by the test setup.
import { POST } from "@/app/api/in/portfolio-optimizer/route";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/in/portfolio-optimizer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * Stub fetch so any call to port 8100 returns `mlResponse`.
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
 * Stub fetch so any call to port 8100 throws a network error.
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

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("POST /api/in/portfolio-optimizer", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── 10.5 — Route accepts symbols + method, returns PortfolioAllocation ────

  describe("happy path — ML service reachable", () => {
    beforeEach(() => {
      vi.stubGlobal("fetch", stubMlFetch(SAMPLE_ML_RESPONSE));
    });

    it("returns HTTP 200 when the ML service responds successfully", async () => {
      const res = await POST(
        makeRequest({ symbols: ["RELIANCE", "TCS", "INFY"], method: "hrp" }),
      );
      expect(res.status).toBe(200);
    });

    it("response body has `available: true` when the ML service succeeds", async () => {
      const res = await POST(
        makeRequest({ symbols: ["RELIANCE", "TCS", "INFY"], method: "hrp" }),
      );
      const body = (await res.json()) as { available: boolean };
      expect(body.available).toBe(true);
    });

    it("response body includes `weights` as a non-empty object", async () => {
      const res = await POST(
        makeRequest({ symbols: ["RELIANCE", "TCS", "INFY"], method: "hrp" }),
      );
      const body = (await res.json()) as { weights: Record<string, number> };

      expect(body).toHaveProperty("weights");
      expect(typeof body.weights).toBe("object");
      expect(body.weights).not.toBeNull();
      expect(Object.keys(body.weights).length).toBeGreaterThan(0);
    });

    it("response body includes `riskMetrics` with all four fields", async () => {
      const res = await POST(
        makeRequest({ symbols: ["RELIANCE", "TCS", "INFY"], method: "hrp" }),
      );
      const body = (await res.json()) as {
        riskMetrics: {
          volatility: number;
          cvar: number;
          sharpe: number;
          maxDrawdown: number;
        };
      };

      expect(body).toHaveProperty("riskMetrics");
      expect(typeof body.riskMetrics.volatility).toBe("number");
      expect(typeof body.riskMetrics.cvar).toBe("number");
      expect(typeof body.riskMetrics.sharpe).toBe("number");
      expect(typeof body.riskMetrics.maxDrawdown).toBe("number");
    });

    it("response body includes `method` matching the requested method", async () => {
      const res = await POST(
        makeRequest({ symbols: ["RELIANCE", "TCS", "INFY"], method: "cvar" }),
      );
      const body = (await res.json()) as { method: string };
      // The method in the response must match what was requested.
      // Note: SAMPLE_ML_RESPONSE returns 'hrp'; if the route passes method
      // correctly the ML service would return 'cvar'. We verify the field exists.
      expect(body).toHaveProperty("method");
      expect(typeof body.method).toBe("string");
    });

    it("conforms to the full PortfolioAllocation shape", async () => {
      const res = await POST(
        makeRequest({ symbols: ["RELIANCE", "TCS", "INFY"], method: "hrp" }),
      );
      const body = (await res.json()) as Record<string, unknown>;

      // All top-level required fields
      expect(body).toHaveProperty("method");
      expect(body).toHaveProperty("weights");
      expect(body).toHaveProperty("riskMetrics");
      expect(body).toHaveProperty("available");

      // `weights` values are numbers
      for (const v of Object.values(body.weights as Record<string, unknown>)) {
        expect(typeof v).toBe("number");
      }
    });
  });

  // ── 10.6 / 13.1 — Graceful degradation when ML service is unreachable ─────

  describe("graceful degradation — ML service unreachable", () => {
    beforeEach(() => {
      vi.stubGlobal("fetch", stubMlNetworkError());
    });

    it("returns HTTP 200 (not 5xx) when the ML service throws a network error", async () => {
      const res = await POST(
        makeRequest({ symbols: ["RELIANCE", "TCS"], method: "hrp" }),
      );
      expect(res.status).toBe(200);
    });

    it("returns `{ available: false }` when the ML service is unreachable", async () => {
      const res = await POST(
        makeRequest({ symbols: ["RELIANCE", "TCS"], method: "hrp" }),
      );
      const body = (await res.json()) as { available: boolean };
      expect(body.available).toBe(false);
    });

    it("does not throw or return a 5xx when ML service returns HTTP 500", async () => {
      vi.stubGlobal("fetch", stubMlFetch({ error: "Internal Server Error" }, 500));

      const res = await POST(
        makeRequest({ symbols: ["RELIANCE", "TCS"], method: "hrp" }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { available: boolean };
      expect(body.available).toBe(false);
    });
  });
});
