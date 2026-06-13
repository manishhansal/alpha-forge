import "server-only";

import { z } from "zod";

const BINANCE_REST = "https://api.binance.com";

const tickerSchema = z.object({
  symbol: z.string(),
  lastPrice: z.string(),
  priceChange: z.string(),
  priceChangePercent: z.string(),
  highPrice: z.string(),
  lowPrice: z.string(),
  volume: z.string(),
  quoteVolume: z.string(),
  closeTime: z.number(),
});

const tickerArraySchema = z.array(tickerSchema);

export interface Binance24hrTicker {
  symbol: string;
  price: number;
  change: number;
  changePct: number;
  high: number;
  low: number;
  volume: number;
  quoteVolume: number;
  ts: number;
}

export async function fetch24hrTickers(symbols: string[]): Promise<Binance24hrTicker[]> {
  const symbolsParam = encodeURIComponent(JSON.stringify(symbols));
  const url = `${BINANCE_REST}/api/v3/ticker/24hr?symbols=${symbolsParam}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    throw new Error(`Binance 24hr ticker request failed: ${res.status} ${res.statusText}`);
  }
  const json: unknown = await res.json();
  const parsed = tickerArraySchema.parse(json);
  return parsed.map((t) => ({
    symbol: t.symbol,
    price: Number(t.lastPrice),
    change: Number(t.priceChange),
    changePct: Number(t.priceChangePercent),
    high: Number(t.highPrice),
    low: Number(t.lowPrice),
    volume: Number(t.volume),
    quoteVolume: Number(t.quoteVolume),
    ts: t.closeTime,
  }));
}
