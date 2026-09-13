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
//
// Requirements 14.1, 14.2 — canonical TTLs used for both L1 (in-process) and
// L2 (Redis) cache layers.
//
//   LTP quotes      3 s   — tightest freshness; broker feeds update sub-second
//   Full quotes     5 s   — includes Greeks/depth, slightly looser bound
//   1m candles     30 s   — current bar updates every tick during market hours
//   5m–1h candles  60 s   — intraday bars settle more slowly than 1m
//   1d+ candles     4 h   — historical bars are stable during the trading day
//   Option chains  15 s   — OI and IV change rapidly; keep tight
//   Instrument master 12 h — ScripMaster changes rarely

export const TTL = {
  /** LTP-only quotes (3 s). Requirement 14.1. */
  ltpQuote: 3_000,
  /** Full quotes including Greeks, depth etc. (5 s). Requirement 14.1. */
  liveQuote: 5_000,
  /** 1-minute intraday candles (30 s). Requirement 14.1. */
  oneMinuteCandle: 30_000,
  /** 5m–1h intraday candles (60 s). Requirement 14.1. */
  intradayCandle: 60_000,
  /** Daily / weekly / monthly candles (4 h). Requirement 14.1. */
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
  // Use liveQuote (5s full-quote TTL) for set operations.
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

/**
 * Derive the correct cache TTL for a given candle interval.
 *
 * Requirements 14.1:
 *   1m   → 30 s  (oneMinuteCandle)
 *   5m–1h → 60 s  (intradayCandle)
 *   1d+  → 4 h   (dailyCandle)
 */
export function candleTtlForInterval(interval: string): number {
  if (interval === "1m") return TTL.oneMinuteCandle;
  if (interval === "1d" || interval === "1w" || interval === "1M") return TTL.dailyCandle;
  // 5m, 10m, 15m, 30m, 1h
  return TTL.intradayCandle;
}

function candleCacheKey(
  symbol: string,
  exchange: string,
  interval: string,
  from: string,
  to: string,
  provider: ProviderId,
): string {
  // L2 Redis key pattern: md:candles:{provider}:{exchange}:{symbol}:{interval}:{from}:{to}
  // Requirement 14.2
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
  const ttl = candleTtlForInterval(interval);
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
 *
 * TTL: 3s (ltpQuote) — live batch quotes are treated as LTP-level freshness.
 * Requirement 14.1.
 */
export async function memoQuoteBatch(
  symbols: string[],
  provider: ProviderId,
  loader: () => Promise<Array<MDQuote | null>>,
): Promise<Array<MDQuote | null>> {
  if (symbols.length === 0) return [];
  const orderedKey = symbols.map((s) => s.toUpperCase()).join(",");
  // L2 Redis key pattern: md:quotes-batch:{provider}:{SYM1,SYM2,...}
  // Uses ltpQuote (3s) TTL — live batch quotes.  Requirement 14.1, 14.2.
  return cache.memo(key("quotes-batch", provider, orderedKey), TTL.ltpQuote, loader);
}
