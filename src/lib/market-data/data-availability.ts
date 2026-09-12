/**
 * DataAvailability<T> — the canonical data contract for the market-data layer
 * (Data Foundation V2, Phase 2).
 *
 * Every "*WithStatus" read returns this envelope so a consumer can ALWAYS tell:
 *   - whether the data is usable and how fresh/complete it is,
 *   - which provider(s) served it and its full provenance timestamps,
 *   - the difference between "no data", "provider failed", "rate limited",
 *     "insufficient history", and "inconsistent snapshot" (Absolute Rules
 *     9/10/14 — provider failure / insufficient history must never masquerade
 *     as empty valid data).
 *
 * This module is additive and dependency-light: it does NOT change any existing
 * function signature. Legacy bare-array/object reads remain; new consumers opt
 * into the richer contract via the `*WithStatus` services.
 */

import type { ProviderId } from "./types";
import type { QualityEnvelope } from "./services/reconciliation.service";

// ── Status ─────────────────────────────────────────────────────────────────

/**
 * The machine-readable outcome of a data request. Ordered from best to worst;
 * `worstStatus()` uses this ordering to combine multiple sub-statuses.
 */
export type DataAvailabilityStatus =
  | "AVAILABLE" // Data present, fresh, complete enough to use.
  | "PARTIAL" // Data present but incomplete (some intervals/fields missing).
  | "STALE" // Data present but older than its freshness bound.
  | "INSUFFICIENT_HISTORY" // Provider responded, but fewer bars than required.
  | "DATA_SNAPSHOT_INCONSISTENT" // Cross-field timestamps skew beyond tolerance.
  | "RATE_LIMITED" // Upstream returned 429 / throttled.
  | "AUTH_FAILED" // Upstream returned 401/403 auth/authorization failure.
  | "PROVIDER_FAILED" // Every provider in the chain failed (5xx/network/etc.).
  | "INVALID" // Data present but failed structural validation.
  | "UNAVAILABLE"; // No provider could serve the request (not an error, no data).

/** Worst-to-best precedence for combining statuses (index 0 = worst). */
const STATUS_SEVERITY: readonly DataAvailabilityStatus[] = [
  "PROVIDER_FAILED",
  "AUTH_FAILED",
  "RATE_LIMITED",
  "INVALID",
  "DATA_SNAPSHOT_INCONSISTENT",
  "INSUFFICIENT_HISTORY",
  "UNAVAILABLE",
  "STALE",
  "PARTIAL",
  "AVAILABLE",
];

/** Return the more-severe of two statuses. */
export function worstStatus(
  a: DataAvailabilityStatus,
  b: DataAvailabilityStatus,
): DataAvailabilityStatus {
  return STATUS_SEVERITY.indexOf(a) <= STATUS_SEVERITY.indexOf(b) ? a : b;
}

/**
 * Statuses that must NOT be used to produce a tradable signal (fail-closed).
 * A consumer that sees one of these for a CRITICAL dependency must veto.
 */
export const NON_TRADABLE_STATUSES: ReadonlySet<DataAvailabilityStatus> = new Set([
  "PROVIDER_FAILED",
  "AUTH_FAILED",
  "RATE_LIMITED",
  "INVALID",
  "DATA_SNAPSHOT_INCONSISTENT",
  "INSUFFICIENT_HISTORY",
  "UNAVAILABLE",
]);

/** True when this status is safe to trade on for a critical dependency. */
export function isTradableStatus(status: DataAvailabilityStatus): boolean {
  // AVAILABLE always; PARTIAL/STALE are caller-judged (returned true here so the
  // consumer can decide per-strategy) — the hard vetoes are the set above.
  return !NON_TRADABLE_STATUSES.has(status);
}

// ── Interval accounting ───────────────────────────────────────────────────────

/** A [from, to) UTC-epoch-seconds window used for coverage accounting. */
export type IntervalWindow = {
  /** UTC epoch seconds, inclusive. */
  from: number;
  /** UTC epoch seconds, exclusive. */
  to: number;
};

// ── The envelope ──────────────────────────────────────────────────────────────

