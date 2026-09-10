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
import { MarketDataError, httpStatusToErrorCode, parseRetryAfterMs } from "../types";
import { getProviderHealth, mdLog } from "../health";
import { filterValidCandlesWithReport } from "../validation/candle-validator";
import {
  memoQuote,
  memoQuoteBatch,
  memoCandles,
  memoOptionChain,
  memoInstrumentMaster,
} from "../cache/market-cache";

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

// ── Provider-specific rate limiter ─────────────────────────────────────────────
// The data-service scrapes NSE/BSE, which are the most ban-sensitive upstreams
// in the chain. We cap the request rate this provider issues (token bucket) so a
// burst of consumer requests can never translate into a burst of scrape requests
// — this is the client-side complement to the data-service's own limiter and to
// the request-coalescing cache below.

const DS_RATE_CAPACITY = Number(process.env.DATA_SERVICE_RATE_CAPACITY ?? 8);
const DS_RATE_WINDOW_MS = Number(process.env.DATA_SERVICE_RATE_WINDOW_MS ?? 1_000);

class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  constructor(private readonly capacity: number, private readonly windowMs: number) {
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }
  async acquire(): Promise<void> {
    const now = Date.now();
    if (now - this.lastRefill >= this.windowMs) {
      this.tokens = this.capacity;
      this.lastRefill = now;
    }
    if (this.tokens > 0) {
      this.tokens -= 1;
      return;
    }
    const wait = this.windowMs - (now - this.lastRefill);
    await new Promise<void>((r) => setTimeout(r, Math.max(0, wait)));
    return this.acquire();
  }
}

const rateLimiter = new TokenBucket(
  Number.isFinite(DS_RATE_CAPACITY) && DS_RATE_CAPACITY > 0 ? DS_RATE_CAPACITY : 8,
  Number.isFinite(DS_RATE_WINDOW_MS) && DS_RATE_WINDOW_MS > 0 ? DS_RATE_WINDOW_MS : 1_000,
);

// ── HTTP helper ───────────────────────────────────────────────────────────────

/**
 * Fetch a JSON resource from the data-service. Throws a typed `MarketDataError`
 * on any non-2xx response (or a network/timeout failure) so `withFailover` can
 * classify the failure by HTTP status and move to the next provider.
 *
 * Status → code mapping is delegated to `httpStatusToErrorCode`, giving each of
 * 401 / 403 / 404 / 408 / 429 / 503 / 5xx a distinct code. The `Retry-After`
 * header (429 / 503) is parsed and attached so the failover engine can honour it.
 */
