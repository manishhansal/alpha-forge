import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

vi.mock("@/services/india/yahoo", () => ({
  yahoo: { getHistorical: vi.fn() },
}));

import { yahoo } from "@/services/india/yahoo";
import {
  openIndiaPaperTrade,
  resolveIndiaOpenTrades,
} from "@/features/india/scalping/paper-trader";
import type { IndiaScalpSignal } from "@/features/india/scalping/types";

const mockedHistorical = yahoo.getHistorical as unknown as ReturnType<typeof vi.fn>;

function signal(over: Partial<IndiaScalpSignal> = {}): IndiaScalpSignal {
  return {
    strategyId: "LIQUIDITY_EDGE",
    symbol: "NIFTY",
    symbolName: "NIFTY 50",
    timeframe: "5m",
    direction: "LONG",
    price: 22000,
    reference: 22000,
    atr: 110, // synthetic fallback
    confirmed: true,
    entry: 22000,
    stopLoss: 21890,
    target: 22275,
    riskReward: 2.5,
    confidence: 0.7,
    rationale: ["test"],
    triggeredAt: Date.parse("2026-06-10T05:30:00Z"), // Wednesday, no cooldown
    ...over,
  };
}

interface FakePaperTrade {
  findFirst: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  findMany: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
}

function fakePrisma(over: Partial<FakePaperTrade> = {}): {
  prisma: PrismaClient;
  pt: FakePaperTrade;
} {
  const pt: FakePaperTrade = {
    findFirst: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue({ id: "trade-1" }),
    findMany: vi.fn().mockResolvedValue([]),
    update: vi.fn().mockResolvedValue({}),
    ...over,
  };
  return { prisma: { paperTrade: pt } as unknown as PrismaClient, pt };
}

beforeEach(() => mockedHistorical.mockReset());
afterEach(() => vi.clearAllMocks());

describe("india/scalping/paper-trader — openIndiaPaperTrade", () => {
  it("opens a fresh trade tagged with the `in:<id>:<tf>` source", async () => {
    const { prisma, pt } = fakePrisma();
    const res = await openIndiaPaperTrade(signal(), { prisma });

    expect(res.opened).toBe(true);
    expect(res.reason).toBe("fired");
    expect(pt.create).toHaveBeenCalledTimes(1);
    const data = pt.create.mock.calls[0][0].data;
    expect(data.source).toBe("in:LIQUIDITY_EDGE:5m");
    expect(data.symbol).toBe("NIFTY");
    expect(data.status).toBe("OPEN");
  });

  it("recomputes ATR-sized levels (rounded to tick) when an ATR is supplied", async () => {
    const { prisma, pt } = fakePrisma();
    // LONG entry 22000, atr 50, slMult 1, RR 2.5 → stop 21950, target 22125.
    await openIndiaPaperTrade(signal(), { prisma, atr: 50 });
    const data = pt.create.mock.calls[0][0].data;
    expect(data.atr).toBe(50);
    expect(data.stopLoss).toBeCloseTo(21950, 5);
    expect(data.target).toBeCloseTo(22125, 5);
  });

  it("falls back to the signal's own levels when no ATR is supplied", async () => {
    const { prisma, pt } = fakePrisma();
    await openIndiaPaperTrade(signal(), { prisma });
    const data = pt.create.mock.calls[0][0].data;
    expect(data.stopLoss).toBe(21890);
    expect(data.target).toBe(22275);
  });

  it("skips opening during the expiry-day cooldown (Thursday ≥ 14:30 IST)", async () => {
    const { prisma, pt } = fakePrisma();
    const res = await openIndiaPaperTrade(signal(), {
      prisma,
      now: new Date("2026-06-11T09:30:00Z"), // Thursday 15:00 IST
    });
    expect(res.opened).toBe(false);
    expect(res.reason).toBe("expiry-cooldown");
    expect(pt.create).not.toHaveBeenCalled();
  });

  it("does not open a second trade when one is already open on the same lane", async () => {
    const { prisma, pt } = fakePrisma({
      findFirst: vi.fn().mockResolvedValueOnce({ id: "open-1" }),
    });
    const res = await openIndiaPaperTrade(signal(), { prisma });
    expect(res.opened).toBe(false);
    expect(res.reason).toBe("already-open");
    expect(pt.create).not.toHaveBeenCalled();
  });
});

describe("india/scalping/paper-trader — resolveIndiaOpenTrades", () => {
  it("resolves a LONG open trade to WIN when intraday candles tag the target", async () => {
    const openedAt = new Date("2026-06-10T05:00:00Z");
    const { prisma, pt } = fakePrisma({
      findMany: vi.fn().mockResolvedValue([
        {
          id: "t1",
          symbol: "NIFTY",
          direction: "LONG",
          entry: 22000,
          stopLoss: 21950,
          target: 22100,
          notional: 100000,
          openedAt,
          source: "in:LIQUIDITY_EDGE:5m",
        },
      ]),
    });
    mockedHistorical.mockResolvedValue([
      { time: Math.floor(openedAt.getTime() / 1000) + 300, open: 22010, high: 22120, low: 22000, close: 22090 },
    ]);

    const stats = await resolveIndiaOpenTrades(prisma);
    expect(stats.wins).toBe(1);
    expect(pt.update).toHaveBeenCalledTimes(1);
    const data = pt.update.mock.calls[0][0].data;
    expect(data.status).toBe("WIN");
    expect(data.exitPrice).toBe(22100);
    expect(data.pnlPct).toBeGreaterThan(0);
  });

  it("leaves a trade OPEN when neither stop nor target is touched and it isn't stale", async () => {
    const openedAt = new Date(Date.now() - 60_000);
    const { prisma, pt } = fakePrisma({
      findMany: vi.fn().mockResolvedValue([
        {
          id: "t2",
          symbol: "NIFTY",
          direction: "LONG",
          entry: 22000,
          stopLoss: 21950,
          target: 22100,
          notional: 100000,
          openedAt,
          source: "in:LIQUIDITY_EDGE:5m",
        },
      ]),
    });
    mockedHistorical.mockResolvedValue([
      { time: Math.floor(openedAt.getTime() / 1000) + 60, open: 22010, high: 22030, low: 21990, close: 22020 },
    ]);

    const stats = await resolveIndiaOpenTrades(prisma);
    expect(stats.wins).toBe(0);
    expect(stats.losses).toBe(0);
    expect(pt.update).not.toHaveBeenCalled();
  });
});
