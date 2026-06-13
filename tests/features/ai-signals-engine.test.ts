import { describe, expect, it } from "vitest";

import type {
  AiConfluenceFactor,
  AiFactorCategory,
} from "@/types/ai-signals";
import {
  buildReasons,
  buildTakeProfits,
  buildTimingWindow,
  buildTradeLevels,
  calibrateWinProbability,
  classifyAction,
  clamp,
  compositeScore,
  composeSummary,
  derivativeShare,
  directionFromAction,
  gradeFromConfidence,
  HORIZON_PROFILE,
  invalidationLine,
  makeFactor,
  pickHorizon,
  riskLevelFromConfidence,
  roundToTick,
  suggestPositionSizePct,
} from "@/features/ai-signals/engine";

function f(
  id: string,
  category: AiFactorCategory,
  weight: number,
  score: number,
  available = true,
): AiConfluenceFactor {
  return {
    id,
    category,
    label: id,
    weight,
    score,
    contribution: weight * score,
    available,
    description: id,
  };
}

describe("features/ai-signals/engine", () => {
  describe("clamp()", () => {
    it("clamps within bounds", () => {
      expect(clamp(5, 0, 10)).toBe(5);
      expect(clamp(-1, 0, 10)).toBe(0);
      expect(clamp(11, 0, 10)).toBe(10);
    });
  });

  describe("compositeScore()", () => {
    it("returns 0 when no factors are available", () => {
      const out = compositeScore([
        f("a", "technical", 0.5, 0.5, false),
        f("b", "macro", 0.5, -1, false),
      ]);
      expect(out.score).toBe(0);
      expect(out.confidence).toBe(0);
      expect(out.bullishCount).toBe(0);
      expect(out.bearishCount).toBe(0);
    });

    it("weights factors by their `weight` field", () => {
      // 0.8 weight on +1, 0.2 weight on -1 → net +0.6
      const out = compositeScore([
        f("a", "technical", 0.8, 1),
        f("b", "sentiment", 0.2, -1),
      ]);
      expect(out.score).toBeCloseTo(0.6, 5);
    });

    it("ignores unavailable factors in the numerator", () => {
      const out = compositeScore([
        f("a", "technical", 0.5, 1),
        f("b", "macro", 0.5, -1, false),
      ]);
      expect(out.score).toBeCloseTo(1, 5);
    });

    it("scales confidence by coverage AND magnitude", () => {
      const allAvailable = compositeScore([
        f("a", "technical", 0.5, 0.6),
        f("b", "macro", 0.5, 0.6),
      ]);
      const onlyOne = compositeScore([
        f("a", "technical", 0.5, 0.6),
        f("b", "macro", 0.5, 0, false),
      ]);
      expect(allAvailable.confidence).toBeGreaterThan(onlyOne.confidence);
      expect(allAvailable.confidence).toBeLessThanOrEqual(0.98);
    });

    it("counts bullish vs bearish factors correctly", () => {
      const out = compositeScore([
        f("a", "technical", 0.3, 0.5),
        f("b", "macro", 0.3, 0.7),
        f("c", "sentiment", 0.4, -0.3),
      ]);
      expect(out.bullishCount).toBe(2);
      expect(out.bearishCount).toBe(1);
    });
  });

  describe("classifyAction()", () => {
    it("returns WAIT when |score| is below the minMagnitude threshold", () => {
      expect(classifyAction(0.1, 0.5)).toBe("WAIT");
      expect(classifyAction(-0.05, 0.6)).toBe("WAIT");
    });

    it("returns LONG when score positive + derivatives dominant", () => {
      expect(classifyAction(0.5, 0.6, { allowPerps: true })).toBe("LONG");
    });

    it("returns BUY when score positive but derivatives minor", () => {
      expect(classifyAction(0.5, 0.1, { allowPerps: true })).toBe("BUY");
    });

    it("returns SHORT / SELL for negative scores symmetrically", () => {
      expect(classifyAction(-0.5, 0.6)).toBe("SHORT");
      expect(classifyAction(-0.5, 0.1)).toBe("SELL");
    });

    it("never returns LONG/SHORT when allowPerps is false", () => {
      expect(classifyAction(0.6, 0.9, { allowPerps: false })).toBe("BUY");
      expect(classifyAction(-0.6, 0.9, { allowPerps: false })).toBe("SELL");
    });
  });

  describe("directionFromAction()", () => {
    it("maps LONG/BUY → BULLISH, SHORT/SELL → BEARISH, WAIT → NEUTRAL", () => {
      expect(directionFromAction("LONG")).toBe("BULLISH");
      expect(directionFromAction("BUY")).toBe("BULLISH");
      expect(directionFromAction("SHORT")).toBe("BEARISH");
      expect(directionFromAction("SELL")).toBe("BEARISH");
      expect(directionFromAction("WAIT")).toBe("NEUTRAL");
    });
  });

  describe("gradeFromConfidence()", () => {
    it("publishes S for ≥85%", () => {
      expect(gradeFromConfidence(0.86)).toBe("S");
      expect(gradeFromConfidence(0.95)).toBe("S");
    });
    it("publishes A for 72-84", () => {
      expect(gradeFromConfidence(0.72)).toBe("A");
      expect(gradeFromConfidence(0.8)).toBe("A");
    });
    it("publishes B for 58-71", () => {
      expect(gradeFromConfidence(0.58)).toBe("B");
      expect(gradeFromConfidence(0.7)).toBe("B");
    });
    it("publishes C for 42-57 and D below", () => {
      expect(gradeFromConfidence(0.42)).toBe("C");
      expect(gradeFromConfidence(0.41)).toBe("D");
      expect(gradeFromConfidence(0)).toBe("D");
    });
  });

  describe("calibrateWinProbability()", () => {
    it("never exceeds 0.85 — no signal is 'almost certain'", () => {
      expect(calibrateWinProbability(1, 1)).toBeLessThanOrEqual(0.85);
    });
    it("never dips below 0.3 — even pure noise has coin-flip floor", () => {
      expect(calibrateWinProbability(0, 0)).toBeGreaterThanOrEqual(0.3);
    });
    it("increases monotonically with score magnitude", () => {
      const low = calibrateWinProbability(0.2, 0.5);
      const high = calibrateWinProbability(0.7, 0.5);
      expect(high).toBeGreaterThan(low);
    });
  });

  describe("suggestPositionSizePct()", () => {
    it("caps at the per-horizon ceiling so a tiny stop can't blow up sizing", () => {
      const entry = 100;
      const stop = 99.99; // 0.01% stop
      const size = suggestPositionSizePct(entry, stop, "scalp");
      expect(size).toBeLessThanOrEqual(HORIZON_PROFILE.scalp.sizingCapPct);
    });
    it("returns 0 on degenerate inputs", () => {
      expect(suggestPositionSizePct(0, 0, "scalp")).toBe(0);
      expect(suggestPositionSizePct(100, 100, "scalp")).toBe(0);
    });
    it("scales smaller for marginal confidence", () => {
      // Wider stop (10%) so the raw sizing sits comfortably below the
      // per-horizon cap and the confidence multiplier is what differentiates
      // the two outputs.
      const high = suggestPositionSizePct(100, 90, "intraday", {
        confidence: 0.9,
      });
      const low = suggestPositionSizePct(100, 90, "intraday", {
        confidence: 0.1,
      });
      expect(high).toBeGreaterThan(low);
    });
  });

  describe("riskLevelFromConfidence()", () => {
    it("reports low risk for high confidence + aligned stack", () => {
      expect(riskLevelFromConfidence(0.7, 0.9)).toBe("low");
    });
    it("reports medium for solid confidence", () => {
      expect(riskLevelFromConfidence(0.45, 0.6)).toBe("medium");
    });
    it("reports high for weak/contradictory reads", () => {
      expect(riskLevelFromConfidence(0.1, 0.3)).toBe("high");
    });
  });

  describe("buildTakeProfits()", () => {
    it("returns 3 levels with allocations summing to 1", () => {
      const tps = buildTakeProfits(100, 5, "intraday", true);
      expect(tps.length).toBe(3);
      const total = tps.reduce((s, t) => s + t.allocation, 0);
      expect(total).toBeCloseTo(1, 5);
    });
    it("places long-side TPs above entry, short-side below", () => {
      const long = buildTakeProfits(100, 5, "intraday", true);
      const short = buildTakeProfits(100, 5, "intraday", false);
      expect(long.every((t) => t.price > 100)).toBe(true);
      expect(short.every((t) => t.price < 100)).toBe(true);
    });
    it("widens as horizon increases", () => {
      const scalpTp1 = buildTakeProfits(100, 1, "scalp", true)[0].price;
      const posTp1 = buildTakeProfits(100, 1, "positional", true)[0].price;
      expect(posTp1).toBeGreaterThan(scalpTp1);
    });
  });

  describe("buildTradeLevels()", () => {
    it("computes RR ≈ targetMult/stopMult for the chosen horizon", () => {
      const out = buildTradeLevels({
        underlyingPrice: 100,
        atr: 5,
        horizon: "intraday",
        bullish: true,
      });
      const expectedRR =
        HORIZON_PROFILE.intraday.targetAtrMults[0] /
        HORIZON_PROFILE.intraday.stopAtrMult;
      expect(out.riskReward).toBeCloseTo(expectedRR, 5);
      expect(out.stopLoss).toBeLessThan(100);
      expect(out.takeProfits[0].price).toBeGreaterThan(100);
    });
  });

  describe("buildTimingWindow()", () => {
    it("returns a positive validForMs equal to horizon profile", () => {
      const tw = buildTimingWindow({
        now: 0,
        horizon: "scalp",
        inActiveWindow: true,
        windowLabel: "Power Hour",
      });
      expect(tw.validForMs).toBe(HORIZON_PROFILE.scalp.validForMs);
      expect(tw.exitBy).toBe(HORIZON_PROFILE.scalp.validForMs);
      expect(tw.bestEntryNote).toContain("Power Hour");
    });
    it("flips to a 'wait for window' note when outside the active session", () => {
      const tw = buildTimingWindow({
        now: 0,
        horizon: "intraday",
        inActiveWindow: false,
        windowLabel: "Worst Zone",
      });
      expect(tw.bestEntryNote).toMatch(/wait/i);
    });
  });

  describe("makeFactor()", () => {
    it("publishes an unavailable factor for null inputs", () => {
      const out = makeFactor({
        id: "x",
        category: "technical",
        label: "X",
        weight: 0.1,
        raw: null,
        denominator: 1,
        describe: () => "x",
      });
      expect(out.available).toBe(false);
      expect(out.score).toBe(0);
      expect(out.contribution).toBe(0);
    });
    it("clamps raw/denominator to [-1, 1] and flips score when invert=true", () => {
      const out = makeFactor({
        id: "y",
        category: "macro",
        label: "Y",
        weight: 0.2,
        raw: 5,
        denominator: 1,
        invert: true,
        describe: () => "y",
      });
      expect(out.score).toBe(-1);
      expect(out.contribution).toBeCloseTo(-0.2, 5);
    });
  });

  describe("buildReasons()", () => {
    it("returns at most `limit` entries, sorted by |contribution|", () => {
      const factors: AiConfluenceFactor[] = [
        f("a", "technical", 0.1, 0.5),
        f("b", "macro", 0.5, 0.8),
        f("c", "sentiment", 0.2, -0.9),
        f("d", "flow", 0.1, 0.0, false),
      ];
      const r = buildReasons(factors, { limit: 2 });
      expect(r.length).toBe(2);
      // Largest |contribution| = b (0.4), then c (0.18)
      expect(r[0].text).toContain("b");
      expect(r[1].text).toContain("c");
    });
  });

  describe("derivativeShare()", () => {
    it("computes the weight ratio of factors in the derivative set", () => {
      const factors: AiConfluenceFactor[] = [
        f("rsi", "technical", 0.2, 0.5),
        f("oi", "derivatives", 0.3, 0.5),
        f("funding", "derivatives", 0.2, 0.5),
        f("sent", "sentiment", 0.3, 0.5),
      ];
      const ds = derivativeShare(factors, new Set(["oi", "funding"]));
      // (0.3 + 0.2) / 1 = 0.5
      expect(ds).toBeCloseTo(0.5, 5);
    });
  });

  describe("roundToTick()", () => {
    it("rounds to the nearest tick", () => {
      expect(roundToTick(101.23, 0.05)).toBe(101.25);
      expect(roundToTick(101.22, 0.05)).toBe(101.2);
      expect(roundToTick(101_234.7, 5)).toBe(101_235);
    });
  });

  describe("pickHorizon()", () => {
    it("returns swing when outside the active window", () => {
      expect(
        pickHorizon({
          inActiveWindow: false,
          derivativeShare: 0.5,
          scoreMagnitude: 0.6,
        }),
      ).toBe("swing");
    });
    it("returns scalp for derivative-heavy strong reads inside the window", () => {
      expect(
        pickHorizon({
          inActiveWindow: true,
          derivativeShare: 0.6,
          scoreMagnitude: 0.6,
        }),
      ).toBe("scalp");
    });
    it("returns intraday for moderate-conviction reads", () => {
      expect(
        pickHorizon({
          inActiveWindow: true,
          derivativeShare: 0.2,
          scoreMagnitude: 0.4,
        }),
      ).toBe("intraday");
    });
  });

  describe("composeSummary()", () => {
    it("includes WAIT phrasing for WAIT signals", () => {
      const out = composeSummary({
        action: "WAIT",
        symbol: "BTC",
        grade: "C",
        confidenceScore: 30,
        reasons: [],
        horizon: "intraday",
      });
      expect(out).toMatch(/WAIT on BTC/);
    });
    it("includes the top reason for non-WAIT signals", () => {
      const out = composeSummary({
        action: "LONG",
        symbol: "NIFTY",
        grade: "A",
        confidenceScore: 75,
        reasons: [
          { category: "derivatives", text: "PCR 1.4 — bullish bias", bullish: true },
        ],
        horizon: "swing",
      });
      expect(out).toMatch(/LONG NIFTY/);
      expect(out).toMatch(/PCR 1.4/);
    });
  });

  describe("invalidationLine()", () => {
    it("phrases the stop in market-appropriate language", () => {
      const out = invalidationLine({
        bullish: true,
        stopLoss: 100.5,
        horizon: "scalp",
      });
      expect(out).toContain("1m close below");
      expect(out).toContain("100.50");
    });
    it("flips below/above for bearish setups", () => {
      const out = invalidationLine({
        bullish: false,
        stopLoss: 50,
        horizon: "swing",
      });
      expect(out).toContain("daily close above");
    });
  });
});
