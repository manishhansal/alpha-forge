import { describe, expect, it } from "vitest";

import {
  buildOpeningBreakoutSignal,
  firstFiveMinCandle,
  istParts,
  latestSessionCandles,
  type OpeningBreakoutInput,
} from "@/features/india/scalping/strategies/opening-breakout-core";
import type { Candle } from "@/types/india/market";
import type { OptionChainAnalytics } from "@/types/india/options";

/** 09:15 IST on 2026-06-16 = 03:45 UTC. */
const OPEN_UTC_MS = Date.UTC(2026, 5, 16, 3, 45, 0);

/** Build a 5-min candle `offsetMin` minutes after the 09:15 IST open. */
function candle(
  offsetMin: number,
  o: number,
  h: number,
  l: number,
  c: number,
  volume?: number,
): Candle {
  return {
    time: Math.floor(OPEN_UTC_MS / 1000) + offsetMin * 60,
    open: o,
    high: h,
    low: l,
    close: c,
    volume,
  };
}

function baseInput(candles: Candle[]): OpeningBreakoutInput {
  return { symbol: "NIFTY", symbolName: "NIFTY 50", timeframe: "5m", candles };
}

describe("opening-breakout-core — IST helpers", () => {
  it("istParts maps the opening bar to 09:15 IST", () => {
    const p = istParts(Math.floor(OPEN_UTC_MS / 1000));
    expect(p.hour).toBe(9);
    expect(p.minute).toBe(15);
    expect(p.dateKey).toBe("2026-06-16");
  });

  it("firstFiveMinCandle finds the 09:15 candle in a session", () => {
    const session = [
      candle(0, 100, 100.3, 99.8, 100.1),
      candle(5, 100.2, 100.6, 100, 100.5),
    ];
    expect(firstFiveMinCandle(session)?.time).toBe(session[0].time);
  });

  it("latestSessionCandles keeps only the most recent IST day", () => {
    const prevDay: Candle = {
      time: Math.floor(OPEN_UTC_MS / 1000) - 86_400,
      open: 90,
      high: 91,
      low: 89,
      close: 90,
    };
    const today = candle(0, 100, 100.3, 99.8, 100.1);
    const session = latestSessionCandles([prevDay, today]);
    expect(session).toHaveLength(1);
    expect(session[0].time).toBe(today.time);
  });
});

