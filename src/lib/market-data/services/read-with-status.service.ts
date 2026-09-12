/**
 * read-with-status.service.ts — Data Foundation V2, Phases 3 & 4.
 *
 * Non-breaking `*WithStatus` read APIs that wrap the existing registry reads and
 * return a `DataAvailability<T>` envelope. These eliminate the empty-array /
 * all-null ambiguity: a provider failure, an auth failure, a rate limit, an
 * insufficient-history response, and a genuine empty result are now DISTINCT,
 * machine-readable statuses (Absolute Rules 9/10 — never hide provider failure
 * or insufficient history as empty data).
 *
 * The legacy `getHistoricalCandles()`, `getOptionChain()`, `getInstruments()`,
 * `getQuotes()` remain untouched; consumers migrate incrementally.
 */

import { registry } from "../registry";
import { classifyError } from "../failover";
import type { FailureKind } from "../health";
import type {
  Exchange,
  HistoricalCandleRequest,
  Instrument,
  InstrumentMasterFilter,
  Interval,
  MDQuote,
  OHLCVCandle,
  OptionChain,
  ProviderId,
} from "../types";
import type { ProviderCallOptions } from "../provider";
import {
  buildAvailability,
  newRequestId,
  worstStatus,
  type DataAvailability,
  type DataAvailabilityStatus,
  type IntervalWindow,
} from "../data-availability";
import { filterValidCandlesWithReport } from "../validation/candle-validator";

// ── Error → status mapping ─────────────────────────────────────────────────

/**
 * Map a thrown provider error to a `DataAvailabilityStatus`. Uses the same
 * `classifyError` the failover engine uses, so classification is consistent.
 */
export function failureKindToStatus(kind: FailureKind): DataAvailabilityStatus {
  switch (kind) {
    case "auth_failure":
    case "hard_block": // 403 gateway/WAF block — treated as an access failure
      return "AUTH_FAILED";
    case "rate_limit":
      return "RATE_LIMITED";
    case "malformed":
      return "INVALID";
    case "unavailable":
    case "timeout":
    case "network":
    case "ws_disconnect":
    case "api_error":
    default:
      return "PROVIDER_FAILED";
  }
}

/** Classify an unknown thrown value into a DataAvailabilityStatus. */
export function errorToStatus(err: unknown): DataAvailabilityStatus {
  return failureKindToStatus(classifyError(err));
}

/** The provider chain considered for a capability, in priority order. */
function providerChainFor(
  cap: "historicalCandles" | "liveQuotes" | "optionChain" | "instrumentMaster",
): ProviderId[] {
  return registry.withCapability(cap).map((e) => e.provider.id);
}

// ── Interval seconds (mirrors the canonical Interval union) ────────────────
// 3m intentionally absent — not a supported AlphaForge interval (V8 removal).
const INTERVAL_SECONDS: Partial<Record<Interval, number>> = {
  "1m": 60,
  "5m": 300,
  "10m": 600,
  "15m": 900,
  "30m": 1800,
  "1h": 3600,
  "1d": 86_400,
};

// ── Historical candles ─────────────────────────────────────────────────────

export type HistoricalWithStatusOptions = ProviderCallOptions & {
  /**
   * Minimum number of valid bars the caller needs. When the provider responds
   * successfully but returns fewer, the status is INSUFFICIENT_HISTORY (Rule 10)
   * rather than AVAILABLE-with-few or PROVIDER_FAILED.
   */
  minBars?: number;
};

/**
 * Fetch historical candles with a full availability envelope. Never throws.
 *
 * Distinguishes:
 *   - PROVIDER_FAILED / AUTH_FAILED / RATE_LIMITED / INVALID (from the error),
 *   - INSUFFICIENT_HISTORY (responded, but < minBars valid),
 *   - PARTIAL (some candles dropped as invalid/out-of-order),
 *   - UNAVAILABLE (responded with zero candles and no minBars requirement),
 *   - AVAILABLE.
 */
