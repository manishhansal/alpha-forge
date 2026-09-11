/**
 * provider-selection.ts — Data Foundation V5 §17/§18/§19/§31.
 *
 * Capability-AWARE provider selection. NOT a blind linear chain: the eligible
 * providers depend on the request's capability + interval + instrument type +
 * history-vs-live + options-vs-equity, and on which providers are actually
 * available at runtime (env or worker-loaded credentials).
 *
 * Grounding (from the real integration + provider docs):
 *  - Angel One (SmartAPI getCandleData): historical intraday 1m/5m/15m/30m/1h/1d
 *    (NO 3m — intervalToSmartApi returns null → not eligible for 3m). Options via
 *    NFO chain. Requires credentials.
 *  - Upstox (v3 historical-candle): 1m/3m/5m/15m/30m/1h historical + intraday.
 *    Options via chain. Requires an analytics token.
 *  - data-service (scrapling): quotes + current-day intraday ONLY — NEVER
 *    multi-day historical intraday (V4-confirmed). Daily via bhavcopy.
 *  - Yahoo: equity historical fallback; NEVER for option OI/IV/bid/ask.
 */

import type { Interval, ProviderId } from "./types";
import { getWorkerAngelCredentials, getWorkerUpstoxToken } from "./worker-credentials";

export type Capability = "historicalCandles" | "liveQuote" | "optionChain";
export type InstrumentKind = "EQUITY" | "INDEX" | "OPTION";

export interface SelectionRequest {
  capability: Capability;
  interval?: Interval;
  instrumentKind?: InstrumentKind;
  /** true = multi-day history; false = current-day/live. */
  historical?: boolean;
}

/** Runtime availability of each provider (credentials present). */
export function providerRuntimeAvailable(provider: ProviderId): boolean {
  switch (provider) {
    case "scrapling":
      return !!process.env.DATA_SERVICE_URL;
    case "angel_one":
      return (
        !!(process.env.SMARTAPI_API_KEY && process.env.SMARTAPI_CLIENT_CODE) ||
        getWorkerAngelCredentials() !== null
      );
    case "upstox":
      return (
        !!(process.env.UPSTOX_ANALYTICS_TOKEN || process.env.UPSTOX_ACCESS_TOKEN) ||
        getWorkerUpstoxToken() !== null
      );
    case "yahoo":
      return true;
    default:
      return false;
  }
}

/** Angel supports these historical intraday intervals (no 3m). */
const ANGEL_HIST_INTERVALS = new Set<Interval>(["1m", "5m", "15m", "30m", "1h", "1d"]);
/** Upstox v3 historical intervals (incl 3m). */
const UPSTOX_HIST_INTERVALS = new Set<Interval>(["1m", "3m", "5m", "15m", "30m", "1h", "1d"]);
/** Yahoo historical intraday (coarse; no 1m/3m reliably long-range). */
const YAHOO_HIST_INTERVALS = new Set<Interval>(["5m", "15m", "30m", "1h", "1d"]);

/**
 * Return eligible providers in priority order for the request, filtered by both
 * static capability and runtime availability. Empty when nothing can serve it.
 */
export function selectProviders(req: SelectionRequest): ProviderId[] {
  const ordered: ProviderId[] = [];

  if (req.capability === "optionChain") {
    // Options: Angel → Upstox. NEVER Yahoo (no OI/IV/bid/ask); NEVER data-service
    // for strike-level history.
    for (const p of ["angel_one", "upstox"] as ProviderId[]) {
      if (providerRuntimeAvailable(p)) ordered.push(p);
    }
    return ordered;
  }

  if (req.capability === "liveQuote") {
    // Live quote: Angel → Upstox → data-service → Yahoo.
    for (const p of ["angel_one", "upstox", "scrapling", "yahoo"] as ProviderId[]) {
      if (providerRuntimeAvailable(p)) ordered.push(p);
    }
    return ordered;
  }

  // historicalCandles
  const iv = req.interval;
  const historical = req.historical ?? true;

  if (historical) {
    // Multi-day historical intraday: Angel → Upstox → Yahoo (interval-gated).
    // data-service is EXCLUDED for historical intraday (§18 — it cannot serve it).
    if (iv && ANGEL_HIST_INTERVALS.has(iv) && providerRuntimeAvailable("angel_one")) ordered.push("angel_one");
    if (iv && UPSTOX_HIST_INTERVALS.has(iv) && providerRuntimeAvailable("upstox")) ordered.push("upstox");
    if (iv && YAHOO_HIST_INTERVALS.has(iv) && providerRuntimeAvailable("yahoo") && req.instrumentKind !== "OPTION") ordered.push("yahoo");
    return ordered;
  }

  // Current-day intraday: data-service is valid here (+ Angel/Upstox).
  if (providerRuntimeAvailable("angel_one") && iv && ANGEL_HIST_INTERVALS.has(iv)) ordered.push("angel_one");
  if (providerRuntimeAvailable("upstox") && iv && UPSTOX_HIST_INTERVALS.has(iv)) ordered.push("upstox");
  if (providerRuntimeAvailable("scrapling")) ordered.push("scrapling");
  return ordered;
}

/** True when a provider can serve a given historical interval (static). */
export function providerSupportsHistoricalInterval(provider: ProviderId, iv: Interval): boolean {
  if (provider === "angel_one") return ANGEL_HIST_INTERVALS.has(iv);
  if (provider === "upstox") return UPSTOX_HIST_INTERVALS.has(iv);
  if (provider === "yahoo") return YAHOO_HIST_INTERVALS.has(iv);
  return false; // scrapling: no multi-day historical intraday
}
