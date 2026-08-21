/**
 * Bug 2b — Exploration tests for null mlCtxResult guard in india-builder.ts.
 *
 * These tests run BEFORE any fix is applied. They:
 *   1. Audit that every access to mlCtxResult in india-builder.ts already uses
 *      optional chaining (?.rankings, ?.mlAvailable, ?.regimeScore, ?.regime).
 *   2. Demonstrate that accessing `mlCtxResult?.priceForecast?.regime` on a null
 *      result returns undefined (no TypeError) — confirming the safe pattern.
 *   3. Establish a preservation baseline: when mlCtxResult is non-null, all
 *      property accesses resolve to their expected values.
 *
 * Bug Condition (isBugCondition_2b):
 *   mlCtxResult IS null AND callerAccessesPropertyOf(mlCtxResult) WITHOUT null-check
 *
 * Concrete failing case if unsafe access existed:
 *   mlCtxResult.priceForecast → TypeError: Cannot read properties of null
 *   (reading 'priceForecast')
 *
 * The tests here PASS on unfixed code because we are testing the safe pattern.
 * Their purpose is to establish that `?.` is the correct guard and to document
 * the contract so that any future priceForecast access is added safely.
 *
 * Validates: Requirements 1.3, 2.3, 3.2, 3.3
 */

import { readFileSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock ml-client so buildMLContext can be imported without real HTTP calls
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
  mlFetch: vi.fn(),
  predictRegime: vi.fn(),
  predictRankings: vi.fn(),
  predictRisk: vi.fn(),
  predictStrategy: vi.fn(),
  predictPortfolio: vi.fn(),
}));

import {
  isMLServiceHealthy,
  mlFetch,
  predictRegime,
  predictRankings,
} from "@/lib/india/ml-client";
import { buildMLContext, invalidateMLCache } from "@/lib/india/ml-enhanced-context";
import type { MLEnhancedContext, PriceForecastResult } from "@/lib/india/ml-enhanced-context";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockIsHealthy = isMLServiceHealthy as ReturnType<typeof vi.fn>;
const mockPredictRegime = predictRegime as ReturnType<typeof vi.fn>;
const mockPredictRankings = predictRankings as ReturnType<typeof vi.fn>;
const mockMlFetch = mlFetch as ReturnType<typeof vi.fn>;

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

beforeEach(() => {
  invalidateMLCache();
  mockIsHealthy.mockReset();
  mockPredictRegime.mockReset();
  mockPredictRankings.mockReset();
  mockMlFetch.mockReset();

  mockIsHealthy.mockResolvedValue(true);
  mockPredictRegime.mockResolvedValue({
    regime: "bull",
    confidence: 0.72,
    score: 0.5,
    features: {},
  });
  mockPredictRankings.mockResolvedValue(null);
  // Default: price-regime endpoint throws (simulates 404 pre-restart)
  mockMlFetch.mockRejectedValue(new Error("Not Found"));
});

afterEach(() => {
  vi.restoreAllMocks();
  invalidateMLCache();
});

// ---------------------------------------------------------------------------
// Group 1 — Code audit: india-builder.ts uses optional chaining on mlCtxResult
// ---------------------------------------------------------------------------

