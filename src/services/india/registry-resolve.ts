/**
 * src/services/india/registry-resolve.ts
 *
 * Registry-based quote resolution — now backed by data-service2.0.
 * The old ProviderRegistry has been removed.
 */
import "server-only";
import { getQuotes } from "@/lib/data-service/client";
import type { MarketQuote } from "@/lib/data-service/types";
import type { Quote } from "@/types/india";

export interface ResolvedQuotes {
  quotes: Quote[];
  sources: string[];
}

function toQuote(q: MarketQuote | null, symbol: string): Quote {
  if (!q) return { symbol, name: null, price: null, change: null, changePct: null, prevClose: null, fetchedAt: new Date().toISOString() };
  return {
    symbol: q.symbol ?? symbol,
    name: null,
    price: q.ltp,
    change: q.change ?? null,
    changePct: q.changePct ?? null,
    prevClose: q.prevClose ?? null,
    fetchedAt: q.dataAsOf,
  };
}

/**
 * Resolve quotes via data-service2.0.
 * This is the canonical resolution path — the old registry is gone.
 */
export async function resolveQuotesViaRegistry(
  symbols: string[],
): Promise<ResolvedQuotes> {
  try {
    const mdQuotes = await getQuotes(symbols, "NSE");
    return {
      quotes: symbols.map((sym, i) => toQuote(mdQuotes[i] ?? null, sym)),
      sources: ["data-service2"],
    };
  } catch {
    return {
      quotes: symbols.map((sym) => ({ symbol: sym, name: null, price: null, change: null, changePct: null, prevClose: null, fetchedAt: new Date().toISOString() })),
      sources: [],
    };
  }
}
