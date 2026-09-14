/**
 * src/features/settings/data-sources-shared.ts
 *
 * Client-safe catalog of data sources for the AlphaForge dashboard.
 *
 * After the data-service2.0 centralization refactor, all market data flows
 * exclusively through data-service2.0. Provider-specific data source selection
 * (Angel One, Upstox, Yahoo, NSE, Scrapling, Binance, Delta) has been removed.
 *
 * AlphaForge has exactly one market-data source: data-service2.0.
 * The DataSourceId type is retained for backward compatibility.
 */

export type Market = "india" | "crypto";

/**
 * Stable identifier for the single canonical data source.
 * Legacy provider IDs retained for type compatibility — they are no longer
 * selectable and resolve to data-service2.0.
 *
 * @deprecated All data comes from data-service2.0. Use "data-service2" only.
 */
export type DataSourceId =
  | "data-service2"
  // Legacy IDs retained for type compatibility
  | "yahoo"
  | "groww"
  | "zerodha"
  | "bse"
  | "angel"
  | "upstox"
  | "openalgo"
  | "binance"
  | "delta";

export type Capability = "quotes" | "history" | "optionChain" | "oi" | "feed";

export interface DataSourceMeta {
  id: DataSourceId;
  market: Market;
  label: string;
  blurb: string;
  capabilities: readonly Capability[];
  requiresApiKey: boolean;
  available: boolean;
  homeUrl: string;
}

/** The single canonical data source. */
export const DATA_SOURCES: readonly DataSourceMeta[] = [
  {
    id: "data-service2",
    market: "india",
    label: "data-service2.0",
    blurb: "The single canonical market-data platform. All Indian and crypto market data is served from here.",
    capabilities: ["quotes", "history", "optionChain", "oi", "feed"],
    requiresApiKey: false,
    available: true,
    homeUrl: "https://github.com/manishhansal/data-service2.0",
  },
];

/** Default selections — data-service2.0 is always selected. */
export interface DataSelections {
  india: {
    selected: readonly DataSourceId[];
    optionChain: DataSourceId;
    history: DataSourceId;
  };
  crypto: {
    selected: readonly DataSourceId[];
  };
}

export const DEFAULT_SELECTIONS: DataSelections = {
  india: {
    selected: ["data-service2"],
    optionChain: "data-service2",
    history: "data-service2",
  },
  crypto: {
    selected: ["data-service2"],
  },
};

/**
 * Returns the canonical active selections — always data-service2.0.
 * Provider selection is no longer configurable.
 */
export function getDefaultSelections(): DataSelections {
  return DEFAULT_SELECTIONS;
}

// ---------------------------------------------------------------------------
// Backward-compat exports for consumers that haven't been fully migrated
// ---------------------------------------------------------------------------

/**
 * Returns display labels for a list of source IDs.
 * After centralization, always returns "data-service2.0".
 * @deprecated All data comes from data-service2.0.
 */
export function dataSourceLabels(_ids: readonly DataSourceId[]): string[] {
  return ["data-service2.0"];
}

/**
 * Returns a footer string for the India data source indicator.
 * @deprecated All data comes from data-service2.0.
 */
export function indiaSourceFooter(_labels: string[]): string {
  return "data-service2.0";
}

/**
 * @deprecated Use getExecutionBroker() for order execution.
 * Market data comes from data-service2.0.
 */
export type DataSourceSelections = DataSelections;

// ---------------------------------------------------------------------------
// Missing exports required by data-sources-actions.ts and data-sources.ts
// ---------------------------------------------------------------------------

export const DATA_SOURCES_BY_ID = Object.fromEntries(
  DATA_SOURCES.map((d) => [d.id, d]),
) as Record<DataSourceId, DataSourceMeta>;

export const INDIA_OI_SOURCES: readonly DataSourceId[] = ["data-service2"];

export function dataSourcesFor(_market: Market): readonly DataSourceMeta[] {
  return DATA_SOURCES;
}

export function normalizeSelections(
  input: Partial<{
    india: Partial<DataSelections["india"]> & { selected?: readonly DataSourceId[] | DataSourceId[] };
    crypto: Partial<DataSelections["crypto"]> & { selected?: readonly DataSourceId[] | DataSourceId[] };
  }> | null | undefined,
): DataSelections {
  if (!input) return DEFAULT_SELECTIONS;
  return {
    india: {
      selected:
        Array.isArray(input.india?.selected) && input.india.selected.length > 0
          ? (input.india.selected as DataSourceId[])
          : DEFAULT_SELECTIONS.india.selected,
      optionChain: input.india?.optionChain ?? DEFAULT_SELECTIONS.india.optionChain,
      history: input.india?.history ?? DEFAULT_SELECTIONS.india.history,
    },
    crypto: {
      selected:
        Array.isArray(input.crypto?.selected) && input.crypto.selected.length > 0
          ? (input.crypto.selected as DataSourceId[])
          : DEFAULT_SELECTIONS.crypto.selected,
    },
  };
}

// Aliases for legacy consumers that import CryptoSelections / IndiaSelections
export type IndiaSelections = DataSelections["india"];
export type CryptoSelections = DataSelections["crypto"];
