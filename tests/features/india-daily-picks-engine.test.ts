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
  dailyPickFromScalpSignal,
  groupDailyPicks,
  istDateKey,
  marketAlignment,
  passesBucketGate,
  passesTapeFilter,
  pickFromSignal,
  selectDailyPicks,
  squareOffPick,
  TAPE_HARD_FILTER_BIAS,
  trackPick,
} from "@/features/india/daily-picks/engine";
import type { IndiaScalpSignal } from "@/features/india/scalping/types";

function makeScalpSignal(
  overrides: Partial<IndiaScalpSignal> = {},
): IndiaScalpSignal {
  return {
    strategyId: "OPENING_BREAKOUT",
    symbol: overrides.symbol ?? "RELIANCE",
    symbolName: overrides.symbolName ?? overrides.symbol ?? "RELIANCE",
    timeframe: "5m",
    direction: overrides.direction ?? "LONG",
    price: overrides.price ?? 100.4,
    reference: overrides.reference ?? 100.3,
    atr: overrides.atr ?? 0.3,
    confirmed: overrides.confirmed ?? true,
    entry: overrides.entry ?? 100.3,
    stopLoss: overrides.stopLoss ?? 100.0,
    target: overrides.target ?? 100.9,
    riskReward: overrides.riskReward ?? 2,
    confidence: overrides.confidence ?? 0.7,
    rationale: overrides.rationale ?? [
      "Opening 5-min range break",
      "Bullish breakout",
      "Retest of ₹100.30 held",
    ],
    triggeredAt: overrides.triggeredAt ?? 1_700_000_000_000,
    extras: overrides.extras ?? { stretchTarget: 101.2 },
  };
}

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
    ],
    invalidationCriteria: overrides.invalidationCriteria ?? "Close below 95",
    modelVersion: "test",
    summary: overrides.summary ?? "summary",
  };
}

