/**
 * ScraplingProvider — credential-free market data at Priority 0.
 *
 * Wraps the `data-service` Python microservice (port 8200) via HTTP REST.
 * Registered at priority 0 in `bootstrapRegistry()` so it is always tried
 * first. When `DATA_SERVICE_URL` is not set the provider is disabled and
 * every method returns the appropriate empty/null sentinel so `withFailover`
 * flows cleanly to Angel One.
 *
 * The one exception to the "return empty on not-configured" rule is
 * `getOptionChain`, which throws `MarketDataError(NOT_CONFIGURED)` because
 * `withFailover` needs a thrown error — not a resolved value — to move to the
 * next provider.
 */

import type { MarketDataProvider, ProviderCallOptions } from "../provider";
import type {
  HistoricalCandleRequest,
  Instrument,
  InstrumentMasterFilter,
  LiveTick,
  MDQuote,
  OHLCVCandle,
  OptionChain,
  ProviderHealth,
  ProviderId,
  SubscribeRequest,
} from "../types";
import { MarketDataError } from "../types";
import { getProviderHealth } from "../health";

// ── Environment ───────────────────────────────────────────────────────────────

const PROVIDER_ID: ProviderId = "scrapling";

/**
 * Returns the base URL for the data-service, read dynamically each call so
 * tests can set/unset `DATA_SERVICE_URL` between test cases.
 */
function getBaseUrl(): string {
  return process.env.DATA_SERVICE_URL ?? "";
}

/**
 * Whether the ScraplingProvider is currently enabled.
 * Read dynamically so tests can control it via `process.env`.
 */
