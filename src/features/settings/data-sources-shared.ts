/**
 * Client-safe catalog of supported data sources, plus the canonical shape of
 * the per-user selections stored in `UserSetting.dataSourcesJson`.
 *
 * Everything here is plain data — no Prisma, no `server-only`, no secrets —
 * so it can be imported from both the settings form (browser) and the server
 * actions/route handlers that consume the selections.
 */

export type Market = "india" | "crypto";

/** Stable identifiers for every broker the dashboard can pull data from. */
export type DataSourceId =
  // India
  | "yahoo"
  | "nse"
  | "groww"
  | "zerodha"
  | "bse"
  | "angel"
  // Crypto
  | "binance"
  | "delta";

/** What kind of market data a broker can serve. UI uses this to badge each
 *  source and to surface what falls back when one is unchecked. */
export type Capability = "quotes" | "history" | "optionChain" | "oi" | "feed";

export interface DataSourceMeta {
  id: DataSourceId;
  market: Market;
  label: string;
  /** One-liner shown under the label in the settings card. */
  blurb: string;
  /** Capabilities this source can fulfil. Pure metadata — used only by the
   *  UI today; the per-route resolver still has its own fallback chain. */
  capabilities: readonly Capability[];
  /** Whether this source requires an API key/secret stored in the
   *  "Exchange API keys" card. */
  requiresApiKey: boolean;
  /** False if the adapter is not yet implemented in this codebase — the
   *  picker still shows it but disables it and tags "Coming soon". */
  implemented: boolean;
  /** Marketing/home URL — used for an external link icon. */
  homeUrl: string;
}

export const DATA_SOURCES: readonly DataSourceMeta[] = [
  // ── India ────────────────────────────────────────────────────────────────
  {
    id: "yahoo",
    market: "india",
    label: "Yahoo Finance",
    blurb: "Public quotes, OHLCV history. No credentials required.",
    capabilities: ["quotes", "history"],
    requiresApiKey: false,
    implemented: true,
    homeUrl: "https://finance.yahoo.com",
  },
  {
    id: "nse",
    market: "india",
    label: "NSE direct",
    blurb: "Cookie-warmed option chain, OI, PCR — direct from NSE.",
    capabilities: ["optionChain", "oi", "quotes"],
    requiresApiKey: false,
    implemented: true,
    homeUrl: "https://www.nseindia.com",
  },
  {
    id: "groww",
    market: "india",
    label: "Groww",
    blurb: "Trade API — quotes, history, option chain, OI when authenticated.",
    capabilities: ["quotes", "history", "optionChain", "oi", "feed"],
    requiresApiKey: true,
    implemented: true,
    homeUrl: "https://groww.in",
  },
  {
    id: "zerodha",
    market: "india",
    label: "Zerodha Kite",
    blurb: "Kite Connect — quotes, history, option chain, OI.",
    capabilities: ["quotes", "history", "optionChain", "oi", "feed"],
    requiresApiKey: true,
    implemented: false,
    homeUrl: "https://kite.trade",
  },
  {
    id: "bse",
    market: "india",
    label: "BSE",
    blurb: "Bombay Stock Exchange — SENSEX + cash/derivatives reference data.",
    capabilities: ["quotes", "oi"],
    requiresApiKey: false,
    implemented: false,
    homeUrl: "https://www.bseindia.com",
  },
  {
    id: "angel",
    market: "india",
    label: "Angel One SmartAPI",
    blurb:
      "First-party broker REST — live quotes, intraday/daily candles, polled feed, and option chain (ScripMaster + Quote + Greeks IV). Requires SmartAPI credentials.",
    capabilities: ["quotes", "history", "optionChain", "oi", "feed"],
    requiresApiKey: true,
    implemented: true,
    homeUrl: "https://smartapi.angelone.in",
  },

  // ── Crypto ───────────────────────────────────────────────────────────────
  {
    id: "binance",
    market: "crypto",
    label: "Binance",
    blurb: "Spot + perp tickers, OI, funding, liquidations, long/short ratio.",
    capabilities: ["quotes", "history", "oi", "feed"],
    requiresApiKey: false,
    implemented: true,
    homeUrl: "https://www.binance.com",
  },
  {
    id: "delta",
    market: "crypto",
    label: "Delta Exchange India",
    blurb: "INR-settled BTC/ETH/SOL perpetuals, options, OI history.",
    capabilities: ["quotes", "history", "optionChain", "oi", "feed"],
    requiresApiKey: false,
    implemented: true,
    homeUrl: "https://www.delta.exchange",
  },
];

/** Convenience map for O(1) lookup in resolvers and the UI. */
export const DATA_SOURCES_BY_ID = DATA_SOURCES.reduce(
  (acc, s) => {
    acc[s.id] = s;
    return acc;
  },
  {} as Record<DataSourceId, DataSourceMeta>,
);

