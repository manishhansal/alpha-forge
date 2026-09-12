/**
 * provider-capability-matrix.ts — Data Foundation V3 §3/§5.
 *
 * An EXPLICIT, single-source-of-truth matrix of what each provider in the
 * canonical chain can actually do, per interval, and whether it serves
 * historical (multi-day) vs live (current-day / realtime) data.
 *
 * This is deliberately conservative and grounded in the real provider adapters
 * and the Python data-service behaviour (see ALPHAFORGE_DATA_V3_BASELINE.md §4).
 * It is NOT derived from the registry capability flags alone — those flags only
 * say "intraday-capable: yes/no". This matrix records the finer truth the
 * backfill chunk-planner and the gap-recovery failover need:
 *
 *   - which intervals a provider can serve at all,
 *   - whether it can serve multi-day HISTORY for that interval,
 *   - whether it can serve LIVE / current-day data,
 *   - the maximum days a single request should span (chunking),
 *   - a conservative requests/second budget for the rate governor.
 *
 * NOTHING here fabricates data. It only describes capability. A provider marked
 * `history:false` for an interval means the backfill planner will skip it for
 * that interval and fail over — it will never invent bars.
 */

import type { Interval, ProviderId } from "./types";

/** Per-interval capability for one provider. */
export interface IntervalCapability {
  /** Provider can serve this interval at all. */
  supported: boolean;
  /** Provider can serve multi-day HISTORY (backfill source) for this interval. */
  history: boolean;
  /** Provider can serve LIVE / current-day data for this interval. */
  live: boolean;
  /**
   * Max calendar days a single provider request should span for this interval
   * (chunk size). Null when history is not supported. Conservative values —
   * the chunk planner may go smaller, never larger.
   */
  maxChunkDays: number | null;
}

export interface ProviderCapabilityRow {
  provider: ProviderId;
  /** Human note about the provider's role / limits. */
  note: string;
  /**
   * Conservative sustained request budget (requests/second) for the central
   * rate governor. Angel One's historical endpoint 403s past ~3 req/s.
   */
  requestsPerSecond: number;
  /** Whether the provider requires credentials to function at all. */
  requiresCredentials: boolean;
  intervals: Partial<Record<Interval, IntervalCapability>>;
}

const INTRADAY: readonly Interval[] = ["1m", "3m", "5m", "10m", "15m", "30m", "1h"];

function cap(
  supported: boolean,
  history: boolean,
  live: boolean,
  maxChunkDays: number | null,
): IntervalCapability {
  return { supported, history, live, maxChunkDays };
}

/**
 * The canonical capability matrix. Priority order: scrapling → angel_one →
 * upstox → yahoo (mirrors the registry).
 *
 * Grounding:
 *  - scrapling (data-service): serves daily (bhavcopy, ranged) and current-day
 *    intraday only (NSE chart endpoint) — NOT multi-day intraday history
 *    (explicitly deferred to Angel upstream). Supported intraday intervals per
 *    the data-service: 5m/15m/30m/1h (no native 1m/3m).
 *  - angel_one (SmartAPI): the primary multi-day intraday HISTORY source; all
 *    intraday intervals; ~3 req/s cap on the historical endpoint.
 *  - upstox: intraday history + live; no instrument master.
 *  - yahoo: equity intraday + daily fallback; coarse; no F&O; short intraday
 *    history window.
 */
export const PROVIDER_CAPABILITY_MATRIX: readonly ProviderCapabilityRow[] = [
  {
    provider: "scrapling",
    note: "Data-service gateway. Daily (bhavcopy, ranged) + current-day intraday only; NO multi-day intraday history. Live quotes via nextapi.",
    requestsPerSecond: 8,
    requiresCredentials: false,
    intervals: {
      "1d": cap(true, true, false, 365),
      "5m": cap(true, false, true, null),
      "15m": cap(true, false, true, null),
      "30m": cap(true, false, true, null),
      "1h": cap(true, false, true, null),
    },
  },
  {
    provider: "angel_one",
    // V7 §11/§38 correction: Angel's getCandleData does NOT serve the 3-minute
    // interval (ONE_MINUTE/FIVE_MINUTE/… but no THREE_MINUTE) — a live probe on
    // 2026-09-12 returned 0 bars for 3m RELIANCE while 1m returned 1690. It also
    // returns 0 for INDEX tokens (NIFTY/BANKNIFTY daily = 0). So Angel is marked
    // supported ONLY for the intervals it genuinely serves, on EQUITIES. Index
    // history and 3m are served by Upstox V3 (see below). Never claim a
    // capability the provider does not actually satisfy (§ absolute rule).
    note: "SmartAPI — primary EQUITY multi-day intraday HISTORY source. Serves 1m/5m/15m/30m/1h/1d on equities. Does NOT serve 3m (no THREE_MINUTE) and returns 0 for index tokens. Historical endpoint ~3 req/s (403 past that). Requires SMARTAPI_* credentials.",
    requestsPerSecond: 3,
    requiresCredentials: true,
    intervals: {
      "1m": cap(true, true, true, 30),
      // 3m intentionally omitted — Angel getCandleData has no THREE_MINUTE.
      "5m": cap(true, true, true, 90),
      "15m": cap(true, true, true, 180),
      "30m": cap(true, true, true, 180),
      "1h": cap(true, true, true, 365),
      "1d": cap(true, true, true, 2000),
    },
  },
  {
    provider: "upstox",
    // V7 §5/§6: Upstox V3 is the capable source for INDEX history (all
    // intervals) AND for 3m (equities+indices), verified live 2026-09-12. Minute
    // intervals MUST be requested in narrow windows — a 40-day 1m request 400s
    // while an 8-day request returns 2250 bars. maxChunkDays for sub-hour
    // intervals is therefore small and conservative to stay inside the API's
    // per-request minute-history window.
    note: "Upstox v3 — intraday history + live for equities AND indices; the capable 3m + index-history source. Minute intervals capped to a small per-request window (~7 days) by the API. Requires UPSTOX_* credentials.",
    requestsPerSecond: 5,
    requiresCredentials: true,
    intervals: {
      "1m": cap(true, true, true, 7),
      "3m": cap(true, true, true, 14),
      "5m": cap(true, true, true, 30),
      "15m": cap(true, true, true, 90),
      "30m": cap(true, true, true, 90),
      "1h": cap(true, true, true, 180),
      "1d": cap(true, true, true, 2000),
    },
  },
  {
    provider: "yahoo",
    note: "Yahoo Finance — last-resort equity fallback. Coarse intraday, short history window, delayed. No F&O.",
    requestsPerSecond: 2,
    requiresCredentials: false,
    intervals: {
      "5m": cap(true, true, true, 60),
      "15m": cap(true, true, true, 60),
      "30m": cap(true, true, true, 60),
      "1h": cap(true, true, true, 730),
      "1d": cap(true, true, true, 2000),
    },
  },
];

