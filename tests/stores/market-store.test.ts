import { afterEach, describe, expect, it } from "vitest";

import { selectTicker, useMarketStore } from "@/store/marketStore";
import type { Ticker } from "@/types/market";

function makeTicker(over: Partial<Ticker> = {}): Ticker {
  return {
    symbol: "BTC",
    price: 50_000,
    change24h: 100,
    changePct24h: 1.5,
    high24h: 51_000,
    low24h: 49_000,
    volume24h: 1_000,
    quoteVolume24h: 50_000_000,
    updatedAt: 1_700_000_000_000,
    ...over,
  };
}

describe("store/marketStore", () => {
  afterEach(() => {
    useMarketStore.getState().reset();
  });

  it("starts with empty tickers and idle status", () => {
    const s = useMarketStore.getState();
    expect(s.tickers).toEqual({});
    expect(s.wsStatus).toBe("idle");
    expect(s.lastUpdate).toBeNull();
  });

  it("setTicker stores the ticker by SymbolId", () => {
    const t = makeTicker();
    useMarketStore.getState().setTicker("BTC", t);
    expect(useMarketStore.getState().tickers.BTC).toEqual(t);
  });

  it("setTicker updates lastUpdate to the ticker's updatedAt", () => {
    const t = makeTicker({ updatedAt: 1_800_000_000_000 });
    useMarketStore.getState().setTicker("BTC", t);
    expect(useMarketStore.getState().lastUpdate).toBe(1_800_000_000_000);
  });

  it("setTicker preserves existing tickers", () => {
    useMarketStore.getState().setTicker("BTC", makeTicker({ symbol: "BTC" }));
    useMarketStore.getState().setTicker("ETH", makeTicker({ symbol: "ETH", price: 3000 }));
    const s = useMarketStore.getState();
    expect(s.tickers.BTC).toBeDefined();
    expect(s.tickers.ETH).toBeDefined();
  });

  it("setStatus updates the ws status", () => {
    useMarketStore.getState().setStatus("open");
    expect(useMarketStore.getState().wsStatus).toBe("open");
  });

  it("reset() returns the store to initial state", () => {
    useMarketStore.getState().setTicker("BTC", makeTicker());
    useMarketStore.getState().setStatus("open");
    useMarketStore.getState().reset();
    const s = useMarketStore.getState();
    expect(s.tickers).toEqual({});
    expect(s.wsStatus).toBe("idle");
    expect(s.lastUpdate).toBeNull();
  });

  describe("selectTicker()", () => {
    it("returns the stored ticker for the given symbol", () => {
      const t = makeTicker();
      useMarketStore.getState().setTicker("BTC", t);
      const state = useMarketStore.getState();
      expect(selectTicker("BTC")(state)).toEqual(t);
    });

    it("returns undefined for an unknown symbol", () => {
      const state = useMarketStore.getState();
      expect(selectTicker("BTC")(state)).toBeUndefined();
    });
  });
});
