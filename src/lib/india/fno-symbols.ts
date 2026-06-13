// Consolidated F&O universe (single source of truth, derived from
// lib/india/sectors.ts) plus a reverse symbol → sector lookup.

import { SECTOR_STOCKS } from "@/lib/india/sectors";

// `symbol` is the Yahoo Finance ticker (used for live quotes / charts).
// `underlying` is the NSE F&O underlying name (used for option-chain calls
// against NSE — that endpoint is the source of truth for chains).
export const FNO_INDICES: { name: string; symbol: string; underlying: string }[] = [
  { name: "NIFTY 50", symbol: "^NSEI", underlying: "NIFTY" },
  { name: "BANK NIFTY", symbol: "^NSEBANK", underlying: "BANKNIFTY" },
  // Yahoo doesn't expose a clean FIN NIFTY ticker; ^CNXFIN (Nifty Financial
  // Services) is the closest public proxy and tracks 1:1 in practice.
  { name: "FIN NIFTY", symbol: "^CNXFIN", underlying: "FINNIFTY" },
  // Yahoo proxy for Nifty Midcap Select (MIDCPNIFTY F&O underlying).
  { name: "MIDCAP NIFTY", symbol: "^NSEMDCP50", underlying: "MIDCPNIFTY" },
];

export const SUPPLEMENTARY_INDICES: { name: string; symbol: string }[] = [
  { name: "SENSEX", symbol: "^BSESN" },
  { name: "INDIA VIX", symbol: "^INDIAVIX" },
];

/** All F&O index symbols rendered as a quick lookup set. */
export const FNO_INDEX_UNDERLYINGS = new Set(
  FNO_INDICES.map((i) => i.underlying),
);

/** Flat unique list of F&O stock tickers (no .NS suffix). */
export const FNO_STOCKS: string[] = Array.from(
  new Set(Object.values(SECTOR_STOCKS).flat()),
).sort();

/** Reverse lookup: symbol → list of sector(s) that contain it. */
export const SYMBOL_SECTORS: Record<string, string[]> = (() => {
  const out: Record<string, string[]> = {};
  for (const [sector, list] of Object.entries(SECTOR_STOCKS)) {
    for (const sym of list) {
      (out[sym] ??= []).push(sector);
    }
  }
  return out;
})();

export function primarySector(symbol: string): string | null {
  return SYMBOL_SECTORS[symbol]?.[0] ?? null;
}

/** F&O underlyings for which an option chain is available
 *  (4 indices + every F&O stock — NSE serves both via different endpoints). */
export const FNO_OPTION_UNDERLYINGS: string[] = [
  ...FNO_INDICES.map((i) => i.underlying),
  ...FNO_STOCKS,
];