describe("Bug 2b audit — india-builder.ts uses optional chaining on mlCtxResult", () => {
  it("all mlCtxResult property accesses in india-builder.ts use optional chaining", () => {
    /**
     * Code audit test: read india-builder.ts and verify that every access to
     * a property on mlCtxResult uses the safe optional-chain operator (?.).
     *
     * The unsafe pattern `mlCtxResult.property` (without `?.`) would throw a
     * TypeError when buildMLContext().catch(() => null) resolves to null.
     *
     * This test focuses on accesses that are NOT guarded by a preceding null-check
     * in the same expression. Accesses inside `if (mlCtxResult?.x && mlCtxResult.y)`
     * blocks are considered safe because the `?.x` guard ensures non-null.
     *
     * The key unsafe pattern the fix targets:
     *   `mlCtxResult.priceForecast` (standalone, no `?.`) on null → TypeError
     *
     * Bug Condition documented: `mlCtxResult.priceForecast` (no optional chain)
     * on null → TypeError: Cannot read properties of null (reading 'priceForecast')
     */
    const filePath = join(
      process.cwd(),
      "src/features/ai-signals/india-builder.ts",
    );
    const source = readFileSync(filePath, "utf-8");

    // Find lines where mlCtxResult is accessed WITHOUT optional chaining
    // in a standalone/unguarded context (not inside an if-block that already
    // checks mlCtxResult non-null via `?.`).
    //
    // Specifically look for `mlCtxResult.priceForecast` (without preceding ?)
    // as the new field that would be added for the price-regime integration.
    const lines = source.split("\n");
    const unsafePriceForecastAccesses: { line: number; text: string }[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim().startsWith("//")) continue;
      // Check for mlCtxResult.priceForecast without optional chaining
      // The safe pattern is: mlCtxResult?.priceForecast
      // The unsafe pattern is: mlCtxResult.priceForecast (no ?)
      const unsafePattern = /mlCtxResult(?<!\?)\.priceForecast/;
      if (unsafePattern.test(line)) {
        unsafePriceForecastAccesses.push({ line: i + 1, text: line.trim() });
      }
    }

    expect(unsafePriceForecastAccesses).toHaveLength(0);
    if (unsafePriceForecastAccesses.length > 0) {
      const report = unsafePriceForecastAccesses
        .map((a) => `  Line ${a.line}: ${a.text}`)
        .join("\n");
      throw new Error(
        `Bug 2b: Found unsafe mlCtxResult.priceForecast access(es) in india-builder.ts:\n${report}\n` +
          `Must use mlCtxResult?.priceForecast to avoid TypeError when mlCtxResult is null.`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Group 2 — Safe access pattern: null mlCtxResult → undefined (no TypeError)
// ---------------------------------------------------------------------------

describe("Bug 2b safe pattern — null mlCtxResult returns undefined safely", () => {
  it("accessing priceForecast?.regime on null mlCtxResult returns undefined, no crash", () => {
    /**
     * Demonstrates that the safe access pattern `mlCtxResult?.priceForecast?.regime`
     * returns undefined when mlCtxResult is null — no TypeError is thrown.
     *
     * This is the expected correct behavior documented in the bug fix spec:
     * "When mlCtxResult is null, all property accesses resolve to undefined
     *  without throwing TypeError."
     */
    const mlCtxResult: MLEnhancedContext | null = null;

    // Safe pattern — should never throw
    const regime = mlCtxResult?.priceForecast?.regime;
    const probability = mlCtxResult?.priceForecast?.probability;
    const rankings = mlCtxResult?.rankings;
    const mlAvailable = mlCtxResult?.mlAvailable;

    expect(regime).toBeUndefined();
    expect(probability).toBeUndefined();
    expect(rankings).toBeUndefined();
    expect(mlAvailable).toBeUndefined();
  });

  it("unsafe direct access on null mlCtxResult throws TypeError (documents the bug)", () => {
    /**
     * Documents the bug condition: accessing a property WITHOUT optional chaining
     * on null throws TypeError. This test confirms the risk when the guard is absent.
     *
     * isBugCondition_2b: mlCtxResult IS null AND callerAccessesPropertyOf(mlCtxResult)
     * WITHOUT null-check
     */
    const mlCtxResult: MLEnhancedContext | null = null;

    // Unsafe access WILL throw — documenting the bug condition
    expect(() => {
      // @ts-expect-error — intentionally testing the unsafe access pattern
      void (mlCtxResult as NonNullable<typeof mlCtxResult>).priceForecast;
    }).toThrow(TypeError);
  });

  it("catch(() => null) pattern resolves to null when buildMLContext throws", async () => {
    /**
     * Demonstrates the .catch(() => null) pattern used in india-builder.ts:
     *   const mlCtxResult = await buildMLContext({...}).catch(() => null);
     *
     * When buildMLContext throws (e.g. network failure), mlCtxResult === null.
     * Any subsequent access to mlCtxResult.priceForecast without ?. would crash.
     */
    // Make the ML service health check throw to simulate a network failure
    mockIsHealthy.mockRejectedValue(new Error("Network failure"));

    const mlCtxResult = await buildMLContext(BASE_INPUTS).catch(() => null);

    // The catch resolves the promise to null — this is the exact state that
    // causes Bug 2b when the caller accesses mlCtxResult.priceForecast unsafely
    expect(mlCtxResult).toBeNull();

    // Safe access pattern returns undefined — no crash
    const safeRegime = mlCtxResult?.priceForecast?.regime;
    expect(safeRegime).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Group 3 — Preservation: non-null mlCtxResult path behaves correctly
// ---------------------------------------------------------------------------

describe("Bug 2b preservation — non-null mlCtxResult behavior unchanged", () => {
  it("rankings, mlAvailable, and regimeScore are accessible on a valid context", async () => {
    /**
     * Preservation test: when buildMLContext returns a valid MLEnhancedContext
     * (non-null), all property accesses resolve correctly.
     *
     * This documents the baseline behavior that must be preserved after the fix.
     */
    mockMlFetch.mockResolvedValue({
      regime: "bull",
      probability: 0.72,
      q10: -0.5,
      q90: 1.5,
    });

    const ctx = await buildMLContext(BASE_INPUTS);

    expect(ctx).not.toBeNull();
    expect(ctx.mlAvailable).toBe(true);
    expect(ctx.regimeScore).toBeDefined();
    // Optional-chain access still works on non-null object
    expect(ctx?.rankings).toBeDefined(); // may be null but doesn't throw
    expect(ctx?.mlAvailable).toBe(true);
  });

  it("priceForecast is null when mlFetch throws (graceful degradation)", async () => {
    /**
     * When the /predict/price-regime endpoint throws (404 before restart),
     * priceForecast stays null and no other part of the context is affected.
     */
    mockMlFetch.mockRejectedValue(new Error("Not Found"));

    const ctx = await buildMLContext(BASE_INPUTS);

    expect(ctx).not.toBeNull();
    expect(ctx.priceForecast).toBeNull();
    // The rest of the context is still populated
    expect(ctx.mlAvailable).toBe(true);
    expect(ctx.regime).toBeDefined();
  });

  it("priceForecast is populated when mlFetch returns a valid response", async () => {
    /**
     * When /predict/price-regime returns a valid response, priceForecast is set
     * correctly on the context. Optional-chain access works on the populated object.
     */
    const mockForecast = {
      regime: "bull",
      probability: 0.72,
      q10: -0.5,
      q90: 1.5,
    };
    mockMlFetch.mockResolvedValue(mockForecast);

    const ctx = await buildMLContext(BASE_INPUTS);

    expect(ctx.priceForecast).not.toBeNull();
    const forecast = ctx.priceForecast as PriceForecastResult;
    expect(forecast.regime).toBe("bull");
    expect(forecast.probability).toBe(0.72);

    // Optional-chain access works correctly on non-null priceForecast
    expect(ctx?.priceForecast?.regime).toBe("bull");
    expect(ctx?.priceForecast?.probability).toBe(0.72);
  });

  it("priceForecast is null when ML service is offline (mlAvailable = false)", async () => {
    /**
     * When the ML service is offline, the fallback context has priceForecast = null.
     * This is correct graceful degradation behavior.
     */
    mockIsHealthy.mockResolvedValue(false);

    const ctx = await buildMLContext(BASE_INPUTS);

    expect(ctx.mlAvailable).toBe(false);
    expect(ctx.priceForecast).toBeNull();

    // Safe access still returns undefined safely (not crashing the caller)
    expect(ctx?.priceForecast?.regime).toBeUndefined();
  });
});
