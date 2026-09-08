/**
 * Market data cache for the new provider-agnostic layer.
 *
 * Reuses the existing India cache infrastructure (Redis + memory fallback)
 * behind a typed facade. All keys are namespaced under "md:" to avoid
 * collisions with the existing "fno-pulse:" keys.
 *
 * TTLs are calibrated for Indian market data freshness requirements:
 *   - Live quotes: 3s (tighter than Yahoo's 5s — broker feeds are fresher)
 *   - Intraday candles: 30s (current bar updates frequently)
 *   - Daily/weekly candles: 4h (historical bars are stable)
 *   - Option chains: 15s (OI & IV change rapidly during market hours)
 *   - Instrument master: 12h (ScripMaster changes rarely)
 *   - Provider health: 5s (health state is mutable, keep fresh)
 */

import { cache } from "@/services/india/cache";
import type { Instrument, MDQuote, OHLCVCandle, OptionChain, ProviderId } from "../types";

// ── Namespace prefix ──────────────────────────────────────────────────────────

const NS = "md:";

function key(...parts: string[]): string {
  return NS + parts.join(":");
}

// ── TTL constants (ms) ────────────────────────────────────────────────────────

export const TTL = {
  liveQuote: 3_000,
  intradayCandle: 30_000,
  dailyCandle: 4 * 60 * 60 * 1_000,
  optionChain: 15_000,
  instrumentMaster: 12 * 60 * 60 * 1_000,
  providerHealth: 5_000,
} as const;

// ── Quote cache ───────────────────────────────────────────────────────────────

export async function getCachedQuote(
  symbol: string,
  provider: ProviderId,
): Promise<MDQuote | undefined> {
  return cache.get<MDQuote>(key("quote", provider, symbol));
}

export async function setCachedQuote(
  symbol: string,
  provider: ProviderId,
  quote: MDQuote,
): Promise<void> {
  await cache.set(key("quote", provider, symbol), quote, TTL.liveQuote);
}

export async function memoQuote(
  symbol: string,
  provider: ProviderId,
  loader: () => Promise<MDQuote | null>,
): Promise<MDQuote | null> {
  const cached = await getCachedQuote(symbol, provider);
  if (cached !== undefined) return cached;
  const result = await loader();
  if (result) await setCachedQuote(symbol, provider, result);
  return result;
}

// ── Candle cache ──────────────────────────────────────────────────────────────

function candleCacheKey(
  symbol: string,
  exchange: string,
  interval: string,
  from: string,
  to: string,
  provider: ProviderId,
): string {
  return key("candles", provider, exchange, symbol, interval, from, to);
}

export async function memoCandles(
  symbol: string,
  exchange: string,
  interval: string,
  from: string,
  to: string,
  provider: ProviderId,
  loader: () => Promise<OHLCVCandle[]>,
): Promise<OHLCVCandle[]> {
  const isDailyOrLonger = interval === "1d" || interval === "1w" || interval === "1M";
  const ttl = isDailyOrLonger ? TTL.dailyCandle : TTL.intradayCandle;
  const cacheKey = candleCacheKey(symbol, exchange, interval, from, to, provider);
  return cache.memo(cacheKey, ttl, loader);
}

// ── Option chain cache ────────────────────────────────────────────────────────

export async function memoOptionChain(
  underlying: string,
  expiry: string,
  provider: ProviderId,
  loader: () => Promise<OptionChain>,
): Promise<OptionChain> {
  return cache.memo(
    key("oc", provider, underlying, expiry),
    TTL.optionChain,
    loader,
  );
}

// ── Instrument master cache ───────────────────────────────────────────────────

export async function memoInstrumentMaster(
  provider: ProviderId,
  filterKey: string,
  loader: () => Promise<Instrument[]>,
): Promise<Instrument[]> {
  return cache.memo(
    key("instruments", provider, filterKey),
    TTL.instrumentMaster,
    loader,
  );
}

export async function invalidateInstrumentMaster(provider: ProviderId): Promise<void> {
  // Invalidate the common "all" filter key used by most callers.
  await cache.invalidate(key("instruments", provider, "all"));
}

// ── Batch quote cache (request coalescing for bulk quote endpoints) ────────────

/**
 * Coalesce + cache a batch quote fetch.
 *
 * The cache key is the EXACT ordered, upper-cased symbol list. Keying on the
 * ordered list (rather than a sorted set) keeps the returned array correctly
 * aligned with the caller's `symbols` order — two callers requesting the same
 * symbols in the same order share one in-flight request and one cached payload,
 * which is the common polling case (the tick loop always uses a stable order).
 */
export async function memoQuoteBatch(
  symbols: string[],
  provider: ProviderId,
  loader: () => Promise<Array<MDQuote | null>>,
): Promise<Array<MDQuote | null>> {
  if (symbols.length === 0) return [];
  const orderedKey = symbols.map((s) => s.toUpperCase()).join(",");
  return cache.memo(key("quotes-batch", provider, orderedKey), TTL.liveQuote, loader);
}
