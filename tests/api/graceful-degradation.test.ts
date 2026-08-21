/**
 * Graceful degradation tests for all new Phase 2 API routes.
 *
 * Task 16 / Task 17 — Final integration checkpoint.
 *
 * Routes under test:
 *   GET  /api/in/gex
 *   GET  /api/in/vol-surface
 *   GET  /api/in/order-flow
 *   POST /api/in/portfolio-optimizer
 *
 * Contract (Requirement 13.1):
 *   WHEN the ML service is unreachable (network error, HTTP 500, timeout),
 *   THEN each route MUST return HTTP 200 with { available: false, reason: string }.
 *   The route MUST NEVER return a 5xx status code.
 *
 * Three failure modes are tested per route:
 *   1. Network error (TypeError / ECONNREFUSED)
 *   2. HTTP 500 from the ML service
 *   3. Generic timeout error
 *
 * Validates: Requirements 13.1, 13.2, 13.3, 13.4
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";

// ---------------------------------------------------------------------------
// Mock helpers shared across all route tests
// ---------------------------------------------------------------------------

/**
 * Stub global fetch: any request to port 8100 returns an error status body.
 */
function stubMlHttp500(): MockInstance {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    if (url.includes(":8100")) {
      return new Response(JSON.stringify({ error: "Internal Server Error" }), {
        status: 500,
      });
    }
    return new Response("{}", { status: 200 });
  });
}

/**
 * Stub global fetch: any request to port 8100 throws a network / ECONNREFUSED error.
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
 * Stub global fetch: any request to port 8100 throws a timeout error.
 */
function stubMlTimeout(): MockInstance {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    if (url.includes(":8100")) {
      throw new Error("timeout after 5000 ms");
    }
    return new Response("{}", { status: 200 });
  });
}

// ---------------------------------------------------------------------------
// Mock the ML service client helpers used by gex and order-flow routes
// (those routes use @/lib/india/ml-client rather than bare fetch).
// ---------------------------------------------------------------------------

const mlFetchMock = vi.fn();
const isMLServiceHealthyMock = vi.fn();

vi.mock("@/lib/india/ml-client", () => ({
  isMLServiceHealthy: () => isMLServiceHealthyMock(),
  mlFetch: (...args: unknown[]) => mlFetchMock(...args),
}));

// Mock the Redis cache so tests are deterministic.
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
// Import all four route handlers under test
// ---------------------------------------------------------------------------

import { GET as getGex } from "@/app/api/in/gex/route";
import { GET as getVolSurface } from "@/app/api/in/vol-surface/route";
import { GET as getOrderFlow } from "@/app/api/in/order-flow/route";
import { POST as postPortfolioOptimizer } from "@/app/api/in/portfolio-optimizer/route";

// ---------------------------------------------------------------------------
// Request factory helpers
// ---------------------------------------------------------------------------

function makeGetRequest(path: string, symbol = "NIFTY"): Request {
  return new Request(`http://localhost${path}?symbol=${symbol}`);
}

function makePostRequest(path: string, body: Record<string, unknown>): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Helper: assert graceful degradation contract for a route response
// ---------------------------------------------------------------------------

async function assertGracefulDegradation(res: Response): Promise<void> {
  // Must be HTTP 200 — never 5xx
  expect(res.status).toBe(200);
  expect(res.status).toBeLessThan(500);

  const body = (await res.json()) as { available: boolean; reason?: string };

  // Must signal unavailability
  expect(body.available).toBe(false);

  // Must include a non-empty reason string
  expect(typeof body.reason).toBe("string");
  expect((body.reason as string).length).toBeGreaterThan(0);
}

// ---------------------------------------------------------------------------
// Suite 1 — GET /api/in/gex
// ---------------------------------------------------------------------------

