/**
 * Selected-source-only resolver.
 *
 * Given the ordered chain of brokers the user actually selected (see
 * `pickBrokerChain`), fetch quotes/candles using ONLY those sources. Each
 * broker is called with `allowFallback: false` so it never silently reaches
 * for an unselected upstream (e.g. Angel One → Yahoo). Backfill for symbols a
 * higher-priority source can't serve is attempted against the *next selected*
 * source, and anything still missing comes back as an empty placeholder.
 *
 * The returned quotes carry their true per-value `source`, and `sources` lists
 * the distinct upstreams that actually produced data, so routes/UI can show
 * genuine provenance instead of just the adapter that was picked.
 */

import type { BrokerAdapter } from "./broker/types";
import type { DataSourceId } from "@/features/settings/data-sources-shared";
import type { Candle, HistoricalRequest, Quote } from "@/types/india";
import { yahoo } from "./yahoo";

function emptyQuote(symbol: string): Quote {
  return {
    symbol,
    name: null,
    price: null,
    change: null,
    changePct: null,
    prevClose: null,
    fetchedAt: new Date().toISOString(),
  };
}

export interface ResolvedQuotes {
  /** One quote per requested symbol, in request order. */
  quotes: Quote[];
  /** Distinct upstreams that actually produced a value (first-seen order). */
  sources: DataSourceId[];
}

/**
 * Fetch quotes across the selected chain, backfilling missing symbols only
 * from later *selected* sources. Symbols no selected source can serve return
 * empty placeholders (price null, undefined source).
 */
export async function resolveQuotes(
  chain: readonly BrokerAdapter[],
  symbols: string[],
): Promise<ResolvedQuotes> {
  if (symbols.length === 0) return { quotes: [], sources: [] };
  const effectiveChain = chain.length > 0 ? chain : [yahoo];

  const resolved = new Map<string, Quote>();
  let pending = [...symbols];

  for (const broker of effectiveChain) {
    if (pending.length === 0) break;
    const got = await broker.getQuotes(pending, { allowFallback: false });
    const stillPending: string[] = [];
    pending.forEach((s, i) => {
      const q = got[i];
      if (q && q.price != null) resolved.set(s, q);
      else stillPending.push(s);
    });
    pending = stillPending;
  }

  const quotes = symbols.map((s) => resolved.get(s) ?? emptyQuote(s));

  const sources: DataSourceId[] = [];
  for (const q of quotes) {
    if (q.source && !sources.includes(q.source)) sources.push(q.source);
  }

  return { quotes, sources };
}

export interface ResolvedHistorical {
  candles: Candle[];
  /** The selected source that produced the candles, or null if none could. */
  source: DataSourceId | null;
}

/**
 * Fetch candles from the first selected source that returns a non-empty
 * series. No fallback to unselected sources.
 */
export async function resolveHistorical(
  chain: readonly BrokerAdapter[],
  req: HistoricalRequest,
): Promise<ResolvedHistorical> {
  const effectiveChain = chain.length > 0 ? chain : [yahoo];
  for (const broker of effectiveChain) {
    const candles = await broker.getHistorical(req, { allowFallback: false });
    if (candles.length > 0) {
      return { candles, source: broker.id as DataSourceId };
    }
  }
  return { candles: [], source: null };
}
