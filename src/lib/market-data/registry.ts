/**
 * Provider registry — central catalogue of all market data providers.
 *
 * Responsibilities:
 *   - Maintain the ordered list of providers (Angel One first, Yahoo last).
 *   - Let callers request a provider by capability (e.g. "needs option chain").
 *   - Expose enable/disable controls for runtime provider management.
 *   - Route operations through the failover engine.
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
  MarketDataProvider,
  ProviderCallOptions,
  RegisteredProvider,
} from "./provider";
import { withFailover } from "./failover";
import { getAllProviderHealth } from "./health";

// ── Registry singleton ────────────────────────────────────────────────────────

export class ProviderRegistry {
  private readonly entries: RegisteredProvider[] = [];

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
    return withFailover(
      providers,
      (p) => p.getHistoricalCandles(req, opts),
      "getHistoricalCandles",
    );
  }

  async getLatestQuote(
    symbol: string,
    opts?: ProviderCallOptions,
  ): Promise<MDQuote | null> {
    const providers = this.withCapability("liveQuotes");
    return withFailover(
      providers,
      (p) => p.getLatestQuote(symbol, opts),
      "getLatestQuote",
    );
  }

  async getQuotes(
    symbols: string[],
    opts?: ProviderCallOptions,
  ): Promise<Array<MDQuote | null>> {
    const providers = this.withCapability("liveQuotes");
    return withFailover(
      providers,
      (p) => p.getQuotes(symbols, opts),
      "getQuotes",
    );
  }

  async getOptionChain(
    underlying: string,
    expiry?: string,
    opts?: ProviderCallOptions,
  ): Promise<OptionChain> {
    const providers = this.withCapability("optionChain");
    return withFailover(
      providers,
      (p) => p.getOptionChain(underlying, expiry, opts),
      "getOptionChain",
    );
  }

  async getInstrumentMaster(
    filter?: InstrumentMasterFilter,
    opts?: ProviderCallOptions,
  ): Promise<Instrument[]> {
    const providers = this.withCapability("instrumentMaster");
    return withFailover(
      providers,
      (p) => p.getInstrumentMaster(filter, opts),
      "getInstrumentMaster",
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
}

// ── Global registry singleton ─────────────────────────────────────────────────

declare global {
  // eslint-disable-next-line no-var
  var __marketDataRegistry: ProviderRegistry | undefined;
}

export const registry: ProviderRegistry =
  globalThis.__marketDataRegistry ?? new ProviderRegistry();

if (!globalThis.__marketDataRegistry) {
  globalThis.__marketDataRegistry = registry;
}

// ── Bootstrap: register default providers ────────────────────────────────────

/**
 * Lazily bootstrap the registry with the four default providers.
 * Safe to call multiple times — idempotent via the register() dedup.
 */
export async function bootstrapRegistry(): Promise<void> {
  const [
    { AngelOneProvider },
    { UpstoxProvider },
    { NseProvider },
    { YahooProvider },
  ] = await Promise.all([
    import("./providers/angel-one"),
    import("./providers/upstox"),
    import("./providers/nse"),
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
    provider: new NseProvider(),
    capabilities: {
      historicalCandles: false,
      liveQuotes: true,
      webSocket: false,
      optionChain: true,
      instrumentMaster: false,
      intradayCandles: false,
      fno: true,
    },
    priority: 3,
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
    priority: 4,
    enabled: true,
  });
}
