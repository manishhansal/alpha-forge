/**
 * Failing tests for the TFT-enhanced buildMLContext() function.
 *
 * These tests are written BEFORE the implementation exists:
 *   - `priceForecast` field is not yet returned by `buildMLContext()`
 *   - The ±0.05 confidence delta for TFT/heuristic disagreement is not yet
 *     wired into the India AI signal pipeline.
 *
 * They will fail until Task 10.2 (TFT implementation) and Task 10.3
 * (integration into india-builder.ts) are complete.
 *
 * This is the TDD red phase — all tests marked with "TDD red" are expected
 * to FAIL initially.
 *
 * Validates: Requirements 8.3, 8.5, 8.6
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock the ML client so no real HTTP calls are made.
// The ml-enhanced-context module is imported from @/lib/india/ml-enhanced-context.
// ---------------------------------------------------------------------------

vi.mock("@/lib/india/ml-client", () => ({
  isMLServiceHealthy: vi.fn(),
  mlRegimeToAiRegime: vi.fn((r: string) => {
    if (r === "bull" || r === "strong_bull") return "bullish";
    if (r === "bear" || r === "crash") return "bearish";
    return "neutral";
  }),
  mlRegimeToScore: vi.fn((r: string) => {
    if (r === "bull") return 0.5;
    if (r === "bear") return -0.5;
    return 0;
  }),
  predictRegime: vi.fn(),
  predictRankings: vi.fn(),
  predictRisk: vi.fn(),
  predictStrategy: vi.fn(),
  predictPortfolio: vi.fn(),
}));

import {
  isMLServiceHealthy,
  predictRegime,
  predictRankings,
} from "@/lib/india/ml-client";

// The module under test — imports will succeed because ml-enhanced-context
// already exists. The priceForecast field however is not yet present (TDD red).
import { buildMLContext, invalidateMLCache } from "@/lib/india/ml-enhanced-context";

// ---------------------------------------------------------------------------
// Type assertions
// ---------------------------------------------------------------------------

type MLEnhancedContextWithForecast = Awaited<ReturnType<typeof buildMLContext>> & {
  /** TFT price regime forecast (Phase 2 Task 10 addition — not yet present). */
  priceForecast?: {
    regime: "bull" | "bear" | "flat";
    probability: number;
    q10: number;
    q90: number;
  } | null;
};

// ---------------------------------------------------------------------------
// Shared test fixture — minimal valid MLContextInputs
// ---------------------------------------------------------------------------

const BASE_INPUTS = {
  niftyChangePct: 0.5,
  bankniftyChangePct: 0.4,
  indiaVix: 14.5,
  niftyAtrPct: 0.8,
  niftyAdx: 25,
  advanceDeclineRatio: 0.2,
  marketBreadth: 0.6,
  sectorStrength: 0.3,
  volumeRatio: 1.1,
  gapPct: 0.1,
};

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

const mockIsHealthy = isMLServiceHealthy as ReturnType<typeof vi.fn>;
const mockPredictRegime = predictRegime as ReturnType<typeof vi.fn>;
const mockPredictRankings = predictRankings as ReturnType<typeof vi.fn>;

beforeEach(() => {
  // Invalidate cache between tests so we get fresh results.
  invalidateMLCache();

  mockIsHealthy.mockReset();
  mockPredictRegime.mockReset();
  mockPredictRankings.mockReset();

  // Default: ML service is healthy and returns a bull regime.
  mockIsHealthy.mockResolvedValue(true);
  mockPredictRegime.mockResolvedValue({
    regime: "bull",
    confidence: 0.72,
    score: 0.5,
    features: {},
  });
  mockPredictRankings.mockResolvedValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
  invalidateMLCache();
});

// ---------------------------------------------------------------------------
// Test group 1 — buildMLContext() includes priceForecast field (TDD red)
// ---------------------------------------------------------------------------

