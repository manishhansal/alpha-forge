/**
 * Provider registry — central catalogue of all market data providers.
 *
 * Responsibilities:
 *   - Maintain the ordered list of providers (Angel One first, Yahoo last).
 *   - Let callers request a provider by capability (e.g. "needs option chain").
 *   - Expose enable/disable controls for runtime provider management.
 *   - Route operations through the failover engine.
 *   - Request coalescing: concurrent calls for the same cache key share one
 *     upstream provider call (Requirements 14.4, 14.7).
 *   - 10-second timeout: in-flight coalesced calls that exceed 10 s cancel and
 *     reject all waiters with MarketDataError({ code: "PROVIDER_TIMEOUT" })
 *     (Requirement 14.7).
 */

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
} from "./types";
import type {
  ProviderCallOptions,
  RegisteredProvider,
} from "./provider";
import { withFailover, getLastCallProvenance } from "./failover";
import { getAllProviderHealth } from "./health";
import { persistProvenance } from "./provenance";
import { MarketDataError } from "./types";

// ── Coalescing constants ──────────────────────────────────────────────────────

/**
 * Maximum time (ms) an in-flight coalesced upstream call may run before all
 * waiters are rejected with `MarketDataError({ code: "PROVIDER_TIMEOUT" })`.
 * Requirement 14.7.
 */
const COALESCE_TIMEOUT_MS = 10_000;

// ── Coalescing helpers ────────────────────────────────────────────────────────

/**
 * Wrap an async `operation` with a hard timeout.
 *
 * If `operation` does not settle within `timeoutMs`, the returned promise
 * rejects with a `MarketDataError({ code: "PROVIDER_TIMEOUT", retryAfterMs: null })`.
 * The underlying operation is NOT aborted (JS has no generic cancellation for
 * arbitrary Promises), but the registry no longer awaits it and cleans up the
 * pending-calls entry so subsequent requests start fresh.
 */
function withCoalesceTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new MarketDataError(
          `Provider call timed out after ${timeoutMs}ms (coalescing timeout)`,
          null,
          "PROVIDER_TIMEOUT",
          undefined,
          undefined, // retryAfterMs: null per spec
        ),
      );
    }, timeoutMs);
  });
  return Promise.race([operation, timeoutPromise]).finally(() =>
    clearTimeout(timer),
  );
}

/**
 * Generate a deterministic cache key for request coalescing at the registry
 * level. The key is used ONLY to deduplicate concurrent in-flight calls —
 * it is distinct from the L1/L2 cache key namespace.
 */
function coalescingKey(operation: string, ...parts: string[]): string {
  return `coalesce:${operation}:${parts.join(":")}`;
}

// ── Registry singleton ────────────────────────────────────────────────────────

export class ProviderRegistry {
  private readonly entries: RegisteredProvider[] = [];

  /**
   * In-flight coalesced calls, keyed by a deterministic string.
   *
   * When a second (third, … Nth) request for the same key arrives while the
   * first upstream call has not yet settled, it awaits the same Promise rather
   * than starting a new provider call.  After the Promise settles (resolve OR
   * reject), the key is removed so the next request starts a fresh call.
   *
   * Requirement 14.4, 14.7.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly pendingCalls = new Map<string, Promise<any>>();

  /**
   * Execute `operation` with registry-level request coalescing and a 10s
   * hard timeout.  All concurrent callers with the same `key` share one
   * upstream call and receive the same result (or same error).
   *
   * Requirement 14.4: "the upstream provider SHALL be called exactly once"
   * Requirement 14.7: "if the upstream call does not complete within 10 seconds,
   *                    cancel it and return MarketDataError({ code: PROVIDER_TIMEOUT })"
   */
  private coalesced<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const existing = this.pendingCalls.get(key) as Promise<T> | undefined;
    if (existing) return existing;