/** An index underlying signal (feeds only the Indices-Scalping bucket). */
function makeIndexSignal(
  symbol: string,
  overrides: Partial<AiSignal> = {},
): AiSignal {
  return makeSignal({
    symbol,
    displayName: symbol,
    pair: symbol,
    confluences: [
      makeFactor("trend", 0.6),
      makeFactor("momentum", 0.7),
      makeFactor("oiBuildup", 0.9),
      makeFactor("pcr", 0.6),
      makeFactor("maxPain", 0.5),
    ],
    ...overrides,
  });
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

    it("boosts every bucket when the futures screen is aligned with the trade", () => {
      const common = {
        confluences: [
          makeFactor("trend", 0.8),
          makeFactor("momentum", 0.7),
          makeFactor("volume", 0.6),
          makeFactor("scanner", 0.5),
        ],
      };
      const withScreen = makeSignal({
        symbol: "PASS",
        confluences: [...common.confluences, makeFactor("futuresScreen", 1)],
      });
      const withoutScreen = makeSignal({ symbol: "NOSCREEN", ...common });
      const a = bucketScores(withScreen);
      const b = bucketScores(withoutScreen);
      expect(a.MOMENTUM).toBeGreaterThan(b.MOMENTUM);
      expect(a.SCALPING).toBeGreaterThan(b.SCALPING);
      expect(a.POTENTIAL).toBeGreaterThan(b.POTENTIAL);
    });

    it("does not reward a long whose futures screen is bearish (counter-trend)", () => {
      const base = [
        makeFactor("trend", 0.6),
        makeFactor("momentum", 0.6),
        makeFactor("volume", 0.5),
        makeFactor("scanner", 0.4),
      ];
      const bullScreen = makeSignal({
        symbol: "BULL",
        confluences: [...base, makeFactor("futuresScreen", 1)],
      });
      // A long (BULLISH) carrying a bearish screen → aligned() goes negative →
      // clamped to 0, so it ranks below the same setup with a bullish screen.
      const bearScreenOnLong = makeSignal({
        symbol: "FIGHT",
        confluences: [...base, makeFactor("futuresScreen", -1)],
      });
      expect(bucketScores(bullScreen).MOMENTUM).toBeGreaterThan(
        bucketScores(bearScreenOnLong).MOMENTUM,
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

    it("rewards option-chain OI build-up for the indices-scalping bucket", () => {
      const strongOi = makeIndexSignal("NIFTY", {
        confluences: [
          makeFactor("momentum", 0.6),
          makeFactor("oiBuildup", 1),
          makeFactor("pcr", 0.8),
          makeFactor("maxPain", 0.7),
        ],
      });
      const weakOi = makeIndexSignal("BANKNIFTY", {
        confluences: [
          makeFactor("momentum", 0.6),
          makeFactor("oiBuildup", 0.05),
          makeFactor("pcr", 0.05),
          makeFactor("maxPain", 0),
        ],
      });
      expect(bucketScores(strongOi).INDICES_SCALP).toBeGreaterThan(
        bucketScores(weakOi).INDICES_SCALP,
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

    it("fills the three stock buckets from stocks only", () => {
      const sel = selectDailyPicks(universe(), 3);
      for (const bucket of ["MOMENTUM", "SCALPING", "POTENTIAL"] as const) {
        expect(sel[bucket].length).toBe(3);
      }
      // No index underlyings in the pool → the indices bucket stays empty.
      expect(sel.INDICES_SCALP.length).toBe(0);
    });

    it("feeds the indices bucket only from index underlyings", () => {
      const indices = ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY"].map((s) =>
        makeIndexSignal(s),
      );
      const sel = selectDailyPicks([...universe(), ...indices], 3);
      // Top 3 of the 4 indices land in the indices bucket — all index symbols.
      expect(sel.INDICES_SCALP.length).toBe(3);
      expect(
        sel.INDICES_SCALP.every((x) =>
          ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY"].includes(
            x.signal.symbol,
          ),
        ),
      ).toBe(true);
      // Stock buckets never contain an index.
      for (const bucket of ["MOMENTUM", "SCALPING", "POTENTIAL"] as const) {
        expect(
          sel[bucket].every((x) => x.signal.symbol.startsWith("S")),
        ).toBe(true);
      }
    });

    it("never repeats a symbol across buckets", () => {
      const indices = ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY"].map((s) =>
        makeIndexSignal(s),
      );
      const sel = selectDailyPicks([...universe(), ...indices], 3);
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

  describe("dailyPickFromScalpSignal", () => {
    it("projects an Opening Breakout signal into an OPENING_BREAKOUT pick", () => {
      const pick = dailyPickFromScalpSignal({
        signal: makeScalpSignal({ symbol: "RELIANCE", confidence: 0.72 }),
        rank: 1,
        tradeDate: "2026-06-16",
        now: 9999,
      });
      expect(pick.bucket).toBe("OPENING_BREAKOUT");
      expect(pick.rank).toBe(1);
      expect(pick.direction).toBe("BULLISH");
      expect(pick.action).toBe("LONG");
      expect(pick.entry).toBeCloseTo(100.3, 5);
      expect(pick.stopLoss).toBeCloseTo(100.0, 5);
      expect(pick.target).toBeCloseTo(100.9, 5);
      expect(pick.canMoveUpto).toBeCloseTo(101.2, 5); // stretch (3R)
      expect(pick.riskReward).toBe(2);
      expect(pick.grade).toBe("A"); // 0.72 → A
      expect(pick.status).toBe("OPEN");
      // Appeared-on-board time is the strategy's trigger (the retest instant).
      expect(pick.generatedAt).toBe(1_700_000_000_000);
      expect(pick.pair).toBe("RELIANCE.NS");
      expect(pick.logic).toMatch(/opening breakout/i);
    });

    it("maps a SHORT signal and indices keep a bare pair symbol", () => {
      const pick = dailyPickFromScalpSignal({
        signal: makeScalpSignal({
          symbol: "NIFTY",
          direction: "SHORT",
          entry: 100,
          stopLoss: 101,
          target: 98,
          extras: {},
        }),
        rank: 2,
        tradeDate: "2026-06-16",
        now: 1,
      });
      expect(pick.direction).toBe("BEARISH");
      expect(pick.action).toBe("SHORT");
      expect(pick.pair).toBe("NIFTY");
      // No stretch in extras → derived as 3R below entry (risk 1 → 97).
      expect(pick.canMoveUpto).toBeCloseTo(97, 5);
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

    it("stamps resolvedAt the moment a level is touched", () => {
      expect(base.resolvedAt).toBeNull();
      const hit = trackPick(base, 106, 1234);
      expect(hit.resolvedAt).toBe(1234);
      // Subsequent ticks don't move the resolution time.
      const after = trackPick(hit, 100, 5678);
      expect(after.resolvedAt).toBe(1234);
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

  describe("squareOffPick", () => {
    const base = pickFromSignal({
      signal: makeSignal({ symbol: "X", entry: 100, stopLoss: 95 }),
      bucket: "POTENTIAL",
      rank: 1,
      tradeDate: "2026-06-15",
      bucketScore: 0.7,
      now: 0,
    });

    it("flips an OPEN pick to CLOSED at the market close, keeping its P&L", () => {
      const tracked = trackPick(base, 102, 1); // +2% but neither target nor stop
      expect(tracked.status).toBe("OPEN");
      const closed = squareOffPick(tracked, 5);
      expect(closed.status).toBe("CLOSED");
      expect(closed.pnlPct).toBeCloseTo(2, 5);
      expect(closed.lastPrice).toBe(102);
      expect(closed.updatedAt).toBe(5);
      // Square-off is itself a resolution → time-to-outcome is recorded.
      expect(closed.resolvedAt).toBe(5);
    });

    it("leaves a resolved pick untouched (idempotent)", () => {
      const hit = trackPick(base, 106, 1);
      expect(hit.status).toBe("TARGET_HIT");
      expect(squareOffPick(hit, 9)).toBe(hit);
      const stopped = trackPick(base, 94, 1);
      expect(squareOffPick(stopped, 9).status).toBe("STOP_HIT");
      const closed = squareOffPick(trackPick(base, 101, 1), 9);
      expect(squareOffPick(closed, 12)).toBe(closed);
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
        "INDICES_SCALP",
        "OPENING_BREAKOUT",
        "MOMENTUM",
        "SCALPING",
        "POTENTIAL",
      ]);
      // Only the (stock-fed) buckets have picks here; ranks are contiguous.
      for (const g of groups) {
        if (g.picks.length === 0) continue;
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

  describe("passesTapeFilter (counter-tape hard-filter)", () => {
    it("is a no-op on a weak / mixed tape", () => {
      const short = makeSignal({
        symbol: "X",
        direction: "BEARISH",
        action: "SHORT",
      });
      expect(passesTapeFilter(short, 0.05)).toBe(true);
      expect(passesTapeFilter(short, -0.05)).toBe(true);
    });

    it("drops shorts in a meaningfully-bullish tape", () => {
      const short = makeSignal({
        symbol: "X",
        direction: "BEARISH",
        action: "SHORT",
      });
      const long = makeSignal({
        symbol: "Y",
        direction: "BULLISH",
        action: "LONG",
      });
      expect(passesTapeFilter(short, 0.2)).toBe(false);
      expect(passesTapeFilter(long, 0.2)).toBe(true);
    });

    it("drops longs in a meaningfully-bearish tape", () => {
      const short = makeSignal({
        symbol: "X",
        direction: "BEARISH",
        action: "SHORT",
      });
      const long = makeSignal({
        symbol: "Y",
        direction: "BULLISH",
        action: "LONG",
      });
      expect(passesTapeFilter(short, -0.2)).toBe(true);
      expect(passesTapeFilter(long, -0.2)).toBe(false);
    });

    it("hard-filter threshold sits at the documented constant", () => {
      // Sanity: a tape bias right above the threshold filters, just below
      // doesn't. Catches accidental tightening / loosening of the gate.
      const short = makeSignal({
        symbol: "X",
        direction: "BEARISH",
        action: "SHORT",
      });
      expect(passesTapeFilter(short, TAPE_HARD_FILTER_BIAS + 0.01)).toBe(false);
      expect(passesTapeFilter(short, TAPE_HARD_FILTER_BIAS - 0.01)).toBe(true);
    });
  });

  describe("passesBucketGate (per-bucket factor-direct floor)", () => {
    it("MOMENTUM rejects picks with no day-change push", () => {
      const stale = makeSignal({
        symbol: "STALE",
        confluences: [
          makeFactor("dayChange", 0.05),
          makeFactor("trend", 0.6),
          makeFactor("momentum", 0.5),
          makeFactor("breakout", 0.3),
        ],
      });
      expect(passesBucketGate(stale, "MOMENTUM")).toBe(false);
    });

    it("MOMENTUM accepts a tape-aligned mover even on a low-volume day", () => {
      const mover = makeSignal({
        symbol: "MOVER",
        confluences: [
          makeFactor("dayChange", 0.45),
          makeFactor("trend", 1.0),
          makeFactor("momentum", 0.7),
          makeFactor("breakout", 0.3),
        ],
      });
      expect(passesBucketGate(mover, "MOMENTUM")).toBe(true);
    });

    it("MOMENTUM rejects a pick fighting S/R even with strong day-change", () => {
      const fightingSr = makeSignal({
        symbol: "AGAINST",
        confluences: [
          makeFactor("dayChange", 0.5),
          makeFactor("trend", 0.8),
          makeFactor("momentum", 0.6),
          makeFactor("breakout", -0.4),
        ],
      });
      expect(passesBucketGate(fightingSr, "MOMENTUM")).toBe(false);
    });

    it("SCALPING rejects a setup with poor blended R:R", () => {
      const lowRr = makeSignal({
        symbol: "SCALP1",
        confluences: [
          makeFactor("dayChange", 0.5),
          makeFactor("breakout", 0.3),
        ],
        riskReward: 1.0,
        riskRewardBlended: 1.0,
      });
      expect(passesBucketGate(lowRr, "SCALPING")).toBe(false);
    });

    it("SCALPING accepts an intraday-blended-RR setup on side of the tape", () => {
      const good = makeSignal({
        symbol: "SCALP2",
        confluences: [
          makeFactor("dayChange", 0.4),
          makeFactor("breakout", 0.3),
        ],
        riskReward: 1.14,
        riskRewardBlended: 1.7,
      });
      expect(passesBucketGate(good, "SCALPING")).toBe(true);
    });

    it("POTENTIAL rejects a 'flat' setup with no breakout edge", () => {
      const flat = makeSignal({
        symbol: "WEAK",
        confluences: [
          makeFactor("breakout", 0.05),
          makeFactor("trend", 0.6),
        ],
        confidence: 0.4,
      });
      expect(passesBucketGate(flat, "POTENTIAL")).toBe(false);
    });

    it("POTENTIAL accepts a grade-D, low-conf pick when the factor signature is clean", () => {
      const realSetup = makeSignal({
        symbol: "OK",
        grade: "D",
        confidence: 0.25,
        confluences: [
          makeFactor("breakout", 0.5),
          makeFactor("trend", 0.8),
          makeFactor("momentum", 0.4),
        ],
      });
      expect(passesBucketGate(realSetup, "POTENTIAL")).toBe(true);
    });

    it("INDICES_SCALP enforces a confidence floor (≥0.18) but not a grade gate", () => {
      expect(
        passesBucketGate(
          makeSignal({ symbol: "X", confidence: 0.1, grade: "B" }),
          "INDICES_SCALP",
        ),
      ).toBe(false);
      expect(
        passesBucketGate(
          makeSignal({ symbol: "Y", confidence: 0.22, grade: "D" }),
          "INDICES_SCALP",
        ),
      ).toBe(true);
    });

    it("OPENING_BREAKOUT has no engine-side gate (curated upstream)", () => {
      const weak = makeSignal({ symbol: "X", confidence: 0.1, grade: "D" });
      expect(passesBucketGate(weak, "OPENING_BREAKOUT")).toBe(true);
    });

    it("does NOT gate on grade — a grade-D mover with clean factors clears MOMENTUM", () => {
      const gradeDMover = makeSignal({
        symbol: "MOVER",
        grade: "D",
        confidence: 0.25,
        confluences: [
          makeFactor("dayChange", 0.45),
          makeFactor("trend", 1.0),
          makeFactor("momentum", 0.7),
          makeFactor("breakout", 0.3),
        ],
      });
      expect(passesBucketGate(gradeDMover, "MOMENTUM")).toBe(true);
    });
  });

  describe("selectDailyPicks hard-filter integration", () => {
    it("regression: 3 shorts + 3 weak longs in a bullish tape — only longs survive", () => {
      // Reproduces the 2026-06-17 Highly Scalping incident: shorts ranked
      // highest under the old engine because below-avg volume flipped sign for
      // shorts. With the volume-factor fix + tape filter + bucket gate the
      // shorts are dropped entirely and the bucket reflects the tape.
      const shorts = ["S1", "S2", "S3"].map((sym) =>
        makeSignal({
          symbol: sym,
          direction: "BEARISH",
          action: "SHORT",
          confluences: [
            makeFactor("trend", -0.4),
            makeFactor("momentum", -0.3),
            // Volume factor as the *fixed* builder emits it on a low-volume
            // day: raw score 0 (lack of conviction), not a flipped negative.
            // Under `aligned()` this stays 0 — failing the MOMENTUM/SCALPING
            // volume gate, which is the whole point of the regression.
            makeFactor("volume", 0),
            makeFactor("scanner", -0.2),
          ],
          riskReward: 2,
          stopLoss: 105,
          takeProfits: [
            { level: 1, price: 95, percent: 5, allocation: 0.5 },
            { level: 2, price: 90, percent: 10, allocation: 0.3 },
            { level: 3, price: 85, percent: 15, allocation: 0.2 },
          ],
        }),
      );
      const longs = ["L1", "L2", "L3"].map((sym) =>
        makeSignal({
          symbol: sym,
          direction: "BULLISH",
          action: "LONG",
          confluences: [
            makeFactor("trend", 0.6),
            makeFactor("momentum", 0.5),
            makeFactor("volume", 0.5),
            makeFactor("scanner", 0.4),
          ],
          riskReward: 2,
          horizon: "intraday",
        }),
      );
      const sel = selectDailyPicks([...shorts, ...longs], 3, 0.2);
      const allPicked = (
        ["MOMENTUM", "SCALPING", "POTENTIAL"] as const
      ).flatMap((b) => sel[b].map((x) => x.signal.symbol));
      expect(allPicked.every((s) => s.startsWith("L"))).toBe(true);
      expect(allPicked).not.toContain("S1");
    });

    it("leaves a bucket empty rather than promoting a sub-threshold pick", () => {
      // Pool has only weak (grade D, conf 0.2) signals — POTENTIAL should
      // refuse to fill rather than ship a low-conviction "highest conviction"
      // pick.
      const weak = ["W1", "W2", "W3"].map((sym) =>
        makeSignal({
          symbol: sym,
          confidence: 0.2,
          grade: "D",
          confluences: [
            makeFactor("trend", 0.6),
            makeFactor("volume", 0.5),
          ],
        }),
      );
      const sel = selectDailyPicks(weak, 3, 0);
      expect(sel.POTENTIAL.length).toBe(0);
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
