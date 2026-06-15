import { describe, expect, it } from "vitest";

import type {
  AiConfluenceFactor,
  AiDirection,
  AiHorizon,
  AiSignal,
} from "@/types/ai-signals";
import {
  DAILY_PICK_BUCKETS,
  bucketLogic,
  bucketScores,
  buildDailyPicks,
  groupDailyPicks,
  istDateKey,
  marketAlignment,
  pickFromSignal,
  selectDailyPicks,
  trackPick,
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
    ],
    invalidationCriteria: overrides.invalidationCriteria ?? "Close below 95",
    modelVersion: "test",
    summary: overrides.summary ?? "summary",
  };
}

describe("daily-picks engine", () => {
  describe("bucketScores", () => {
    it("rewards aligned trend/momentum/volume for the momentum bucket", () => {
      const strong = makeSignal({
        symbol: "STRONG",
        confluences: [
          makeFactor("trend", 1),
          makeFactor("momentum", 1),
          makeFactor("volume", 1),
          makeFactor("scanner", 1),
        ],
      });
      const weak = makeSignal({
        symbol: "WEAK",
        confluences: [
          makeFactor("trend", 0.1),
          makeFactor("momentum", 0.1),
          makeFactor("volume", 0),
          makeFactor("scanner", 0),
        ],
      });
      expect(bucketScores(strong).MOMENTUM).toBeGreaterThan(
        bucketScores(weak).MOMENTUM,
      );
    });

    it("gives WAIT/neutral signals a near-zero momentum score", () => {
      const wait = makeSignal({
        symbol: "WAIT",
        action: "WAIT",
        direction: "NEUTRAL",
        confidence: 0.1,
      });
      expect(bucketScores(wait).MOMENTUM).toBeLessThan(0.2);
    });

    it("rewards short horizon + expected move for scalping", () => {
      const scalp = makeSignal({
        symbol: "SCALP",
        horizon: "scalp",
        expectedMovePct: 6,
        riskReward: 3,
      });
      const positional = makeSignal({
        symbol: "POS",
        horizon: "positional",
        expectedMovePct: 1,
        riskReward: 1,
      });
      expect(bucketScores(scalp).SCALPING).toBeGreaterThan(
        bucketScores(positional).SCALPING,
      );
    });

    it("rewards confidence + win-probability for potential", () => {
      const high = makeSignal({
        symbol: "HI",
        confidence: 0.95,
        winProbability: 0.8,
        riskRewardBlended: 4,
      });
      const low = makeSignal({
        symbol: "LO",
        confidence: 0.3,
        winProbability: 0.35,
        riskRewardBlended: 1,
      });
      expect(bucketScores(high).POTENTIAL).toBeGreaterThan(
        bucketScores(low).POTENTIAL,
      );
    });
  });

  describe("selectDailyPicks", () => {
    function universe(): AiSignal[] {
      return Array.from({ length: 12 }, (_, i) =>
        makeSignal({
          symbol: `S${i}`,
          confidence: 0.5 + (i % 5) * 0.08,
          expectedMovePct: 2 + (i % 4),
          horizon: i % 2 === 0 ? "scalp" : "swing",
        }),
      );
    }

    it("returns up to 3 picks per bucket", () => {
      const sel = selectDailyPicks(universe(), 3);
      for (const bucket of DAILY_PICK_BUCKETS) {
        expect(sel[bucket].length).toBe(3);
      }
    });

    it("never repeats a symbol across buckets", () => {
      const sel = selectDailyPicks(universe(), 3);
      const symbols = DAILY_PICK_BUCKETS.flatMap((b) =>
        sel[b].map((x) => x.signal.symbol),
      );
      expect(new Set(symbols).size).toBe(symbols.length);
    });

    it("excludes WAIT signals when enough directional setups exist", () => {
      const signals = [
        ...universe(),
        makeSignal({ symbol: "IDLE", action: "WAIT", direction: "NEUTRAL" }),
      ];
      const sel = selectDailyPicks(signals, 3);
      const picked = DAILY_PICK_BUCKETS.flatMap((b) =>
        sel[b].map((x) => x.signal.symbol),
      );
      expect(picked).not.toContain("IDLE");
    });
  });

  describe("pickFromSignal", () => {
    it("freezes entry/stop/target and derives canMoveUpto + canExpect", () => {
      const signal = makeSignal({ symbol: "RELIANCE", entry: 100 });
      const pick = pickFromSignal({
        signal,
        bucket: "MOMENTUM",
        rank: 1,
        tradeDate: "2026-06-15",
        bucketScore: 0.8,
        now: 1000,
      });
      expect(pick.entry).toBe(100);
      expect(pick.target).toBe(105); // TP1
      expect(pick.canMoveUpto).toBe(120); // TP3
      expect(pick.canExpectPct).toBe(4);
      expect(pick.status).toBe("OPEN");
      expect(pick.logic).toMatch(/momentum/i);
      expect(pick.rank).toBe(1);
    });
  });

  describe("trackPick", () => {
    const base = pickFromSignal({
      signal: makeSignal({ symbol: "X", entry: 100, stopLoss: 95 }),
      bucket: "POTENTIAL",
      rank: 1,
      tradeDate: "2026-06-15",
      bucketScore: 0.7,
      now: 0,
    });

    it("computes signed P&L for a long", () => {
      const t = trackPick(base, 102, 1);
      expect(t.pnlPct).toBeCloseTo(2, 5);
      expect(t.lastPrice).toBe(102);
    });

    it("computes signed P&L for a short", () => {
      const shortPick = pickFromSignal({
        signal: makeSignal({
          symbol: "Y",
          direction: "BEARISH",
          action: "SHORT",
          entry: 100,
          stopLoss: 105,
          takeProfits: [
            { level: 1, price: 95, percent: 5, allocation: 0.5 },
            { level: 2, price: 90, percent: 10, allocation: 0.3 },
            { level: 3, price: 80, percent: 20, allocation: 0.2 },
          ],
        }),
        bucket: "MOMENTUM",
        rank: 1,
        tradeDate: "2026-06-15",
        bucketScore: 0.7,
        now: 0,
      });
      const t = trackPick(shortPick, 98, 1);
      expect(t.pnlPct).toBeCloseTo(2, 5);
    });

    it("tracks the best progress toward target (achieved till now)", () => {
      const t1 = trackPick(base, 102.5, 1); // +2.5% of a 5% target = 50%
      expect(t1.achievedPct).toBeCloseTo(50, 5);
      const t2 = trackPick(t1, 101, 2); // pulled back, but achieved stays at 50
      expect(t2.achievedPct).toBeCloseTo(50, 5);
      expect(t2.pnlPct).toBeCloseTo(1, 5);
    });

    it("resolves to TARGET_HIT and sticks", () => {
      const hit = trackPick(base, 106, 1);
      expect(hit.status).toBe("TARGET_HIT");
      const after = trackPick(hit, 100, 2);
      expect(after.status).toBe("TARGET_HIT");
    });

    it("resolves to STOP_HIT", () => {
      const stopped = trackPick(base, 94, 1);
      expect(stopped.status).toBe("STOP_HIT");
    });

    it("ignores an invalid mark price", () => {
      const t = trackPick(base, 0, 1);
      expect(t.lastPrice).toBeNull();
      expect(t.status).toBe("OPEN");
    });
  });

  describe("groupDailyPicks", () => {
    it("groups in canonical bucket order and sorts by rank", () => {
      const picks = buildDailyPicks({
        signals: Array.from({ length: 12 }, (_, i) =>
          makeSignal({ symbol: `S${i}` }),
        ),
        tradeDate: "2026-06-15",
        now: 0,
      });
      const groups = groupDailyPicks(picks);
      expect(groups.map((g) => g.bucket)).toEqual([
        "MOMENTUM",
        "SCALPING",
        "POTENTIAL",
      ]);
      for (const g of groups) {
        expect(g.picks.map((p) => p.rank)).toEqual([1, 2, 3]);
      }
    });
  });

  describe("istDateKey", () => {
    it("rolls to the next IST day after 18:30 UTC", () => {
      // 2026-06-15T18:31:00Z = 2026-06-16T00:01 IST
      expect(istDateKey(new Date("2026-06-15T18:31:00Z"))).toBe("2026-06-16");
      // 2026-06-15T10:00:00Z = 2026-06-15T15:30 IST
      expect(istDateKey(new Date("2026-06-15T10:00:00Z"))).toBe("2026-06-15");
    });
  });

  describe("marketAlignment", () => {
    it("does not penalise picks on a weak / mixed tape", () => {
      expect(marketAlignment("BEARISH", 0.1)).toBe(1);
      expect(marketAlignment("BULLISH", -0.1)).toBe(1);
    });
    it("keeps full score for picks aligned with a strong tape", () => {
      expect(marketAlignment("BULLISH", 0.8)).toBe(1);
      expect(marketAlignment("BEARISH", -0.8)).toBe(1);
    });
    it("demotes picks that fight a strong tape", () => {
      expect(marketAlignment("BEARISH", 0.8)).toBeLessThan(0.6);
      expect(marketAlignment("BULLISH", -0.8)).toBeLessThan(0.6);
    });
  });

  describe("selectDailyPicks tape bias", () => {
    it("favours longs over equally-strong shorts in a strong bull tape", () => {
      const long = makeSignal({
        symbol: "LONGER",
        direction: "BULLISH",
        action: "LONG",
      });
      const short = makeSignal({
        symbol: "SHORTER",
        direction: "BEARISH",
        action: "SHORT",
        takeProfits: [
          { level: 1, price: 95, percent: 5, allocation: 0.5 },
          { level: 2, price: 90, percent: 10, allocation: 0.3 },
          { level: 3, price: 80, percent: 20, allocation: 0.2 },
        ],
        stopLoss: 105,
      });
      // Strong bullish tape (+0.8) should rank the long ahead of the short
      // for the momentum bucket even though their raw setups are symmetric.
      const sel = selectDailyPicks([short, long], 1, 0.8);
      expect(sel.MOMENTUM[0]?.signal.symbol).toBe("LONGER");
    });
  });

  describe("bucketLogic", () => {
    it("mentions conviction details for the potential bucket", () => {
      const logic = bucketLogic(
        makeSignal({ grade: "A", winProbability: 0.72, expectedMovePct: 5 }),
        "POTENTIAL",
      );
      expect(logic).toMatch(/grade A/);
      expect(logic).toMatch(/72%/);
    });
  });
});
