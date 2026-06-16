import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/india/scanner/engine", () => ({
  runScanner: vi.fn(),
}));

vi.mock("@/features/india/scalping/strategies/positioning", () => ({
  getIndiaPositioningSignals: vi.fn(),
}));

vi.mock("@/features/india/scalping/strategies/opening-breakout", () => ({
  getIndiaOpeningBreakoutSignals: vi.fn(),
}));

import { runScanner } from "@/services/india/scanner/engine";
import { getIndiaPositioningSignals } from "@/features/india/scalping/strategies/positioning";
import { getIndiaOpeningBreakoutSignals } from "@/features/india/scalping/strategies/opening-breakout";
import { getIndiaScalpSignals } from "@/features/india/scalping/fetch-signals";
import type { ScannerHit, ScannerResult, ScannerType } from "@/types/india/scanner";

const mockedRunScanner = runScanner as unknown as ReturnType<typeof vi.fn>;
const mockedPositioning =
  getIndiaPositioningSignals as unknown as ReturnType<typeof vi.fn>;
const mockedOpeningBreakout =
  getIndiaOpeningBreakoutSignals as unknown as ReturnType<typeof vi.fn>;

function makeScanner(type: ScannerType, hits: ScannerHit[]): ScannerResult {
  return {
    type,
    title: `${type} scanner`,
    description: "test scanner",
    hits,
    fetchedAt: new Date("2026-05-18T04:00:00Z").toISOString(),
  };
}

