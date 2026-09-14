import "server-only";
/**
 * src/services/brokers/registry.ts
 *
 * Server-side broker registry.
 *
 * After the data-service2.0 centralization, this registry ONLY returns
 * a data-service2.0-backed adapter for market data operations.
 * The real broker adapters (Binance, Delta) are removed — their market data
 * responsibilities are now handled exclusively by data-service2.0.
 *
 * For order execution: use src/services/india/broker/factory.ts (OpenAlgo).
 */
import {
  getCryptoOHLCV,
  getCryptoTicker,
  getFuturesOverview,
} from "@/lib/data-service/client";
import type { BrokerId } from "./types";
import type { ServerBrokerAdapter } from "./server-types";
import { createServerStreamStub } from "./server-types";

/**
 * A lightweight server-side adapter backed by data-service2.0.
 * This replaces the old Binance and Delta Exchange direct adapters.
 */
const dataService2Adapter: ServerBrokerAdapter = {
  id: "binance" as BrokerId, // kept for interface compat
  displayName: "data-service2.0",
  homeUrl: "https://github.com/manishhansal/data-service2.0",
  pairs: {
    spot: { BTC: "BTCUSDT", ETH: "ETHUSDT", SOL: "SOLUSDT" },
    futures: { BTC: "BTCUSDT", ETH: "ETHUSDT", SOL: "SOLUSDT" },
  },
  capabilities: {
    spotTicker: true,
    futuresTicker: true,
    liquidations: false,
    klines: true,
  },
  async fetch24hrTickers(pairs: string[]) {
    const tickers = await Promise.all(pairs.map((p) => getCryptoTicker(p)));
    // data-service2.0 returns price as a string despite the TypeScript type
    // annotation. Coerce to number here so downstream formatPrice() calls work.
    return tickers.map((t) => {
      const price = Number(t.price) || 0;
      return {
        pair: t.symbol ?? "",
        price,
        change: 0,
        changePct: 0,
        high: price,
        low: price,
        volume: 0,
        quoteVolume: 0,
        ts: Date.now(),
      };
    });
  },
  async fetchAllFuturesTickers() {
    const overview = await getFuturesOverview();
    return overview.map((f) => ({
      pair: f.symbol,
      price: f.markPrice ?? 0,
      changePct: 0,
      quoteVolume: 0,
      ts: Date.now(),
    }));
  },
  async fetchKlines(pair: string, interval: string, limit?: number) {
    const candles = await getCryptoOHLCV(pair, interval, limit);
    return candles.map((c) => ({
      openTime: c.time * 1000,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
      closeTime: c.time * 1000 + 60000,
    }));
  },
  async fetchKlinesRange(pair: string, interval: string, startTimeMs: number, endTimeMs: number) {
    void startTimeMs; void endTimeMs;
    const candles = await getCryptoOHLCV(pair, interval);
    return candles.map((c) => ({
      openTime: c.time * 1000,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
      closeTime: c.time * 1000 + 60000,
    }));
  },
  async fetchPremiumIndex(pair: string) {
    const overview = await getFuturesOverview();
    const f = overview.find((x) => x.symbol === pair);
    return f
      ? {
          pair,
          markPrice: f.markPrice ?? 0,
          indexPrice: f.markPrice ?? 0,
          fundingRate: f.fundingRate ?? 0,
          fundingRateAnnualized: (f.fundingRate ?? 0) * 3 * 365,
          nextFundingTime: f.nextFundingTime
            ? new Date(f.nextFundingTime).getTime()
            : 0,
          ts: Date.now(),
        }
      : { pair, markPrice: 0, indexPrice: 0, fundingRate: 0, fundingRateAnnualized: 0, nextFundingTime: 0, ts: Date.now() };
  },
  async fetchOpenInterest(pair: string) {
    const overview = await getFuturesOverview();
    const f = overview.find((x) => x.symbol === pair);
    return f ? { pair, openInterest: f.openInterest ?? 0, ts: Date.now() } : { pair, openInterest: 0, ts: Date.now() };
  },
  getQuote: async () => { throw new Error("getQuote not supported — use getQuotes from data-service client"); },
  getQuotes: async () => [],
  getHistorical: async () => [],
  getOptionChain: async () => { throw new Error("getOptionChain not supported — use option-chain endpoint"); },
  fetchOpenInterestHistory: async () => [],
  fetchLongShortRatio: async () => [],
  createTickerStream: (_opts) => createServerStreamStub("data-service2-ticker"),
  createLiquidationStream: (_opts) => createServerStreamStub("data-service2-liquidation"),
};

export function getActiveBrokerId(): BrokerId {
  return "binance" as BrokerId;
}

export function getServerBroker(_id?: BrokerId): ServerBrokerAdapter {
  return dataService2Adapter;
}

export const SERVER_BROKERS: Record<BrokerId, ServerBrokerAdapter> = {
  binance: dataService2Adapter,
  delta: dataService2Adapter,
};
