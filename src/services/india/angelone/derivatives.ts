/**
 * SmartAPI first-party derivatives parsers.
 *
 * Angel One exposes three derivative-segment market-data endpoints that give
 * exchange-grade signals the app currently derives by hand (or skips):
 *
 *   - gainersLosers  → top OI / price gainers & losers in the F&O segment
 *   - putCallRatio   → first-party PCR per F&O underlying
 *   - OIBuildup      → Long / Short Built Up · Short Covering · Long Unwinding
 *
 * These pure parsers normalise each response into underlying-keyed records so
 * the scanner / AI engines can consume them without re-implementing the
 * fragile ΔOI math that depends on the (unavailable) per-strike change-in-OI.
 *
 * The network wrappers that call these live on the AngelOneAdapter so they can
 * reuse the existing auth + rate-limit plumbing; everything here is I/O-free
 * and unit-tested.
 */

import type { OptionGreeks } from "@/types/india/options";
import type { OiBuildupKind } from "@/types/india/scanner";

export type GainersLosersDataType =
  | "PercOIGainers"
  | "PercOILosers"
  | "PercPriceGainers"
  | "PercPriceLosers";

export type OiBuildupDataType =
  | "Long Built Up"
  | "Short Built Up"
  | "Short Covering"
  | "Long Unwinding";

export type DerivExpiryType = "NEAR" | "NEXT" | "FAR";

/** Loosely-typed row as it arrives from the SmartAPI marketData endpoints. */
interface RawDerivRow {
  tradingSymbol?: unknown;
  symbolToken?: unknown;
  ltp?: unknown;
  netChange?: unknown;
  percentChange?: unknown;
  opnInterest?: unknown;
  pcr?: unknown;
}

export interface DerivGainerLoser {
  /** Underlying name, e.g. "NIFTY" / "RELIANCE". */
  symbol: string;
  /** Raw FUT trading symbol the row was reported against. */
  tradingSymbol: string;
  token: string | null;
  ltp: number | null;
  netChange: number | null;
  percentChange: number | null;
  oi: number | null;
}

export interface DerivPcr {
  symbol: string;
  pcr: number;
}

export interface DerivOiBuildup {
  symbol: string;
  tradingSymbol: string;
  token: string | null;
  ltp: number | null;
  percentChange: number | null;
  oi: number | null;
  kind: OiBuildupKind;
}

const num = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v : null;

/**
 * Derive the F&O underlying name from a derivative trading symbol.
 *
 * SmartAPI reports the derivatives lists against the FUT symbol of the expiry
 * (e.g. `NIFTY29MAY25FUT`, `RELIANCE24APR25FUT`, `M&M28AUG25FUT`). We strip the
 * `DDMMM[YY|YYYY]FUT` tail to recover the underlying ("NIFTY", "RELIANCE",
 * "M&M"). When the symbol doesn't carry an expiry pattern we drop a bare `FUT`
 * suffix and return whatever remains.
 */
export function underlyingFromFutSymbol(sym: string): string {
  if (!sym) return "";
  const upper = sym.toUpperCase();
  const m = /^([A-Z0-9&-]+?)\d{1,2}[A-Z]{3}\d{2,4}FUT$/.exec(upper);
  if (m) return m[1];
  return upper.replace(/FUT$/, "");
}

const OI_BUILDUP_KINDS: Record<string, OiBuildupKind> = {
  "LONG BUILT UP": "LONG_BUILDUP",
  "SHORT BUILT UP": "SHORT_BUILDUP",
  "SHORT COVERING": "SHORT_COVERING",
  "LONG UNWINDING": "LONG_UNWINDING",
};

/** Map a SmartAPI OIBuildup `datatype` label to the canonical OiBuildupKind. */
export function mapOiBuildupKind(datatype: string): OiBuildupKind | null {
  if (!datatype) return null;
  const key = datatype.trim().toUpperCase().replace(/\s+/g, " ");
  return OI_BUILDUP_KINDS[key] ?? null;
}

function asRows(raw: unknown): RawDerivRow[] {
  return Array.isArray(raw) ? (raw as RawDerivRow[]) : [];
}

/** Normalise a gainersLosers response into underlying-keyed records. */
export function parseGainersLosers(raw: unknown): DerivGainerLoser[] {
  const out: DerivGainerLoser[] = [];
  for (const r of asRows(raw)) {
    const tradingSymbol = str(r.tradingSymbol);
    if (!tradingSymbol) continue;
    out.push({
      symbol: underlyingFromFutSymbol(tradingSymbol),
      tradingSymbol,
      token: str(r.symbolToken),
      ltp: num(r.ltp),
      netChange: num(r.netChange),
      percentChange: num(r.percentChange),
      oi: num(r.opnInterest),
    });
  }
  return out;
}

/** Normalise a putCallRatio response into `{ symbol, pcr }`, dropping NaNs. */
export function parsePcr(raw: unknown): DerivPcr[] {
  const out: DerivPcr[] = [];
  for (const r of asRows(raw)) {
    const tradingSymbol = str(r.tradingSymbol);
    const pcr = num(r.pcr);
    if (!tradingSymbol || pcr == null) continue;
    out.push({ symbol: underlyingFromFutSymbol(tradingSymbol), pcr });
  }
  return out;
}

/** Loosely-typed row from the SmartAPI optionGreek response. */
interface RawGreekRow {
  strikePrice?: unknown;
  optionType?: unknown;
  delta?: unknown;
  gamma?: unknown;
  theta?: unknown;
  vega?: unknown;
  impliedVolatility?: unknown;
}

/**
 * Normalise an optionGreek response into a `${strike}:${type}` → full-greeks
 * map. The strike is keyed by its numeric value (drops trailing zeros like
 * `3900.000000` → `3900`) so callers can look it up by the chain strike.
 * Greeks that are missing / non-numeric come back as null, but the row is
 * still keyed as long as it carries a strike + CE/PE option type.
 */
export function parseGreekRows(raw: unknown): Map<string, OptionGreeks> {
  const out = new Map<string, OptionGreeks>();
  if (!Array.isArray(raw)) return out;
  for (const r of raw as RawGreekRow[]) {
    const strike = num(r.strikePrice);
    const type = str(r.optionType);
    if (strike == null || (type !== "CE" && type !== "PE")) continue;
    out.set(`${strike}:${type}`, {
      delta: num(r.delta),
      gamma: num(r.gamma),
      theta: num(r.theta),
      vega: num(r.vega),
      iv: num(r.impliedVolatility),
    });
  }
  return out;
}

/**
 * Normalise an OIBuildup response. The build-up direction isn't in the row —
 * it's implied by the `datatype` the request asked for — so callers pass the
 * request label through and we tag every row with the derived kind.
 */
export function parseOiBuildup(raw: unknown, datatype: string): DerivOiBuildup[] {
  const kind = mapOiBuildupKind(datatype);
  if (!kind) return [];
  const out: DerivOiBuildup[] = [];
  for (const r of asRows(raw)) {
    const tradingSymbol = str(r.tradingSymbol);
    if (!tradingSymbol) continue;
    out.push({
      symbol: underlyingFromFutSymbol(tradingSymbol),
      tradingSymbol,
      token: str(r.symbolToken),
      ltp: num(r.ltp),
      percentChange: num(r.percentChange),
      oi: num(r.opnInterest),
      kind,
    });
  }
  return out;
}
