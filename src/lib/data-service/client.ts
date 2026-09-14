/**
 * DataServiceClient — canonical TypeScript SDK for data-service2.0.
 *
 * Phase 5 of the data-service centralization refactor.
 *
 * This module is the SINGLE entry point for all market data in AlphaForge.
 * It calls data-service2.0 REST and WebSocket endpoints directly.
 *
 * RULES:
 *  - No fallback providers. If data-service2.0 is unavailable → DataServiceUnavailableError.
 *  - No imports from Angel One, Upstox, Yahoo Finance, NSE, Scrapling, Binance, Deribit, Delta.
 *  - Server-side only (protected by `import "server-only"`).
 *  - All HTTP calls carry a 10-second AbortSignal timeout.
 *  - X-API-KEY header is included when DATA_SERVICE_API_KEY env var is set.
 *
 * Usage:
 *   import { DataServiceClient } from "@/lib/data-service/client";
 *   const quote  = await DataServiceClient.market.quote("RELIANCE");
 *   const candles = await DataServiceClient.market.candles({ symbol: "NIFTY", interval: "1d" });
 *
 * Named convenience exports are also available:
 *   import { getQuote, getCandles } from "@/lib/data-service/client";
 */

import "server-only";

export type {
  CryptoOHLCV,
  DataServiceHealth,
  FuturesOverview,
  HistoricalRequest,
  LiveTick,
  MarketQuote,
  MarketStatusResponse,
  OHLCVCandle,
  OptionChain,
  OptionChainRow,
  ProviderHealthEntry,
} from "./types";

export { DataServiceUnavailableError } from "./types";

import type {
  CryptoOHLCV,
  DataServiceHealth,
  FuturesOverview,
  HistoricalRequest,
  LiveTick,
  MarketQuote,
  MarketStatusResponse,
  OHLCVCandle,
  OptionChain,
  ProviderHealthEntry,
} from "./types";
import { DataServiceUnavailableError } from "./types";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Base URL for data-service2.0. Prefer DATA_SERVICE_2_URL, fall back to DATA_SERVICE_URL. */
function getBaseUrl(): string {
  return (
    process.env.DATA_SERVICE_2_URL ??
    process.env.DATA_SERVICE_URL ??
    "http://localhost:8200"
  );
}

/** Build shared request headers. */
function buildHeaders(): HeadersInit {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  const apiKey = process.env.DATA_SERVICE_API_KEY;
  if (apiKey) {
    headers["X-API-KEY"] = apiKey;
  }
  return headers;
}

/** Default HTTP timeout for all requests (10 seconds). */
const REQUEST_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Internal HTTP helpers
// ---------------------------------------------------------------------------

/**
 * Execute a GET request to a data-service2.0 path and return the parsed
 * `data` field from the success envelope.
 *
 * Throws DataServiceUnavailableError on:
 *   - Network errors / AbortError (timeout)
 *   - Non-2xx HTTP responses
 *   - Well-formed error envelopes from data-service2.0
 */