    const upstream = withCoalesceTimeout(operation(), COALESCE_TIMEOUT_MS);
    // Wrap to guarantee cleanup regardless of outcome.
    const managed: Promise<T> = upstream.finally(() => {
      this.pendingCalls.delete(key);
    });
    this.pendingCalls.set(key, managed);
    return managed;
  }

  // ── Registry management ────────────────────────────────────────────────────

  /**
   * Register a provider. Providers are sorted by `priority` (ascending) so
   * the highest-priority provider is always tried first.
   */
  register(entry: RegisteredProvider): void {
    // Remove any existing entry for the same provider id.
    const idx = this.entries.findIndex((e) => e.provider.id === entry.provider.id);
    if (idx >= 0) this.entries.splice(idx, 1);
    this.entries.push(entry);
    this.entries.sort((a, b) => a.priority - b.priority);
  }

  /** Return the registered entry for a provider id, or undefined. */
  get(id: ProviderId): RegisteredProvider | undefined {
    return this.entries.find((e) => e.provider.id === id);
  }

  /** All registered entries in priority order. */
  all(): readonly RegisteredProvider[] {
    return this.entries;
  }

  /** All enabled entries in priority order. */
  enabled(): RegisteredProvider[] {
    return this.entries.filter((e) => e.enabled);
  }

  /** Entries with a specific capability, enabled and ordered by priority. */
  withCapability(
    cap: keyof RegisteredProvider["capabilities"],
  ): RegisteredProvider[] {
    return this.entries.filter((e) => e.enabled && e.capabilities[cap]);
  }

  enable(id: ProviderId): void {
    const entry = this.get(id);
    if (entry) entry.enabled = true;
  }

  disable(id: ProviderId): void {
    const entry = this.get(id);
    if (entry) entry.enabled = false;
  }

  // ── Routed operations ──────────────────────────────────────────────────────

  async getHistoricalCandles(
    req: HistoricalCandleRequest,
    opts?: ProviderCallOptions,
  ): Promise<OHLCVCandle[]> {
    const providers = this.withCapability("historicalCandles");
    // Coalescing key includes all request dimensions so distinct candle requests
    // are never collapsed together.  L2 key pattern (Req 14.2):
    // md:candles:{provider*}:{exchange}:{symbol}:{interval}:{from}:{to}
    // At the registry level we omit provider (it's selected at runtime) and use
    // the same dimensions.
    const key = coalescingKey(
      "getHistoricalCandles",
      req.symbol,
      req.exchange,
      req.interval,
      req.from,
      req.to,
    );
    const candles = await this.coalesced(key, () =>
      withFailover(
        providers,
        (p) => p.getHistoricalCandles(req, opts),
        "getHistoricalCandles",
        "historicalCandles",
      ),
    );

    // ── DataProvenanceRecord persistence (Requirements 16.2, 21.5) ─────────
    // Fire-and-forget: write a DataProvenanceRecord for every successful
    // historical candle fetch.
    const lastProv = getLastCallProvenance("getHistoricalCandles");
    if (lastProv) {
      const isAuthenticated =
        lastProv.authenticated ??
        (lastProv.provider === "angel_one" || lastProv.provider === "upstox");
      void persistProvenance(lastProv.provider, req, "", isAuthenticated);
    }
    // ── End DataProvenanceRecord persistence ─────────────────────────────────

    return candles;
  }

  async getLatestQuote(
    symbol: string,
    opts?: ProviderCallOptions,
  ): Promise<MDQuote | null> {
    const providers = this.withCapability("liveQuotes");
    // Coalescing key for single quote: symbol only.
    // L2 key pattern (Req 14.2): md:quote:{provider}:{SYMBOL} — provider resolved
    // at runtime so we key on symbol at the coalescing layer.
    const key = coalescingKey("getLatestQuote", symbol.toUpperCase());
    return this.coalesced(key, () =>
      withFailover(
        providers,
        (p) => p.getLatestQuote(symbol, opts),
        "getLatestQuote",
        "liveQuotes",
      ),
    );
  }

  async getQuotes(
    symbols: string[],
    opts?: ProviderCallOptions,
  ): Promise<Array<MDQuote | null>> {
    const providers = this.withCapability("liveQuotes");
    // Coalescing key: ordered, upper-cased symbol list — same ordering as
    // market-cache.ts memoQuoteBatch so concurrent requests for the same set
    // collapse to one upstream call.
    const key = coalescingKey(
      "getQuotes",
      symbols.map((s) => s.toUpperCase()).join(","),
    );
    return this.coalesced(key, () =>
      withFailover(
        providers,
        (p) => p.getQuotes(symbols, opts),
        "getQuotes",
        "liveQuotes",
      ),
    );
  }

  async getOptionChain(
    underlying: string,
    expiry?: string,
    opts?: ProviderCallOptions,
  ): Promise<OptionChain> {
    const providers = this.withCapability("optionChain");
    const key = coalescingKey(
      "getOptionChain",
      underlying.toUpperCase(),
      expiry ?? "nearest",
    );
    return this.coalesced(key, () =>
      withFailover(
        providers,
        (p) => p.getOptionChain(underlying, expiry, opts),
        "getOptionChain",
        "optionChain",
      ),
    );
  }

  async getInstrumentMaster(
    filter?: InstrumentMasterFilter,
    opts?: ProviderCallOptions,
  ): Promise<Instrument[]> {
    const providers = this.withCapability("instrumentMaster");
    // Instrument master is large and rarely changes — coalesce on a stable key
    // derived from the filter dimensions.
    const filterKey = filter
      ? `${filter.exchange ?? "all"}:${filter.instrumentType ?? "all"}:${filter.underlying ?? "all"}`
      : "all";
    const key = coalescingKey("getInstrumentMaster", filterKey);
    return this.coalesced(key, () =>
      withFailover(
        providers,
        (p) => p.getInstrumentMaster(filter, opts),
        "getInstrumentMaster",
        "instrumentMaster",
      ),
    );
  }

  subscribe(
    req: SubscribeRequest,
    onTick: (tick: LiveTick) => void,
    onError?: (err: unknown) => void,
  ): () => void {
    // Subscribe on the highest-priority provider that supports WebSocket.
    const wsProviders = this.withCapability("webSocket");
    if (wsProviders.length === 0) {
      // Fall back to the first enabled provider's polling-based subscribe.
      const fallback = this.enabled()[0];
      if (!fallback) return () => {};
      return fallback.provider.subscribe(req, onTick, onError);
    }
    return wsProviders[0]!.provider.subscribe(req, onTick, onError);
  }

  unsubscribe(tokens: string[]): void {
    for (const entry of this.enabled()) {
      entry.provider.unsubscribe(tokens);
    }
  }

  /** Health snapshots for all registered providers. */
  getHealth(): ProviderHealth[] {
    return getAllProviderHealth();
  }

  /** Health snapshot for a single provider. */
  getProviderHealth(id: ProviderId): ProviderHealth | undefined {
    const entry = this.get(id);
    return entry?.provider.getProviderHealth();
  }

  /**
   * Expose the number of currently pending coalesced calls (test/observability
   * helper).
   */
  get pendingCallCount(): number {
    return this.pendingCalls.size;
  }

  /**
   * Clear all pending coalesced calls (test helper — do NOT call in production).
   * Existing waiters will still resolve/reject when the in-flight Promise settles.
   */
  clearPendingCalls(): void {
    this.pendingCalls.clear();
  }
}

