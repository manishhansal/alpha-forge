/**
 * Tests for GET /api/in/option-chain
 *
 * After data-service2.0 centralization, the route calls getOptionChain()
 * from @/lib/data-service/client directly.
 *
 * Requirements covered: 3.4, 3.5, 9.6, 9.7
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// ── Minimal option-chain shape returned by data-service2.0 ──────────────────
const SAMPLE_CHAIN = {
  underlying: "NIFTY",
  expiry: "2025-01-30",
  expiries: ["2025-01-30"],
  spotPrice: 23000,
  spot: 23000,
  pcrOi: 0.85,
  atmIv: 18.5,
  maxPain: 22900,
  rows: [
    { strike: 22900, optionType: "CE" as const, ltp: 120, bid: 119, ask: 121, oi: 50000, oiChange: 100, volume: 5000, iv: 18.5, delta: 0.55, gamma: null, theta: null, vega: null },
    { strike: 22900, optionType: "PE" as const, ltp: 80, bid: 79, ask: 81, oi: 60000, oiChange: 200, volume: 6000, iv: 17.8, delta: -0.45, gamma: null, theta: null, vega: null },
  ],
  dataAsOf: new Date().toISOString(),
  fetchedAt: new Date().toISOString(),
  provider: "angel_one",
};

// ── Mock data-service2.0 client ──────────────────────────────────────────────
const getOptionChainMock = vi.fn();
vi.mock("@/lib/data-service/client", () => ({
  getOptionChain: (...args: unknown[]) => getOptionChainMock(...args),
  DataServiceUnavailableError: class DataServiceUnavailableError extends Error {
    constructor(msg: string) { super(msg); this.name = "DataServiceUnavailableError"; }
  },
}));

// ── Mock ML service helpers ──────────────────────────────────────────────────
const fetchGreeksMock = vi.fn();
const predictIVRegimeMock = vi.fn();
vi.mock("@/lib/india/ml-client", () => ({
  fetchOptionChainGreeks: (...args: unknown[]) => fetchGreeksMock(...args),
  predictIVRegime: (...args: unknown[]) => predictIVRegimeMock(...args),
}));

// ── Mock chaos helpers ───────────────────────────────────────────────────────
vi.mock("@/lib/chaos/option-chain-resilience", () => ({
  validateOptionChain: () => ({ valid: true, reason: null, strikeCount: 2 }),
  sanitizeOptionChain: (c: unknown) => c,
  withOptionChainFallback: async (_sym: string, _exp: string, fn: () => Promise<unknown>) => {
    const chain = await fn();
    return { chain, fromCache: false, partial: false };
  },
}));

vi.mock("@/lib/redis", () => ({
  redis: { get: vi.fn(), set: vi.fn(), setex: vi.fn() },
}));

describe("GET /api/in/option-chain — ML service graceful degradation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getOptionChainMock.mockResolvedValue(SAMPLE_CHAIN);
    fetchGreeksMock.mockResolvedValue(null);
    predictIVRegimeMock.mockResolvedValue({ iv_regime: null });
  });

  afterEach(() => vi.restoreAllMocks());

  async function getRoute(params = "symbol=NIFTY") {
    vi.resetModules();
    const mod = await import("@/app/api/in/option-chain/route");
    const url = `http://localhost/api/in/option-chain?${params}`;
    const req = new Request(url);
    return mod.GET(req);
  }

  it("returns HTTP 200 (not 5xx) when the ML service throws a network error", async () => {
    fetchGreeksMock.mockRejectedValue(new Error("ECONNREFUSED"));
    predictIVRegimeMock.mockRejectedValue(new Error("ECONNREFUSED"));

    const res = await getRoute();
    expect(res.status).toBe(200);
  });

  it("response body includes the standard chain fields when ML service is down", async () => {
    fetchGreeksMock.mockRejectedValue(new Error("network error"));
    predictIVRegimeMock.mockRejectedValue(new Error("network error"));

    const res = await getRoute();
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty("underlying");
    expect(body).toHaveProperty("expiry");
  });

  it("each strike row has CE and PE entries or rows array", async () => {
    const res = await getRoute();
    const body = await res.json() as Record<string, unknown>;
    const rows = (body.rows ?? body.strikes) as unknown[];
    expect(Array.isArray(rows)).toBe(true);
  });

  it("response body includes an `iv_regime` field", async () => {
    const res = await getRoute();
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty("iv_regime");
  });

  it("`iv_regime` is null when the ML service is unreachable", async () => {
    predictIVRegimeMock.mockRejectedValue(new Error("ECONNREFUSED"));

    const res = await getRoute();
    const body = await res.json() as Record<string, unknown>;
    expect(body.iv_regime).toBeNull();
  });

  it("attempts to call the ML service analytics endpoint when the broker succeeds", async () => {
    const res = await getRoute();
    expect(res.status).toBe(200);
    // ML service is attempted (even if it fails gracefully)
    expect(fetchGreeksMock).toHaveBeenCalled();
  });

  it("returns HTTP 200 when ML service returns a 500 error response", async () => {
    predictIVRegimeMock.mockResolvedValue(null);
    fetchGreeksMock.mockResolvedValue(null);

    const res = await getRoute();
    expect(res.status).toBe(200);
  });

  it("`iv_regime` is null when the ML service returns HTTP 500", async () => {
    predictIVRegimeMock.mockResolvedValue(null);

    const res = await getRoute();
    const body = await res.json() as Record<string, unknown>;
    expect(body.iv_regime).toBeNull();
  });

  it("returns PCR and maxPain values from data-service2.0", async () => {
    const res = await getRoute();
    const body = await res.json() as Record<string, unknown>;
    // PCR and maxPain come from data-service2.0 chain
    expect(body.pcrOi ?? body.pcr).toBeDefined();
    expect(body.maxPain ?? body.max_pain).toBeDefined();
  });

  it("returns the symbol in the response", async () => {
    const res = await getRoute();
    const body = await res.json() as Record<string, unknown>;
    expect(body.underlying ?? body.symbol).toBeDefined();
  });
});
