/**
 * Daily Picks — soft annotation engine helpers.
 *
 * These are *additive* fields on every `DailyPick` that surface the
 * institutional-spec data (Confluence Score X/10, Key Indicators row, Setup
 * Type, Time Window, Research Note, soft Warnings) without changing the
 * underlying ranking logic. All helpers are pure: deterministic on a fixed
 * (signal, bucket, context) input.
 */
import { describe, expect, it } from "vitest";

import type {
  AiConfluenceFactor,
  AiDirection,
  AiSignal,
} from "@/types/ai-signals";
import {
  buildResearchNote,
  buildSoftWarnings,
  confluenceScoreFromBucket,
  keyIndicatorsFor,
  setupTypeFor,
  timeWindowFor,
} from "@/features/india/daily-picks/engine";

function makeFactor(
  id: string,
  score: number,
  available = true,
): AiConfluenceFactor {
  return {
    id,
    category: "technical",
    label: id,
    description: `${id} factor`,
    weight: 0.1,
    score,
    contribution: score * 0.1,
    available,
  };
}

function makeSignal(overrides: Partial<AiSignal> = {}): AiSignal {
  const direction: AiDirection = overrides.direction ?? "BULLISH";
  const entry = overrides.entry ?? 100;
  return {
    id: overrides.id ?? overrides.symbol ?? "SIG",
    symbol: overrides.symbol ?? "SIG",
    displayName: overrides.displayName ?? overrides.symbol ?? "SIG",
    market: "india",
    pair: overrides.pair ?? `${overrides.symbol ?? "SIG"}.NS`,
    action: overrides.action ?? (direction === "BEARISH" ? "SHORT" : "LONG"),
    direction,
    horizon: overrides.horizon ?? "intraday",
    underlyingPrice: overrides.underlyingPrice ?? entry,
    entry,
    entryZone: { min: entry - 1, max: entry + 1 },
    strike: overrides.strike ?? entry,
    stopLoss: overrides.stopLoss ?? 95,
    takeProfits: overrides.takeProfits ?? [
      { level: 1, price: 105, percent: 5, allocation: 0.5 },
      { level: 2, price: 110, percent: 10, allocation: 0.3 },
      { level: 3, price: 120, percent: 20, allocation: 0.2 },
    ],
    riskReward: overrides.riskReward ?? 2,
    riskRewardBlended: overrides.riskRewardBlended ?? 2.5,
    expectedMovePct: overrides.expectedMovePct ?? 4,
    positionSizingPct: overrides.positionSizingPct ?? 5,
    riskLevel: overrides.riskLevel ?? "medium",
    confidence: overrides.confidence ?? 0.7,
    confidenceScore: overrides.confidenceScore ?? 70,
    grade: overrides.grade ?? "B",
    winProbability: overrides.winProbability ?? 0.6,
    timing: {
      generatedAt: 0,
      enterBy: 0,
      exitBy: 0,
      validForMs: 0,
      bestEntryNote: "",
      bestExitNote: "",
    },
    confluences: overrides.confluences ?? [
      makeFactor("dayChange", 0.5),
      makeFactor("breakout", 0.4),
      makeFactor("trend", 0.8),
      makeFactor("momentum", 0.7),
      makeFactor("volume", 0.6),
      makeFactor("scanner", 0.5),
    ],
    bullishCount: overrides.bullishCount ?? 4,
    bearishCount: overrides.bearishCount ?? 0,
    reasons: overrides.reasons ?? [
      { category: "technical", text: "Strong uptrend", bullish: true },
      { category: "flow", text: "Volume breakout", bullish: true },
      { category: "derivatives", text: "Put writers defending", bullish: true },
    ],
    invalidationCriteria: overrides.invalidationCriteria ?? "Close below 95",
    modelVersion: "test",
    summary: overrides.summary ?? "summary",
  };
}

