/**
 * intraday-write-through.service.ts — Data Foundation V3 §6.
 *
 * Write-through intraday reads: whenever AlphaForge requests intraday historical
 * candles during normal operation, this path
 *   1. retrieves via the status-aware read (failover + validation),
 *   2. persists valid candles with provenance (async, non-blocking),
 *   3. records a ProviderObservation,
 *   4. surfaces a persistence failure as DATA_DEGRADED (observable, §37),
 *   5. returns the DataAvailability envelope unchanged for the caller.
 *
 * The DB is progressively populated so future reads can serve DB → cache →
 * provider rather than provider-every-time. NOTHING is fabricated: an empty
 * provider response persists nothing and returns UNAVAILABLE/INSUFFICIENT.
 */

import "server-only";

import type { DataAvailability } from "../data-availability";
import type { HistoricalCandleRequest, OHLCVCandle } from "../types";
import { getHistoricalCandlesWithStatus, type HistoricalWithStatusOptions } from "./read-with-status.service";
import { persistCandles } from "./candle-persist.service";
import { recordProviderObservation, type ObservationOutcome } from "./provider-observation.service";
import { datasetVersion } from "../dataset-version";
import { IST_OFFSET_MS } from "@/lib/india/nse-trading-calendar";
import { mdLog } from "../health";

function statusToOutcome(status: string): ObservationOutcome {
  switch (status) {
    case "AVAILABLE":
    case "PARTIAL":
      return "SUCCESS";
    case "UNAVAILABLE":
      return "EMPTY";
    case "AUTH_FAILED":
      return "AUTH_FAILED";
    case "RATE_LIMITED":
      return "RATE_LIMITED";
    case "INVALID":
      return "INVALID";
    case "STALE":
      return "STALE";
    case "INSUFFICIENT_HISTORY":
      return "EMPTY";
    default:
      return "UNAVAILABLE";
  }
}

function istDateKey(fromIso: string): string {
  const ms = Date.parse(fromIso);
  const base = Number.isFinite(ms) ? ms : Date.now();
  const ist = new Date(base + IST_OFFSET_MS);
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, "0")}-${String(ist.getUTCDate()).padStart(2, "0")}`;
}

/**
 * Read intraday candles WITH persistence side-effect. Returns the same
 * DataAvailability the caller would get, except the status is downgraded to
 * DATA-degraded semantics (PARTIAL) when persistence of retrieved data failed.
 */
export async function getIntradayCandlesWriteThrough(
  req: HistoricalCandleRequest,
  opts?: HistoricalWithStatusOptions,
): Promise<DataAvailability<OHLCVCandle[]>> {
  const t0 = Date.now();
  const availability = await getHistoricalCandlesWithStatus(req, opts);
  const provider = availability.provider ?? availability.providerChain[0] ?? "scrapling";
  const candles = availability.data ?? [];

  let persistError = false;
  if (candles.length > 0) {
    const dv = datasetVersion(istDateKey(req.from), { kind: "provider", provider });
    try {
      const pr = await persistCandles(candles, req.symbol, req.exchange, req.interval, {
        provider,
        datasetVersion: dv,
        recordIncidentOnFailure: true,
        strictOhlc: true,
      });
      if (pr.errors > 0 && pr.upserted === 0) persistError = true;
    } catch (err) {
      persistError = true;
      mdLog("stale_data", {
        reason: "write_through_persist_failed",
        instrumentId: req.symbol,
        interval: req.interval,
        error: (err as Error).message,
      });
    }
  }

  // Fire-and-forget observation (do not block the caller on it).
  void recordProviderObservation({
    provider,
    instrumentId: req.symbol,
    dataType: "CANDLE",
    requestType: "write-through-read",
    interval: req.interval,
    requestStart: req.from,
    requestEnd: req.to,
    outcome: statusToOutcome(availability.status),
    latencyMs: Date.now() - t0,
    recordCount: candles.length,
    qualityStatus: availability.status,
    requestId: availability.requestId,
  });

  if (persistError) {
    // §37: provider succeeded but the DB write failed → observable degradation.
    return {
      ...availability,
      status: "PARTIAL",
      warnings: [...availability.warnings, "persistence_failed: retrieved candles were not durably written"],
    };
  }
  return availability;
}