// ── Global registry singleton ─────────────────────────────────────────────────

declare global {
  var __marketDataRegistry: ProviderRegistry | undefined; // eslint-disable-line no-var
}

export const registry: ProviderRegistry =
  globalThis.__marketDataRegistry ?? new ProviderRegistry();

if (!globalThis.__marketDataRegistry) {
  globalThis.__marketDataRegistry = registry;
}

// ── Bootstrap: register default providers ────────────────────────────────────

/**
 * Lazily bootstrap the registry with the canonical three providers.
 * Provider priority:  Data Service (0) → Angel One (1) → Upstox (2) → Yahoo (3)
 *
 * NSE is NOT registered. Direct NSE data acquisition is prohibited in production.
 * Safe to call multiple times — idempotent via the register() dedup.
 */
export async function bootstrapRegistry(): Promise<void> {
  const { ScraplingProvider } = await import("./providers/scrapling");

  registry.register({
    provider: new ScraplingProvider(),
    capabilities: {
      historicalCandles: true,
      liveQuotes: true,
      webSocket: false,
      optionChain: true,
      instrumentMaster: true,
      intradayCandles: true,
      fno: true,
    },
    priority: 0,
    enabled: !!process.env.DATA_SERVICE_URL,
  });

  const [
    { AngelOneProvider },
    { UpstoxProvider },
    { YahooProvider },
  ] = await Promise.all([
    import("./providers/angel-one"),
    import("./providers/upstox"),
    import("./providers/yahoo"),
  ]);

  registry.register({
    provider: new AngelOneProvider(),
    capabilities: {
      historicalCandles: true,
      liveQuotes: true,
      webSocket: true,
      optionChain: true,
      instrumentMaster: true,
      intradayCandles: true,
      fno: true,
    },
    priority: 1,
    enabled: true,
  });

  registry.register({
    provider: new UpstoxProvider(),
    capabilities: {
      historicalCandles: true,
      liveQuotes: true,
      webSocket: true,
      optionChain: true,
      instrumentMaster: false,
      intradayCandles: true,
      fno: true,
    },
    priority: 2,
    enabled: true,
  });

  registry.register({
    provider: new YahooProvider(),
    capabilities: {
      historicalCandles: true,
      liveQuotes: true,
      webSocket: false,
      optionChain: false,
      instrumentMaster: false,
      intradayCandles: true,
      fno: false,
    },
    priority: 3,
    enabled: true,
  });
}
