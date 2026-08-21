/**
 * Tests for GET /api/in/option-chain
 *
 * Task 4.2 — failing tests for graceful ML-service degradation.
 *
 * These tests are intentionally written BEFORE Task 4.4 wires the ML service
 * into the route. They will fail until:
 *   - The route calls POST http://localhost:8100/analytics/greeks
 *   - Falls back gracefully when that call fails (no 5xx, no crash)
 *   - Returns `iv_regime: null` when the ML service is unreachable
 *
 * Requirements covered: 3.4, 3.5, 9.6, 9.7, 13.1
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";

// ── Minimal option-chain shape returned by a broker adapter ──────────────────
const SAMPLE_CHAIN = {
  symbol: "NIFTY",
  expiry: "2025-01-30",
  underlyingPrice: 23000,
  pcr: 0.85,
  maxPain: 22900,
  atmStrike: 23000,
  strikes: [
    {
      strike: 22900,
      ce: { ltp: 120, oi: 50000, iv: 18.5, delta: 0.55 },
      pe: { ltp: 80, oi: 60000, iv: 17.8, delta: -0.45 },
    },
    {
      strike: 23000,
      ce: { ltp: 80, oi: 45000, iv: 19.0, delta: 0.50 },
      pe: { ltp: 90, oi: 55000, iv: 18.2, delta: -0.50 },
    },
    {
      strike: 23100,
      ce: { ltp: 50, oi: 40000, iv: 17.5, delta: 0.45 },
      pe: { ltp: 130, oi: 65000, iv: 18.9, delta: -0.55 },
    },
  ],
};

// ── Mock the broker factory and settings BEFORE importing the route ───────────

const getOptionChainBrokerMock = vi.fn();
const getBrokerByIdMock = vi.fn();

vi.mock("@/services/india/broker/factory", () => ({
  getOptionChainBroker: (...args: unknown[]) => getOptionChainBrokerMock(...args),
  getBrokerById: (...args: unknown[]) => getBrokerByIdMock(...args),
  get nse() {
    return nseBrokerStub;
  },
}));

vi.mock("@/features/settings/active-sources", () => ({
  getActiveSelections: vi.fn(async () => ({
    india: { selected: ["nse"], optionChain: "nse" },
    crypto: { selected: ["binance"], primary: "binance" },
  })),
}));

// Stub broker that successfully returns SAMPLE_CHAIN.
const nseBrokerStub = {
  id: "nse",
  getOptionChain: vi.fn(async () => SAMPLE_CHAIN),
};

// ── Import the route handler AFTER the mocks are in place ────────────────────
import { GET } from "@/app/api/in/option-chain/route";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRequest(symbol = "NIFTY", expiry?: string): Request {
  const url = `http://localhost/api/in/option-chain?symbol=${symbol}${expiry ? `&expiry=${expiry}` : ""}`;
  return new Request(url, { method: "GET" });
}

/**
 * Build a fetch mock that throws a network error when the ML service port
 * (8100) is called, and passes through all other URLs to the real fetch.
 */
function buildFetchWithMlError(): MockInstance {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes(":8100") || url.includes("localhost:8100")) {
      throw new TypeError("fetch failed: connect ECONNREFUSED 127.0.0.1:8100");
    }
    // For any other URL (should not be called in these tests), fall through.
    return new Response(JSON.stringify({}), { status: 200 });
  });
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe("GET /api/in/option-chain — ML service graceful degradation", () => {
  let fetchSpy: MockInstance;

  beforeEach(() => {
    // Wire the primary broker stub.
    nseBrokerStub.getOptionChain.mockResolvedValue(SAMPLE_CHAIN);
    getOptionChainBrokerMock.mockReturnValue(nseBrokerStub);
    getBrokerByIdMock.mockReturnValue(null);

    // Replace global fetch with our ML-error-throwing version.
    fetchSpy = buildFetchWithMlError();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── 3.5 / 13.1 — No crash, no 5xx when ML service is unreachable ──────────
  it("returns HTTP 200 (not 5xx) when the ML service throws a network error", async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
  });

  it("response body includes the standard chain fields when ML service is down", async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    // Core chain fields must survive ML-service failure.
    expect(body).toHaveProperty("pcr");
    expect(body).toHaveProperty("maxPain");
    expect(body).toHaveProperty("strikes");
    expect(Array.isArray(body.strikes)).toBe(true);
    expect((body.strikes as unknown[]).length).toBeGreaterThan(0);
  });

  it("each strike row has CE and PE sub-objects when ML service is down", async () => {
    const res = await GET(makeRequest());
    const body = (await res.json()) as { strikes: Array<Record<string, unknown>> };

    for (const row of body.strikes) {
      expect(row).toHaveProperty("strike");
      expect(row).toHaveProperty("ce");
      expect(row).toHaveProperty("pe");
    }
  });

  // ── 9.6 / 9.7 — iv_regime must be present and null when ML is down ────────
  it("response body includes an `iv_regime` field", async () => {
    const res = await GET(makeRequest());
    const body = (await res.json()) as Record<string, unknown>;

    // The field MUST exist in the response object — Task 4.4 will add it.
    // Until then this test is expected to FAIL (TDD red phase).
    expect(body).toHaveProperty("iv_regime");
  });

  it("`iv_regime` is null when the ML service is unreachable", async () => {
    const res = await GET(makeRequest());
    const body = (await res.json()) as Record<string, unknown>;

    // Must be explicitly null, not undefined, not a string.
    expect(body.iv_regime).toBeNull();
  });

  // ── 3.4 / 3.5 — Verify the ML analytics endpoint is attempted at all ──────
  it("attempts to call the ML service analytics endpoint when the broker succeeds", async () => {
    await GET(makeRequest());

    // After Task 4.4 the route must call POST :8100/analytics/greeks.
    // Until then the call won't happen and this test will FAIL (TDD red).
    const mlCalls = (fetchSpy.mock.calls as [RequestInfo | URL, RequestInit?][]).filter(
      ([input]) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : (input as Request).url;
        return url.includes(":8100") && url.includes("/analytics/greeks");
      },
    );
    expect(mlCalls.length).toBeGreaterThan(0);
  });

  // ── 3.5 — Route must NOT return 5xx regardless of ML-service error mode ───
  it("returns HTTP 200 when ML service returns a 500 error response", async () => {
    // Override fetch so the ML service returns HTTP 500 instead of throwing.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
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
        return new Response(JSON.stringify({}), { status: 200 });
      }),
    );

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
  });

  it("`iv_regime` is null when the ML service returns HTTP 500", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
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
        return new Response(JSON.stringify({}), { status: 200 });
      }),
    );

    const res = await GET(makeRequest());
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.iv_regime).toBeNull();
  });

  // ── Baseline — route works normally (no ML call yet) ─────────────────────
  it("returns PCR and maxPain values from the broker adapter", async () => {
    // Swap out our ML-error-throwing fetch so this baseline doesn't trigger it.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));

    const res = await GET(makeRequest("NIFTY"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pcr: number; maxPain: number };
    expect(typeof body.pcr).toBe("number");
    expect(typeof body.maxPain).toBe("number");
  });

  it("returns the symbol in the response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    // The broker stub returns SAMPLE_CHAIN which has symbol: "NIFTY"; the
    // route spreads the chain payload directly so symbol comes from the adapter.
    const res = await GET(makeRequest("NIFTY"));
    const body = (await res.json()) as { symbol: string };
    expect(body.symbol).toBe("NIFTY");
  });
});