function isEnabled(): boolean {
  return !!getBaseUrl();
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

/**
 * Fetch a JSON resource from the data-service. Throws `MarketDataError` on any
 * non-2xx response so `withFailover` can move to the next provider.
 *
 * Error code mapping:
 *   429 → RATE_LIMIT
 *   401 → AUTH_FAILURE
 *   anything else 4xx/5xx → INVALID_RESPONSE
 */
async function dsGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${getBaseUrl()}${path}`, { signal });
  if (!res.ok) {
    const code =
      res.status === 429
        ? "RATE_LIMIT"
        : res.status === 401
          ? "AUTH_FAILURE"
          : ("INVALID_RESPONSE" as const);
    throw new MarketDataError(
      `data-service ${path}: HTTP ${res.status}`,
      PROVIDER_ID,
      code,
    );
  }
  return res.json() as Promise<T>;
}

// ── Response shapes from data-service ────────────────────────────────────────

interface HistoricalResponse {
  candles: OHLCVCandle[];
  count: number;
}

interface QuotesResponse {
  quotes: Array<MDQuote | null>;
}

interface InstrumentsResponse {
  instruments: Instrument[];
  count: number;
  cached: boolean;
  exchange: string;
}

// ── Provider implementation ───────────────────────────────────────────────────

export class ScraplingProvider implements MarketDataProvider {
  readonly id: ProviderId = PROVIDER_ID;

  // ── Historical candles ──────────────────────────────────────────────────

  async getHistoricalCandles(
    req: HistoricalCandleRequest,
    opts?: ProviderCallOptions,
  ): Promise<OHLCVCandle[]> {
    if (!isEnabled()) return [];

    const params = new URLSearchParams({
      symbol:   req.symbol,
      exchange: req.exchange,
      interval: req.interval,
      from:     req.from,
      to:       req.to,
    });

    const data = await dsGet<HistoricalResponse>(
      `/scraping/historical?${params}`,
      opts?.signal,
    );
    return data.candles;
  }

  // ── Latest quote ────────────────────────────────────────────────────────

  async getLatestQuote(
    symbol: string,
    opts?: ProviderCallOptions,
  ): Promise<MDQuote | null> {
    if (!isEnabled()) return null;
    const results = await this.getQuotes([symbol], opts);
    return results[0] ?? null;
  }

  // ── Batch quotes ────────────────────────────────────────────────────────

  async getQuotes(
    symbols: string[],
    opts?: ProviderCallOptions,
  ): Promise<Array<MDQuote | null>> {
    if (!isEnabled()) return Array<MDQuote | null>(symbols.length).fill(null);

    const params = new URLSearchParams({ symbols: symbols.join(",") });
    const data = await dsGet<QuotesResponse>(
      `/scraping/quotes?${params}`,
      opts?.signal,
    );
    return data.quotes;
  }

  // ── Option chain ────────────────────────────────────────────────────────

  async getOptionChain(
    underlying: string,
    expiry?: string,
    opts?: ProviderCallOptions,
  ): Promise<OptionChain> {
    if (!isEnabled()) {
      throw new MarketDataError(
        "ScraplingProvider not configured — set DATA_SERVICE_URL",
        PROVIDER_ID,
        "NOT_CONFIGURED",
      );
    }

    const params = new URLSearchParams({ underlying });
    if (expiry) params.set("expiry", expiry);

    return dsGet<OptionChain>(`/scraping/option-chain?${params}`, opts?.signal);
  }

  // ── Instrument master ───────────────────────────────────────────────────

  async getInstrumentMaster(
    filter?: InstrumentMasterFilter,
    opts?: ProviderCallOptions,
  ): Promise<Instrument[]> {
    if (!isEnabled()) return [];

    const params = new URLSearchParams();
    if (filter?.exchange) params.set("exchange", filter.exchange);
    if (filter?.instrumentType) params.set("type", filter.instrumentType);

    const query = params.toString() ? `?${params}` : "";
    const data = await dsGet<InstrumentsResponse>(
      `/scraping/instruments${query}`,
      opts?.signal,
    );
    return data.instruments;
  }

  // ── WebSocket / subscribe (polling fallback) ────────────────────────────

  /**
   * Poll `getQuotes` every 5 seconds and emit `LiveTick` events.
   * Primary tick delivery is via the Redis pub/sub tick listener; this is a
   * polling fallback for code paths that call `subscribe()` directly.
   *
   * When `getQuotes` throws, `onError` is called and polling continues.
   */
  subscribe(
    req: SubscribeRequest,
    onTick: (tick: LiveTick) => void,
    onError?: (err: unknown) => void,
  ): () => void {
    if (!isEnabled()) return () => {};

    const symbols = req.tokens.map((t) => t.token);
    let stopped = false;

    const poll = async () => {
      while (!stopped) {
        try {
          const quotes = await this.getQuotes(symbols);
          const now = Date.now();
          for (const quote of quotes) {
            if (!quote || quote.ltp == null) continue;
            onTick({
              token:               quote.token ?? quote.symbol,
              symbol:              quote.symbol,
              exchange:            quote.exchange ?? req.tokens[0]?.exchange ?? "NSE",
              ltp:                 quote.ltp,
              change:              quote.change,
              changePct:           quote.changePct,
              volume:              quote.volume,
              oi:                  quote.oi,
              exchangeTimestampMs: now,
              receivedAtMs:        now,
              provider:            PROVIDER_ID,
            });
          }
        } catch (err) {
          onError?.(err);
        }
        // Wait 5 seconds before the next poll.
        await new Promise<void>((resolve) => setTimeout(resolve, 5_000));
      }
    };

    // Start polling in the background; don't await.
    void poll();

    // Return the teardown function.
    return () => {
      stopped = true;
    };
  }

  /** No-op — Redis pub/sub is the primary delivery mechanism. */
  unsubscribe(_tokens: string[]): void {
    // Intentional no-op. TickListener handles Redis pub/sub teardown.
  }

  // ── Health ─────────────────────────────────────────────────────────────

  getProviderHealth(): ProviderHealth {
    return getProviderHealth(PROVIDER_ID);
  }
}
