/**
 * NSE DIRECT SCRAPER — REMOVED 2026-09-03
 *
 * This module previously contained direct scraping code against:
 *   - www.nseindia.com (option chain, quotes)
 *   - stock-nse-india npm package (cookie-warmed requests)
 *
 * ALL direct NSE data acquisition has been removed from production code.
 *
 * Provider chain is: DATA_SERVICE → ANGEL_ONE → UPSTOX → YAHOO
 *
 * Any code that previously imported from this module must be updated to use:
 *   - Option chain: registry.getOptionChain() → Angel One or Upstox provider
 *   - Quotes: registry.getLatestQuote() / registry.getQuotes()
 *   - Historical: registry.getHistoricalCandles()
 *
 * NSE exchange identifiers (Exchange = "NSE", "NFO") remain valid in types.ts.
 *
 * @deprecated Removed 2026-09-03
 */

export const NSE_ADAPTER_REMOVED =
  "NSE direct adapter removed 2026-09-03. Route through ProviderRegistry.";

/**
 * Legacy stub to prevent import errors in any code that wasn't yet migrated.
 * All methods throw — this forces callers to migrate to the provider registry.
 */
class NseAdapterStub {
  readonly id = "nse" as const;

  getQuote(_symbol: string): never {
    throw new Error(
      "NseAdapter.getQuote: Direct NSE data acquisition removed. Use registry.getLatestQuote() instead.",
    );
  }

  getQuotes(_symbols: string[]): never {
    throw new Error(
      "NseAdapter.getQuotes: Direct NSE data acquisition removed. Use registry.getQuotes() instead.",
    );
  }

  getHistorical(_req: unknown): never {
    throw new Error(
      "NseAdapter.getHistorical: Direct NSE data acquisition removed. Use registry.getHistoricalCandles() instead.",
    );
  }

  getOptionChain(_symbol: string, _expiry?: string): never {
    throw new Error(
      "NseAdapter.getOptionChain: Direct NSE data acquisition removed. Use registry.getOptionChain() instead.",
    );
  }
}

export const nse = new NseAdapterStub();
