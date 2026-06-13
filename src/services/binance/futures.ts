import "server-only";

import { z } from "zod";

const FUTURES_REST = "https://fapi.binance.com";

async function safeFetch<T>(url: string, schema: z.ZodType<T>): Promise<T> {
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    throw new Error(`Binance Futures request failed: ${res.status} ${res.statusText} (${url})`);
  }
  const json: unknown = await res.json();
  return schema.parse(json);
}

const premiumIndexSchema = z.object({
  symbol: z.string(),
  markPrice: z.string(),
  indexPrice: z.string(),
  estimatedSettlePrice: z.string().optional(),
  lastFundingRate: z.string(),
  nextFundingTime: z.number(),
  interestRate: z.string().optional(),
  time: z.number(),
});

export interface FundingInfo {
  symbol: string;
  markPrice: number;
  indexPrice: number;
  fundingRate: number;
  fundingRateAnnualized: number;
  nextFundingTime: number;
  ts: number;
}

export async function fetchPremiumIndex(symbol: string): Promise<FundingInfo> {
  const data = await safeFetch(
    `${FUTURES_REST}/fapi/v1/premiumIndex?symbol=${symbol}`,
    premiumIndexSchema,
  );
  const fundingRate = Number(data.lastFundingRate);
  return {
    symbol: data.symbol,
    markPrice: Number(data.markPrice),
    indexPrice: Number(data.indexPrice),
    fundingRate,
    fundingRateAnnualized: fundingRate * 3 * 365,
    nextFundingTime: data.nextFundingTime,
    ts: data.time,
  };
}

const openInterestSchema = z.object({
  symbol: z.string(),
  openInterest: z.string(),
  time: z.number(),
});

export interface OpenInterestSnapshot {
  symbol: string;
  openInterest: number;
  ts: number;
}

export async function fetchOpenInterest(symbol: string): Promise<OpenInterestSnapshot> {
  const data = await safeFetch(
    `${FUTURES_REST}/fapi/v1/openInterest?symbol=${symbol}`,
    openInterestSchema,
  );
  return {
    symbol: data.symbol,
    openInterest: Number(data.openInterest),
    ts: data.time,
  };
}

const oiHistEntrySchema = z.object({
  symbol: z.string(),
  sumOpenInterest: z.string(),
  sumOpenInterestValue: z.string(),
  timestamp: z.number(),
});
const oiHistArraySchema = z.array(oiHistEntrySchema);

export type OiPeriod = "5m" | "15m" | "30m" | "1h" | "2h" | "4h" | "6h" | "12h" | "1d";

export interface OpenInterestHistPoint {
  ts: number;
  openInterest: number;
  notionalUsd: number;
}

export async function fetchOpenInterestHistory(
  symbol: string,
  period: OiPeriod = "5m",
  limit = 30,
): Promise<OpenInterestHistPoint[]> {
  const url = `${FUTURES_REST}/futures/data/openInterestHist?symbol=${symbol}&period=${period}&limit=${limit}`;
  const data = await safeFetch(url, oiHistArraySchema);
  return data.map((p) => ({
    ts: p.timestamp,
    openInterest: Number(p.sumOpenInterest),
    notionalUsd: Number(p.sumOpenInterestValue),
  }));
}

const lsRatioEntrySchema = z.object({
  symbol: z.string(),
  longShortRatio: z.string(),
  longAccount: z.string(),
  shortAccount: z.string(),
  timestamp: z.number(),
});
const lsRatioArraySchema = z.array(lsRatioEntrySchema);

export interface LongShortPoint {
  ts: number;
  longShortRatio: number;
  longAccount: number;
  shortAccount: number;
}

export async function fetchLongShortRatio(
  symbol: string,
  period: OiPeriod = "5m",
  limit = 1,
): Promise<LongShortPoint[]> {
  const url = `${FUTURES_REST}/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=${period}&limit=${limit}`;
  const data = await safeFetch(url, lsRatioArraySchema);
  return data.map((p) => ({
    ts: p.timestamp,
    longShortRatio: Number(p.longShortRatio),
    longAccount: Number(p.longAccount),
    shortAccount: Number(p.shortAccount),
  }));
}

const futuresTickerSchema = z.object({
  symbol: z.string(),
  lastPrice: z.string(),
  priceChangePercent: z.string(),
  quoteVolume: z.string(),
  closeTime: z.number(),
});
const futuresTickerArraySchema = z.array(futuresTickerSchema);

export interface FuturesTicker {
  symbol: string;
  price: number;
  changePct: number;
  quoteVolume: number;
  ts: number;
}

export async function fetchAllFuturesTickers(): Promise<FuturesTicker[]> {
  const data = await safeFetch(`${FUTURES_REST}/fapi/v1/ticker/24hr`, futuresTickerArraySchema);
  return data
    .filter((t) => t.symbol.endsWith("USDT"))
    .map((t) => ({
      symbol: t.symbol,
      price: Number(t.lastPrice),
      changePct: Number(t.priceChangePercent),
      quoteVolume: Number(t.quoteVolume),
      ts: t.closeTime,
    }));
}
