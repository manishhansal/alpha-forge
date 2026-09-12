/**
 * provider-selection.ts — Data Foundation V5 §17/§18/§19/§31 (updated V8).
 *
 * Capability-AWARE provider selection. NOT a blind linear chain.
 * 3m was permanently removed in V8 (refactor/signals).
 *
 * Provider grounding:
 *  - Angel One (SmartAPI getCandleData): historical intraday 1m/5m/15m/30m/1h/1d
 *    on EQUITIES. No 3m. Returns 0 for index tokens.
 *  - Upstox (v3): 1m/5m/15m/30m/1h historical + intraday on equities AND indices.
 *    No 3m in scope (removed V8). Requires credentials.
 *  - jugaad: EOD (1d) only — F&O bhavcopy (equity + derivatives). No intraday.
 *  - openchart: historical OHLCV 1m–1M on equity/index/F&O. No OI/IV. No live.
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

/** Angel supports these historical intraday intervals (no 3m — removed V8). */
const ANGEL_HIST_INTERVALS = new Set<Interval>(["1m", "5m", "15m", "30m", "1h", "1d"]);
/** Upstox v3 historical intervals (3m removed from scope in V8). */
const UPSTOX_HIST_INTERVALS = new Set<Interval>(["1m", "5m", "15m", "30m", "1h", "1d"]);
/** Yahoo historical intraday (coarse; no 1m reliably long-range). */
const YAHOO_HIST_INTERVALS = new Set<Interval>(["5m", "15m", "30m", "1h", "1d"]);
/** jugaad: EOD only (bhavcopy). */
const JUGAAD_HIST_INTERVALS = new Set<Interval>(["1d"]);
/** openchart: full range, no live. */
const OPENCHART_HIST_INTERVALS = new Set<Interval>(["1m", "5m", "10m", "15m", "30m", "1h", "1d", "1w", "1M"]);

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
    // Multi-day historical:
    // LIVE BROKER sources (authenticated, highest trust):
    //   Angel → Upstox (interval-gated)
    // OPEN-SOURCE historical sources (unauthenticated, NSE-derived):
    //   jugaad (1d/EOD only) → openchart (1m–1M, no live)
    // LAST-RESORT FALLBACK (equity only, restricted):
    //   Yahoo
    // data-service is EXCLUDED for historical intraday (§18 — cannot serve it).
    if (iv && ANGEL_HIST_INTERVALS.has(iv) && providerRuntimeAvailable("angel_one")) ordered.push("angel_one");
    if (iv && UPSTOX_HIST_INTERVALS.has(iv) && providerRuntimeAvailable("upstox")) ordered.push("upstox");
    if (iv && JUGAAD_HIST_INTERVALS.has(iv) && req.instrumentKind !== "OPTION") ordered.push("jugaad");
    if (iv && OPENCHART_HIST_INTERVALS.has(iv) && req.instrumentKind !== "OPTION") ordered.push("openchart");
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
  if (provider === "jugaad") return JUGAAD_HIST_INTERVALS.has(iv);
  if (provider === "openchart") return OPENCHART_HIST_INTERVALS.has(iv);
  if (provider === "yahoo") return YAHOO_HIST_INTERVALS.has(iv);
  return false; // scrapling: no multi-day historical intraday
}