describe("confluenceScoreFromBucket", () => {
  it("scales a [0..1] bucket score onto a 0..10 ladder", () => {
    expect(confluenceScoreFromBucket(0)).toBe(0);
    expect(confluenceScoreFromBucket(1)).toBe(10);
    expect(confluenceScoreFromBucket(0.5)).toBe(5);
  });

  it("rounds to one decimal place", () => {
    expect(confluenceScoreFromBucket(0.6234)).toBe(6.2);
    expect(confluenceScoreFromBucket(0.6789)).toBe(6.8);
  });

  it("clamps out-of-range inputs", () => {
    expect(confluenceScoreFromBucket(-0.5)).toBe(0);
    expect(confluenceScoreFromBucket(1.5)).toBe(10);
  });

  it("handles non-finite inputs by returning 0", () => {
    expect(confluenceScoreFromBucket(Number.NaN)).toBe(0);
    expect(confluenceScoreFromBucket(Number.POSITIVE_INFINITY)).toBe(10);
  });
});

describe("keyIndicatorsFor", () => {
  it("INDICES_SCALP exposes derivatives-positioning indicators first", () => {
    const ind = keyIndicatorsFor(makeSignal({ symbol: "NIFTY" }), "INDICES_SCALP");
    // Spec says: OI / PCR / Max Pain / India VIX / VWAP
    expect(ind).toContain("OI");
    expect(ind).toContain("PCR");
    expect(ind).toContain("Max Pain");
    // Order matters — OI is the headline read for indices
    expect(ind[0]).toBe("OI");
  });

  it("OPENING_BREAKOUT surfaces ORB structural indicators", () => {
    const ind = keyIndicatorsFor(
      makeSignal({ symbol: "RELIANCE" }),
      "OPENING_BREAKOUT",
    );
    expect(ind).toContain("ORB");
    expect(ind).toContain("Vol");
    expect(ind).toContain("VWAP");
  });

  it("MOMENTUM emphasises trend + momentum indicators", () => {
    const ind = keyIndicatorsFor(makeSignal(), "MOMENTUM");
    expect(ind).toContain("RSI");
    expect(ind).toContain("EMA");
    expect(ind).toContain("OI");
    expect(ind).toContain("Vol");
  });

  it("SCALPING emphasises liquidity / VWAP / ATR", () => {
    const ind = keyIndicatorsFor(makeSignal(), "SCALPING");
    expect(ind).toContain("VWAP");
    expect(ind).toContain("ATR");
  });

  it("POTENTIAL emphasises structure + OI confluence", () => {
    const ind = keyIndicatorsFor(makeSignal(), "POTENTIAL");
    expect(ind).toContain("OI");
    expect(ind).toContain("RSI");
  });

  it("returns 3..6 indicators (never empty)", () => {
    for (const bucket of [
      "INDICES_SCALP",
      "OPENING_BREAKOUT",
      "MOMENTUM",
      "SCALPING",
      "POTENTIAL",
    ] as const) {
      const ind = keyIndicatorsFor(makeSignal(), bucket);
      expect(ind.length).toBeGreaterThanOrEqual(3);
      expect(ind.length).toBeLessThanOrEqual(6);
    }
  });
});

describe("setupTypeFor", () => {
  it("classifies an INDICES_SCALP long as an OI-wall/max-pain magnet", () => {
    const setup = setupTypeFor(
      makeSignal({
        symbol: "NIFTY",
        confluences: [
          makeFactor("oiBuildup", 0.9),
          makeFactor("maxPain", 0.6),
          makeFactor("pcr", 0.5),
        ],
      }),
      "INDICES_SCALP",
    );
    expect(setup.toLowerCase()).toMatch(/oi|max[- ]pain|gravity|wall|magnet/);
  });

  it("classifies an OPENING_BREAKOUT pick as an ORB retest", () => {
    const setup = setupTypeFor(
      makeSignal({ symbol: "RELIANCE" }),
      "OPENING_BREAKOUT",
    );
    expect(setup.toLowerCase()).toMatch(/opening range|orb|retest/);
  });

  it("classifies a MOMENTUM pick as trend continuation", () => {
    const setup = setupTypeFor(makeSignal(), "MOMENTUM");
    expect(setup.toLowerCase()).toMatch(/trend continuation|momentum/);
  });

  it("classifies a SCALPING pick by its R:R+horizon profile", () => {
    const setup = setupTypeFor(
      makeSignal({ horizon: "scalp", riskReward: 2.5 }),
      "SCALPING",
    );
    expect(setup.toLowerCase()).toMatch(/scalp|range|vwap|breakout/);
  });

  it("classifies a POTENTIAL pick as a high-conviction structural play", () => {
    const setup = setupTypeFor(
      makeSignal({ grade: "A", confidence: 0.82 }),
      "POTENTIAL",
    );
    expect(setup.toLowerCase()).toMatch(
      /liquidity|sweep|structural|confluence|swing/,
    );
  });
});