export async function getHistoricalCandlesWithStatus(
  req: HistoricalCandleRequest,
  opts?: HistoricalWithStatusOptions,
): Promise<DataAvailability<OHLCVCandle[]>> {
  const requestId = newRequestId("hist");
  const requestedAt = new Date().toISOString();
  const providerChain = providerChainFor("historicalCandles");

  let raw: OHLCVCandle[];
  try {
    raw = await registry.getHistoricalCandles(req, opts);
  } catch (err) {
    const status = errorToStatus(err);
    return buildAvailability<OHLCVCandle[]>({
      data: [],
      status,
      providerChain,
      requestedAt,
      requestId,
      errors: [err instanceof Error ? err.message : String(err)],
    });
  }

  // Validate + report drops instead of silently repairing (Rule 11).
  const report = filterValidCandlesWithReport(raw);
  const valid = report.candles;

  const invalidIntervals: IntervalWindow[] = report.dropped
    .filter((d) => d.error !== "TIMESTAMP_NOT_ASCENDING")
    .map((d) => ({ from: d.time, to: d.time + 1 }));
  const duplicateIntervals: IntervalWindow[] = report.dropped
    .filter((d) => d.error === "TIMESTAMP_NOT_ASCENDING")
    .map((d) => ({ from: d.time, to: d.time + 1 }));

  const coverageStart = valid.length > 0 ? new Date(valid[0]!.time * 1000).toISOString() : null;
  const coverageEnd =
    valid.length > 0 ? new Date(valid[valid.length - 1]!.time * 1000).toISOString() : null;
  const dataTimestamp = coverageEnd;

  // Expected-interval accounting (calendar-agnostic here; the coverage engine
  // applies the trading calendar. This is the raw span estimate.)
  const secs = INTERVAL_SECONDS[req.interval] ?? null;
  let expectedIntervals: number | null = null;
  const fromMs = Date.parse(req.from);
  const toMs = Date.parse(req.to);
  if (secs && Number.isFinite(fromMs) && Number.isFinite(toMs) && toMs > fromMs) {
    expectedIntervals = Math.max(1, Math.floor((toMs - fromMs) / 1000 / secs));
  }

  const warnings: string[] = [];
  if (report.droppedCount > 0) {
    warnings.push(
      `${report.droppedCount}/${report.inputCount} candles dropped on validation`,
    );
  }

  // Status resolution.
  let status: DataAvailabilityStatus;
  if (valid.length === 0) {
    status = "UNAVAILABLE";
  } else if (opts?.minBars != null && valid.length < opts.minBars) {
    status = "INSUFFICIENT_HISTORY";
    warnings.push(`have ${valid.length} valid bars, need ${opts.minBars}`);
  } else if (report.droppedCount > 0) {
    status = "PARTIAL";
  } else {
    status = "AVAILABLE";
  }

  const completeness =
    expectedIntervals && expectedIntervals > 0
      ? Math.min(1, valid.length / expectedIntervals)
      : status === "AVAILABLE"
        ? 1
        : valid.length > 0
          ? 0.5
          : 0;

  return buildAvailability<OHLCVCandle[]>({
    data: valid,
    status,
    provider: providerChain[0] ?? null, // failover resolves the actual one; chain head is best-effort
    providerChain,
    requestedAt,
    dataTimestamp,
    coverageStart,
    coverageEnd,
    expectedIntervals,
    actualIntervals: valid.length,
    invalidIntervals,
    duplicateIntervals,
    completeness,
    warnings,
    requestId,
  });
}

// ── Option chain ───────────────────────────────────────────────────────────

export async function getOptionChainWithStatus(
  underlying: string,
  expiry?: string,
  opts?: ProviderCallOptions,
): Promise<DataAvailability<OptionChain | null>> {
  const requestId = newRequestId("oc");
  const requestedAt = new Date().toISOString();
  const providerChain = providerChainFor("optionChain");

  try {
    const chain = await registry.getOptionChain(underlying, expiry, opts);
    const rows = chain.rows ?? [];
    // Completeness = fraction of rows that have at least one non-missing OI leg
    // (uses the V1 *Missing flags — never counts a fabricated 0 as present).
    const present = rows.filter(
      (r) =>
        (r.ce && !r.ce.oiMissing) || (r.pe && !r.pe.oiMissing),
    ).length;
    const completeness = rows.length > 0 ? present / rows.length : 0;
    const status: DataAvailabilityStatus =
      rows.length === 0 ? "UNAVAILABLE" : completeness < 1 ? "PARTIAL" : "AVAILABLE";
    return buildAvailability<OptionChain | null>({
      data: chain,
      status,
      provider: chain.provider ?? providerChain[0] ?? null,
      providerChain,
      requestedAt,
      dataTimestamp: chain.fetchedAt ?? null,
      completeness,
      actualIntervals: rows.length,
      requestId,
    });
  } catch (err) {
    return buildAvailability<OptionChain | null>({
      data: null,
      status: errorToStatus(err),
      providerChain,
      requestedAt,
      requestId,
      errors: [err instanceof Error ? err.message : String(err)],
    });
  }
}