async function dsGet<T>(path: string): Promise<T> {
  const url = `${getBaseUrl()}${path}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: buildHeaders(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      // Next.js server components default to caching — we always want fresh data.
      cache: "no-store",
    });
  } catch (err) {
    const msg =
      err instanceof Error ? err.message : "network error";
    throw new DataServiceUnavailableError(
      `DATA_SERVICE_UNAVAILABLE: ${msg} (${url})`,
    );
  }

  if (!response.ok) {
    // Try to parse a structured error envelope first.
    let serviceCode: string | undefined;
    try {
      const body = (await response.json()) as {
        error?: { code?: string; message?: string };
      };
      serviceCode = body?.error?.code;
      if (body?.error?.message) {
        throw new DataServiceUnavailableError(
          `DATA_SERVICE_UNAVAILABLE: ${body.error.message} (HTTP ${response.status})`,
          response.status,
          serviceCode,
        );
      }
    } catch (parseErr) {
      // If it's already a DataServiceUnavailableError, re-throw.
      if (parseErr instanceof DataServiceUnavailableError) throw parseErr;
      // Otherwise fall through to the generic error below.
    }

    throw new DataServiceUnavailableError(
      `DATA_SERVICE_UNAVAILABLE: HTTP ${response.status} from ${url}`,
      response.status,
      serviceCode,
    );
  }

  const envelope = (await response.json()) as {
    data?: T;
    error?: { code?: string; message?: string };
  };

  if (envelope.error) {
    throw new DataServiceUnavailableError(
      `DATA_SERVICE_UNAVAILABLE: ${envelope.error.message ?? envelope.error.code ?? "unknown error"}`,
      response.status,
      envelope.error.code,
    );
  }

  if (envelope.data === undefined) {
    throw new DataServiceUnavailableError(
      `DATA_SERVICE_UNAVAILABLE: missing "data" field in response from ${url}`,
      response.status,
    );
  }

  return envelope.data;
}

/**
 * Build a query string from a plain-object record, omitting undefined values.
 * Returns an empty string when there are no params.
 */
function qs(params: Record<string, string | number | boolean | undefined>): string {
  const pairs = Object.entries(params).filter(
    ([, v]) => v !== undefined && v !== null,
  ) as Array<[string, string | number | boolean]>;
  if (pairs.length === 0) return "";
  return "?" + new URLSearchParams(pairs.map(([k, v]) => [k, String(v)])).toString();
}

// ---------------------------------------------------------------------------
// Indian Market — Quotes
// ---------------------------------------------------------------------------

/**
 * Normalise raw `MarketQuote` fields returned by data-service2.0.
 *
 * data-service2.0 sometimes serialises numeric fields as strings (matching
 * upstream broker wire formats). Coerce every numeric field to a proper JS
 * number so downstream code can safely call Number.isFinite(), arithmetic
 * operations, and formatPrice() without unexpected "—" results.
 */
function normalizeMarketQuote(raw: MarketQuote): MarketQuote {
  const n = (v: unknown): number => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
  const nOrNull = (v: unknown): number | null => {
    if (v === null || v === undefined) return null;
    const x = Number(v);
    return Number.isFinite(x) ? x : null;
  };
  return {
    ...raw,
    ltp:        nOrNull(raw.ltp) ?? 0,
    open:       nOrNull(raw.open),
    high:       nOrNull(raw.high),
    low:        nOrNull(raw.low),
    prevClose:  nOrNull(raw.prevClose),
    change:     nOrNull(raw.change),
    changePct:  nOrNull(raw.changePct),
    volume:     nOrNull(raw.volume),
    oi:         nOrNull(raw.oi),
    bid:        nOrNull(raw.bid),
    ask:        nOrNull(raw.ask),
    weekHigh52: nOrNull(raw.weekHigh52),
    weekLow52:  nOrNull(raw.weekLow52),
    tradedValue: nOrNull(raw.tradedValue),
  };
}

/**
 * Fetch the live quote for a single Indian equity / index / derivative.
 *
 * @param symbol  NSE/BSE symbol, e.g. "RELIANCE", "NIFTY"
 * @param exchange  Defaults to "NSE" in data-service2.0
 */
export async function getQuote(
  symbol: string,
  exchange?: string,
): Promise<MarketQuote> {
  const params = qs({ exchange: exchange ?? "NSE" });
  const raw = await dsGet<MarketQuote>(`/v1/india/quotes/${encodeURIComponent(symbol)}${params}`);
  // Populate backward-compat alias fields and normalise numeric strings
  return normalizeMarketQuote({ ...raw, fetchedAt: raw.dataAsOf, name: raw.name ?? null, weekHigh52: raw.weekHigh52 ?? null, weekLow52: raw.weekLow52 ?? null, spot: undefined } as MarketQuote);
}

/**
 * Fetch live quotes for multiple symbols concurrently.
 * Symbols that fail individually return null in the corresponding slot rather
 * than rejecting the whole batch.
 */
export async function getQuotes(
  symbols: string[],
  exchange?: string,
): Promise<Array<MarketQuote | null>> {
  const results = await Promise.allSettled(
    symbols.map((s) => getQuote(s, exchange)),
  );
  return results.map((r) => (r.status === "fulfilled" ? r.value : null));
}

// ---------------------------------------------------------------------------
// Indian Market — Historical OHLCV
// ---------------------------------------------------------------------------

/**
 * Fetch historical OHLCV candles for an Indian instrument.
 */
export async function getHistorical(req: HistoricalRequest): Promise<OHLCVCandle[]> {
  const params = qs({
    symbol: req.symbol,
    interval: req.interval,
    exchange: req.exchange,
    from: req.from,
    to: req.to,
  });
  return dsGet<OHLCVCandle[]>(`/v1/india/historical${params}`);
}

/** Alias for getHistorical — kept for backward compatibility. */
export const getCandles = getHistorical;

// ---------------------------------------------------------------------------
// Indian Market — Option Chain
// ---------------------------------------------------------------------------

/**
 * Fetch the live option chain for an underlying × expiry pair.
 *
 * @param underlying  E.g. "NIFTY", "BANKNIFTY", "RELIANCE"
 * @param expiry      YYYY-MM-DD expiry date; omit for front-month default
 */
export async function getOptionChain(
  underlying: string,
  expiry?: string,
): Promise<OptionChain> {
  const params = qs({ underlying, expiry });
  const raw = await dsGet<OptionChain>(`/v1/india/option-chain${params}`);
  // Populate backward-compat alias fields
  return {
    ...raw,
    spot: raw.spotPrice,
    fetchedAt: raw.dataAsOf,
    provider: raw.provider ?? null,
    expiries: raw.expiries ?? [raw.expiry],
    // Backward compat: analytics sub-object maps to flat fields
    analytics: {
      pcrOi: raw.pcrOi,
      pcrVolume: null,
      atmIv: raw.atmIv,
      maxPain: raw.maxPain,
      maxCeOiStrike: null as number | null,
      maxPeOiStrike: null as number | null,
      totalCeOi: 0,
      totalPeOi: 0,
      totalCeOiChange: 0,
      totalPeOiChange: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Indian Market — Market Status & Instruments
// ---------------------------------------------------------------------------

/**
 * Fetch the current NSE market session status.
 */
export async function getMarketStatus(): Promise<MarketStatusResponse> {
  return dsGet<MarketStatusResponse>("/v1/india/market/status");
}

/**
 * Fetch the instrument master from data-service2.0.
 *
 * @param filter  Optional exchange and/or instrumentType filter
 */
export async function getInstruments(
  filter?: { exchange?: string; instrumentType?: string },
): Promise<unknown[]> {
  const params = qs({
    exchange: filter?.exchange,
    instrumentType: filter?.instrumentType,
  });
  return dsGet<unknown[]>(`/v1/india/instruments${params}`);
}

/**
 * Fetch the current NSE F&O eligible equity universe.
 */
export async function getFNOUniverse(): Promise<unknown[]> {
  return getInstruments({ exchange: "NSE", instrumentType: "EQ" });
}

// ---------------------------------------------------------------------------
// Crypto
// ---------------------------------------------------------------------------

/**
 * Fetch OHLCV candles for a crypto pair.
 *
 * @param symbol    E.g. "BTCUSDT"
 * @param interval  E.g. "1d", "1h", "15m"
 * @param limit     Max number of candles to return (default handled by service)
 */
export async function getCryptoOHLCV(
  symbol: string,
  interval: string,
  limit?: number,
): Promise<CryptoOHLCV[]> {
  const params = qs({ interval, limit });
  return dsGet<CryptoOHLCV[]>(
    `/v1/crypto/${encodeURIComponent(symbol)}/ohlcv${params}`,
  );
}

/**
 * Fetch the live ticker for a crypto pair.
 *
 * @param symbol  E.g. "BTCUSDT"
 */
export async function getCryptoTicker(
  symbol: string,
): Promise<{ symbol: string; price: number }> {
  const raw = await dsGet<{ symbol: string; price: number | string }>(
    `/v1/crypto/${encodeURIComponent(symbol)}/ticker`,
  );
  // data-service2.0 serialises price as a string (Binance API format).
  // Normalise to number here so every consumer gets a real numeric value.
  return { symbol: raw.symbol, price: Number(raw.price) || 0 };
}

/**
 * Fetch the perpetual futures overview (funding rates, OI, long/short ratios).
 */
export async function getFuturesOverview(): Promise<FuturesOverview[]> {
  return dsGet<FuturesOverview[]>("/v1/crypto/futures/overview");
}

/**
 * Fetch the Deribit options analytics overview.
 * Note: endpoint name mentions Deribit because that is the upstream; this
 * client never connects to Deribit directly — data-service2.0 handles that.
 */
export async function getDeribitOptionsOverview(): Promise<unknown[]> {
  return dsGet<unknown[]>("/v1/deribit/options/overview");
}

// ---------------------------------------------------------------------------
// Streaming — WebSocket tick subscriptions
// ---------------------------------------------------------------------------

/**
 * Derive the WebSocket URL from the HTTP base URL, appending the API key as
 * a query parameter when DATA_SERVICE_API_KEY is set.
 *
 * http://...  → ws://...
 * https://... → wss://...
 *
 * The `api_key` query param is the server-accepted fallback for WebSocket
 * connections where the X-API-KEY header cannot be set by the caller.
 */
function wsUrl(path: string): string {
  const base = getBaseUrl().replace(/^http/, "ws");
  const url = `${base}${path}`;
  const apiKey = process.env.DATA_SERVICE_API_KEY;
  return apiKey ? `${url}?api_key=${encodeURIComponent(apiKey)}` : url;
}

/**
 * Subscribe to live ticks for a set of symbols via the data-service2.0
 * WebSocket stream at /v1/stream/ticks.
 *
 * Sends `{"action":"subscribe","symbols":[...]}` on connect.
 * Returns an unsubscribe function that sends `{"action":"unsubscribe","symbols":[...]}`
 * and then closes the socket.
 *
 * This function is safe to call from server-side Node.js environments (API
 * routes, workers). For browser-side usage, use the data-service2.0 REST
 * endpoints with polling instead.
 *
 * @param symbols   Array of NSE/BSE symbols to subscribe to
 * @param onTick    Callback invoked for each tick message
 * @param onError   Optional callback invoked on socket errors / close errors
 * @returns         Unsubscribe function — call to stop and clean up
 */
export function subscribeToTicks(
  symbols: string[],
  onTick: (tick: LiveTick) => void,
  onError?: (err: Error) => void,
): () => void {
  const url = wsUrl("/v1/stream/ticks");

  // We use the standard browser-compatible WebSocket API.
  // In Node.js 18+ this is globally available.
  let ws: WebSocket | null = null;
  let closed = false;

  function connect(): void {
    try {
      ws = new WebSocket(url);
    } catch (err) {
      onError?.(
        err instanceof Error
          ? err
          : new Error(`WebSocket construction failed: ${String(err)}`),
      );
      return;
    }

    ws.onopen = () => {
      try {
        ws?.send(JSON.stringify({ action: "subscribe", symbols }));
      } catch (err) {
        onError?.(
          err instanceof Error ? err : new Error(`WebSocket send failed: ${String(err)}`),
        );
      }
    };

    ws.onmessage = (event: MessageEvent) => {
      if (closed) return;
      try {
        const payload = JSON.parse(event.data as string) as LiveTick;
        onTick(payload);
      } catch {
        // Silently discard unparseable frames — they may be heartbeats or
        // control messages from data-service2.0.
      }
    };

    ws.onerror = (event: Event) => {
      onError?.(new Error(`WebSocket error on ${url}: ${String(event)}`));
    };

    ws.onclose = (event: CloseEvent) => {
      if (!closed && event.code !== 1000) {
        // Abnormal close — surface to caller.
        onError?.(
          new Error(
            `WebSocket closed unexpectedly (code=${event.code}, reason=${event.reason ?? "none"})`,
          ),
        );
      }
    };
  }

  connect();

  /** Unsubscribe and close the WebSocket connection. */
  return function unsubscribe(): void {
    closed = true;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ action: "unsubscribe", symbols }));
      } catch {
        // Best-effort; we're closing anyway.
      }
      ws.close(1000, "client unsubscribed");
    }
    ws = null;
  };
}

// ---------------------------------------------------------------------------
// Health / Observability
// ---------------------------------------------------------------------------

/**
 * Fetch the combined health status of data-service2.0 and its upstream providers.
 */
export async function getDataServiceHealth(): Promise<DataServiceHealth> {
  return dsGet<DataServiceHealth>("/v1/health/live");
}

/**
 * Fetch the health status of individual upstream data providers.
 */
export async function getProviderHealth(): Promise<ProviderHealthEntry[]> {
  return dsGet<ProviderHealthEntry[]>("/v1/analytics/providers");
}

// ---------------------------------------------------------------------------
// DataServiceClient namespace — backward-compatible object API
// ---------------------------------------------------------------------------

/**
 * Namespace object that groups data-service2.0 functions by domain.
 *
 * Provides backward compatibility for callers that destructure or use the
 * old `DataServiceClient.market.*` / `DataServiceClient.stream.*` pattern.
 *
 * New code should prefer the named function exports above.
 */
export const DataServiceClient = {
  market: {
    /** Fetch live quote for a single symbol. */
    quote: getQuote,
    /** Fetch live quotes for multiple symbols. */
    quotes: getQuotes,
    /** Fetch historical OHLCV candles. */
    candles: getHistorical,
    /** Alias for candles. */
    historical: getHistorical,
    /** Fetch the live option chain for an underlying. */
    options: getOptionChain,
    /** Fetch the instrument master. */
    instruments: getInstruments,
    /** Current NSE market session status. */
    status: getMarketStatus,
  },
  universe: {
    /** NSE F&O eligible equity universe. */
    fno: getFNOUniverse,
  },
  crypto: {
    /** Crypto OHLCV candles. */
    ohlcv: getCryptoOHLCV,
    /** Crypto live ticker. */
    ticker: getCryptoTicker,
    /** Perpetual futures overview. */
    futures: getFuturesOverview,
    /** Deribit options analytics. */
    deribitOptions: getDeribitOptionsOverview,
  },
  stream: {
    /**
     * Subscribe to live ticks for a set of symbols.
     * Returns an unsubscribe function.
     */
    subscribe: subscribeToTicks,
  },
  observability: {
    /** data-service2.0 liveness and provider health. */
    health: getDataServiceHealth,
    /** Per-provider health entries. */
    providers: getProviderHealth,
  },
} as const;

// ---------------------------------------------------------------------------
// Legacy named re-exports (keep old call sites working without modification)
// ---------------------------------------------------------------------------

// These names existed in the old ProviderRegistry-backed client.
// They now resolve to the equivalent data-service2.0 functions.

/** @deprecated Use DataServiceClient.stream.subscribe or subscribeToTicks */
export const subscribeQuotes = subscribeToTicks;

// ---------------------------------------------------------------------------
// Testing helpers
// ---------------------------------------------------------------------------

/**
 * No-op in this implementation — kept for test-suite backward compatibility.
 * The old client had a bootstrap phase; data-service2.0 is stateless from
 * the client's perspective.
 * @internal
 */
export function _resetDataServiceClientBootstrap(): void {
  // intentional no-op
}
