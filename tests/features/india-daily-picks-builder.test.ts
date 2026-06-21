import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AiSignal } from "@/types/ai-signals";
import type { IndiaScalpSignal } from "@/features/india/scalping/types";

const getCandidatesMock = vi.fn();
const getOrbMock = vi.fn();
const nseGetOptionChainMock = vi.fn();

vi.mock("@/features/ai-signals/india-builder", () => ({
  getIndiaDailyPickCandidates: () => getCandidatesMock(),
}));

vi.mock("@/features/india/scalping/strategies/opening-breakout", () => ({
  getIndiaOpeningBreakoutSignals: (...args: unknown[]) => getOrbMock(...args),
}));

// Mock the NSE service surface used by the builder for INDICES_SCALP option
// projection + live tracking. Default behaviour: chain unavailable (null) so
// existing tests that don't surface any index symbols behave exactly as
// before. Tests that exercise the option-projection path stub this to return
// a controlled chain.
vi.mock("@/services/india/nse", () => ({
  nse: {
    getOptionChain: (...args: unknown[]) => nseGetOptionChainMock(...args),
  },
}));

import {
  getIndiaDailyPicks,
  getIndiaDailyPicksHistory,
  summariseDay,
} from "@/features/india/daily-picks/builder";
import {
  buildDailyPicks,
  dailyPickFromScalpSignal,
  istDateKey,
  type DailyPick,
} from "@/features/india/daily-picks/engine";

function makeOrbSignal(
  overrides: Partial<IndiaScalpSignal> = {},
): IndiaScalpSignal {
  return {
    strategyId: "OPENING_BREAKOUT",
    symbol: overrides.symbol ?? "NIFTY",
    symbolName: overrides.symbolName ?? overrides.symbol ?? "NIFTY",
    timeframe: "5m",
    direction: overrides.direction ?? "LONG",
    price: overrides.price ?? 100.4,
    reference: overrides.reference ?? 100.3,
    atr: overrides.atr ?? 0.3,
    confirmed: overrides.confirmed ?? true,
    entry: overrides.entry ?? 100.3,
    stopLoss: overrides.stopLoss ?? 100,
    target: overrides.target ?? 100.9,
    riskReward: overrides.riskReward ?? 2,
    confidence: overrides.confidence ?? 0.7,
    rationale: overrides.rationale ?? ["range break", "retest held"],
    triggeredAt: overrides.triggeredAt ?? Date.now(),
    extras: overrides.extras ?? { stretchTarget: 101.2 },
  };
}

function makeSignal(overrides: Partial<AiSignal> = {}): AiSignal {
  const entry = overrides.entry ?? 100;
  return {
    id: overrides.symbol ?? "SIG",
    symbol: overrides.symbol ?? "SIG",
    displayName: overrides.symbol ?? "SIG",
    market: "india",
    pair: `${overrides.symbol ?? "SIG"}.NS`,
    action: "LONG",
    direction: "BULLISH",
    horizon: overrides.horizon ?? "intraday",
    underlyingPrice: overrides.underlyingPrice ?? entry,
    entry,
    entryZone: { min: entry - 1, max: entry + 1 },
    strike: entry,
    stopLoss: 95,
    takeProfits: [
      { level: 1, price: 105, percent: 5, allocation: 0.5 },
      { level: 2, price: 110, percent: 10, allocation: 0.3 },
      { level: 3, price: 120, percent: 20, allocation: 0.2 },
    ],
    riskReward: 2,
    riskRewardBlended: 2.5,
    expectedMovePct: 4,
    positionSizingPct: 5,
    riskLevel: "medium",
    confidence: overrides.confidence ?? 0.7,
    confidenceScore: 70,
    grade: "B",
    winProbability: 0.6,
    timing: {
      generatedAt: 0,
      enterBy: 0,
      exitBy: 0,
      validForMs: 0,
      bestEntryNote: "",
      bestExitNote: "",
    },
    confluences: [
      { id: "dayChange", category: "flow", label: "dayChange", description: "", weight: 0.13, score: 0.5, contribution: 0.065, available: true },
      { id: "breakout", category: "chart", label: "breakout", description: "", weight: 0.13, score: 0.4, contribution: 0.052, available: true },
      { id: "trend", category: "technical", label: "trend", description: "", weight: 0.1, score: 0.8, contribution: 0.08, available: true },
      { id: "momentum", category: "technical", label: "momentum", description: "", weight: 0.1, score: 0.7, contribution: 0.07, available: true },
      { id: "volume", category: "flow", label: "volume", description: "", weight: 0.1, score: 0.6, contribution: 0.06, available: true },
      { id: "scanner", category: "flow", label: "scanner", description: "", weight: 0.1, score: 0.5, contribution: 0.05, available: true },
    ],
    bullishCount: 4,
    bearishCount: 0,
    reasons: [{ category: "technical", text: "Uptrend", bullish: true }],
    invalidationCriteria: "x",
    modelVersion: "test",
    summary: "s",
    ...overrides,
  };
}