/** Look up a provider row. */
export function capabilityRow(provider: ProviderId): ProviderCapabilityRow | undefined {
  return PROVIDER_CAPABILITY_MATRIX.find((r) => r.provider === provider);
}

/** The interval capability for a provider, or a fully-false cell if unknown. */
export function intervalCapability(
  provider: ProviderId,
  interval: Interval,
): IntervalCapability {
  return capabilityRow(provider)?.intervals[interval] ?? cap(false, false, false, null);
}

/**
 * Ordered list of providers that can serve HISTORY for an interval, in the
 * canonical priority order. Used by the backfill chunk planner + gap recovery
 * to pick a history source and to fail over.
 */
export function historyProvidersFor(interval: Interval): ProviderId[] {
  return PROVIDER_CAPABILITY_MATRIX.filter(
    (r) => r.intervals[interval]?.history,
  ).map((r) => r.provider);
}

/** Ordered list of providers that can serve LIVE data for an interval. */
export function liveProvidersFor(interval: Interval): ProviderId[] {
  return PROVIDER_CAPABILITY_MATRIX.filter(
    (r) => r.intervals[interval]?.live,
  ).map((r) => r.provider);
}

/** The canonical NSE index underlyings whose HISTORY Angel cannot serve. */
export const INDEX_UNDERLYINGS: ReadonlySet<string> = new Set([
  "NIFTY",
  "BANKNIFTY",
  "FINNIFTY",
  "MIDCPNIFTY",
  "NIFTYNXT50",
  "INDIAVIX",
]);

/** True when `symbol` is an NSE index (history must go through Upstox V3). */
export function isIndexSymbol(symbol: string): boolean {
  return INDEX_UNDERLYINGS.has(symbol.toUpperCase());
}

/**
 * V7 §6/§11 capability-aware history-provider ordering for a concrete
 * (symbol, interval).
 *
 * This refines {@link historyProvidersFor} with the two facts a plain
 * interval lookup cannot express and that were verified against the live
 * providers on 2026-09-12:
 *
 *   1. Angel returns 0 bars for INDEX tokens → indices must use Upstox first.
 *   2. Angel has no 3-minute interval → 3m must use Upstox (already reflected
 *      in the matrix, but kept explicit here for the symbol-aware path).
 *
 * The result is still grounded ENTIRELY in the capability matrix — it only
 * re-orders / filters the providers the matrix already says can serve the
 * interval. It never invents a provider or a capability.
 */
export function historyProvidersForSymbol(
  symbol: string,
  interval: Interval,
): ProviderId[] {
  const base = historyProvidersFor(interval);
  if (isIndexSymbol(symbol)) {
    // Indices: Upstox is the only capable history source. Drop Angel entirely
    // (it returns empty for index tokens — never let it be tried and recorded
    // as a false EMPTY that could be mistaken for "no data exists").
    return base.filter((p) => p !== "angel_one");
  }
  return base;
}

/** All intraday intervals V3 targets. */
export const V3_INTRADAY_INTERVALS: readonly Interval[] = INTRADAY;

/**
 * Render the matrix as a Markdown table (used by the provider-runtime report).
 * `enabled` optionally marks which providers are currently usable so the report
 * can state, e.g., that Angel One is present in the matrix but disabled for
 * lack of credentials.
 */
export function renderCapabilityMatrixMarkdown(
  enabled?: (p: ProviderId) => boolean,
): string {
  const cols: Interval[] = ["1m", "3m", "5m", "15m", "30m", "1h"];
  const header = `| Provider | ${cols.join(" | ")} | History | Live | Enabled |`;
  const sep = `| --- | ${cols.map(() => "---").join(" | ")} | --- | --- | --- |`;
  const rows = PROVIDER_CAPABILITY_MATRIX.map((r) => {
    const cells = cols.map((iv) => {
      const c = r.intervals[iv];
      if (!c || !c.supported) return "—";
      return c.history ? "H+L" : c.live ? "L" : "?";
    });
    const anyHistory = cols.some((iv) => r.intervals[iv]?.history) || r.intervals["1d"]?.history;
    const anyLive = cols.some((iv) => r.intervals[iv]?.live);
    const en = enabled ? (enabled(r.provider) ? "yes" : "no") : "?";
    return `| ${r.provider} | ${cells.join(" | ")} | ${anyHistory ? "yes" : "no"} | ${anyLive ? "yes" : "no"} | ${en} |`;
  });
  return [header, sep, ...rows].join("\n");
}
