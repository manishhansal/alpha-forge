import { describe, expect, it } from "vitest";

import { computeSentiment } from "@/features/sentiment/engine";
import type { FuturesSymbolView, FuturesTickerSummary } from "@/types/market";

function makeTicker(
  changePct24h: number,
  symbol: "BTC" | "ETH" | "SOL" = "BTC",
): FuturesTickerSummary {
  return {
    symbol,
    pair: `${symbol}USDT`,
    price: 50_000,
    changePct24h,
    high24h: 51_000,
    low24h: 49_000,
    quoteVolume24h: 1_000_000,
  };
}

function makeFutures(opts: {
  symbol?: "BTC" | "ETH" | "SOL";
  fundingRate: number;
  oiChangePct1h: number;
  longShortRatio: number;
}): FuturesSymbolView {
  return {
    symbol: opts.symbol ?? "BTC",
    markPrice: 50_000,
    fundingRate: opts.fundingRate,
    fundingRateAnnualized: opts.fundingRate * 3 * 365,
    nextFundingTime: 0,
    openInterest: 0,
    openInterestNotionalUsd: 0,
    oiChangePct1h: opts.oiChangePct1h,
    longShortRatio: opts.longShortRatio,
    longAccount: 0.55,
    shortAccount: 0.45,
  };
}

describe("features/sentiment/engine", () => {
  it("returns Neutral when every input is unavailable", () => {
    const r = computeSentiment({
      fearGreedValue: null,
      futures: [],
      tickers24h: [],
    });
    expect(r.label).toBe("Neutral");
    expect(r.score).toBeCloseTo(0);
    expect(r.confidence).toBe(0);
  });

  it("flags a 5% rally with positive funding/OI as Bullish", () => {
    const r = computeSentiment({
      fearGreedValue: 70,
      tickers24h: [makeTicker(5)],
      futures: [
        makeFutures({ fundingRate: -0.0002, oiChangePct1h: 1.2, longShortRatio: 1.0 }),
      ],
    });
    expect(r.label).toBe("Bullish");
    expect(r.score).toBeGreaterThan(0);
  });

  it("flags a 4% sell-off with crowded longs as Bearish", () => {
    const r = computeSentiment({
      fearGreedValue: 18,
      tickers24h: [makeTicker(-4)],
      futures: [
        makeFutures({ fundingRate: 0.0005, oiChangePct1h: 1.5, longShortRatio: 1.6 }),
      ],
    });
    expect(r.label).toBe("Bearish");
    expect(r.score).toBeLessThan(0);
  });

  it("clamps the price-action contribution to ±1", () => {
    const r = computeSentiment({
      fearGreedValue: null,
      tickers24h: [makeTicker(50)], // absurd +50% day
      futures: [],
    });
    const pa = r.breakdown.find((b) => b.label === "Price Action (24h)");
    expect(pa?.score).toBeCloseTo(1);
  });

  it("publishes a breakdown row for every contributor", () => {
    const r = computeSentiment({
      fearGreedValue: 50,
      tickers24h: [makeTicker(0.5)],
      futures: [
        makeFutures({ fundingRate: 0, oiChangePct1h: 0, longShortRatio: 1 }),
      ],
    });
    const labels = r.breakdown.map((b) => b.label);
    expect(labels).toEqual(
      expect.arrayContaining([
        "Price Action (24h)",
        "Fear & Greed",
        "Funding Bias",
        "OI Flow (1h)",
        "Long/Short",
      ]),
    );
  });

  it("OI flow is bearish when price drops while OI builds", () => {
    const r = computeSentiment({
      fearGreedValue: null,
      tickers24h: [makeTicker(-2)],
      futures: [
        makeFutures({ fundingRate: 0, oiChangePct1h: 1.5, longShortRatio: 1 }),
      ],
    });
    const oi = r.breakdown.find((b) => b.label === "OI Flow (1h)");
    expect(oi?.score).toBeLessThan(0);
  });

  it("OI flow is bullish when price rises while OI builds", () => {
    const r = computeSentiment({
      fearGreedValue: null,
      tickers24h: [makeTicker(2)],
      futures: [
        makeFutures({ fundingRate: 0, oiChangePct1h: 1.5, longShortRatio: 1 }),
      ],
    });
    const oi = r.breakdown.find((b) => b.label === "OI Flow (1h)");
    expect(oi?.score).toBeGreaterThan(0);
  });

  it("confidence is in [0, 1]", () => {
    const r = computeSentiment({
      fearGreedValue: 99,
      tickers24h: [makeTicker(10)],
      futures: [
        makeFutures({ fundingRate: 0.001, oiChangePct1h: 5, longShortRatio: 2 }),
      ],
    });
    expect(r.confidence).toBeGreaterThanOrEqual(0);
    expect(r.confidence).toBeLessThanOrEqual(1);
  });

  it("publishes a sortable generatedAt timestamp", () => {
    const before = Date.now();
    const r = computeSentiment({
      fearGreedValue: 50,
      tickers24h: [makeTicker(0)],
      futures: [],
    });
    expect(r.generatedAt).toBeGreaterThanOrEqual(before);
  });
});
