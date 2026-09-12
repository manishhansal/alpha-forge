/**
 * Tests for strategy-specific, regime-specific signal scoring.
 *
 * Proves:
 *   • different strategies get different feature weights (no universal formula)
 *   • a feature strong for ORB is NOT auto-strong for mean-reversion
 *   • learned weights are regime-specific
 *   • poor-in-regime strategies are suppressed by the selector
 *   • strategyHealth / alpha-decay need statistically meaningful evidence
 *   • recommendedStatus mapping (ACTIVE/CAUTION/SHADOW/DISABLED), no auto-LIVE
 *   • determinism
 */

import { describe, it, expect } from "vitest";
import {
  INDIA_STRATEGIES,
  STRATEGY_PROFILES,
  getStrategyProfile,
  priorWeights,
  learnFeatureImportance,
  learnCellImportance,
  resolveFeatureWeights,
  scoreStrategyFeatures,
  computeStrategyHealth,
  detectAlphaDecay,
  wilsonLowerBound,
  buildStrategyRegimeMatrix,
  recommendStatus,
  selectStrategiesForRegime,
  RELEVANCE_PRIOR,
  type FeatureImportanceObs,
  type IndiaStrategy,
  type SrsRegime,
  type SrsFeature,
  type StrategyTrade,
} from "@/lib/signal-intelligence/strategy-regime-scoring";

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (1664525 * s + 1013904223) >>> 0; return s / 0xffffffff; };
}
const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

/**
 * Generate importance observations where the DRIVER feature determines the
 * outcome and the OTHER feature is pure noise. This lets us assert the learner
 * assigns high weight to the driver and low weight to the noise — differently
 * per strategy.
 */
function makeObs(
  n: number,
  seed: number,
  strategyId: IndiaStrategy,
  regime: SrsRegime,
  driver: SrsFeature,
  noise: SrsFeature,
): FeatureImportanceObs[] {
  const rng = lcg(seed);
  const out: FeatureImportanceObs[] = [];
  for (let i = 0; i < n; i++) {
    const d = rng();                     // driver value
    const trueP = clamp01(0.2 + 0.6 * d); // outcome driven by the driver
    const win = rng() < trueP ? 1 : 0;
    out.push({
      strategyId,
      regime,
      timeframe: "INTRADAY",
      features: {
        [driver]: clamp01(d + (rng() - 0.5) * 0.1),
        [noise]: rng(), // pure noise, uncorrelated with outcome
      },
      label: win as 0 | 1,
      returnR: win === 1 ? 1.8 : -1.0,
    });
  }
  return out;
}