describe("timeWindowFor", () => {
  it("INDICES_SCALP runs the full liquid intraday band", () => {
    const w = timeWindowFor("INDICES_SCALP", "intraday");
    expect(w.start).toMatch(/^\d{2}:\d{2}$/);
    expect(w.end).toMatch(/^\d{2}:\d{2}$/);
    expect(w.start).toBe("09:30");
    // Late-day window for index scalps (max-pain pull post-13:30, Power Hour)
    expect(w.end >= "15:15").toBe(true);
  });

  it("OPENING_BREAKOUT runs the first 1.5h after the open", () => {
    const w = timeWindowFor("OPENING_BREAKOUT", "intraday");
    expect(w.start).toBe("09:20");
    expect(w.end <= "12:00").toBe(true);
  });

  it("MOMENTUM stretches across the trending day", () => {
    const w = timeWindowFor("MOMENTUM", "intraday");
    expect(w.start <= "10:00").toBe(true);
    expect(w.end >= "14:30").toBe(true);
  });

  it("SCALPING pins to the two highest-liquidity bands", () => {
    const w = timeWindowFor("SCALPING", "scalp");
    expect(w.start).toBe("09:15");
    // Power Hour is the second leg — end at 15:15.
    expect(w.end).toBe("15:15");
  });

  it("POTENTIAL runs through the prime trending window", () => {
    const w = timeWindowFor("POTENTIAL", "intraday");
    expect(w.start <= "10:00").toBe(true);
    expect(w.end >= "15:00").toBe(true);
  });

  it("carries a human-readable label", () => {
    expect(timeWindowFor("INDICES_SCALP", "intraday").label.length).toBeGreaterThan(0);
    expect(timeWindowFor("OPENING_BREAKOUT", "intraday").label).toMatch(
      /opening|orb|range/i,
    );
  });
});

describe("buildResearchNote", () => {
  it("emits a 3–5 sentence institutional-grade note", () => {
    const note = buildResearchNote({
      signal: makeSignal({
        symbol: "RELIANCE",
        confidence: 0.74,
        riskReward: 2.2,
        expectedMovePct: 3.4,
        reasons: [
          { category: "technical", text: "Bull SMA stack", bullish: true },
          { category: "derivatives", text: "PCR 1.4 — PE writers loaded", bullish: true },
          { category: "flow", text: "Volume +1.8× avg", bullish: true },
        ],
      }),
      bucket: "MOMENTUM",
    });
    const sentences = note.split(/[.!?]\s+/).filter((s) => s.trim().length > 0);
    expect(sentences.length).toBeGreaterThanOrEqual(3);
    expect(sentences.length).toBeLessThanOrEqual(5);
    expect(note).toMatch(/RELIANCE/);
  });

  it("includes the win-probability + expected move context for POTENTIAL", () => {
    const note = buildResearchNote({
      signal: makeSignal({
        symbol: "INFY",
        confidence: 0.82,
        winProbability: 0.73,
        expectedMovePct: 4.6,
      }),
      bucket: "POTENTIAL",
    });
    expect(note).toMatch(/INFY/);
    expect(note).toMatch(/73%/);
  });

  it("frames an INDICES_SCALP note around derivatives positioning", () => {
    const note = buildResearchNote({
      signal: makeSignal({
        symbol: "NIFTY",
        confluences: [
          makeFactor("oiBuildup", 0.9),
          makeFactor("pcr", 0.7),
          makeFactor("maxPain", 0.4),
        ],
        reasons: [
          { category: "derivatives", text: "Heavy PE writing at 24000", bullish: true },
          { category: "derivatives", text: "Max-pain pin at 24050", bullish: true },
        ],
      }),
      bucket: "INDICES_SCALP",
    });
    expect(note.toLowerCase()).toMatch(/oi|pcr|max[- ]pain|writers|positioning/);
  });
});

