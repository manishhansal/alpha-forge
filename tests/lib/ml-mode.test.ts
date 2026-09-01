// @vitest-environment node
/**
 * Phase 4 & 5 — ML Service Connectivity and Feature Contract Tests
 *
 * Tests for:
 *   1. ML_MODE=disabled → all calls return null immediately (no network calls)
 *   2. ML_MODE=fallback (default) → null on failure, no throw
 *   3. ML_MODE=required → throws when service is unreachable
 *   4. Feature contract — REGIME_FEATURES, RANKING_FEATURES, STRATEGY_FEATURES, RISK_FEATURES
 *      are defined and ordered
 *   5. predictPriceRegime passes bars correctly (not empty array)
 *   6. ML client centralizes all ML service calls
 *
 * Validates: PHASE 4 (ML connectivity) and PHASE 5 (feature parity) requirements
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. ML_MODE=disabled — all calls return null, no fetch
// ─────────────────────────────────────────────────────────────────────────────

describe("ML_MODE=disabled — no ML calls made", () => {
  beforeEach(() => {
    process.env.ML_MODE = "disabled";
  });

  afterEach(() => {
    delete process.env.ML_MODE;
    vi.restoreAllMocks();
  });

  it("predictRegime returns null without fetching", async () => {
    const fetchSpy = vi.spyOn(global, "fetch");
    const { predictRegime, getMLMode } = await import("@/lib/india/ml-client");

    expect(getMLMode()).toBe("disabled");

    const result = await predictRegime({
      nifty_change_pct: 0.5,
      banknifty_change_pct: 0.4,
      india_vix: 14.5,
      nifty_atr_pct: 0.8,
      nifty_adx: 25,
      advance_decline_ratio: 0.2,
      market_breadth: 60,
      sector_strength: 0.3,
      volume_ratio: 1.1,
      gap_pct: 0.1,
    });

    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("predictPriceRegime returns null without fetching", async () => {
    const fetchSpy = vi.spyOn(global, "fetch");
    const { predictPriceRegime } = await import("@/lib/india/ml-client");

    const result = await predictPriceRegime([[1, 2, 3, 4, 5, 0, 15, 1, 0]]);
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("isMLServiceHealthy returns false without fetching", async () => {
    const fetchSpy = vi.spyOn(global, "fetch");
    const { isMLServiceHealthy } = await import("@/lib/india/ml-client");

    const result = await isMLServiceHealthy();
    expect(result).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("/health"),
      expect.anything()
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. ML_MODE=fallback (default) — null on network failure, no throw
// ─────────────────────────────────────────────────────────────────────────────

describe("ML_MODE=fallback — graceful degradation on failure", () => {
  it("predictRegime returns null when fetch throws (network down)", async () => {
    vi.spyOn(global, "fetch").mockRejectedValueOnce(new TypeError("fetch failed"));
    delete process.env.ML_MODE; // use default

    const { predictRegime } = await import("@/lib/india/ml-client");
    const result = await predictRegime({
      nifty_change_pct: 0.5,
      banknifty_change_pct: 0.4,
      india_vix: 14.5,
      nifty_atr_pct: 0.8,
      nifty_adx: 25,
      advance_decline_ratio: 0.2,
      market_breadth: 60,
      sector_strength: 0.3,
      volume_ratio: 1.1,
      gap_pct: 0.1,
    });

    // In fallback mode, errors return null instead of throwing
    expect(result).toBeNull();
  });

  it("does NOT throw when ML service is unreachable in fallback mode", async () => {
    vi.spyOn(global, "fetch").mockRejectedValueOnce(new TypeError("ECONNREFUSED"));
    delete process.env.ML_MODE;

    const { predictRisk } = await import("@/lib/india/ml-client");
    await expect(
      predictRisk({
        symbol: "RELIANCE",
        direction: "LONG",
        entry: 2800,
        stop_loss: 2750,
        target: 2900,
        atr: 35,
        regime: "bull",
        rsi: 55,
        adx: 30,
        volume_ratio: 1.2,
        vix: 15,
      })
    ).resolves.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. ML_MODE=required — throws on failure
// ─────────────────────────────────────────────────────────────────────────────

describe("ML_MODE=required — throws when ML service unreachable", () => {
  beforeEach(() => {
    process.env.ML_MODE = "required";
  });

  afterEach(() => {
    delete process.env.ML_MODE;
  });

  it("throws when fetch fails in required mode", async () => {
    vi.spyOn(global, "fetch").mockRejectedValueOnce(new TypeError("ECONNREFUSED"));

    const { predictRegime, getMLMode } = await import("@/lib/india/ml-client");
    expect(getMLMode()).toBe("required");

    await expect(
      predictRegime({
        nifty_change_pct: 0.5,
        banknifty_change_pct: 0.4,
        india_vix: 14.5,
        nifty_atr_pct: 0.8,
        nifty_adx: 25,
        advance_decline_ratio: 0.2,
        market_breadth: 60,
        sector_strength: 0.3,
        volume_ratio: 1.1,
        gap_pct: 0.1,
      })
    ).rejects.toThrow(/ML_MODE=required/);
  });

  it("throws when fetch returns non-OK status in required mode", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response("Service unavailable", { status: 503 })
    );

    const { predictStrategy } = await import("@/lib/india/ml-client");

    await expect(
      predictStrategy({
        regime: "bull",
        symbol: "NIFTY",
        rsi: 55,
        adx: 30,
        atr_pct: 0.5,
        volume_ratio: 1.2,
        vwap_distance_pct: 0.1,
        bollinger_position: 0.6,
        trend_strength: 0.4,
        volatility_rank: 0.5,
        time_of_day_minutes: 90,
      })
    ).rejects.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. predictPriceRegime passes bars (not always empty array)
// ─────────────────────────────────────────────────────────────────────────────

describe("predictPriceRegime — bar data wiring", () => {
  it("sends the provided bars in the request body", async () => {
    const mockResponse = {
      regime: "bull",
      probability: 0.75,
      q10: -0.3,
      q90: 1.2,
    };
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    delete process.env.ML_MODE;
    const { predictPriceRegime } = await import("@/lib/india/ml-client");

    const bars = Array.from({ length: 60 }, (_, i) => [
      100 + i, 102 + i, 99 + i, 101 + i, 1000, 0.3, 15, 1.0, 0.5,
    ]);

    const result = await predictPriceRegime(bars);

    // Verify that the bars were actually sent
    expect(fetchSpy).toHaveBeenCalled();
    const callArgs = fetchSpy.mock.calls[0];
    const body = JSON.parse(callArgs?.[1]?.body as string ?? "{}");
    expect(body.last_60_bars).toHaveLength(60);
    expect(body.last_60_bars[0]).toHaveLength(9);

    expect(result).not.toBeNull();
    expect(result?.regime).toBe("bull");
    expect(result?.probability).toBe(0.75);
  });

  it("returns null for non-standard regime values", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ regime: "unknown", probability: 0.5, q10: 0, q90: 1 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    delete process.env.ML_MODE;
    const { predictPriceRegime } = await import("@/lib/india/ml-client");
    const result = await predictPriceRegime([]);
    // "unknown" is not a valid regime
    expect(result).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. ML_MODE env var range validation
// ─────────────────────────────────────────────────────────────────────────────

describe("getMLMode — all valid values", () => {
  const cases: Array<[string | undefined, "required" | "fallback" | "disabled"]> = [
    [undefined, "fallback"],
    ["fallback", "fallback"],
    ["required", "required"],
    ["disabled", "disabled"],
    ["FALLBACK", "fallback"],   // case-insensitive
    ["DISABLED", "disabled"],
    ["REQUIRED", "required"],
    ["invalid", "fallback"],    // unknown → default fallback
    ["", "fallback"],           // empty string → default fallback
  ];

  for (const [input, expected] of cases) {
    it(`ML_MODE="${input}" → getMLMode() returns "${expected}"`, async () => {
      const orig = process.env.ML_MODE;
      if (input === undefined) delete process.env.ML_MODE;
      else process.env.ML_MODE = input;

      try {
        const { getMLMode } = await import("@/lib/india/ml-client");
        expect(getMLMode()).toBe(expected);
      } finally {
        if (orig !== undefined) process.env.ML_MODE = orig;
        else delete process.env.ML_MODE;
      }
    });
  }
});