beforeEach(() => {
  mockedRunScanner.mockReset();
  mockedPositioning.mockReset();
  mockedOpeningBreakout.mockReset();
  // Default: the option-positioning + opening-breakout engines yield nothing
  // so the scanner-focused assertions below stay deterministic. Individual
  // tests override these when they exercise ILE / IMPG / ORB.
  mockedPositioning.mockResolvedValue([]);
  mockedOpeningBreakout.mockResolvedValue([]);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("features/india/scalping/fetch-signals — adapter shape", () => {
  it("dispatches one scanner per strategy id and produces ScalpSignal-shaped rows", async () => {
    mockedRunScanner.mockImplementation(async (type: ScannerType) => {
      const hit: ScannerHit = {
        symbol: type === "pcr" ? "NIFTY" : "RELIANCE",
        price: 100,
        changePct: 1.5,
        metric: 1.5,
        metricLabel: "+1.50%",
        kind: type === "oi-buildup" ? "LONG_BUILDUP" : "GAINER",
      };
      return makeScanner(type, [hit]);
    });

    const res = await getIndiaScalpSignals({ timeframe: "5m" });

    expect(mockedRunScanner).toHaveBeenCalledTimes(6);
    const requestedTypes = mockedRunScanner.mock.calls
      .map((c) => c[0])
      .sort();
    expect(requestedTypes).toEqual([
      "iv-spike",
      "momentum",
      "oi-buildup",
      "pcr",
      "range-expansion",
      "volume-breakout",
    ]);

    expect(res.timeframe).toBe("5m");
    expect(res.signals.length).toBe(6);
    for (const s of res.signals) {
      expect(s.entry).toBe(100);
      expect(s.stopLoss).toBeGreaterThan(0);
      expect(s.target).toBeGreaterThan(0);
      expect(s.riskReward).toBeCloseTo(2, 5);
      expect(["LONG", "SHORT"]).toContain(s.direction);
      expect(s.confidence).toBeGreaterThanOrEqual(0);
      expect(s.confidence).toBeLessThanOrEqual(1);
      expect(s.rationale.length).toBeGreaterThan(0);
      expect(s.symbol).toBeTruthy();
      expect(s.timeframe).toBe("5m");
    }
  });

  it("honours the `strategies=` filter and only runs the requested scanners", async () => {
    mockedRunScanner.mockImplementation(async (type: ScannerType) => {
      return makeScanner(type, [
        {
          symbol: "NIFTY",
          price: 22000,
          changePct: 0.5,
          metric: 0.5,
          metricLabel: "+0.50%",
        },
      ]);
    });

    await getIndiaScalpSignals({
      timeframe: "15m",
      strategies: ["MOMENTUM", "VOLUME_BREAKOUT"],
    });

    expect(mockedRunScanner).toHaveBeenCalledTimes(2);
    const types = mockedRunScanner.mock.calls.map((c) => c[0]).sort();
    expect(types).toEqual(["momentum", "volume-breakout"]);
  });

  it("drops hits with no price (we can't build entry/stop/target without one)", async () => {
    mockedRunScanner.mockImplementation(async (type: ScannerType) => {
      return makeScanner(type, [
        { symbol: "X", price: null, changePct: null, metric: 0, metricLabel: "—" },
      ]);
    });

    const res = await getIndiaScalpSignals({ strategies: ["MOMENTUM"] });
    expect(res.signals).toHaveLength(0);
  });

  it("never throws when a single scanner rejects — keeps the rest of the feed alive", async () => {
    mockedRunScanner.mockImplementation(async (type: ScannerType) => {
      if (type === "pcr") throw new Error("nse 503");
      return makeScanner(type, [
        {
          symbol: "RELIANCE",
          price: 2900,
          changePct: 0.8,
          metric: 0.8,
          metricLabel: "+0.80%",
        },
      ]);
    });

    const res = await getIndiaScalpSignals();
    // 6 scanners, 1 failed → 5 succeed, each produces 1 row.
    expect(res.signals.length).toBe(5);
  });

  it("PCR_EXTREME picks contrarian direction at PCR>=1.3 (LONG) vs <0.7 (SHORT)", async () => {
    mockedRunScanner.mockImplementation(async (type: ScannerType) => {
      if (type === "pcr") {
        return makeScanner("pcr", [
          { symbol: "NIFTY", price: 22000, changePct: null, metric: 1.5, metricLabel: "PCR 1.50" },
          { symbol: "BANKNIFTY", price: 48000, changePct: null, metric: 0.5, metricLabel: "PCR 0.50" },
        ]);
      }
      return makeScanner(type, []);
    });

    const res = await getIndiaScalpSignals({ strategies: ["PCR_EXTREME"] });
    const nifty = res.signals.find((s) => s.symbol === "NIFTY");
    const bnf = res.signals.find((s) => s.symbol === "BANKNIFTY");
    expect(nifty?.direction).toBe("LONG");
    expect(bnf?.direction).toBe("SHORT");
  });

  it("OI_BUILDUP maps LONG_BUILDUP / SHORT_COVERING -> LONG; the others -> SHORT", async () => {
    mockedRunScanner.mockImplementation(async (type: ScannerType) => {
      if (type === "oi-buildup") {
        return makeScanner("oi-buildup", [
          { symbol: "A", price: 100, changePct: 0.5, metric: 1, metricLabel: "", kind: "LONG_BUILDUP" },
          { symbol: "B", price: 100, changePct: -0.5, metric: 1, metricLabel: "", kind: "SHORT_BUILDUP" },
          { symbol: "C", price: 100, changePct: 0.5, metric: 1, metricLabel: "", kind: "SHORT_COVERING" },
          { symbol: "D", price: 100, changePct: -0.5, metric: 1, metricLabel: "", kind: "LONG_UNWINDING" },
        ]);
      }
      return makeScanner(type, []);
    });

    const res = await getIndiaScalpSignals({ strategies: ["OI_BUILDUP"] });
    const map = Object.fromEntries(res.signals.map((s) => [s.symbol, s.direction]));
    expect(map.A).toBe("LONG");
    expect(map.B).toBe("SHORT");
    expect(map.C).toBe("LONG");
    expect(map.D).toBe("SHORT");
  });

  it("uses the synthetic 0.5%-band stop / 1%-band target around price", async () => {
    mockedRunScanner.mockImplementation(async (type: ScannerType) => {
      return makeScanner(type, [
        {
          symbol: "RELIANCE",
          price: 2000,
          changePct: 1,
          metric: 1,
          metricLabel: "+1%",
        },
      ]);
    });

    const res = await getIndiaScalpSignals({ strategies: ["MOMENTUM"] });
    const sig = res.signals[0];
    expect(sig).toBeDefined();
    // LONG → stop below, target above, both at 0.5% / 1% from entry.
    expect(sig.direction).toBe("LONG");
    expect(sig.entry).toBe(2000);
    expect(sig.stopLoss).toBeCloseTo(1990, 5);
    expect(sig.target).toBeCloseTo(2020, 5);
  });

  it("clamps the timeframe param to the allowed trio (1m/5m/15m)", async () => {
    mockedRunScanner.mockImplementation(async (type: ScannerType) =>
      makeScanner(type, [
        { symbol: "X", price: 100, changePct: 0, metric: 0, metricLabel: "" },
      ]),
    );

    const res = await getIndiaScalpSignals({
      timeframe: "1h" as unknown as "5m",
    });
    expect(res.timeframe).toBe("5m");
  });

  it("delegates the two ILE-Pine ports to the positioning engine and merges their signals", async () => {
    mockedRunScanner.mockImplementation(async (type: ScannerType) =>
      makeScanner(type, [
        { symbol: "RELIANCE", price: 2900, changePct: 0.8, metric: 0.8, metricLabel: "+0.80%" },
      ]),
    );
    mockedPositioning.mockResolvedValue([
      {
        strategyId: "MAX_PAIN_GRAVITY",
        symbol: "NIFTY",
        symbolName: "NIFTY 50",
        timeframe: "5m",
        direction: "SHORT",
        price: 22300,
        reference: 22000,
        atr: 111,
        confirmed: true,
        entry: 22300,
        stopLoss: 22411,
        target: 22000,
        riskReward: 2.7,
        confidence: 0.6,
        rationale: ["Max-Pain Gravity"],
        triggeredAt: Date.now(),
      },
    ]);

    const res = await getIndiaScalpSignals({ timeframe: "5m" });

    // Six scanner-backed strategies still drive runScanner...
    expect(mockedRunScanner).toHaveBeenCalledTimes(6);
    // ...and the two non-scanner strategies are handed to the positioning engine.
    expect(mockedPositioning).toHaveBeenCalledTimes(1);
    const arg = mockedPositioning.mock.calls[0][0];
    expect([...arg.strategies].sort()).toEqual([
      "LIQUIDITY_EDGE",
      "MAX_PAIN_GRAVITY",
    ]);
    expect(arg.timeframe).toBe("5m");
    // 6 scanner rows + 1 positioning row.
    expect(res.signals.length).toBe(7);
    expect(res.signals.some((s) => s.strategyId === "MAX_PAIN_GRAVITY")).toBe(
      true,
    );
  });

  it("merges Opening Breakout signals and only runs the ORB engine when requested", async () => {
    mockedRunScanner.mockImplementation(async (type: ScannerType) =>
      makeScanner(type, [
        { symbol: "RELIANCE", price: 2900, changePct: 0.8, metric: 0.8, metricLabel: "+0.80%" },
      ]),
    );
    mockedOpeningBreakout.mockResolvedValue([
      {
        strategyId: "OPENING_BREAKOUT",
        symbol: "NIFTY",
        symbolName: "NIFTY 50",
        timeframe: "5m",
        direction: "LONG",
        price: 22050,
        reference: 22000,
        atr: 30,
        confirmed: true,
        entry: 22000,
        stopLoss: 21970,
        target: 22060,
        riskReward: 2,
        confidence: 0.7,
        rationale: ["Opening 5-min range break", "Retest held"],
        triggeredAt: Date.now(),
      },
    ]);

    const res = await getIndiaScalpSignals({ timeframe: "5m" });

    expect(mockedOpeningBreakout).toHaveBeenCalledTimes(1);
    expect(mockedOpeningBreakout.mock.calls[0][0].timeframe).toBe("5m");
    expect(res.signals.some((s) => s.strategyId === "OPENING_BREAKOUT")).toBe(
      true,
    );
  });

  it("runs only the Opening Breakout engine when only ORB is requested", async () => {
    await getIndiaScalpSignals({ strategies: ["OPENING_BREAKOUT"] });
    expect(mockedRunScanner).not.toHaveBeenCalled();
    expect(mockedPositioning).not.toHaveBeenCalled();
    expect(mockedOpeningBreakout).toHaveBeenCalledTimes(1);
  });

  it("does NOT invoke the positioning engine when only scanner strategies are requested", async () => {
    mockedRunScanner.mockImplementation(async (type: ScannerType) =>
      makeScanner(type, []),
    );

    await getIndiaScalpSignals({ strategies: ["MOMENTUM", "PCR_EXTREME"] });
    expect(mockedPositioning).not.toHaveBeenCalled();
  });

  it("runs only the positioning engine when only ILE / IMPG are requested", async () => {
    mockedRunScanner.mockImplementation(async (type: ScannerType) =>
      makeScanner(type, []),
    );

    await getIndiaScalpSignals({ strategies: ["LIQUIDITY_EDGE"] });
    expect(mockedRunScanner).not.toHaveBeenCalled();
    expect(mockedPositioning).toHaveBeenCalledTimes(1);
    expect(mockedPositioning.mock.calls[0][0].strategies).toEqual([
      "LIQUIDITY_EDGE",
    ]);
  });
});