async function dsGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  // Provider-specific rate budget — never let consumer bursts become scrape bursts.
  await rateLimiter.acquire();
  let res: Response;
  try {
    res = await fetch(`${getBaseUrl()}${path}`, { signal });
  } catch (err) {
    // fetch() rejects on network failure / abort — classify accordingly so the
    // caller doesn't mistake it for a malformed provider response.
    const msg = err instanceof Error ? err.message : String(err);
    const isAbort = err instanceof Error && err.name === "AbortError";
    throw new MarketDataError(
      `data-service ${path}: ${isAbort ? "timeout/abort" : "network error"} (${msg})`,
      PROVIDER_ID,
      isAbort ? "TIMEOUT" : "NETWORK",
    );
  }

  if (!res.ok) {
    const code = httpStatusToErrorCode(res.status);
    const retryAfterMs =
      res.status === 429 || res.status === 503
        ? parseRetryAfterMs(res.headers.get("retry-after")) ?? undefined
        : undefined;
    throw new MarketDataError(
      `data-service ${path}: HTTP ${res.status}`,
      PROVIDER_ID,
      code,
      res.status,
      retryAfterMs,
    );
  }

  try {
    return (await res.json()) as T;
  } catch (err) {
    throw new MarketDataError(
      `data-service ${path}: malformed JSON (${err instanceof Error ? err.message : String(err)})`,
      PROVIDER_ID,
      "MALFORMED_RESPONSE",
      res.status,
    );
  }
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

    // Cache-first + request coalescing: identical concurrent requests share a
    // single in-flight promise (via memoCandles → TtlCache.memo), so 100
    // consumers asking for "RELIANCE 5m 09:15–10:00" produce ONE scrape call.
    return memoCandles(
      req.symbol,
      req.exchange,
      req.interval,
      req.from,
      req.to,
      PROVIDER_ID,
      async () => {
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
        // Phase 22 (finding M): do NOT trust gateway data blindly. Re-validate
        // OHLC invariants + strict-ascending timestamps locally before it enters
        // the canonical layer. Invalid/out-of-order candles are dropped and the
        // drop is reported (never silently repaired — Rule 11).
        const raw = data.candles ?? [];
        const report = filterValidCandlesWithReport(raw);
        if (report.droppedCount > 0) {
          mdLog("stale_data", {
            reason: "scrapling_candles_dropped_on_local_validation",
            providerId: PROVIDER_ID,
            symbol: req.symbol,
            exchange: req.exchange,
            interval: req.interval,
            inputCount: report.inputCount,
            droppedCount: report.droppedCount,
            firstDrop: report.dropped[0] ?? null,
          });
        }
        return report.candles;
      },
    );
  }

  // ── Latest quote ────────────────────────────────────────────────────────

  async getLatestQuote(
    symbol: string,
    opts?: ProviderCallOptions,
  ): Promise<MDQuote | null> {
    if (!isEnabled()) return null;
    // Coalesce per-symbol; the loader delegates to the batch endpoint for one.
    return memoQuote(symbol, PROVIDER_ID, async () => {
      const results = await this._fetchQuotes([symbol], opts);
      return results[0] ?? null;
    });
  }

  // ── Batch quotes ────────────────────────────────────────────────────────

  async getQuotes(
    symbols: string[],
    opts?: ProviderCallOptions,
  ): Promise<Array<MDQuote | null>> {
    if (!isEnabled()) return Array<MDQuote | null>(symbols.length).fill(null);
    // Coalesce identical concurrent batch polls into a single scrape request.
    return memoQuoteBatch(symbols, PROVIDER_ID, () => this._fetchQuotes(symbols, opts));
  }

  /** Raw batch fetch against the data-service (uncached; used by the memo layer). */
  private async _fetchQuotes(
    symbols: string[],
    opts?: ProviderCallOptions,
  ): Promise<Array<MDQuote | null>> {
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

    return memoOptionChain(underlying, expiry ?? "nearest", PROVIDER_ID, async () => {
      const params = new URLSearchParams({ underlying });
      if (expiry) params.set("expiry", expiry);
      return dsGet<OptionChain>(`/scraping/option-chain?${params}`, opts?.signal);
    });
  }

  // ── Instrument master ───────────────────────────────────────────────────

  async getInstrumentMaster(
    filter?: InstrumentMasterFilter,
    opts?: ProviderCallOptions,
  ): Promise<Instrument[]> {
    if (!isEnabled()) return [];

    const filterKey = `${filter?.exchange ?? "all"}:${filter?.instrumentType ?? "all"}`;
    return memoInstrumentMaster(PROVIDER_ID, filterKey, async () => {
      const params = new URLSearchParams();
      if (filter?.exchange) params.set("exchange", filter.exchange);
      if (filter?.instrumentType) params.set("type", filter.instrumentType);

      const query = params.toString() ? `?${params}` : "";
      const data = await dsGet<InstrumentsResponse>(
        `/scraping/instruments${query}`,
        opts?.signal,
      );
      return data.instruments;
    });
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
            // RCA-D03: this is a REST-polled quote, not a real-time exchange
            // tick. It has no exchange-side timestamp, so mark it synthetic and
            // use the data-service fetch time (quote.fetchedAt) rather than the
            // local poll instant as the best-available data timestamp. Freshness
            // checks MUST NOT treat this as an exchange-fresh tick (Rule 7).
            const dataTsMs = quote.fetchedAt ? Date.parse(quote.fetchedAt) : now;
            onTick({
              token:               quote.token ?? quote.symbol,
              symbol:              quote.symbol,
              exchange:            quote.exchange ?? req.tokens[0]?.exchange ?? "NSE",
              ltp:                 quote.ltp,
              change:              quote.change,
              changePct:           quote.changePct,
              volume:              quote.volume,
              oi:                  quote.oi,
              exchangeTimestampMs: Number.isFinite(dataTsMs) ? dataTsMs : now,
              receivedAtMs:        now,
              provider:            PROVIDER_ID,
              synthetic:           true,
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
