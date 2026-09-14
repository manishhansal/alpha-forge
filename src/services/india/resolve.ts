/**
 * src/services/india/resolve.ts
 *
 * Quote and historical resolution.
 *
 * After the data-service2.0 centralization, this module delegates entirely
 * to the canonical data-service2.0 client. The old broker-chain resolution
 * (Angel One → Upstox → Yahoo) has been removed.
 */
import "server-only";
import { getQuotes, getHistorical } from "@/lib/data-service/client";
import type { MarketQuote } from "@/lib/data-service/types";
import type { Quote, Candle, HistoricalRequest } from "@/types/india";

export interface ResolvedQuotes {
  quotes: Quote[];
  sources: string[];
}

function mdQuoteToQuote(q: MarketQuote | null, symbol: string): Quote {
  if (!q) return { symbol, name: null, price: null, change: null, changePct: null, prevClose: null, fetchedAt: new Date().toISOString() };
  return {
    symbol: q.symbol ?? symbol,
    name: null,
    price: q.ltp,
    change: q.change ?? null,
    changePct: q.changePct ?? null,
    prevClose: q.prevClose ?? null,
    open: q.open ?? null,
    high: q.high ?? null,
    low: q.low ?? null,
    volume: q.volume ?? null,
    oi: q.oi ?? null,
    fetchedAt: q.dataAsOf,
  };
}

/**
 * Resolve quotes for a list of symbols via data-service2.0.
 */
export async function resolveQuotes(
  _chain: unknown,
  symbols: string[],
): Promise<ResolvedQuotes> {
  try {
    const mdQuotes = await getQuotes(symbols, "NSE");
    return {
      quotes: symbols.map((sym, i) => mdQuoteToQuote(mdQuotes[i] ?? null, sym)),
      sources: ["data-service2"],
    };
  } catch {
    return {
      quotes: symbols.map((sym) => ({ symbol: sym, name: null, price: null, change: null, changePct: null, prevClose: null, fetchedAt: new Date().toISOString() })),
      sources: [],
    };
  }
}

/**
 * Resolve historical candles via data-service2.0.
 */
export async function resolveHistorical(
  _chain: unknown,
  req: HistoricalRequest,
): Promise<{ candles: Candle[]; source: string }> {
  try {
    const candles = await getHistorical({
      symbol: req.symbol,
      interval: req.interval as "1m" | "5m" | "10m" | "15m" | "30m" | "1h" | "1d" | "1w" | "1M",
      exchange: "NSE",
    });
    return {
      candles: candles.map((c) => ({
        time: c.time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
        oi: c.oi ?? null,
      })),
      source: "data-service2",
    };
  } catch {
    return { candles: [], source: "data-service2" };
  }
}
