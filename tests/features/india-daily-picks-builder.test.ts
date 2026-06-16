import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AiSignal } from "@/types/ai-signals";
import type { IndiaScalpSignal } from "@/features/india/scalping/types";

const getCandidatesMock = vi.fn();
const getOrbMock = vi.fn();

vi.mock("@/features/ai-signals/india-builder", () => ({
  getIndiaDailyPickCandidates: () => getCandidatesMock(),
}));

vi.mock("@/features/india/scalping/strategies/opening-breakout", () => ({
  getIndiaOpeningBreakoutSignals: (...args: unknown[]) => getOrbMock(...args),
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

beforeEach(() => {
  getCandidatesMock.mockReset();
  getOrbMock.mockReset();
  // Default: no Opening Breakout signals (the opening candle hasn't broken /
  // retested yet) so the AI-bucket assertions stay deterministic.
  getOrbMock.mockResolvedValue([]);
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