describe("GET /api/in/gex — graceful degradation (Requirement 13.1)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    mlFetchMock.mockReset();
    isMLServiceHealthyMock.mockReset();
  });

  it("returns HTTP 200 + { available: false } on network error", async () => {
    isMLServiceHealthyMock.mockResolvedValueOnce(false);
    mlFetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));

    const res = await getGex(makeGetRequest("/api/in/gex", "NIFTY"));
    await assertGracefulDegradation(res);
  });

  it("returns HTTP 200 + { available: false } when ML service returns HTTP 500", async () => {
    isMLServiceHealthyMock.mockResolvedValueOnce(false);
    mlFetchMock.mockRejectedValueOnce(
      Object.assign(new Error("ML service returned 500"), { status: 500 }),
    );

    const res = await getGex(makeGetRequest("/api/in/gex", "NIFTY"));
    await assertGracefulDegradation(res);
  });

  it("returns HTTP 200 + { available: false } on timeout error", async () => {
    isMLServiceHealthyMock.mockResolvedValueOnce(false);
    mlFetchMock.mockRejectedValueOnce(new Error("timeout after 5000 ms"));

    const res = await getGex(makeGetRequest("/api/in/gex", "BANKNIFTY"));
    await assertGracefulDegradation(res);
  });

  it("never returns a 5xx status under any ML failure mode", async () => {
    const failures = [
      new TypeError("ECONNREFUSED"),
      new Error("timeout"),
      Object.assign(new Error("500"), { status: 500 }),
    ];

    for (const err of failures) {
      mlFetchMock.mockReset();
      isMLServiceHealthyMock.mockReset();
      isMLServiceHealthyMock.mockResolvedValueOnce(false);
      mlFetchMock.mockRejectedValueOnce(err);

      const res = await getGex(makeGetRequest("/api/in/gex", "NIFTY"));
      expect(res.status).toBeLessThan(500);
    }
  });

  it("does not throw an unhandled exception when ML service is down", async () => {
    isMLServiceHealthyMock.mockResolvedValueOnce(false);
    mlFetchMock.mockRejectedValueOnce(new Error("connection refused"));

    await expect(
      getGex(makeGetRequest("/api/in/gex", "NIFTY")),
    ).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Suite 2 — GET /api/in/vol-surface
// ---------------------------------------------------------------------------

describe("GET /api/in/vol-surface — graceful degradation (Requirement 13.1)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns HTTP 200 + { available: false } on network error", async () => {
    vi.stubGlobal("fetch", stubMlNetworkError());

    const res = await getVolSurface(makeGetRequest("/api/in/vol-surface", "NIFTY"));
    await assertGracefulDegradation(res);
  });

  it("returns HTTP 200 + { available: false } when ML service returns HTTP 500", async () => {
    vi.stubGlobal("fetch", stubMlHttp500());

    const res = await getVolSurface(makeGetRequest("/api/in/vol-surface", "NIFTY"));
    await assertGracefulDegradation(res);
  });

  it("returns HTTP 200 + { available: false } on timeout error", async () => {
    vi.stubGlobal("fetch", stubMlTimeout());

    const res = await getVolSurface(makeGetRequest("/api/in/vol-surface", "BANKNIFTY"));
    await assertGracefulDegradation(res);
  });

  it("never returns a 5xx status under any ML failure mode", async () => {
    const stubs = [stubMlNetworkError(), stubMlHttp500(), stubMlTimeout()];

    for (const stub of stubs) {
      vi.restoreAllMocks();
      vi.stubGlobal("fetch", stub);

      const res = await getVolSurface(makeGetRequest("/api/in/vol-surface", "NIFTY"));
      expect(res.status).toBeLessThan(500);
    }
  });

  it("does not throw an unhandled exception when ML service is down", async () => {
    vi.stubGlobal("fetch", stubMlNetworkError());

    await expect(
      getVolSurface(makeGetRequest("/api/in/vol-surface", "NIFTY")),
    ).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Suite 3 — GET /api/in/order-flow
// ---------------------------------------------------------------------------

describe("GET /api/in/order-flow — graceful degradation (Requirement 13.1)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    mlFetchMock.mockReset();
    isMLServiceHealthyMock.mockReset();
  });

  it("returns HTTP 200 + { available: false } on network error", async () => {
    isMLServiceHealthyMock.mockResolvedValueOnce(false);
    mlFetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));

    const res = await getOrderFlow(makeGetRequest("/api/in/order-flow", "NIFTY"));
    await assertGracefulDegradation(res);
  });

  it("returns HTTP 200 + { available: false } when ML service returns HTTP 500", async () => {
    isMLServiceHealthyMock.mockResolvedValueOnce(false);
    mlFetchMock.mockRejectedValueOnce(
      Object.assign(new Error("ML service returned 500"), { status: 500 }),
    );

    const res = await getOrderFlow(makeGetRequest("/api/in/order-flow", "NIFTY"));
    await assertGracefulDegradation(res);
  });

  it("returns HTTP 200 + { available: false } on timeout error", async () => {
    isMLServiceHealthyMock.mockResolvedValueOnce(false);
    mlFetchMock.mockRejectedValueOnce(new Error("timeout after 5000 ms"));

    const res = await getOrderFlow(makeGetRequest("/api/in/order-flow", "BANKNIFTY"));
    await assertGracefulDegradation(res);
  });

  it("never returns a 5xx status under any ML failure mode", async () => {
    const failures = [
      new TypeError("ECONNREFUSED"),
      new Error("timeout"),
      Object.assign(new Error("500"), { status: 500 }),
    ];

    for (const err of failures) {
      mlFetchMock.mockReset();
      isMLServiceHealthyMock.mockReset();
      isMLServiceHealthyMock.mockResolvedValueOnce(false);
      mlFetchMock.mockRejectedValueOnce(err);

      const res = await getOrderFlow(makeGetRequest("/api/in/order-flow", "NIFTY"));
      expect(res.status).toBeLessThan(500);
    }
  });

  it("does not throw an unhandled exception when ML service is down", async () => {
    isMLServiceHealthyMock.mockResolvedValueOnce(false);
    mlFetchMock.mockRejectedValueOnce(new Error("connection refused"));

    await expect(
      getOrderFlow(makeGetRequest("/api/in/order-flow", "NIFTY")),
    ).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Suite 4 — POST /api/in/portfolio-optimizer
// ---------------------------------------------------------------------------

describe(
  "POST /api/in/portfolio-optimizer — graceful degradation (Requirement 13.1)",
  () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    const sampleBody = { symbols: ["RELIANCE", "TCS", "INFY"], method: "hrp" };

    it("returns HTTP 200 + { available: false } on network error", async () => {
      vi.stubGlobal("fetch", stubMlNetworkError());

      const res = await postPortfolioOptimizer(
        makePostRequest("/api/in/portfolio-optimizer", sampleBody),
      );
      await assertGracefulDegradation(res);
    });

    it("returns HTTP 200 + { available: false } when ML service returns HTTP 500", async () => {
      vi.stubGlobal("fetch", stubMlHttp500());

      const res = await postPortfolioOptimizer(
        makePostRequest("/api/in/portfolio-optimizer", sampleBody),
      );
      await assertGracefulDegradation(res);
    });

    it("returns HTTP 200 + { available: false } on timeout error", async () => {
      vi.stubGlobal("fetch", stubMlTimeout());

      const res = await postPortfolioOptimizer(
        makePostRequest("/api/in/portfolio-optimizer", sampleBody),
      );
      await assertGracefulDegradation(res);
    });

    it("never returns a 5xx status under any ML failure mode", async () => {
      const stubs = [stubMlNetworkError(), stubMlHttp500(), stubMlTimeout()];

      for (const stub of stubs) {
        vi.restoreAllMocks();
        vi.stubGlobal("fetch", stub);

        const res = await postPortfolioOptimizer(
          makePostRequest("/api/in/portfolio-optimizer", sampleBody),
        );
        expect(res.status).toBeLessThan(500);
      }
    });

    it("does not throw an unhandled exception when ML service is down", async () => {
      vi.stubGlobal("fetch", stubMlNetworkError());

      await expect(
        postPortfolioOptimizer(
          makePostRequest("/api/in/portfolio-optimizer", sampleBody),
        ),
      ).resolves.toBeDefined();
    });
  },
);
