/**
 * Upstox instrument-master resolver.
 *
 * WHY THIS EXISTS
 * ---------------
 * Upstox's market-data endpoints (market-quote, historical-candle, option-chain)
 * identify NSE/BSE *equities* by an ISIN-based instrument key, e.g.
 *   RELIANCE  →  NSE_EQ|INE002A01018
 * A symbol-based key such as `NSE_EQ|RELIANCE` is REJECTED with
 *   HTTP 400  UDAPI100011  "Invalid Instrument key"
 * and bulk quotes silently return an empty `data: {}` object.
 *
 * (Indices are keyed by name — `NSE_INDEX|Nifty 50` — and F&O by exchange token,
 *  so only equities need this ISIN resolution.)
 *
 * This module downloads Upstox's public instrument master (no auth required),
 * builds a `trading_symbol → instrument_key` map for the equity segments, and
 * caches it for 12h (the master changes at most once per trading day). The
 * lookup is used by the Upstox provider to build correct equity keys, with a
 * graceful fallback to the raw symbol form when the master is unavailable.
 *
 * SECURITY: no credentials involved — the instrument master is public.
 */

import { cache } from "@/services/india/cache";

// Upstox publishes gzipped JSON per exchange. NSE covers equities + F&O + indices.
const UPSTOX_NSE_MASTER_URL =
  "https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz";
const UPSTOX_BSE_MASTER_URL =
  "https://assets.upstox.com/market-quote/instruments/exchange/BSE.json.gz";

/** Cache key + TTL (12h) for the built symbol→key maps. */
const CACHE_KEY_NSE = "md:upstox:instrmap:NSE_EQ";
const CACHE_KEY_BSE = "md:upstox:instrmap:BSE_EQ";
const MASTER_TTL_MS = 12 * 60 * 60 * 1_000;
const FETCH_TIMEOUT_MS = 30_000;

/** One raw instrument-master row (only the fields we consume). */
interface UpstoxMasterRow {
  segment?: string;
  instrument_type?: string;
  instrument_key?: string;
  trading_symbol?: string;
  isin?: string;
  exchange?: string;
}

// In-process memo so we never re-parse the ~2 MB payload within a hot window,
// even across cache backends. Keyed by segment.
declare global {
  // eslint-disable-next-line no-var
  var __upstoxInstrMap: Map<string, Map<string, string>> | undefined;
  // eslint-disable-next-line no-var
  var __upstoxInstrInflight: Map<string, Promise<Map<string, string>>> | undefined;
}
const memMaps = globalThis.__upstoxInstrMap ?? new Map<string, Map<string, string>>();
if (!globalThis.__upstoxInstrMap) globalThis.__upstoxInstrMap = memMaps;
const inflight =
  globalThis.__upstoxInstrInflight ?? new Map<string, Promise<Map<string, string>>>();
if (!globalThis.__upstoxInstrInflight) globalThis.__upstoxInstrInflight = inflight;

async function downloadAndParse(url: string, segment: "NSE_EQ" | "BSE_EQ"): Promise<Map<string, string>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`Upstox instrument master ${segment}: HTTP ${res.status}`);

    // IMPORTANT: this endpoint serves RAW gzip bytes with
    //   Content-Type: application/gzip  (NO Content-Encoding: gzip)
    // so undici does NOT auto-decompress. Calling res.json() directly on the
    // gzip bytes throws/hangs. We read the bytes and gunzip manually, with a
    // fallback to plain JSON in case a future deployment pre-decompresses.
    const buf = Buffer.from(await res.arrayBuffer());
    let text: string;
    if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
      const zlib = await import("node:zlib");
      text = zlib.gunzipSync(buf).toString("utf8");
    } else {
      text = buf.toString("utf8");
    }
    const rows = JSON.parse(text) as UpstoxMasterRow[];
    const map = new Map<string, string>();
    for (const row of rows) {
      if (row.segment !== segment) continue;
      // Equities only — instrument_type "EQ". Skip bonds/SG/ETF-with-symbol etc.
      if (row.instrument_type !== "EQ") continue;
      const sym = row.trading_symbol?.toUpperCase();
      const key = row.instrument_key;
      if (sym && key) map.set(sym, key);
    }
    return map;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Return the equity symbol→instrument_key map for a segment, cached.
 * Concurrent callers share one in-flight download (single-flight).
 */
async function getEquityMap(segment: "NSE_EQ" | "BSE_EQ"): Promise<Map<string, string>> {
  const existing = memMaps.get(segment);
  if (existing && existing.size > 0) return existing;

  const pending = inflight.get(segment);
  if (pending) return pending;

  const url = segment === "NSE_EQ" ? UPSTOX_NSE_MASTER_URL : UPSTOX_BSE_MASTER_URL;
  const cacheKey = segment === "NSE_EQ" ? CACHE_KEY_NSE : CACHE_KEY_BSE;

  const p = (async () => {
    // Try the shared cache first (serialised as an array of [sym,key] pairs).
    try {
      const cached = await cache.get<Array<[string, string]>>(cacheKey);
      if (cached && cached.length > 0) {
        const m = new Map(cached);
        memMaps.set(segment, m);
        return m;
      }
    } catch {
      /* cache miss / backend hiccup — fall through to download */
    }

    const map = await downloadAndParse(url, segment);
    memMaps.set(segment, map);
    // Best-effort cache write (array form so it survives JSON serialisation).
    try {
      await cache.set(cacheKey, [...map.entries()], MASTER_TTL_MS);
    } catch {
      /* non-fatal */
    }
    return map;
  })().finally(() => {
    inflight.delete(segment);
  });

  inflight.set(segment, p);
  return p;
}

/**
 * Resolve an NSE/BSE equity trading symbol to its ISIN-based Upstox instrument
 * key. Returns null when the symbol isn't found in the master (caller should
 * fall back to the raw symbol form). Only equities need this — indices and F&O
 * are handled by the caller's static key logic.
 */
export async function resolveEquityInstrumentKey(
  symbol: string,
  exchange: "NSE" | "BSE" = "NSE",
): Promise<string | null> {
  const segment = exchange === "BSE" ? "BSE_EQ" : "NSE_EQ";
  const clean = symbol.replace(/\.(NS|BO)$/i, "").toUpperCase();
  try {
    const map = await getEquityMap(segment);
    return map.get(clean) ?? null;
  } catch {
    return null;
  }
}

/** Test/ops helper: clear the in-process + shared cache maps. */
export async function _resetUpstoxInstrumentCache(): Promise<void> {
  memMaps.clear();
  inflight.clear();
  try {
    await cache.invalidate(CACHE_KEY_NSE);
    await cache.invalidate(CACHE_KEY_BSE);
  } catch {
    /* ignore */
  }
}