export function dataSourcesFor(market: Market): readonly DataSourceMeta[] {
  return DATA_SOURCES.filter((s) => s.market === market);
}

/**
 * Footer copy for the India sidebar card, derived from the active quote-source
 * chain (highest-priority first). Pure + client-safe so the sidebar and tests
 * share one source of truth for the wording.
 */
export function indiaSourceFooter(labels: readonly string[]): {
  title: string;
  sub: string;
} {
  if (labels.length === 0) {
    return {
      title: "Live data via Yahoo Finance",
      sub: "Public quotes — no broker keys required.",
    };
  }
  const [primary, ...rest] = labels;
  return {
    title: `Live data via ${primary}`,
    sub:
      rest.length > 0
        ? `Backfill stays within your selection: ${labels.join(" · ")}.`
        : `Only ${primary} is selected — no fallback to other sources.`,
  };
}

/** Map data-source ids to their display labels (unknown ids pass through). */
export function dataSourceLabels(ids: readonly DataSourceId[]): string[] {
  return ids.map((id) => DATA_SOURCES_BY_ID[id]?.label ?? id);
}

/**
 * OI for the Indian market intentionally bypasses Yahoo (no live OI). The
 * picker only offers the brokers that actually publish chain/OI data.
 */
export const INDIA_OI_SOURCES: readonly DataSourceId[] = [
  "angel",
  "nse",
  "groww",
  "bse",
];

/* ───────────────── Per-user selection shape ───────────────── */

export interface IndiaSelections {
  /** Brokers the user toggled on for India quotes/history. */
  selected: DataSourceId[];
  /** Which of the OI-capable sources to use for the option chain & OI
   *  routes. Defaults to "nse". */
  optionChain: DataSourceId;
}

export interface CryptoSelections {
  selected: DataSourceId[];
  /** The single broker that owns the live WS ticker stream. Most surfaces
   *  can multi-source quotes, but only one WS pipe at a time keeps the
   *  socket budget sane. */
  primary: DataSourceId;
}

export interface DataSourceSelections {
  india: IndiaSelections;
  crypto: CryptoSelections;
}

export const DEFAULT_SELECTIONS: DataSourceSelections = {
  india: { selected: ["yahoo", "nse"], optionChain: "nse" },
  crypto: { selected: ["binance", "delta"], primary: "delta" },
};

/**
 * Validate & sanitize a stored JSON blob from the DB (or a form submission)
 * into a guaranteed-well-formed `DataSourceSelections`. Falls back to the
 * default whenever a field is missing/invalid so the app never crashes on
 * an unfamiliar shape (e.g. produced by a future or older version).
 */
export function normalizeSelections(raw: unknown): DataSourceSelections {
  const out: DataSourceSelections = {
    india: { ...DEFAULT_SELECTIONS.india, selected: [...DEFAULT_SELECTIONS.india.selected] },
    crypto: { ...DEFAULT_SELECTIONS.crypto, selected: [...DEFAULT_SELECTIONS.crypto.selected] },
  };
  if (!raw || typeof raw !== "object") return out;
  const r = raw as { india?: unknown; crypto?: unknown };

  if (r.india && typeof r.india === "object") {
    const i = r.india as { selected?: unknown; optionChain?: unknown };
    const selected = filterIds(i.selected, "india");
    if (selected.length > 0) out.india.selected = selected;
    if (typeof i.optionChain === "string" && isOiSource(i.optionChain)) {
      out.india.optionChain = i.optionChain as DataSourceId;
    }
  }
  if (r.crypto && typeof r.crypto === "object") {
    const c = r.crypto as { selected?: unknown; primary?: unknown };
    const selected = filterIds(c.selected, "crypto");
    if (selected.length > 0) out.crypto.selected = selected;
    if (typeof c.primary === "string" && isCryptoSource(c.primary)) {
      out.crypto.primary = c.primary as DataSourceId;
    } else if (!out.crypto.selected.includes(out.crypto.primary)) {
      out.crypto.primary = out.crypto.selected[0];
    }
  }
  return out;
}

function filterIds(raw: unknown, market: Market): DataSourceId[] {
  if (!Array.isArray(raw)) return [];
  const allowed = new Set(dataSourcesFor(market).map((s) => s.id));
  const out: DataSourceId[] = [];
  for (const v of raw) {
    if (typeof v === "string" && allowed.has(v as DataSourceId)) {
      const id = v as DataSourceId;
      if (!out.includes(id)) out.push(id);
    }
  }
  return out;
}

function isOiSource(id: string): boolean {
  return (INDIA_OI_SOURCES as readonly string[]).includes(id);
}

function isCryptoSource(id: string): boolean {
  return dataSourcesFor("crypto").some((s) => s.id === id);
}