export type DataAvailability<T> = {
  /** The payload. May be an empty array / null when status is not AVAILABLE. */
  data: T;
  status: DataAvailabilityStatus;
  /** 0..1 — fraction of expected content actually present. */
  completeness: number;
  /** Composite quality envelope (freshness/outlier/agreement), when computed. */
  quality: QualityEnvelope | null;

  /** Provider that ultimately served the data (null when none did). */
  provider: ProviderId | null;
  /** Full ordered chain of providers considered for this request. */
  providerChain: ProviderId[];

  /** UTC ISO-8601 — when the caller requested. */
  requestedAt: string;
  /** UTC ISO-8601 — the data's own timestamp (exchange/source), if known. */
  dataTimestamp: string | null;
  /** UTC ISO-8601 — when we received the data. */
  receivedAt: string;
  /** Age of the data at receipt (ms), or null when dataTimestamp unknown. */
  staleAge: number | null;

  /** UTC ISO-8601 — first covered instant, when applicable (candles). */
  coverageStart: string | null;
  /** UTC ISO-8601 — last covered instant, when applicable (candles). */
  coverageEnd: string | null;

  /** Counts for coverage accounting (candle reads). */
  expectedIntervals: number | null;
  actualIntervals: number | null;
  missingIntervals: IntervalWindow[];
  invalidIntervals: IntervalWindow[];
  duplicateIntervals: IntervalWindow[];

  /** Non-fatal notes (e.g. dropped candles, degraded provider). */
  warnings: string[];
  /** Fatal reasons explaining a non-AVAILABLE status. */
  errors: string[];

  /** Unique id for tracing this request across logs/lineage. */
  requestId: string;
  /** Version of the dataset/normalization that produced this payload. */
  datasetVersion: string;
};

// ── Construction helpers ──────────────────────────────────────────────────────

/** Current normalization/dataset version. Bump when the normalizer changes. */
export const DATASET_VERSION = "md-v2.0.0";

let __reqCounter = 0;

/** Generate a lightweight, collision-resistant request id (no crypto dep). */
export function newRequestId(prefix = "md"): string {
  __reqCounter = (__reqCounter + 1) % 1_000_000;
  return `${prefix}_${Date.now().toString(36)}_${__reqCounter.toString(36)}`;
}

export type BuildAvailabilityInput<T> = {
  data: T;
  status: DataAvailabilityStatus;
  provider?: ProviderId | null;
  providerChain?: ProviderId[];
  requestedAt?: string;
  dataTimestamp?: string | null;
  receivedAt?: string;
  quality?: QualityEnvelope | null;
  completeness?: number;
  coverageStart?: string | null;
  coverageEnd?: string | null;
  expectedIntervals?: number | null;
  actualIntervals?: number | null;
  missingIntervals?: IntervalWindow[];
  invalidIntervals?: IntervalWindow[];
  duplicateIntervals?: IntervalWindow[];
  warnings?: string[];
  errors?: string[];
  requestId?: string;
  datasetVersion?: string;
};

/** Build a fully-populated `DataAvailability<T>` from partial input. */
export function buildAvailability<T>(input: BuildAvailabilityInput<T>): DataAvailability<T> {
  const receivedAt = input.receivedAt ?? new Date().toISOString();
  const dataTimestamp = input.dataTimestamp ?? null;
  let staleAge: number | null = null;
  if (dataTimestamp) {
    const dtMs = Date.parse(dataTimestamp);
    const rxMs = Date.parse(receivedAt);
    if (Number.isFinite(dtMs) && Number.isFinite(rxMs)) {
      staleAge = Math.max(0, rxMs - dtMs);
    }
  }
  return {
    data: input.data,
    status: input.status,
    completeness: clamp01(input.completeness ?? (input.status === "AVAILABLE" ? 1 : 0)),
    quality: input.quality ?? null,
    provider: input.provider ?? null,
    providerChain: input.providerChain ?? [],
    requestedAt: input.requestedAt ?? receivedAt,
    dataTimestamp,
    receivedAt,
    staleAge,
    coverageStart: input.coverageStart ?? null,
    coverageEnd: input.coverageEnd ?? null,
    expectedIntervals: input.expectedIntervals ?? null,
    actualIntervals: input.actualIntervals ?? null,
    missingIntervals: input.missingIntervals ?? [],
    invalidIntervals: input.invalidIntervals ?? [],
    duplicateIntervals: input.duplicateIntervals ?? [],
    warnings: input.warnings ?? [],
    errors: input.errors ?? [],
    requestId: input.requestId ?? newRequestId(),
    datasetVersion: input.datasetVersion ?? DATASET_VERSION,
  };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
