/**
 * Provider health tracking, circuit breaker, and staleness detection.
 *
 * Health scoring rules:
 *   - Start at 100.
 *   - Each consecutive failure subtracts progressively more points.
 *   - Each consecutive success recovers points (slower than decay).
 *   - Stale data events subtract a fixed penalty.
 *   - Circuit opens when score < CIRCUIT_OPEN_THRESHOLD.
 *   - Circuit attempts half-open after CIRCUIT_RETRY_MS.
 *   - Provider is "unhealthy" when circuit is open.
 *   - Provider is "degraded" when score < DEGRADED_THRESHOLD.
 *   - Provider is "healthy" otherwise.
 *
 * A provider must be marked unhealthy when:
 *   - Authentication fails repeatedly (≥ AUTH_FAILURE_THRESHOLD).
 *   - API repeatedly returns errors (≥ ERROR_THRESHOLD).
 *   - WebSocket disconnects repeatedly (≥ WS_DISCONNECT_THRESHOLD).
 *   - Data becomes stale (timestamp age > STALE_THRESHOLD_MS).
 *   - Returned timestamps are older than configured thresholds.
 */

import type { ProviderHealth, ProviderHealthStatus, ProviderId } from "./types";

// ── Thresholds ───────────────────────────────────────────────────────────────

const CIRCUIT_OPEN_THRESHOLD = 20;   // score below this opens the circuit
const DEGRADED_THRESHOLD = 60;        // score below this = degraded
const CIRCUIT_RETRY_MS = 30_000;      // 30s half-open window
const MAX_FAILURE_PENALTY = 40;       // maximum points removed per failure
const RECOVERY_PER_SUCCESS = 10;      // points recovered per success
const STALE_DATA_PENALTY = 15;        // flat penalty for stale data event
const AUTH_FAILURE_PENALTY = 25;      // extra penalty for auth failures

/** Rolling window for latency percentile estimation (last N calls). */
const LATENCY_WINDOW = 50;

// ── Per-provider mutable state ───────────────────────────────────────────────

interface HealthState {
  score: number;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  lastSuccessAt: number | null;   // UTC epoch ms
  lastFailureAt: number | null;   // UTC epoch ms
  circuitOpen: boolean;
  circuitRetryAt: number | null;  // UTC epoch ms
  latencySamples: number[];
}

function freshState(): HealthState {
  return {
    score: 100,
    consecutiveFailures: 0,
    consecutiveSuccesses: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    circuitOpen: false,
    circuitRetryAt: null,
    latencySamples: [],
  };
}

// Global registry of per-provider states, keyed by ProviderId.
const states = new Map<ProviderId, HealthState>();

function getState(id: ProviderId): HealthState {
  let s = states.get(id);
  if (!s) {
    s = freshState();
    states.set(id, s);
  }
  return s;
}

// ── Latency percentiles ──────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)] ?? null;
}

function recordLatency(state: HealthState, ms: number): void {
  state.latencySamples.push(ms);
  if (state.latencySamples.length > LATENCY_WINDOW) {
    state.latencySamples.shift();
  }
}

// ── Circuit breaker ──────────────────────────────────────────────────────────

/**
 * Returns true if the circuit is currently open AND the half-open retry
 * window has not yet elapsed — meaning the provider should be skipped.
 */
export function isCircuitOpen(id: ProviderId, now = Date.now()): boolean {
  const s = getState(id);
  if (!s.circuitOpen) return false;
  if (s.circuitRetryAt != null && now >= s.circuitRetryAt) {
    // Half-open: allow one probe call through.
    return false;
  }
  return true;
}

/** Reset health state (used in tests and after manual provider re-enable). */
export function resetHealth(id: ProviderId): void {
  states.set(id, freshState());
}

/** Reset all provider health states (used in tests). */
export function resetAllHealth(): void {
  states.clear();
}

// ── Event recorders ──────────────────────────────────────────────────────────

/**
 * Record a successful call. Reduces consecutive failure count, recovers score,
 * and closes the circuit if it was in half-open state.
 */
export function recordSuccess(id: ProviderId, latencyMs: number): void {
  const s = getState(id);
  s.consecutiveFailures = 0;
  s.consecutiveSuccesses += 1;
  s.lastSuccessAt = Date.now();
  s.score = Math.min(100, s.score + RECOVERY_PER_SUCCESS);
  recordLatency(s, latencyMs);

  // Close the circuit on a successful probe.
  if (s.circuitOpen) {
    s.circuitOpen = false;
    s.circuitRetryAt = null;
    mdLog("provider_recovery", { providerId: id, score: s.score });
  }
}

export type FailureKind = "api_error" | "auth_failure" | "ws_disconnect" | "timeout";

/**
 * Record a failed call. Increments consecutive failure count, applies a
 * progressive score penalty, and opens the circuit when score falls below
 * the threshold.
 */