describe("buildSoftWarnings", () => {
  it("flags HIGH_VIX when India VIX > 20", () => {
    const w = buildSoftWarnings({
      signal: makeSignal(),
      bucket: "INDICES_SCALP",
      indiaVix: 22.5,
      marketBias: 0,
    });
    expect(w.find((x) => x.kind === "HIGH_VIX")).toBeTruthy();
    expect(w.find((x) => x.kind === "HIGH_VIX")?.severity).toBe("warn");
  });

  it("flags EXTREME_VIX when India VIX > 25 (in addition to HIGH_VIX)", () => {
    const w = buildSoftWarnings({
      signal: makeSignal(),
      bucket: "INDICES_SCALP",
      indiaVix: 27,
      marketBias: 0,
    });
    expect(w.find((x) => x.kind === "EXTREME_VIX")).toBeTruthy();
  });

  it("does NOT flag HIGH_VIX when VIX is in the normal regime", () => {
    const w = buildSoftWarnings({
      signal: makeSignal(),
      bucket: "INDICES_SCALP",
      indiaVix: 14,
      marketBias: 0,
    });
    expect(w.find((x) => x.kind === "HIGH_VIX")).toBeFalsy();
  });

  it("flags LOW_CONFIDENCE when the pick is below the spec's 6/10 floor", () => {
    const w = buildSoftWarnings({
      signal: makeSignal(),
      bucket: "MOMENTUM",
      confluenceScore: 5.4,
      indiaVix: 13,
      marketBias: 0,
    });
    expect(w.find((x) => x.kind === "LOW_CONFIDENCE")).toBeTruthy();
  });

  it("flags LOW_RR when R:R falls below the bucket floor", () => {
    const wScalp = buildSoftWarnings({
      signal: makeSignal({ riskReward: 1.2, riskRewardBlended: 1.2 }),
      bucket: "SCALPING",
      confluenceScore: 7,
      indiaVix: 13,
      marketBias: 0,
    });
    expect(wScalp.find((x) => x.kind === "LOW_RR")).toBeTruthy();

    const wMom = buildSoftWarnings({
      signal: makeSignal({ riskReward: 1.4, riskRewardBlended: 1.4 }),
      bucket: "MOMENTUM",
      confluenceScore: 7,
      indiaVix: 13,
      marketBias: 0,
    });
    expect(wMom.find((x) => x.kind === "LOW_RR")).toBeTruthy();
  });

  it("flags COUNTER_TAPE when a pick fights a strong regime", () => {
    const w = buildSoftWarnings({
      signal: makeSignal({ direction: "BEARISH", action: "SHORT" }),
      bucket: "MOMENTUM",
      confluenceScore: 7,
      indiaVix: 13,
      marketBias: 0.5,
    });
    expect(w.find((x) => x.kind === "COUNTER_TAPE")).toBeTruthy();
  });

  it("never blocks the pick — all warnings are soft annotations", () => {
    const w = buildSoftWarnings({
      signal: makeSignal({ riskReward: 0.5, riskRewardBlended: 0.5, confidence: 0.1 }),
      bucket: "SCALPING",
      confluenceScore: 1,
      indiaVix: 32,
      marketBias: -0.9,
    });
    // The pick can carry a lot of soft warnings without ever being blocked.
    // (Severity stays non-fatal; presence of warnings doesn't drop the pick.)
    expect(w.length).toBeGreaterThan(2);
    for (const warning of w) {
      expect(["info", "warn", "danger"]).toContain(warning.severity);
    }
  });

  it("EVENT_RISK is included when `earningsWithinDays` is set ≤ 2", () => {
    const w = buildSoftWarnings({
      signal: makeSignal(),
      bucket: "MOMENTUM",
      confluenceScore: 7,
      indiaVix: 13,
      marketBias: 0,
      earningsWithinDays: 1,
    });
    expect(w.find((x) => x.kind === "EVENT_RISK")).toBeTruthy();
  });
});
