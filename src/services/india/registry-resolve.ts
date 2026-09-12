import "server-only";

/**
 * Registry-backed quote resolver.
 *
 * The legacy BrokerAdapter chain (see `resolveQuotes` + `pickBrokerChain`) can
 * only serve sources that have a concrete BrokerAdapter — that's Yahoo, Groww,
 * Angel One, and OpenAlgo. Upstox (and the DATA_SERVICE / scrapling provider)
 * live ONLY in the ProviderRegistry, so when a user selects Upstox the legacy
 * chain skips it and silently falls back to Yahoo. The Market Pulse badge then
 * says "Yahoo Finance" even though the user asked for Upstox.
 *
 * This module fetches quotes through the ProviderRegistry and tags each result
 * with its GENUINE provider (mapped back to a catalog `DataSourceId`), so the
 * snapshot route can surface real provenance including Upstox.
 */

import { registry, bootstrapRegistry } from "@/lib/market-data/registry";
import type { MDQuote, ProviderId } from "@/lib/market-data/types";
import type { DataSourceId } from "@/features/settings/data-sources-shared";
import type { Quote } from "@/types/india";

/**
 * Map an internal ProviderRegistry id to the catalog DataSourceId used by the
 * data-source picker + badge labels. The scrapling/DATA_SERVICE provider is a
 * managed aggregation layer with no user-selectable catalog entry, so it is
 * surfaced as "yahoo" (its ultimate public-data equivalent) rather than an
 * unknown id that would render a raw string in the badge.
 */
const PROVIDER_TO_DATA_SOURCE: Record<ProviderId, DataSourceId> = {
  scrapling:  "yahoo",    // managed aggregation layer (credential-free public data)
  angel_one:  "angel",
  upstox:     "upstox",
  jugaad:     "yahoo",    // open-source NSE-derived — no catalog entry; map to nearest public
  openchart:  "yahoo",    // open-source NSE chart data — no catalog entry; map to nearest public
  yahoo:      "yahoo",
};

export function providerToDataSource(provider: ProviderId): DataSourceId {
  return PROVIDER_TO_DATA_SOURCE[provider] ?? "yahoo";
}

/** Convert a registry MDQuote into the India `Quote` shape used across the UI. */
function toIndiaQuote(md: MDQuote): Quote {
  return {
    symbol: md.symbol,
    name: md.name,
    price: md.ltp,
    change: md.change,
    changePct: md.changePct,
    prevClose: md.prevClose,
    open: md.open,
    high: md.high,
    low: md.low,
    volume: md.volume,
    oi: md.oi,
    weekHigh52: md.weekHigh52,
    weekLow52: md.weekLow52,
    upperCircuit: md.upperCircuit,
    lowerCircuit: md.lowerCircuit,
    totalBuyQty: md.totalBuyQty,
    totalSellQty: md.totalSellQty,
    source: providerToDataSource(md.provider),
    fetchedAt: md.fetchedAt,
  };
}

export interface RegistryResolved {
  /** Successfully-resolved quotes keyed by requested symbol. */
  bySymbol: Map<string, Quote>;
  /** Distinct catalog sources that actually produced a value (first-seen). */
  sources: DataSourceId[];
}

/**
 * Resolve quotes for `symbols` via the ProviderRegistry.
 *
 * When `allowedSources` is provided, only quotes whose genuine provider maps
 * to one of those catalog ids are accepted — this keeps provenance honest with
 * the user's selection (e.g. "only show data the user opted into"). Pass
 * `undefined` to accept whatever the registry serves.
 *
 * Never throws: registry/bootstrap failures resolve to an empty result so the
 * caller can fall back to its existing chain.
 */
export async function resolveQuotesViaRegistry(
  symbols: string[],
  allowedSources?: readonly DataSourceId[],
): Promise<RegistryResolved> {
  const bySymbol = new Map<string, Quote>();
  const sources: DataSourceId[] = [];
  if (symbols.length === 0) return { bySymbol, sources };

  try {
    await bootstrapRegistry();
    const results = await registry.getQuotes(symbols);
    symbols.forEach((sym, i) => {
      const md = results[i];
      if (!md || md.ltp == null) return;
      const src = providerToDataSource(md.provider);
      if (allowedSources && !allowedSources.includes(src)) return;
      bySymbol.set(sym, toIndiaQuote(md));
      if (!sources.includes(src)) sources.push(src);
    });
  } catch {
    // Swallow — caller falls back to the legacy adapter chain.
  }

  return { bySymbol, sources };
}