describe("opening-breakout-core — buildOpeningBreakoutSignal", () => {
  // 09:15 range 99.8–100.3 (0.5% wide), bullish break at 09:20, retest at 09:25.
  // Retest bar must be bullish (close > open) — a doji / bearish bar at the
  // level is a *failed* retest under the strategy's "support flip held" rule.
  const bullishRetest = [
    candle(0, 100, 100.3, 99.8, 100.1, 1000),
    candle(5, 100.2, 100.6, 100.0, 100.5, 2000),
    candle(10, 100.4, 100.6, 100.25, 100.55, 1500),
  ];

  it("returns a confirmed LONG on a breakout + retest, entering at the range high", () => {
    const sig = buildOpeningBreakoutSignal(baseInput(bullishRetest));
    expect(sig).not.toBeNull();
    expect(sig?.strategyId).toBe("OPENING_BREAKOUT");
    expect(sig?.direction).toBe("LONG");
    expect(sig?.confirmed).toBe(true);
    // Entry on the broken level (range high), stop below the breakout candle low.
    expect(sig?.entry).toBeCloseTo(100.3, 5);
    expect(sig?.stopLoss).toBeCloseTo(100.0, 5);
    // Target = 2R above entry (risk 0.3 → +0.6).
    expect(sig?.target).toBeCloseTo(100.9, 5);
    expect(sig?.riskReward).toBe(2);
    // Confirmed base (0.62) + volume thrust (0.08) + index bonus (0.05),
    // range in the healthy band.
    expect(sig?.confidence).toBeCloseTo(0.75, 5);
    expect(sig?.triggeredAt).toBe(bullishRetest[2].time * 1000);
    expect(sig?.rationale.join(" ")).toMatch(/retest/i);
  });

  it("applies the F&O-index bonus so index breakouts rank above equal stock setups", () => {
    // Regression for 2026-06-17: NIFTY's clean ORB long (retested, stretch
    // target hit on the day) ranked #9 of 10 because chain max-pain was
    // marginally below spot (-0.04) while stock setups got no such penalty.
    // The +0.05 index bonus restores the structural advantage indices have
    // over single stocks (max liquidity, tightest spreads, no idiosyncratic
    // news shock) so the F&O hero shows up on the board.
    const stockInput: OpeningBreakoutInput = {
      ...baseInput(bullishRetest),
      symbol: "RELIANCE",
      symbolName: "RELIANCE",
    };
    const indexSig = buildOpeningBreakoutSignal(baseInput(bullishRetest));
    const stockSig = buildOpeningBreakoutSignal(stockInput);
    expect(indexSig?.confidence).toBeGreaterThan(stockSig?.confidence ?? 0);
    expect((indexSig?.confidence ?? 0) - (stockSig?.confidence ?? 0)).toBeCloseTo(
      0.05,
      5,
    );
  });

  it("rejects a doji / counter-bar at the level as an unconfirmed retest", () => {
    // Same geometry as bullishRetest but the retest candle closes below its
    // open (bearish bar) — the strategy treats this as a failed retest.
    const counterBar = [
      candle(0, 100, 100.3, 99.8, 100.1, 1000),
      candle(5, 100.2, 100.6, 100.0, 100.5, 2000),
      candle(10, 100.5, 100.6, 100.2, 100.35, 1500),
    ];
    const sig = buildOpeningBreakoutSignal(baseInput(counterBar));
    expect(sig?.confirmed).toBe(false);
    expect(sig?.rationale.join(" ")).toMatch(/awaiting retest/i);
  });

  it("flags an unconfirmed breakout while the retest is still pending", () => {
    // No candle pulls back to the level — runs straight up.
    const noRetest = [
      candle(0, 100, 100.3, 99.8, 100.1, 1000),
      candle(5, 100.2, 100.6, 100.0, 100.5, 2000),
      candle(10, 100.6, 101.0, 100.55, 100.9, 1500),
    ];
    const sig = buildOpeningBreakoutSignal(baseInput(noRetest));
    expect(sig?.confirmed).toBe(false);
    expect(sig?.confidence).toBeLessThan(0.7);
    expect(sig?.rationale.join(" ")).toMatch(/awaiting retest/i);
  });

  it("returns a SHORT on a bearish breakout + retest", () => {
    const bearish = [
      candle(0, 100, 100.2, 99.7, 99.9, 1000),
      candle(5, 99.8, 100.0, 99.4, 99.5, 2000), // close < 99.7 → bearish
      // Retest: high reaches 99.7, close back below — *and* bearish bar
      // (close < open) so the support-flipped-to-resistance held.
      candle(10, 99.65, 99.75, 99.45, 99.55, 1500),
    ];
    const sig = buildOpeningBreakoutSignal(baseInput(bearish));
    expect(sig?.direction).toBe("SHORT");
    expect(sig?.confirmed).toBe(true);
    expect(sig?.entry).toBeCloseTo(99.7, 5);
    expect(sig?.stopLoss).toBeCloseTo(100.0, 5);
    expect(sig?.target).toBeCloseTo(99.1, 5);
  });

  it("returns null when price never closes beyond the opening range", () => {
    const inside = [
      candle(0, 100, 100.3, 99.8, 100.1),
      candle(5, 100.1, 100.25, 99.9, 100.0),
      candle(10, 100.0, 100.2, 99.85, 100.1),
    ];
    expect(buildOpeningBreakoutSignal(baseInput(inside))).toBeNull();
  });

  it("returns null when the 09:15 opening candle is missing", () => {
    const noOpen = [candle(5, 100.2, 100.6, 100.0, 100.5)];
    expect(buildOpeningBreakoutSignal(baseInput(noOpen))).toBeNull();
  });

  it("layers option-chain confirmation into confidence for a long", () => {
    const analytics = {
      pcrOi: 1.3,
      maxPain: 101,
    } as OptionChainAnalytics;
    const plain = buildOpeningBreakoutSignal(baseInput(bullishRetest));
    const confirmed = buildOpeningBreakoutSignal({
      ...baseInput(bullishRetest),
      analytics,
    });
    expect(confirmed!.confidence).toBeGreaterThan(plain!.confidence);
    expect(confirmed!.rationale.join(" ")).toMatch(/PCR/i);
  });
});