function candidateUniverse(): AiSignal[] {
  return Array.from({ length: 12 }, (_, i) =>
    makeSignal({
      symbol: `S${i}`,
      confidence: 0.5 + (i % 5) * 0.07,
      horizon: i % 2 === 0 ? "scalp" : "swing",
    }),
  );
}

/** Minimal in-memory fake of the Prisma `indiaDailyPick` model. */
function fakePrisma() {
  let store: Record<string, unknown>[] = [];
  const model = {
    findMany: vi.fn(async (args?: { where?: { tradeDate?: unknown }; distinct?: string[]; orderBy?: unknown; take?: number; select?: unknown }) => {
      let rows = store.slice();
      const where = args?.where as { tradeDate?: string | { in?: string[]; not?: string } } | undefined;
      if (where?.tradeDate && typeof where.tradeDate === "string") {
        rows = rows.filter((r) => r.tradeDate === where.tradeDate);
      } else if (where?.tradeDate && typeof where.tradeDate === "object") {
        const td = where.tradeDate as { in?: string[]; not?: string };
        if (td.in) rows = rows.filter((r) => td.in!.includes(r.tradeDate as string));
        if (td.not) rows = rows.filter((r) => r.tradeDate !== td.not);
      }
      if (args?.distinct?.includes("tradeDate")) {
        const seen = new Set<string>();
        rows = rows.filter((r) => {
          const d = r.tradeDate as string;
          if (seen.has(d)) return false;
          seen.add(d);
          return true;
        });
        rows.sort((a, b) => String(b.tradeDate).localeCompare(String(a.tradeDate)));
        if (args.take) rows = rows.slice(0, args.take);
        return rows.map((r) => ({ tradeDate: r.tradeDate }));
      }
      return rows;
    }),
    createMany: vi.fn(async (args: { data: Record<string, unknown>[] }) => {
      for (const d of args.data) {
        store.push({
          ...d,
          generatedAt: d.generatedAt ?? new Date(),
          updatedAt: new Date(),
        });
      }
      return { count: args.data.length };
    }),
    update: vi.fn(async (args: { where: { tradeDate_bucket_rank: { tradeDate: string; bucket: string; rank: number } }; data: Record<string, unknown> }) => {
      const key = args.where.tradeDate_bucket_rank;
      const row = store.find(
        (r) => r.tradeDate === key.tradeDate && r.bucket === key.bucket && r.rank === key.rank,
      );
      if (row) Object.assign(row, args.data, { updatedAt: new Date() });
      return row;
    }),
    updateMany: vi.fn(async (args: { where: { OR?: Array<{ tradeDate: string; bucket: string; rank: number }> }; data: Record<string, unknown> }) => {
      const or = args.where.OR ?? [];
      let count = 0;
      for (const sel of or) {
        const row = store.find(
          (r) => r.tradeDate === sel.tradeDate && r.bucket === sel.bucket && r.rank === sel.rank,
        );
        if (row) {
          Object.assign(row, args.data, { updatedAt: new Date() });
          count += 1;
        }
      }
      return { count };
    }),
    deleteMany: vi.fn(
      async (args: {
        where: {
          tradeDate?: string;
          generatedAt?: { lt?: Date };
        };
      }) => {
        const before = store.length;
        const where = args.where;
        store = store.filter((r) => {
          if (where.tradeDate && r.tradeDate !== where.tradeDate) return true;
          if (where.generatedAt?.lt) {
            const ts = (r.generatedAt as Date).getTime();
            if (ts >= where.generatedAt.lt.getTime()) return true;
          }
          return false;
        });
        return { count: before - store.length };
      },
    ),
  };
  return {
    client: { indiaDailyPick: model } as never,
    model,
    seed: (rows: Record<string, unknown>[]) => {
      store = rows.map((r) => ({
        ...r,
        generatedAt: r.generatedAt instanceof Date ? r.generatedAt : new Date(),
        updatedAt: r.updatedAt instanceof Date ? r.updatedAt : new Date(),
      }));
    },
    all: () => store,
  };
}