export function recordFailure(
  id: ProviderId,
  kind: FailureKind,
  message?: string,
): void {
  const s = getState(id);
  s.consecutiveSuccesses = 0;
  s.consecutiveFailures += 1;
  s.lastFailureAt = Date.now();

  // Progressive penalty: each additional failure hurts more.
  const base = Math.min(MAX_FAILURE_PENALTY, 5 * s.consecutiveFailures);
  const authExtra = kind === "auth_failure" ? AUTH_FAILURE_PENALTY : 0;
  s.score = Math.max(0, s.score - base - authExtra);

  mdLog("provider_failure", {
    providerId: id,
    kind,
    consecutiveFailures: s.consecutiveFailures,
    score: s.score,
    message,
  });

  if (!s.circuitOpen && s.score < CIRCUIT_OPEN_THRESHOLD) {
    s.circuitOpen = true;
    s.circuitRetryAt = Date.now() + CIRCUIT_RETRY_MS;
    mdLog("provider_circuit_open", {
      providerId: id,
      score: s.score,
      retryAt: new Date(s.circuitRetryAt).toISOString(),
    });
  }
}

/**
 * Record a stale data event (data received but timestamps are too old).
 * Applies a flat score penalty without opening the circuit immediately.
 */
export function recordStaleData(id: ProviderId, ageMs: number, thresholdMs: number): void {
  const s = getState(id);
  s.score = Math.max(0, s.score - STALE_DATA_PENALTY);
  mdLog("stale_data", { providerId: id, ageMs, thresholdMs, score: s.score });
}

// ── Snapshot ─────────────────────────────────────────────────────────────────

/** Return a read-only health snapshot for a provider. */
export function getProviderHealth(id: ProviderId): ProviderHealth {
  const s = getState(id);
  const sorted = [...s.latencySamples].sort((a, b) => a - b);
  const status: ProviderHealthStatus =
    s.circuitOpen
      ? "unhealthy"
      : s.score < DEGRADED_THRESHOLD
        ? "degraded"
        : "healthy";

  return {
    providerId: id,
    status,
    score: s.score,
    lastSuccessAt: s.lastSuccessAt != null ? new Date(s.lastSuccessAt).toISOString() : null,
    lastFailureAt: s.lastFailureAt != null ? new Date(s.lastFailureAt).toISOString() : null,
    consecutiveFailures: s.consecutiveFailures,
    consecutiveSuccesses: s.consecutiveSuccesses,
    circuitOpen: s.circuitOpen,
    circuitRetryAt:
      s.circuitRetryAt != null ? new Date(s.circuitRetryAt).toISOString() : null,
    latencyP50Ms: percentile(sorted, 50),
    latencyP99Ms: percentile(sorted, 99),
  };
}

/** Return health snapshots for all known providers. */
export function getAllProviderHealth(): ProviderHealth[] {
  const allIds: ProviderId[] = ["angel_one", "upstox", "nse", "yahoo"];
  return allIds.map(getProviderHealth);
}

// ── Staleness detection ──────────────────────────────────────────────────────

/** Default stale thresholds by data type (ms). */
export const STALE_THRESHOLDS_MS = {
  /** Live quote/tick — stale after 5s during market hours. */
  liveTick: 5_000,
  /** Intraday candle — stale after 60s. */
  intradayCandle: 60_000,
  /** Daily candle — stale after 4h. */
  dailyCandle: 4 * 60 * 60 * 1_000,
  /** Option chain — stale after 30s during market hours. */
  optionChain: 30_000,
  /** Instrument master — stale after 12h. */
  instrumentMaster: 12 * 60 * 60 * 1_000,
} as const;

export type StaleDataType = keyof typeof STALE_THRESHOLDS_MS;

/**
 * Check whether a fetched-at timestamp (ISO-8601 UTC) is stale for the given
 * data type. Returns true when the data is too old.
 */
export function isStale(
  fetchedAt: string,
  dataType: StaleDataType,
  now = Date.now(),
): boolean {
  const fetchedMs = Date.parse(fetchedAt);
  if (!Number.isFinite(fetchedMs)) return true;
  return now - fetchedMs > STALE_THRESHOLDS_MS[dataType];
}

/**
 * Check a UTC epoch-ms timestamp (from a provider frame) against a configured
 * threshold. Use this for per-tick staleness checks during the live feed.
 */
export function isTickStale(
  exchangeTimestampMs: number,
  thresholdMs: number = STALE_THRESHOLDS_MS.liveTick,
  now = Date.now(),
): boolean {
  return now - exchangeTimestampMs > thresholdMs;
}

// ── Structured logging ───────────────────────────────────────────────────────

type LogEvent =
  | "provider_selected"
  | "provider_failure"
  | "provider_failover"
  | "provider_recovery"
  | "provider_circuit_open"
  | "stale_data"
  | "data_mismatch";

/** Structured log emitter. Replace with your observability sink as needed. */
export function mdLog(event: LogEvent, payload: Record<string, unknown>): void {
  console.log(
    JSON.stringify({ ts: new Date().toISOString(), event, ...payload }),
  );
}