describe("buildMLContext() — priceForecast field (Requirements 8.3, 8.5)", () => {
  it("returns an object with a priceForecast property", async () => {
    // TDD red: priceForecast does not yet exist — this will fail until Task 10.3.
    const ctx = (await buildMLContext(BASE_INPUTS)) as MLEnhancedContextWithForecast;

    expect(ctx).toHaveProperty("priceForecast");
  });

  it("priceForecast is null when ML service is offline (graceful degradation)", async () => {
    // Requirement 8.6: when ML service is offline, TFT forecast chip is absent.
    mockIsHealthy.mockResolvedValue(false);

    const ctx = (await buildMLContext(BASE_INPUTS)) as MLEnhancedContextWithForecast;

    expect(ctx).toHaveProperty("priceForecast");
    // When the ML service is offline the field should be null, not throw.
    expect(ctx.priceForecast).toBeNull();
  });

  it("priceForecast.regime is one of bull | bear | flat when ML service is available", async () => {
    // The TFT forecast endpoint returns {regime, probability, q10, q90}.
    // Here we verify the regime value is constrained to valid classes.
    const ctx = (await buildMLContext(BASE_INPUTS)) as MLEnhancedContextWithForecast;

    if (ctx.priceForecast !== null && ctx.priceForecast !== undefined) {
      expect(["bull", "bear", "flat"]).toContain(ctx.priceForecast.regime);
    }
    // If priceForecast is null, the test still passes (graceful degradation).
  });

  it("priceForecast.probability is in [0, 1] when present", async () => {
    const ctx = (await buildMLContext(BASE_INPUTS)) as MLEnhancedContextWithForecast;

    if (ctx.priceForecast !== null && ctx.priceForecast !== undefined) {
      expect(ctx.priceForecast.probability).toBeGreaterThanOrEqual(0);
      expect(ctx.priceForecast.probability).toBeLessThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Test group 2 — TFT/heuristic disagreement applies ±0.05 confidence delta
// (TDD red)
// ---------------------------------------------------------------------------

describe(
  "India AI signal — TFT/heuristic disagreement confidence delta (Requirement 8.5)",
  () => {
    /**
     * The spec says:
     *   "WHEN the buildMLContext() function receives a TFT forecast whose
     *    regime disagrees with the heuristic direction, THE System SHALL apply
     *    a ±0.05 confidence delta to the AI signal."
     *
     * To test this we need to import the signal builder internals and
     * pass a TFT forecast that contradicts the heuristic.
     *
     * Because the priceForecast field does not exist yet, we test the
     * CONTRACT: when the context includes a priceForecast with an opposing
     * regime, the resulting AI signal confidence changes by approximately 0.05.
     *
     * These tests import buildMLContext and check the resulting context shape.
     * The actual confidence delta test will need the signal builder to be
     * updated to read priceForecast (Task 10.3), at which point these tests
     * will also become meaningful.
     */

    it("context includes priceForecast when TFT endpoint returns a forecast", async () => {
      // TDD red: this documents the expected contract — the context should
      // carry priceForecast for downstream signal confidence adjustment.
      const ctx = (await buildMLContext(BASE_INPUTS)) as MLEnhancedContextWithForecast;

      // Until Task 10.3 wires this in, priceForecast will not be present,
      // and this assertion will fail — that is expected.
      expect(ctx).toHaveProperty("priceForecast");
    });

    it(
      "priceForecast.regime can differ from the ML regime regime (independent forecaster)",
      async () => {
        // The TFT forecaster is independent of the existing market-regime model.
        // Even when the ML regime returns "bull", the TFT may return "bear".
        // This test documents that the context should hold both values separately.
        mockPredictRegime.mockResolvedValue({
          regime: "bear",
          confidence: 0.65,
          score: -0.5,
          features: {},
        });

        const ctx = (await buildMLContext(BASE_INPUTS)) as MLEnhancedContextWithForecast;

        // priceForecast.regime is from the TFT endpoint (/predict/price-regime).
        // ctx.regime is from the existing market-regime model (/predict/regime).
        // They are independent — both should be accessible on the context.
        expect(ctx).toHaveProperty("priceForecast");
        // The existing regime field should still be present.
        expect(ctx).toHaveProperty("regime");
      },
    );
  },
);
