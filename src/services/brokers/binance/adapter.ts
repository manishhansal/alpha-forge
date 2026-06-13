import "server-only";

import { TRACKED_SYMBOLS } from "@/lib/constants";
import { fetch24hrTickers } from "@/services/binance/rest";
import {
  fetchAllFuturesTickers,
  fetchLongShortRatio,
  fetchOpenInterest,
  fetchOpenInterestHistory,
  fetchPremiumIndex,
} from "@/services/binance/futures";
import { fetchKlines, fetchKlinesRange, type KlineInterval } from "@/services/binance/klines";
import type { KlineCandle, SymbolId } from "@/types/market";

import { createServerStreamStub, type ServerBrokerAdapter } from "../server-types";
import type {
  BrokerPairs,
  NormalizedFuturesTicker,
  NormalizedLongShortPoint,
  NormalizedOpenInterest,
  NormalizedOpenInterestPoint,
  NormalizedPremiumIndex,
  NormalizedTicker,
  OiPeriod,
} from "../types";

function buildPairs(): BrokerPairs {
  const spot: Record<SymbolId, string> = { BTC: "BTCUSDT", ETH: "ETHUSDT", SOL: "SOLUSDT" };
  const futures: Record<SymbolId, string> = { ...spot };
  for (const s of TRACKED_SYMBOLS) {
    spot[s.id] = s.brokers.binance.spot;
    futures[s.id] = s.brokers.binance.futures;
  }
  return { spot, futures };
}

const binancePairs = buildPairs();

async function adaptedFetch24hrTickers(pairs: string[]): Promise<NormalizedTicker[]> {
  const upstream = await fetch24hrTickers(pairs);
  return upstream.map<NormalizedTicker>((t) => ({
    pair: t.symbol,
    price: t.price,
    change: t.change,
    changePct: t.changePct,
    high: t.high,
    low: t.low,
    volume: t.volume,
    quoteVolume: t.quoteVolume,
    ts: t.ts,
  }));
}

async function adaptedFetchPremiumIndex(pair: string): Promise<NormalizedPremiumIndex> {
  const v = await fetchPremiumIndex(pair);
  return {
    pair: v.symbol,
    markPrice: v.markPrice,
    indexPrice: v.indexPrice,
    fundingRate: v.fundingRate,
    fundingRateAnnualized: v.fundingRateAnnualized,
    nextFundingTime: v.nextFundingTime,
    ts: v.ts,
  };
}

async function adaptedFetchOpenInterest(pair: string): Promise<NormalizedOpenInterest> {
  const v = await fetchOpenInterest(pair);
  return { pair: v.symbol, openInterest: v.openInterest, ts: v.ts };
}

async function adaptedFetchOpenInterestHistory(
  pair: string,
  period: OiPeriod = "5m",
  limit = 30,
): Promise<NormalizedOpenInterestPoint[]> {
  const v = await fetchOpenInterestHistory(pair, period, limit);
  return v.map((p) => ({ ts: p.ts, openInterest: p.openInterest, notionalUsd: p.notionalUsd }));
}

async function adaptedFetchLongShortRatio(
  pair: string,
  period: OiPeriod = "5m",
  limit = 1,
): Promise<NormalizedLongShortPoint[]> {
  const v = await fetchLongShortRatio(pair, period, limit);
  return v.map((p) => ({
    ts: p.ts,
    longShortRatio: p.longShortRatio,
    longAccount: p.longAccount,
    shortAccount: p.shortAccount,
  }));
}

async function adaptedFetchAllFuturesTickers(): Promise<NormalizedFuturesTicker[]> {
  const v = await fetchAllFuturesTickers();
  return v.map<NormalizedFuturesTicker>((t) => ({
    pair: t.symbol,
    price: t.price,
    changePct: t.changePct,
    quoteVolume: t.quoteVolume,
    ts: t.ts,
  }));
}

async function adaptedFetchKlines(
  pair: string,
  interval: KlineInterval,
  limit?: number,
): Promise<KlineCandle[]> {
  return fetchKlines(pair, interval, limit);
}

async function adaptedFetchKlinesRange(
  pair: string,
  interval: KlineInterval,
  startMs: number,
  endMs: number,
): Promise<KlineCandle[]> {
  return fetchKlinesRange(pair, interval, startMs, endMs);
}

/**
 * Server-side Binance adapter. Browser-side streaming is wired through
 * `brokers/binance/client.ts` so we don't drag the `WebSocket` constructor
 * into server bundles.
 */
export const binanceServerAdapter: ServerBrokerAdapter = {
  id: "binance",
  displayName: "Binance",
  homeUrl: "https://www.binance.com",
  pairs: binancePairs,
  capabilities: {
    liquidations: true,
    longShortRatio: true,
    openInterestHistory: true,
  },
  fetch24hrTickers: adaptedFetch24hrTickers,
  fetchKlines: adaptedFetchKlines,
  fetchKlinesRange: adaptedFetchKlinesRange,
  fetchPremiumIndex: adaptedFetchPremiumIndex,
  fetchOpenInterest: adaptedFetchOpenInterest,
  fetchOpenInterestHistory: adaptedFetchOpenInterestHistory,
  fetchLongShortRatio: adaptedFetchLongShortRatio,
  fetchAllFuturesTickers: adaptedFetchAllFuturesTickers,
  // Stream factories on the server side are stubs — the actual `WebSocket`
  // implementations run in either the browser (`brokers/client.ts`) or the
  // worker (`worker/src/jobs/liquidations.ts`).
  createTickerStream: () => createServerStreamStub("binance:ticker"),
  createLiquidationStream: () => createServerStreamStub("binance:liquidations"),
};