function makeTrades(
  n: number,
  seed: number,
  strategyId: IndiaStrategy,
  regime: SrsRegime,
  winProb: number,
  opts: { decayHalf?: number } = {},
): StrategyTrade[] {
  const rng = lcg(seed);
  const out: StrategyTrade[] = [];
  for (let i = 0; i < n; i++) {
    // optional decay: second half has a lower win prob
    const p = opts.decayHalf != null && i >= n / 2 ? opts.decayHalf : winProb;
    const win = rng() < p ? 1 : 0;
    out.push({
      strategyId,
      regime,
      label: win as 0 | 1,
      returnR: win === 1 ? 1.8 : -1.0,
      outcomeMs: 1_700_000_000_000 + i * 3_600_000,
    });
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════

describe("StrategyProfiles — structure", () => {
  it("has a profile for every strategy with distinct feature relevance maps", () => {
    for (const s of INDIA_STRATEGIES) {
      const p = getStrategyProfile(s);
      expect(p).not.toBeNull();
      expect(p!.suitableRegimes.length).toBeGreaterThan(0);
    }
    // The universal-formula smell test: ORB and mean-reversion must NOT share
    // the same feature-relevance map.
    const orb = STRATEGY_PROFILES.OPENING_BREAKOUT.featureRelevance;
    const mr = STRATEGY_PROFILES.PCR_EXTREME.featureRelevance;
    expect(JSON.stringify(orb)).not.toBe(JSON.stringify(mr));
  });

  it("prior weights reflect relevance classes (REQUIRED > SUPPORTING > 0 > ADVERSE)", () => {
    expect(RELEVANCE_PRIOR.REQUIRED).toBeGreaterThan(RELEVANCE_PRIOR.SUPPORTING);
    expect(RELEVANCE_PRIOR.SUPPORTING).toBeGreaterThan(RELEVANCE_PRIOR.IRRELEVANT);
    expect(RELEVANCE_PRIOR.IRRELEVANT).toBeGreaterThan(RELEVANCE_PRIOR.ADVERSE);
    // mean-reversion treats strong trend as ADVERSE (negative prior)
    const mrW = priorWeights(STRATEGY_PROFILES.PCR_EXTREME);
    expect(mrW.trendStack).toBeLessThan(0);
    // ORB treats breakout volume as REQUIRED (max prior)
    const orbW = priorWeights(STRATEGY_PROFILES.OPENING_BREAKOUT);
    expect(orbW.breakoutVolume).toBe(RELEVANCE_PRIOR.REQUIRED);
  });
});

describe("strategy-specific feature importance (NOT universal)", () => {
  it("the SAME feature earns different learned weights for ORB vs mean-reversion", () => {
    // For ORB, breakoutVolume drives outcomes; rsi is noise.
    const orbObs = makeObs(600, 11, "OPENING_BREAKOUT", "BULL_TREND", "breakoutVolume", "rsi");
    // For PCR_EXTREME (mean-reversion), rsi drives outcomes; breakoutVolume is noise.
    const mrObs = makeObs(600, 12, "PCR_EXTREME", "RANGE", "rsi", "breakoutVolume");

    const orbCell = learnCellImportance("OPENING_BREAKOUT", "BULL_TREND", "INTRADAY", orbObs, STRATEGY_PROFILES.OPENING_BREAKOUT, { minSample: 50 });
    const mrCell = learnCellImportance("PCR_EXTREME", "RANGE", "INTRADAY", mrObs, STRATEGY_PROFILES.PCR_EXTREME, { minSample: 50 });

    // breakoutVolume should weigh MORE for ORB than for mean-reversion
    expect(orbCell.effectiveWeights.breakoutVolume!).toBeGreaterThan(mrCell.effectiveWeights.breakoutVolume ?? -1);
    // rsi should weigh MORE for mean-reversion than for ORB
    expect(mrCell.effectiveWeights.rsi!).toBeGreaterThan(orbCell.effectiveWeights.rsi ?? -1);
    // and the driver beats the noise WITHIN each strategy
    expect(orbCell.effectiveWeights.breakoutVolume!).toBeGreaterThan(orbCell.effectiveWeights.rsi ?? -1);
    expect(mrCell.effectiveWeights.rsi!).toBeGreaterThan(mrCell.effectiveWeights.breakoutVolume ?? -1);
  });

  it("learned weights differ across REGIMES for the same strategy", () => {
    // MOMENTUM: momentum drives in trend, but is noise in a range.
    const trendObs = makeObs(600, 21, "MOMENTUM", "BULL_TREND", "momentum", "rsi");
    const rangeObs = makeObs(600, 22, "MOMENTUM", "RANGE", "rsi", "momentum");
    const model = learnFeatureImportance([...trendObs, ...rangeObs], { minSample: 50 });
    const trendW = resolveFeatureWeights("MOMENTUM", "BULL_TREND", "INTRADAY", model).weights.momentum!;
    const rangeW = resolveFeatureWeights("MOMENTUM", "RANGE", "INTRADAY", model).weights.momentum!;
    expect(trendW).toBeGreaterThan(rangeW);
  });

  it("falls back to profile priors when there is no learned cell", () => {
    const { provenance, weights } = resolveFeatureWeights("IV_SPIKE", "HIGH_VOL", "INTRADAY", null);
    expect(provenance).toBe("PRIOR_ONLY");
    expect(weights.ivRegime).toBe(RELEVANCE_PRIOR.REQUIRED);
  });

  it("scoreStrategyFeatures: adverse features push the score down", () => {
    // mean-reversion with a strong trend present (adverse) should score lower
    // than the same setup without the trend signal.
    const withTrend = scoreStrategyFeatures("PCR_EXTREME", "RANGE", "INTRADAY",
      { pcr: 0.9, rsi: 0.9, vwapDistance: 0.9, volatilityExpansion: 0.8, trendStack: 0.95 }, null);
    const withoutTrend = scoreStrategyFeatures("PCR_EXTREME", "RANGE", "INTRADAY",
      { pcr: 0.9, rsi: 0.9, vwapDistance: 0.9, volatilityExpansion: 0.8, trendStack: 0.05 }, null);
    expect(withTrend.score).toBeLessThan(withoutTrend.score);
  });

  it("scoreStrategyFeatures is deterministic", () => {
    const f = { breakoutVolume: 0.8, vwapAlignment: 0.7, marketRegimeFit: 0.9, openingRangeStructure: 0.85 };
    const a = scoreStrategyFeatures("OPENING_BREAKOUT", "BULL_TREND", "INTRADAY", f, null);
    const b = scoreStrategyFeatures("OPENING_BREAKOUT", "BULL_TREND", "INTRADAY", f, null);
    expect(a.score).toBe(b.score);
  });
});

describe("strategyHealth + alpha decay (statistically meaningful)", () => {
  it("a few losses do NOT flip a healthy strategy to decaying", () => {
    // strong strategy with only a short tail of losses
    const trades = makeTrades(60, 31, "MOMENTUM", "BULL_TREND", 0.6);
    // append 4 losses (a "few losses")
    for (let i = 0; i < 4; i++) trades.push({ strategyId: "MOMENTUM", regime: "BULL_TREND", label: 0, returnR: -1, outcomeMs: 1_700_000_000_000 + (60 + i) * 3_600_000 });
    const decay = detectAlphaDecay(trades, 30);
    expect(decay.decaying).toBe(false);
  });

  it("a sustained, meaningful deterioration IS flagged as decaying", () => {
    const trades = makeTrades(120, 32, "MOMENTUM", "BULL_TREND", 0.62, { decayHalf: 0.30 });
    const decay = detectAlphaDecay(trades, 30);
    expect(decay.decaying).toBe(true);
    expect(decay.recentExpectancyR).toBeLessThan(decay.earlyExpectancyR);
  });

  it("health is shrunk toward neutral and flagged unreliable on tiny samples", () => {
    const tiny = makeTrades(5, 33, "MOMENTUM", "BULL_TREND", 0.9);
    const h = computeStrategyHealth("MOMENTUM", tiny, 30);
    expect(h.reliable).toBe(false);
    expect(h.strategyHealthScore).toBeLessThan(0.8); // not trusted despite 90% wins
    expect(h.strategyHealthScore).toBeGreaterThan(0.3);
  });

  it("wilson lower bound ranks a large solid sample above a tiny glowing one", () => {
    expect(wilsonLowerBound(335, 500)).toBeGreaterThan(wilsonLowerBound(4, 5));
  });
});

describe("strategyRegimeMatrix + recommendedStatus", () => {
  it("meaningful positive edge in a suitable regime → ACTIVE", () => {
    const trades = makeTrades(200, 41, "MOMENTUM", "BULL_TREND", 0.62);
    const matrix = buildStrategyRegimeMatrix(trades, 30);
    const cell = matrix.find((c) => c.strategyId === "MOMENTUM" && c.regime === "BULL_TREND")!;
    expect(cell.recommendedStatus).toBe("ACTIVE");
    expect(cell.sampleCount).toBe(200);
    expect(cell.regimeSuitable).toBe(true);
  });

  it("meaningful negative edge → DISABLED", () => {
    const trades = makeTrades(200, 42, "MOMENTUM", "RANGE", 0.25);
    const matrix = buildStrategyRegimeMatrix(trades, 30);
    const cell = matrix.find((c) => c.strategyId === "MOMENTUM" && c.regime === "RANGE")!;
    expect(cell.recommendedStatus).toBe("DISABLED");
  });

  it("insufficient sample → SHADOW (never auto-promoted)", () => {
    const trades = makeTrades(12, 43, "IV_SPIKE", "HIGH_VOL", 0.7);
    const matrix = buildStrategyRegimeMatrix(trades, 30);
    const cell = matrix.find((c) => c.strategyId === "IV_SPIKE" && c.regime === "HIGH_VOL")!;
    expect(cell.recommendedStatus).toBe("SHADOW");
  });

  it("recommendStatus NEVER returns a LIVE status", () => {
    const statuses = new Set<string>();
    for (const wr of [0.2, 0.4, 0.5, 0.6, 0.8]) {
      for (const n of [5, 40, 200]) {
        for (const suitable of [true, false]) {
          const s = recommendStatus({ sampleCount: n, winRateLB: wr - 0.1, expectancy: (wr - 0.4) * 2, currentHealth: wr, regimeSuitable: suitable, decaying: false, recentExpectancyR: 0.1 }, 30);
          statuses.add(s.status);
        }
      }
    }
    expect([...statuses].every((s) => ["ACTIVE", "CAUTION", "SHADOW", "DISABLED"].includes(s))).toBe(true);
    expect(statuses.has("LIVE" as never)).toBe(false);
  });
});

describe("regime-aware selector — poor-in-regime strategies suppressed", () => {
  it("suppresses a strategy that performs poorly in the current regime", () => {
    // MOMENTUM good in BULL, bad in RANGE.
    const good = makeTrades(200, 51, "MOMENTUM", "BULL_TREND", 0.62);
    const bad = makeTrades(200, 52, "MOMENTUM", "RANGE", 0.28);
    const matrix = buildStrategyRegimeMatrix([...good, ...bad], 30);

    const inBull = selectStrategiesForRegime("BULL_TREND", matrix, ["MOMENTUM"]);
    const inRange = selectStrategiesForRegime("RANGE", matrix, ["MOMENTUM"]);
    expect(inBull[0]!.suppressed).toBe(false);
    expect(inBull[0]!.suitability).toBeGreaterThan(0);
    expect(inRange[0]!.suppressed).toBe(true);   // poor regime → suppressed
    expect(inRange[0]!.suitability).toBe(0);
  });

  it("a profile-unsuitable regime is suppressed even without matrix data", () => {
    // MOMENTUM's profile marks RANGE unsuitable.
    const sel = selectStrategiesForRegime("RANGE", [], ["MOMENTUM"]);
    expect(sel[0]!.suppressed).toBe(true);
    expect(sel[0]!.recommendedStatus).toBe("SHADOW"); // no data → shadow
  });

  it("mean-reversion is eligible in RANGE where trend strategies are not", () => {
    const mrTrades = makeTrades(200, 53, "PCR_EXTREME", "RANGE", 0.6);
    const matrix = buildStrategyRegimeMatrix(mrTrades, 30);
    const sel = selectStrategiesForRegime("RANGE", matrix, ["PCR_EXTREME", "MOMENTUM"]);
    const mr = sel.find((s) => s.strategyId === "PCR_EXTREME")!;
    const mom = sel.find((s) => s.strategyId === "MOMENTUM")!;
    expect(mr.suppressed).toBe(false);
    expect(mom.suppressed).toBe(true); // MOMENTUM unsuitable in RANGE
  });
});
