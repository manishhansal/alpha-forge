import "server-only";

import { z } from "zod";

import type { KlineCandle } from "@/types/market";

const BINANCE_REST = "https://api.binance.com";

const klineTupleSchema = z.tuple([
  z.number(),
  z.string(),
  z.string(),
  z.string(),
  z.string(),
  z.string(),
  z.number(),
  z.string(),
  z.number(),
  z.string(),
  z.string(),
  z.string(),
]);
const klinesSchema = z.array(klineTupleSchema);

export type KlineInterval =
  | "1m"
  | "3m"
  | "5m"
  | "15m"
  | "30m"
  | "1h"
  | "2h"
  | "4h"
  | "6h"
  | "8h"
  | "12h"
  | "1d";

export async function fetchKlines(
  symbol: string,
  interval: KlineInterval = "1h",
  limit = 100,
): Promise<KlineCandle[]> {
  const url = `${BINANCE_REST}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  return doFetchKlines(url);
}

/**
 * Fetch all klines between `startTime` and `endTime` (inclusive of opens),
 * automatically paging if the range exceeds Binance's per-request cap (1000).
 * Used by the backtesting outcome tracker to walk price action since a
 * signal was generated.
 */
export async function fetchKlinesRange(
  symbol: string,
  interval: KlineInterval,
  startTime: number,
  endTime: number,
): Promise<KlineCandle[]> {
  const out: KlineCandle[] = [];
  let cursor = startTime;
  // Guard against runaway loops if the API behaves oddly.
  for (let i = 0; i < 20; i += 1) {
    if (cursor >= endTime) break;
    const url =
      `${BINANCE_REST}/api/v3/klines?symbol=${symbol}` +
      `&interval=${interval}` +
      `&startTime=${cursor}` +
      `&endTime=${endTime}` +
      `&limit=1000`;
    const batch = await doFetchKlines(url);
    if (batch.length === 0) break;
    out.push(...batch);
    const last = batch[batch.length - 1];
    if (!last) break;
    const next = last.closeTime + 1;
    if (next <= cursor) break;
    cursor = next;
    if (batch.length < 1000) break;
  }
  return out;
}

async function doFetchKlines(url: string): Promise<KlineCandle[]> {
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) {
    throw new Error(`Binance klines failed: ${res.status} ${res.statusText} (${url})`);
  }
  const json: unknown = await res.json();
  const parsed = klinesSchema.parse(json);
  return parsed.map((k) => ({
    openTime: k[0],
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
    closeTime: k[6],
  }));
}
