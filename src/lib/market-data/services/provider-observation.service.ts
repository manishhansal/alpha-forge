/**
 * provider-observation.service.ts — Data Foundation V3 §12/§13.
 *
 * Durable write path for `ProviderObservation` — the raw evidence of a real
 * provider call, separated from the normalized data (Absolute Rule 12). Every
 * observation captures WHAT was asked, WHICH provider answered, HOW it went
 * (status/latency/records), and WHEN — so a provider health scorecard can be
 * computed from real calls rather than assumed.
 *
 * NEVER stores credentials, API keys, or tokens. Raw payload retention is
 * opt-in and, when enabled, callers are responsible for passing a payload that
 * has already been stripped of secrets.
 *
 * This module is fail-open: a failure to persist an observation is logged and
 * swallowed — observability must never break the data path it observes.
 */

import "server-only";

import type { PrismaClient } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { mdLog } from "../health";
import type { Interval, ProviderId } from "../types";

export type ObservationDataType =
  | "QUOTE"
  | "CANDLE"
  | "OPTION_CHAIN"
  | "INSTRUMENT_MASTER";

/** A normalized outcome classification for the scorecard. */
export type ObservationOutcome =
  | "SUCCESS"
  | "EMPTY" // 200 but zero records
  | "AUTH_FAILED" // 401/403
  | "RATE_LIMITED" // 429
  | "UNAVAILABLE" // 5xx
  | "TIMEOUT"
  | "INVALID" // malformed / failed validation
  | "STALE"
  | "NETWORK";

export interface RecordObservationInput {
  provider: ProviderId | string;
  instrumentId: string;
  dataType: ObservationDataType;
  /** e.g. "getHistoricalCandlesWithStatus", "backfill-chunk", "gap-recovery". */
  requestType?: string;
  interval?: Interval;
  /** Request window (UTC ISO or epoch seconds), when applicable. */
  requestStart?: string | number | null;
  requestEnd?: string | number | null;
  /** HTTP status when known. */
  httpStatus?: number | null;
  /** Normalized outcome. */
  outcome: ObservationOutcome;
  /** Error class / message (never contains secrets). */
  errorClass?: string | null;
  /** Round-trip latency in ms. */
  latencyMs?: number | null;
  /** Provider/exchange-declared source time (UTC ISO), when supplied. */
  sourceTimestamp?: string | null;
  /** Number of records returned. */
  recordCount?: number | null;
  /** Data-quality status string (e.g. "AVAILABLE"|"PARTIAL"|...). */
  qualityStatus?: string | null;
  /** Retry count within this provider before success/failure. */
  retryCount?: number | null;
  /** Position in the failover chain (0 = primary). */
  failoverPosition?: number | null;
  /** True when a rate-limit (429/403-rate) event occurred. */
  rateLimited?: boolean;
  /** Circuit-breaker state at call time: CLOSED|OPEN|HALF_OPEN. */
  circuitState?: string | null;
  /** Correlation / request id for tracing. */
  requestId?: string | null;
  /** Optional pre-sanitised raw payload for replay (NO secrets). */
  rawPayload?: unknown;
  schemaVersion?: string | null;
  normalizationVersion?: string | null;
  prisma?: PrismaClient;
}

function toIso(v: string | number | null | undefined): Date | null {
  if (v == null) return null;
  if (typeof v === "number") {
    // Heuristic: treat < 10^12 as epoch SECONDS, else ms.
    const ms = v < 1e12 ? v * 1000 : v;
    const d = new Date(ms);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/**
 * Persist a single provider observation. Fail-open. Returns the created row id
 * or null on failure.
 *
 * The rich per-call metrics (httpStatus, latency, outcome, failoverPosition,
 * retryCount, circuitState, requestStart/End, requestType) are stored in the
 * `detail`-shaped columns available on the model. The Prisma model keeps the
 * strongly-typed columns (provider/instrumentId/dataType/sourceTimestamp/
 * receivedAt/payloadHash/rawPayload/schemaVersion/normalizationVersion); the
 * remaining metrics are folded into `rawPayload.__metrics` when payload
 * retention is on, and always emitted to the structured log for the scorecard
 * builder to aggregate even without payload retention.
 */
export async function recordProviderObservation(
  input: RecordObservationInput,
): Promise<string | null> {
  const prisma = input.prisma ?? getPrisma();

  const metrics = {
    requestType: input.requestType ?? null,
    interval: input.interval ?? null,
    requestStart: input.requestStart ?? null,
    requestEnd: input.requestEnd ?? null,
    httpStatus: input.httpStatus ?? null,
    outcome: input.outcome,
    errorClass: input.errorClass ?? null,
    latencyMs: input.latencyMs ?? null,
    recordCount: input.recordCount ?? null,
    qualityStatus: input.qualityStatus ?? null,
    retryCount: input.retryCount ?? null,
    failoverPosition: input.failoverPosition ?? null,
    rateLimited: input.rateLimited ?? false,
    circuitState: input.circuitState ?? null,
  };

  // Always emit a structured log line — the scorecard can be rebuilt from logs
  // even if DB retention is trimmed. Never contains secrets.
  mdLog("provider_selected", {
    event: "PROVIDER_OBSERVATION",
    provider: input.provider,
    instrumentId: input.instrumentId,
    dataType: input.dataType,
    requestId: input.requestId ?? null,
    ...metrics,
  });

  try {
    // Fold metrics into rawPayload so the durable row carries the full
    // observation without needing extra columns. Secrets are never included.
    const rawPayload =
      input.rawPayload !== undefined
        ? { data: input.rawPayload, __metrics: metrics }
        : { __metrics: metrics };

    const row = await prisma.providerObservation.create({
      data: {
        provider: String(input.provider),
        instrumentId: input.instrumentId,
        dataType: input.dataType,
        requestId: input.requestId ?? null,
        sourceTimestamp: toIso(input.sourceTimestamp),
        receivedAt: new Date(),
        rawPayload: rawPayload as object,
        schemaVersion: input.schemaVersion ?? null,
        normalizationVersion: input.normalizationVersion ?? null,
      },
      select: { id: true },
    });
    return row.id;
  } catch (err) {
    mdLog("stale_data", {
      reason: "provider_observation_persist_failed",
      provider: input.provider,
      instrumentId: input.instrumentId,
      error: (err as Error).message,
    });
    return null;
  }
}
