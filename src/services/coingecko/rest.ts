import "server-only";

import { z } from "zod";

import { TRACKED_SYMBOLS } from "@/lib/constants";

const COINGECKO_REST = "https://api.coingecko.com/api/v3";

const globalSchema = z.object({
  data: z.object({
    total_market_cap: z.record(z.string(), z.number()),
    total_volume: z.record(z.string(), z.number()),
    market_cap_percentage: z.record(z.string(), z.number()),
  }),
});

const coinSchema = z.object({
  id: z.string(),
  symbol: z.string(),
  market_cap: z.number().nullable(),
  market_cap_rank: z.number().nullable(),
  circulating_supply: z.number().nullable(),
  fully_diluted_valuation: z.number().nullable().optional(),
  total_volume: z.number().nullable(),
});

const coinsArraySchema = z.array(coinSchema);

export interface GlobalMarket {
  totalMarketCap: number;
  totalVolume24h: number;
  btcDominance: number;
  ethDominance: number;
}

export interface CoinMarketCap {
  coingeckoId: string;
  marketCap: number;
  fullyDilutedValuation: number | null;
  circulatingSupply: number | null;
  volume: number;
}

async function safeFetch(url: string): Promise<unknown> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (process.env.COINGECKO_API_KEY) {
    headers["x-cg-demo-api-key"] = process.env.COINGECKO_API_KEY;
  }
  const res = await fetch(url, {
    headers,
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`CoinGecko request failed: ${res.status} ${res.statusText} (${url})`);
  }
  return res.json();
}

export async function fetchGlobalMarket(): Promise<GlobalMarket> {
  const json = await safeFetch(`${COINGECKO_REST}/global`);
  const parsed = globalSchema.parse(json);
  return {
    totalMarketCap: parsed.data.total_market_cap.usd ?? 0,
    totalVolume24h: parsed.data.total_volume.usd ?? 0,
    btcDominance: parsed.data.market_cap_percentage.btc ?? 0,
    ethDominance: parsed.data.market_cap_percentage.eth ?? 0,
  };
}

export async function fetchTrackedCoinsMarket(): Promise<CoinMarketCap[]> {
  const ids = TRACKED_SYMBOLS.map((s) => s.coingeckoId).join(",");
  const url = `${COINGECKO_REST}/coins/markets?vs_currency=usd&ids=${ids}&price_change_percentage=24h`;
  const json = await safeFetch(url);
  const parsed = coinsArraySchema.parse(json);
  return parsed.map((c) => ({
    coingeckoId: c.id,
    marketCap: c.market_cap ?? 0,
    fullyDilutedValuation: c.fully_diluted_valuation ?? null,
    circulatingSupply: c.circulating_supply ?? null,
    volume: c.total_volume ?? 0,
  }));
}