// ── Instrument master (fixes G-12) ─────────────────────────────────────────

export async function getInstrumentsWithStatus(
  filter?: InstrumentMasterFilter,
  opts?: ProviderCallOptions,
): Promise<DataAvailability<Instrument[]>> {
  const requestId = newRequestId("instr");
  const requestedAt = new Date().toISOString();
  const providerChain = providerChainFor("instrumentMaster");

  try {
    const instruments = await registry.getInstrumentMaster(filter, opts);
    const status: DataAvailabilityStatus = instruments.length === 0 ? "UNAVAILABLE" : "AVAILABLE";
    return buildAvailability<Instrument[]>({
      data: instruments,
      status,
      provider: providerChain[0] ?? null,
      providerChain,
      requestedAt,
      actualIntervals: instruments.length,
      requestId,
    });
  } catch (err) {
    // G-12: a provider failure must NOT look like a valid empty master.
    return buildAvailability<Instrument[]>({
      data: [],
      status: errorToStatus(err),
      providerChain,
      requestedAt,
      requestId,
      errors: [err instanceof Error ? err.message : String(err)],
    });
  }
}

// ── Quotes (fixes G-13) ────────────────────────────────────────────────────

/** A per-symbol quote result that distinguishes the reasons a quote is null. */
export type QuoteResult = {
  symbol: string;
  quote: MDQuote | null;
  /** Why the quote is null (only set when quote is null). */
  reason: "OK" | "UNRESOLVED" | "PROVIDER_FAILED" | "AUTH_FAILED" | "RATE_LIMITED" | "INVALID";
};

/**
 * Fetch quotes with per-symbol reasons. On a provider failure the batch status
 * is PROVIDER_FAILED/AUTH_FAILED/RATE_LIMITED and every symbol carries that
 * reason — NEVER an undifferentiated `null` that looks like "unresolved symbol"
 * (Rule 9 / G-13). A genuine null from a successful call means UNRESOLVED.
 */
export async function getQuotesWithStatus(
  symbols: string[],
  opts?: ProviderCallOptions,
): Promise<DataAvailability<QuoteResult[]>> {
  const requestId = newRequestId("quote");
  const requestedAt = new Date().toISOString();
  const providerChain = providerChainFor("liveQuotes");

  try {
    const quotes = await registry.getQuotes(symbols, opts);
    const results: QuoteResult[] = symbols.map((symbol, i) => {
      const q = quotes[i] ?? null;
      return { symbol, quote: q, reason: q ? "OK" : "UNRESOLVED" };
    });
    const resolved = results.filter((r) => r.quote != null).length;
    const dataTimestamp =
      results.find((r) => r.quote?.fetchedAt)?.quote?.fetchedAt ?? null;
    const completeness = symbols.length > 0 ? resolved / symbols.length : 0;
    const status: DataAvailabilityStatus =
      resolved === 0 ? "UNAVAILABLE" : resolved < symbols.length ? "PARTIAL" : "AVAILABLE";
    return buildAvailability<QuoteResult[]>({
      data: results,
      status,
      provider: providerChain[0] ?? null,
      providerChain,
      requestedAt,
      dataTimestamp,
      completeness,
      actualIntervals: resolved,
      expectedIntervals: symbols.length,
      requestId,
    });
  } catch (err) {
    const status = errorToStatus(err);
    // Attach the failure reason to EVERY symbol — no ambiguous all-null.
    const reason = (
      status === "AUTH_FAILED"
        ? "AUTH_FAILED"
        : status === "RATE_LIMITED"
          ? "RATE_LIMITED"
          : status === "INVALID"
            ? "INVALID"
            : "PROVIDER_FAILED"
    ) as QuoteResult["reason"];
    const results: QuoteResult[] = symbols.map((symbol) => ({
      symbol,
      quote: null,
      reason,
    }));
    return buildAvailability<QuoteResult[]>({
      data: results,
      status,
      providerChain,
      requestedAt,
      requestId,
      completeness: 0,
      errors: [err instanceof Error ? err.message : String(err)],
    });
  }
}

// Re-export for consumers that combine multiple sub-reads into one snapshot.
export { worstStatus };
export type { DataAvailability, DataAvailabilityStatus, Exchange };
