import "server-only";

import { z } from "zod";

import { env } from "@/lib/env";
import type { KlineCandle } from "@/types/market";
import type { KlineInterval } from "@/services/binance/klines";

// Delta India's REST gateway is geographically pinned to India and frequently
// takes 6–12s to respond from outside that region (the worker job spam
// "operation aborted due to timeout" was the symptom). The cached layer
// already memoises results so we can afford a generous per-request budget
// before declaring a fetch dead — env-overridable for fast/local environments.
const TIMEOUT_MS = (() => {
  const raw = Number(process.env.DELTA_REST_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 20_000;
})();

/* ──────────────────────── HTTP plumbing ──────────────────────── */

function buildUrl(path: string, query?: Record<string, string | number | undefined>): string {
  const base = env.DELTA_REST_BASE_URL.replace(/\/+$/u, "");
  const search = new URLSearchParams();
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === "") continue;
      search.set(k, String(v));
    }
  }
  const qs = search.toString();
  return `${base}${path}${qs ? `?${qs}` : ""}`;
}

async function deltaFetch<T>(
  path: string,
  schema: z.ZodType<T>,
  query?: Record<string, string | number | undefined>,
): Promise<T> {
  const url = buildUrl(path, query);
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Delta request failed: ${res.status} ${res.statusText} (${url})`);
  }
  const json: unknown = await res.json();
  return schema.parse(json);
}

const envelopeOf = <T extends z.ZodTypeAny>(inner: T) =>
  z.object({ success: z.boolean(), result: inner });

/* ──────────────────────── Tickers ──────────────────────── */

const tickerSchema = z
  .object({
    symbol: z.string(),
    contract_type: z.string().optional(),
    close: z.coerce.number().optional(),
    open: z.coerce.number().optional(),
    high: z.coerce.number().optional(),
    low: z.coerce.number().optional(),
    mark_price: z.coerce.number().optional(),
    spot_price: z.coerce.number().optional(),
    /** 24h change in percent — `-1.5220` means -1.522% (NOT a decimal
     *  fraction). Verified against Delta's `/v2/tickers` response where
     *  `(close - open) / open * 100` exactly equals `ltp_change_24h`. */
    ltp_change_24h: z.coerce.number().optional(),
    /** OI in contracts. */
    oi: z.coerce.number().optional(),
    oi_value: z.coerce.number().optional(),
    oi_value_usd: z.coerce.number().optional(),
    turnover: z.coerce.number().optional(),
    turnover_usd: z.coerce.number().optional(),
    volume: z.coerce.number().optional(),
    /** Unix seconds. */
    timestamp: z.coerce.number().optional(),
    product_id: z.coerce.number().optional(),
  })
  .passthrough();

export type DeltaTicker = z.infer<typeof tickerSchema>;
const tickersEnvelope = envelopeOf(z.array(tickerSchema));

export interface FetchTickersOptions {
  /** `perpetual_futures`, `call_options`, `put_options`, `spot`, ... */
  contractTypes?: string[];
  /** e.g. `BTC,ETH,SOL`. */
  underlyingAssetSymbols?: string[];
}

/**
 * `GET /v2/tickers` — list all live tickers. Pass `contractTypes` to filter
 * the response server-side (cheaper than fetching all options + spot just to
 * grab futures).
 */
export async function fetchAllTickers(opts: FetchTickersOptions = {}): Promise<DeltaTicker[]> {
  const parsed = await deltaFetch("/v2/tickers", tickersEnvelope, {
    contract_types: opts.contractTypes?.join(",") ?? undefined,
    underlying_asset_symbols: opts.underlyingAssetSymbols?.join(",") ?? undefined,
  });
  return parsed.result;
}

/**
 * `GET /v2/tickers/{symbol}` — accepts up to 10 comma-separated symbols.
 * Delta sometimes returns an array for the comma form and an object for a
 * single symbol, so we normalise both shapes.
 */
const tickerOrArraySchema = z.union([tickerSchema, z.array(tickerSchema)]);
const tickersBySymbolEnvelope = envelopeOf(tickerOrArraySchema);

export async function fetchTickersForSymbols(pairs: string[]): Promise<DeltaTicker[]> {
  if (pairs.length === 0) return [];
  // Delta's gateway 404s on percent-encoded commas in the path
  // (`/v2/tickers/BTCUSD%2CETHUSD` → 404), so escape each symbol individually
  // and keep the `,` separator literal. The endpoint caps at 10 symbols.
  const joined = pairs.map((p) => encodeURIComponent(p)).join(",");
  const parsed = await deltaFetch(`/v2/tickers/${joined}`, tickersBySymbolEnvelope);
  return Array.isArray(parsed.result) ? parsed.result : [parsed.result];
}

/* ──────────────────────── Products ──────────────────────── */

const productSchema = z
  .object({
    id: z.coerce.number().optional(),
    symbol: z.string(),
    contract_type: z.string().optional(),
    description: z.string().optional(),
    annualized_funding: z.coerce.number().optional(),
    funding_method: z.string().optional(),
    settling_asset: z
      .object({ symbol: z.string() })
      .passthrough()
      .optional(),
  })
  .passthrough();

const productEnvelope = envelopeOf(productSchema);

export type DeltaProduct = z.infer<typeof productSchema>;

export async function fetchProduct(symbol: string): Promise<DeltaProduct> {
  const parsed = await deltaFetch(
    `/v2/products/${encodeURIComponent(symbol)}`,
    productEnvelope,
  );
  return parsed.result;
}

/* ──────────────────────── Candles ──────────────────────── */

/** Delta supports these resolutions on `/v2/history/candles`. */
const DELTA_RESOLUTIONS: Record<KlineInterval, string> = {
  "1m": "1m",
  "3m": "3m",
  "5m": "5m",
  "15m": "15m",
  "30m": "30m",
  "1h": "1h",
  "2h": "2h",
  "4h": "4h",
  "6h": "6h",
  // Delta has no 8h candle; use 6h as a safe fallback to keep types compatible.
  "8h": "6h",
  "12h": "12h",
  "1d": "1d",
};

function toDeltaResolution(interval: KlineInterval): string {
  return DELTA_RESOLUTIONS[interval];
}

const intervalSeconds: Record<KlineInterval, number> = {
  "1m": 60,
  "3m": 180,
  "5m": 300,
  "15m": 900,
  "30m": 1_800,
  "1h": 3_600,
  "2h": 7_200,
  "4h": 14_400,
  "6h": 21_600,
  "8h": 28_800,
  "12h": 43_200,
  "1d": 86_400,
};

const candleSchema = z.object({
  time: z.coerce.number(),
  open: z.coerce.number(),
  high: z.coerce.number(),
  low: z.coerce.number(),
  close: z.coerce.number(),
  volume: z.coerce.number().optional(),
});
const candlesEnvelope = envelopeOf(z.array(candleSchema));

interface FetchCandlesParams {
  symbol: string;
  interval: KlineInterval;
  /** Inclusive start (unix seconds). */
  startSec: number;
  /** Inclusive end (unix seconds). */
  endSec: number;
}

async function fetchCandles({ symbol, interval, startSec, endSec }: FetchCandlesParams): Promise<
  KlineCandle[]
> {
  const resolution = toDeltaResolution(interval);
  const intervalSec = intervalSeconds[interval];
  const parsed = await deltaFetch("/v2/history/candles", candlesEnvelope, {
    resolution,
    symbol,
    start: startSec,
    end: endSec,
  });
  // Delta returns candles in descending order by `time` — sort ascending so
  // it matches Binance's `fetchKlines` contract and the downstream indicator
  // code (RSI/MACD etc.) which expects oldest-first.
  const sorted = [...parsed.result].sort((a, b) => a.time - b.time);
  return sorted.map<KlineCandle>((c) => {
    const openMs = c.time * 1000;
    return {
      openTime: openMs,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume ?? 0,
      // Delta candles report `time` = bar open. Close time is open + interval - 1ms
      // to mirror Binance's [openTime, closeTime] semantics.
      closeTime: openMs + intervalSec * 1000 - 1,
    };
  });
}

const MAX_CANDLES_PER_REQUEST = 2_000;

export async function fetchLatestCandles(
  symbol: string,
  interval: KlineInterval,
  limit = 100,
): Promise<KlineCandle[]> {
  const intervalSec = intervalSeconds[interval];
  const endSec = Math.floor(Date.now() / 1000);
  // Pad the lookback slightly so we don't miss the latest bar on rounding.
  const startSec = endSec - Math.max(limit + 2, 10) * intervalSec;
  const candles = await fetchCandles({ symbol, interval, startSec, endSec });
  // Trim to `limit` (most recent) so callers get the same number of bars
  // they'd get from Binance with the same `limit` value.
  return candles.slice(-limit);
}

/** Walk a wider time range, paging in 2000-candle chunks. */
export async function fetchCandleRange(
  symbol: string,
  interval: KlineInterval,
  startMs: number,
  endMs: number,
): Promise<KlineCandle[]> {
  const intervalSec = intervalSeconds[interval];
  const chunkSpanSec = intervalSec * MAX_CANDLES_PER_REQUEST;
  const out: KlineCandle[] = [];
  let cursorSec = Math.floor(startMs / 1000);
  const endSec = Math.floor(endMs / 1000);
  // Guard against unbounded pagination.
  for (let i = 0; i < 20; i += 1) {
    if (cursorSec >= endSec) break;
    const sliceEnd = Math.min(endSec, cursorSec + chunkSpanSec);
    const batch = await fetchCandles({
      symbol,
      interval,
      startSec: cursorSec,
      endSec: sliceEnd,
    });
    if (batch.length === 0) break;
    // Avoid double-counting bars at the chunk boundary.
    const lastKept = out.length > 0 ? out[out.length - 1].openTime : -Infinity;
    for (const c of batch) {
      if (c.openTime > lastKept) out.push(c);
    }
    const newCursor = sliceEnd + 1;
    if (newCursor <= cursorSec) break;
    cursorSec = newCursor;
    if (batch.length < MAX_CANDLES_PER_REQUEST) break;
  }
  return out;
}