// Freeze wall-clock to a post-open instant (10:30 IST on 2026-06-16, a
// Tuesday). The builder gates freezing on `now >= 09:15 IST`, so the suite
// would behave differently depending on the actual time of day without this.
const FAKE_NOW_MS = Date.UTC(2026, 5, 16, 5, 0, 0); // 2026-06-16T05:00:00Z = 10:30 IST
const TODAY = "2026-06-16";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(FAKE_NOW_MS));
  getCandidatesMock.mockReset();
  getOrbMock.mockReset();
  nseGetOptionChainMock.mockReset();
  // Default: no Opening Breakout signals (the opening candle hasn't broken /
  // retested yet) so the AI-bucket assertions stay deterministic.
  getOrbMock.mockResolvedValue([]);
  // Default: option chains unavailable — the builder fail-softs to dropping
  // any INDICES_SCALP picks rather than fabricating premiums.
  nseGetOptionChainMock.mockRejectedValue(new Error("no chain (test default)"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("getIndiaDailyPicks", () => {
  it("freezes 3 picks per bucket on the first request of the day", async () => {
    getCandidatesMock.mockResolvedValue({
      signals: candidateUniverse(),
      context: { market: "india", regime: "mixed" },
      inActiveWindow: true,
      generatedAt: Date.now(),
    });
    const db = fakePrisma();

    const res = await getIndiaDailyPicks(db.client);
    expect(res.persisted).toBe(true);
    expect(res.groups.map((g) => g.bucket)).toEqual([
      "INDICES_SCALP",
      "OPENING_BREAKOUT",
      "MOMENTUM",
      "SCALPING",
      "POTENTIAL",
    ]);
    // The synthetic universe is all stocks (S0..S11) — the three stock buckets
    // fill to 3 each. Indices + Opening Breakout have no candidates here.
    const STOCK = ["MOMENTUM", "SCALPING", "POTENTIAL"];
    const stockGroups = res.groups.filter((g) => STOCK.includes(g.bucket));
    for (const g of stockGroups) expect(g.picks.length).toBe(3);
    expect(
      res.groups.find((g) => g.bucket === "INDICES_SCALP")?.picks.length,
    ).toBe(0);
    expect(
      res.groups.find((g) => g.bucket === "OPENING_BREAKOUT")?.picks.length,
    ).toBe(0);
    expect(db.model.createMany).toHaveBeenCalledTimes(1);
    expect(db.all().length).toBe(9);
  });

  it("live-tracks frozen picks on subsequent requests instead of re-freezing", async () => {
    const tradeDate = istDateKey(new Date());
    // Freeze a known pick at entry 100, target 105, and seed it.
    const frozen = buildDailyPicks({
      signals: [makeSignal({ symbol: "RELIANCE", entry: 100, underlyingPrice: 100 })].concat(
        candidateUniverse(),
      ),
      tradeDate,
      now: Date.now(),
    });
    const db = fakePrisma();
    db.seed(frozen.map((p) => ({ ...p, generatedAt: new Date(), updatedAt: new Date() })));

    // Now the candidate for RELIANCE has rallied to 106 → target hit.
    getCandidatesMock.mockResolvedValue({
      signals: [makeSignal({ symbol: "RELIANCE", entry: 100, underlyingPrice: 106 })].concat(
        candidateUniverse().map((s) => ({ ...s, underlyingPrice: s.underlyingPrice })),
      ),
      context: { market: "india", regime: "mixed" },
      inActiveWindow: true,
      generatedAt: Date.now(),
    });

    const res = await getIndiaDailyPicks(db.client);
    expect(db.model.createMany).not.toHaveBeenCalled();
    const reliance = res.groups
      .flatMap((g) => g.picks)
      .find((p) => p.symbol === "RELIANCE");
    expect(reliance?.status).toBe("TARGET_HIT");
    expect(reliance?.pnlPct).toBeCloseTo(6, 5);
    expect(db.model.update).toHaveBeenCalled();
  });

  it("falls back to ephemeral picks when the DB throws", async () => {
    getCandidatesMock.mockResolvedValue({
      signals: candidateUniverse(),
      context: { market: "india", regime: "mixed" },
      inActiveWindow: false,
      generatedAt: Date.now(),
    });
    const broken = {
      indiaDailyPick: {
        findMany: vi.fn(async () => {
          throw new Error("connection refused");
        }),
      },
    } as never;

    const res = await getIndiaDailyPicks(broken);
    expect(res.persisted).toBe(false);
    const STOCK = ["MOMENTUM", "SCALPING", "POTENTIAL"];
    const stockGroups = res.groups.filter((g) => STOCK.includes(g.bucket));
    for (const g of stockGroups) expect(g.picks.length).toBe(3);
  });

  it("lazily freezes the Opening Breakout bucket from the ORB strategy", async () => {
    getCandidatesMock.mockResolvedValue({
      signals: candidateUniverse(),
      context: { market: "india", regime: "mixed" },
      inActiveWindow: true,
      generatedAt: Date.now(),
    });
    getOrbMock.mockResolvedValue([
      makeOrbSignal({ symbol: "NIFTY", confidence: 0.74 }),
      makeOrbSignal({ symbol: "RELIANCE", confidence: 0.68, price: 100.4 }),
      makeOrbSignal({ symbol: "INFY", confidence: 0.6, price: 100.4 }),
    ]);
    const db = fakePrisma();

    const res = await getIndiaDailyPicks(db.client);
    const orb = res.groups.find((g) => g.bucket === "OPENING_BREAKOUT");
    expect(orb?.picks.length).toBe(3);
    expect(orb?.picks.map((p) => p.symbol)).toEqual([
      "NIFTY",
      "RELIANCE",
      "INFY",
    ]);
    // Both the AI buckets and the ORB bucket freeze on this first request.
    expect(db.model.createMany).toHaveBeenCalledTimes(2);
    expect(getOrbMock).toHaveBeenCalledWith({ timeframe: "5m", limit: 12 });
  });

  it("tracks already-frozen ORB rows without re-freezing them", async () => {
    const tradeDate = istDateKey(new Date());
    const db = fakePrisma();
    // Seed AI picks + a frozen ORB pick (entry 100.3, target 100.9).
    const aiFrozen = buildDailyPicks({
      signals: candidateUniverse(),
      tradeDate,
      now: Date.now(),
    });
    const orbFrozen = dailyPickFromScalpSignal({
      signal: makeOrbSignal({ symbol: "NIFTY", entry: 100.3, target: 100.9 }),
      rank: 1,
      tradeDate,
      now: Date.now(),
    });
    db.seed(
      [...aiFrozen, orbFrozen].map((p) => ({
        ...p,
        generatedAt: new Date(),
        updatedAt: new Date(),
      })),
    );
    // ORB strategy now marks NIFTY rallied past target.
    getCandidatesMock.mockResolvedValue({
      signals: candidateUniverse(),
      context: { market: "india", regime: "mixed" },
      inActiveWindow: true,
      generatedAt: Date.now(),
    });
    getOrbMock.mockResolvedValue([
      makeOrbSignal({ symbol: "NIFTY", entry: 100.3, target: 100.9, price: 101 }),
    ]);

    const res = await getIndiaDailyPicks(db.client);
    expect(db.model.createMany).not.toHaveBeenCalled();
    const nifty = res.groups
      .flatMap((g) => g.picks)
      .find((p) => p.bucket === "OPENING_BREAKOUT" && p.symbol === "NIFTY");
    expect(nifty?.status).toBe("TARGET_HIT");
  });

  it("filters Opening Breakout to confirmed retests above the confidence floor", async () => {
    getCandidatesMock.mockResolvedValue({
      signals: candidateUniverse(),
      context: { market: "india", regime: "mixed" },
      inActiveWindow: true,
      generatedAt: Date.now(),
    });
    // Unconfirmed (awaiting retest) and low-confidence signals both reach the
    // strategy feed; only the confirmed + ≥0.55 confidence ones make it into
    // Daily Picks. Regression for the ICICIBANK 18-min stopout on 2026-06-17.
    getOrbMock.mockResolvedValue([
      // Unconfirmed — must be dropped despite high confidence.
      makeOrbSignal({ symbol: "ICICIBANK", confirmed: false, confidence: 0.83 }),
      // Confirmed but sub-floor — must be dropped.
      makeOrbSignal({ symbol: "ITC", confirmed: true, confidence: 0.42 }),
      // Confirmed + above floor — survives.
      makeOrbSignal({ symbol: "NIFTY", confirmed: true, confidence: 0.66 }),
    ]);
    const db = fakePrisma();

    const res = await getIndiaDailyPicks(db.client);
    const orbPicks =
      res.groups.find((g) => g.bucket === "OPENING_BREAKOUT")?.picks ?? [];
    expect(orbPicks.map((p) => p.symbol)).toEqual(["NIFTY"]);
  });

  it("applies the tape filter to Opening Breakout — drops counter-tape shorts on a bullish day", async () => {
    // Regression for 2026-06-17 second incident: the NIFTY ORB long fired at
    // ~10:00 IST, retested, and ran to its stretch target (24,102). But the
    // top 3 of the ORB feed were ICICIBANK SHORT (0.75), MIDCPNIFTY LONG
    // (0.66), and AXISBANK SHORT (0.62) — two stock shorts fighting a +0.15
    // bullish tape crowded the cleanest index long off the board. With the
    // tape filter the shorts get dropped and NIFTY finally surfaces.
    getCandidatesMock.mockResolvedValue({
      signals: candidateUniverse(),
      context: {
        market: "india",
        regime: "bullish",
        regimeScore: 0.15, // > +0.10 tape bias → drops shorts
      },
      inActiveWindow: true,
      generatedAt: Date.now(),
    });
    getOrbMock.mockResolvedValue([
      makeOrbSignal({ symbol: "ICICIBANK", direction: "SHORT", confidence: 0.75 }),
      makeOrbSignal({ symbol: "MIDCPNIFTY", direction: "LONG", confidence: 0.66 }),
      makeOrbSignal({ symbol: "AXISBANK", direction: "SHORT", confidence: 0.62 }),
      makeOrbSignal({ symbol: "KOTAKBANK", direction: "LONG", confidence: 0.62 }),
      makeOrbSignal({ symbol: "NIFTY", direction: "LONG", confidence: 0.58 }),
    ]);
    const db = fakePrisma();

    const res = await getIndiaDailyPicks(db.client);
    const orbSyms =
      res.groups.find((g) => g.bucket === "OPENING_BREAKOUT")?.picks.map(
        (p) => p.symbol,
      ) ?? [];
    expect(orbSyms).not.toContain("ICICIBANK");
    expect(orbSyms).not.toContain("AXISBANK");
    // Top 3 longs by confidence after the shorts are dropped.
    expect(orbSyms).toEqual(["MIDCPNIFTY", "KOTAKBANK", "NIFTY"]);
  });

  it("Opening Breakout falls back to the unfiltered set when tape would empty the bucket", async () => {
    // If the only confirmed ORB setups today are counter-tape, surface them
    // anyway rather than going empty — better to show the day's actual
    // strategy output than a blank board.
    getCandidatesMock.mockResolvedValue({
      signals: candidateUniverse(),
      context: {
        market: "india",
        regime: "bullish",
        regimeScore: 0.3,
      },
      inActiveWindow: true,
      generatedAt: Date.now(),
    });
    getOrbMock.mockResolvedValue([
      makeOrbSignal({ symbol: "TCS", direction: "SHORT", confidence: 0.7 }),
      makeOrbSignal({ symbol: "INFY", direction: "SHORT", confidence: 0.62 }),
    ]);
    const db = fakePrisma();

    const res = await getIndiaDailyPicks(db.client);
    const orbSyms =
      res.groups.find((g) => g.bucket === "OPENING_BREAKOUT")?.picks.map(
        (p) => p.symbol,
      ) ?? [];
    expect(orbSyms).toEqual(["TCS", "INFY"]);
  });

  it("projects INDICES_SCALP picks into ATM option contracts (premiums, not index levels)", async () => {
    // Inject one NIFTY index candidate strong enough to clear the bucket
    // gates, alongside the stock universe.
    const niftySignal = makeSignal({
      symbol: "NIFTY",
      displayName: "NIFTY 50",
      pair: "NIFTY",
      entry: 24080,
      underlyingPrice: 24080,
      stopLoss: 23866,
      confidence: 0.6,
      grade: "B",
      takeProfits: [
        { level: 1, price: 24337, percent: 1.07, allocation: 0.5 },
        { level: 2, price: 24450, percent: 1.54, allocation: 0.3 },
        { level: 3, price: 24500, percent: 1.74, allocation: 0.2 },
      ],
      confluences: [
        { id: "trend", category: "technical", label: "trend", description: "", weight: 0.2, score: 0.7, contribution: 0.14, available: true },
        { id: "momentum", category: "technical", label: "momentum", description: "", weight: 0.2, score: 0.6, contribution: 0.12, available: true },
        { id: "volume", category: "flow", label: "volume", description: "", weight: 0.1, score: 0.5, contribution: 0.05, available: true },
        { id: "oiBuildup", category: "derivatives", label: "OI", description: "", weight: 0.2, score: 0.8, contribution: 0.16, available: true },
        { id: "pcr", category: "derivatives", label: "PCR", description: "", weight: 0.1, score: 0.4, contribution: 0.04, available: true },
        { id: "maxPain", category: "derivatives", label: "maxPain", description: "", weight: 0.1, score: 0.3, contribution: 0.03, available: true },
      ],
    });
    getCandidatesMock.mockResolvedValue({
      signals: [niftySignal, ...candidateUniverse()],
      context: { market: "india", regime: "mixed", regimeScore: 0 },
      inActiveWindow: true,
      generatedAt: Date.now(),
    });
    // Stub the chain so the projection has an ATM strike with a quotable
    // premium. Per-symbol behaviour keyed off the requested underlying.
    nseGetOptionChainMock.mockImplementation(async (sym: string) => {
      if (sym !== "NIFTY") throw new Error(`no chain for ${sym}`);
      return {
        symbol: "NIFTY",
        spot: 24080,
        expiry: "26-Jun-2026",
        expiries: ["26-Jun-2026"],
        rows: [
          { strike: 24050, ce: null, pe: null },
          {
            strike: 24100,
            ce: { strike: 24100, type: "CE", oi: 0, changeInOi: 0, volume: 0, iv: 14, ltp: 100, bid: null, ask: null, delta: 0.5 },
            pe: { strike: 24100, type: "PE", oi: 0, changeInOi: 0, volume: 0, iv: 14, ltp: 110, bid: null, ask: null, delta: -0.5 },
          },
          { strike: 24150, ce: null, pe: null },
        ],
        analytics: {
          pcrOi: null,
          pcrVolume: null,
          maxCeOiStrike: null,
          maxPeOiStrike: null,
          totalCeOi: 0,
          totalPeOi: 0,
          totalCeOiChange: 0,
          totalPeOiChange: 0,
          atmIv: 14,
          maxPain: null,
        },
        fetchedAt: new Date().toISOString(),
      };
    });
    const db = fakePrisma();

    const res = await getIndiaDailyPicks(db.client);
    const indices = res.groups.find((g) => g.bucket === "INDICES_SCALP")?.picks ?? [];
    expect(indices.length).toBe(1);
    const nifty = indices[0];
    // Display + contract metadata reflect the OPTION the desk actually trades.
    expect(nifty.displayName).toBe("NIFTY 24100 CE");
    expect(nifty.optionContract).toMatchObject({
      strike: 24100,
      side: "CE",
      lotSize: 75,
      expiry: "26-Jun-2026",
      delta: 0.5,
    });
    // Entry = current option LTP (₹100), not the index level (24080).
    expect(nifty.entry).toBe(100);
    // Target underlying +257 × delta 0.5 = +128.5 premium → ≈228.5.
    expect(nifty.target).toBeCloseTo(228.5, 1);
    // Stop underlying −214 × 0.5 = −107 → floored at MIN_PREMIUM (≈0.05).
    expect(nifty.stopLoss).toBeLessThan(1);
    // Persisted with the option contract JSON for live re-pricing.
    const stored = db.all().find((r) => r.bucket === "INDICES_SCALP");
    expect(stored?.optionContract).toMatchObject({ strike: 24100, side: "CE" });
  });

  it("drops INDICES_SCALP picks when the option chain is unavailable", async () => {
    const niftySignal = makeSignal({
      symbol: "NIFTY",
      entry: 24080,
      underlyingPrice: 24080,
      confidence: 0.6,
      grade: "B",
      confluences: [
        { id: "trend", category: "technical", label: "trend", description: "", weight: 0.2, score: 0.7, contribution: 0.14, available: true },
        { id: "volume", category: "flow", label: "volume", description: "", weight: 0.1, score: 0.5, contribution: 0.05, available: true },
        { id: "oiBuildup", category: "derivatives", label: "OI", description: "", weight: 0.2, score: 0.8, contribution: 0.16, available: true },
      ],
    });
    getCandidatesMock.mockResolvedValue({
      signals: [niftySignal, ...candidateUniverse()],
      context: { market: "india", regime: "mixed", regimeScore: 0 },
      inActiveWindow: true,
      generatedAt: Date.now(),
    });
    // Chain mock stays at the suite default (rejects) — projection can't run.
    const db = fakePrisma();

    const res = await getIndiaDailyPicks(db.client);
    const indices = res.groups.find((g) => g.bucket === "INDICES_SCALP")?.picks ?? [];
    expect(indices.length).toBe(0);
  });

  it("does NOT freeze before the 09:15 IST open — returns empty groups", async () => {
    // Re-arm fake time to 08:30 IST (pre-market) on the same trade date.
    vi.setSystemTime(new Date(Date.UTC(2026, 5, 16, 3, 0, 0))); // 03:00 UTC = 08:30 IST
    getCandidatesMock.mockResolvedValue({
      signals: candidateUniverse(),
      context: { market: "india", regime: "mixed" },
      inActiveWindow: false,
      generatedAt: Date.now(),
    });
    const db = fakePrisma();

    const res = await getIndiaDailyPicks(db.client);
    expect(res.tradeDate).toBe(TODAY);
    expect(res.groups.every((g) => g.picks.length === 0)).toBe(true);
    expect(db.model.createMany).not.toHaveBeenCalled();
    expect(db.all()).toEqual([]);
  });

  it("tops up an AI bucket when an earlier freeze landed fewer than 3 picks", async () => {
    // Reproduces the 2026-06-18 INDICES_SCALP shortfall — at the first freeze
    // tick only NIFTY made it through (BANKNIFTY/FINNIFTY/MIDCPNIFTY were
    // dropped by `projectIndicesScalpPicks` because their chains were
    // unavailable). Without top-up the bucket stays at rank 1 for the whole
    // day even though those chains come back online a minute later.
    const tradeDate = istDateKey(new Date());
    const db = fakePrisma();
    // Seed ONLY a single MOMENTUM rank-1 pick to simulate the "shortfall"
    // freeze. Two stock buckets (SCALPING / POTENTIAL) and the AI's other
    // buckets are intentionally empty.
    const partial = buildDailyPicks({
      signals: [makeSignal({ symbol: "SOLO", entry: 100, underlyingPrice: 100 })],
      tradeDate,
      now: Date.now(),
    }).filter((p) => p.bucket === "MOMENTUM" && p.rank === 1);
    expect(partial.length).toBe(1);
    db.seed(
      partial.map((p) => ({ ...p, generatedAt: new Date(), updatedAt: new Date() })),
    );

    // Next minute: fresh candidates that would fill the bucket with 3 names.
    getCandidatesMock.mockResolvedValue({
      signals: candidateUniverse(),
      context: { market: "india", regime: "mixed", regimeScore: 0 },
      inActiveWindow: true,
      generatedAt: Date.now(),
    });

    const res = await getIndiaDailyPicks(db.client);
    const momentum =
      res.groups.find((g) => g.bucket === "MOMENTUM")?.picks ?? [];

    // Bucket is now full to 3, with the originally-frozen rank 1 intact and
    // two new picks added at ranks 2 + 3 from the latest tick.
    expect(momentum.length).toBe(3);
    expect(momentum.map((p) => p.rank)).toEqual([1, 2, 3]);
    expect(momentum[0].symbol).toBe("SOLO");

    // Top-up persisted exactly the 2 missing slots — no duplicate ranks.
    expect(db.model.createMany).toHaveBeenCalledTimes(1);
    const persisted = db
      .all()
      .filter((r) => r.bucket === "MOMENTUM")
      .map((r) => r.rank);
    expect(persisted.sort()).toEqual([1, 2, 3]);
  });

  it("tops up the Opening Breakout bucket as more ORB signals qualify later", async () => {
    // Reproduces the 2026-06-18 OPENING_BREAKOUT shortfall — only AXISBANK
    // had qualified at the first non-empty ORB freeze (09:45), so the bucket
    // froze at rank 1 only. Later in the session more ORB signals fired
    // (confirmed + ≥0.55 confidence) but never reached the board.
    const tradeDate = istDateKey(new Date());
    const db = fakePrisma();
    const seeded = dailyPickFromScalpSignal({
      signal: makeOrbSignal({ symbol: "AXISBANK", confidence: 0.7 }),
      rank: 1,
      tradeDate,
      now: Date.now(),
    });
    db.seed([
      { ...seeded, generatedAt: new Date(), updatedAt: new Date() },
    ]);

    // Two more ORB signals now qualify. The existing one is still in the
    // feed (real strategy keeps emitting it) — top-up must NOT re-create it.
    getOrbMock.mockResolvedValue([
      makeOrbSignal({ symbol: "AXISBANK", confidence: 0.7 }),
      makeOrbSignal({ symbol: "RELIANCE", confidence: 0.66, price: 100.4 }),
      makeOrbSignal({ symbol: "INFY", confidence: 0.6, price: 100.4 }),
    ]);
    getCandidatesMock.mockResolvedValue({
      signals: candidateUniverse(),
      context: { market: "india", regime: "mixed", regimeScore: 0 },
      inActiveWindow: true,
      generatedAt: Date.now(),
    });

    const res = await getIndiaDailyPicks(db.client);
    const orb =
      res.groups.find((g) => g.bucket === "OPENING_BREAKOUT")?.picks ?? [];

    expect(orb.length).toBe(3);
    expect(orb.map((p) => p.rank)).toEqual([1, 2, 3]);
    expect(orb.map((p) => p.symbol)).toEqual(["AXISBANK", "RELIANCE", "INFY"]);

    // AXISBANK rank 1 was tracked, not re-frozen.
    const persistedRanks = db
      .all()
      .filter((r) => r.bucket === "OPENING_BREAKOUT")
      .map((r) => r.rank)
      .sort();
    expect(persistedRanks).toEqual([1, 2, 3]);
  });

  it("never re-freezes when both AI + ORB buckets are already full", async () => {
    // Steady-state sanity check: if every bucket already has its 3 picks,
    // top-up must be a no-op (only tracking updates).
    const tradeDate = istDateKey(new Date());
    const db = fakePrisma();
    const aiFrozen = buildDailyPicks({
      signals: candidateUniverse(),
      tradeDate,
      now: Date.now(),
    });
    const orbFrozen = [
      dailyPickFromScalpSignal({
        signal: makeOrbSignal({ symbol: "NIFTY", confidence: 0.74 }),
        rank: 1,
        tradeDate,
        now: Date.now(),
      }),
      dailyPickFromScalpSignal({
        signal: makeOrbSignal({ symbol: "RELIANCE", confidence: 0.68 }),
        rank: 2,
        tradeDate,
        now: Date.now(),
      }),
      dailyPickFromScalpSignal({
        signal: makeOrbSignal({ symbol: "INFY", confidence: 0.6 }),
        rank: 3,
        tradeDate,
        now: Date.now(),
      }),
    ];
    db.seed(
      [...aiFrozen, ...orbFrozen].map((p) => ({
        ...p,
        generatedAt: new Date(),
        updatedAt: new Date(),
      })),
    );
    getCandidatesMock.mockResolvedValue({
      signals: candidateUniverse(),
      context: { market: "india", regime: "mixed", regimeScore: 0 },
      inActiveWindow: true,
      generatedAt: Date.now(),
    });
    getOrbMock.mockResolvedValue([
      makeOrbSignal({ symbol: "NIFTY", confidence: 0.74 }),
      makeOrbSignal({ symbol: "TCS", confidence: 0.7 }),
    ]);

    await getIndiaDailyPicks(db.client);
    expect(db.model.createMany).not.toHaveBeenCalled();
  });

  it("evicts stale pre-market rows and re-freezes with fresh opening prices", async () => {
    // Seed yesterday-evening / midnight rows for today (generatedAt < 09:15 IST)
    // — exactly the scenario reported in production where a midnight cron froze
    // picks against stale closes that then live-tracked all morning.
    const preOpenMs = Date.UTC(2026, 5, 15, 18, 42, 0); // 00:12 IST today
    const stale = buildDailyPicks({
      signals: [makeSignal({ symbol: "STALE", entry: 50 })],
      tradeDate: TODAY,
      now: preOpenMs,
    });
    const db = fakePrisma();
    db.seed(
      stale.map((p) => ({
        ...p,
        generatedAt: new Date(preOpenMs),
        updatedAt: new Date(preOpenMs),
      })),
    );

    // Now we're at 10:30 IST (the global fake "now") with fresh candidates.
    getCandidatesMock.mockResolvedValue({
      signals: candidateUniverse(),
      context: { market: "india", regime: "mixed" },
      inActiveWindow: true,
      generatedAt: Date.now(),
    });

    const res = await getIndiaDailyPicks(db.client);

    // Old midnight rows are gone.
    expect(db.model.deleteMany).toHaveBeenCalled();
    const allSymbols = db.all().map((r) => r.symbol);
    expect(allSymbols).not.toContain("STALE");
    // Fresh picks were frozen against the post-open universe.
    expect(db.model.createMany).toHaveBeenCalled();
    const fresh = res.groups.flatMap((g) => g.picks);
    expect(fresh.length).toBeGreaterThan(0);
    expect(fresh.every((p) => p.generatedAt >= FAKE_NOW_MS - 60_000)).toBe(true);
    expect(fresh.every((p) => p.symbol !== "STALE")).toBe(true);
  });
});

describe("getIndiaDailyPicksHistory", () => {
  it("groups past days most-recent-first and excludes today", async () => {
    const today = istDateKey(new Date());
    const db = fakePrisma();
    const mk = (tradeDate: string, status: string) =>
      buildDailyPicks({ signals: candidateUniverse(), tradeDate, now: Date.now() }).map(
        (p) => ({ ...p, status }),
      );
    db.seed([
      ...mk("2026-06-10", "TARGET_HIT"),
      ...mk("2026-06-11", "STOP_HIT"),
      ...mk(today, "OPEN"),
    ]);

    const res = await getIndiaDailyPicksHistory({ days: 14, excludeDate: today }, db.client);
    expect(res.days.map((d) => d.tradeDate)).toEqual(["2026-06-11", "2026-06-10"]);
    expect(res.days.find((d) => d.tradeDate === today)).toBeUndefined();
  });

  it("returns an empty list when the DB is unavailable", async () => {
    const broken = {
      indiaDailyPick: {
        findMany: vi.fn(async () => {
          throw new Error("db down");
        }),
      },
    } as never;
    const res = await getIndiaDailyPicksHistory({ days: 5 }, broken);
    expect(res.days).toEqual([]);
  });

  it("squares off any pick left OPEN on a past trading day and persists it", async () => {
    const today = istDateKey(new Date());
    const db = fakePrisma();
    const mk = (tradeDate: string, status: string) =>
      buildDailyPicks({ signals: candidateUniverse(), tradeDate, now: Date.now() }).map(
        (p) => ({ ...p, status }),
      );
    // A past day whose picks never hit target/stop — still OPEN in the DB.
    db.seed([...mk("2026-06-11", "OPEN"), ...mk(today, "OPEN")]);

    const res = await getIndiaDailyPicksHistory(
      { days: 14, excludeDate: today },
      db.client,
    );
    const past = res.days.find((d) => d.tradeDate === "2026-06-11");
    const picks = past?.groups.flatMap((g) => g.picks) ?? [];
    expect(picks.length).toBeGreaterThan(0);
    expect(picks.every((p) => p.status === "CLOSED")).toBe(true);
    // Squared off at the day's 15:30 close, so each carries a resolution time.
    expect(picks.every((p) => p.resolvedAt != null)).toBe(true);
    expect(past?.summary.open).toBe(0);
    expect(past?.summary.closed).toBe(picks.length);
    // The flip is persisted back to the store (per-pick, with resolvedAt).
    expect(db.model.update).toHaveBeenCalled();
    expect(
      db
        .all()
        .filter((r) => r.tradeDate === "2026-06-11")
        .every((r) => r.status === "CLOSED" && r.resolvedAt != null),
    ).toBe(true);
  });
});

describe("summariseDay", () => {
  it("computes win rate over resolved picks only", () => {
    const picks = [
      { status: "TARGET_HIT" },
      { status: "TARGET_HIT" },
      { status: "STOP_HIT" },
      { status: "CLOSED" },
      { status: "OPEN" },
    ] as DailyPick[];
    const s = summariseDay(picks);
    expect(s.total).toBe(5);
    expect(s.targetHit).toBe(2);
    expect(s.stopHit).toBe(1);
    expect(s.closed).toBe(1);
    expect(s.open).toBe(1);
    // Win rate counts only target/stop resolutions, not square-offs.
    expect(s.winRate).toBeCloseTo(2 / 3, 5);
  });
});
