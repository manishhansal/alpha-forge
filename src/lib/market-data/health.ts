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
const CIRCUIT_RETRY_MS = 30_000;      // base half-open window (first probe)
const CIRCUIT_RETRY_MAX_MS = 5 * 60_000; // cap on the escalating half-open window
const MAX_FAILURE_PENALTY = 40;       // maximum points removed per failure
const RECOVERY_PER_SUCCESS = 10;      // points recovered per success
const STALE_DATA_PENALTY = 15;        // flat penalty for stale data event
const AUTH_FAILURE_PENALTY = 25;      // extra penalty for auth failures
const HARD_BLOCK_PENALTY = 40;        // 403 / forbidden — treat as a hard, non-retryable block
const RATE_PRESSURE_PENALTY = 15;     // 429 / 503 — transient provider pressure; back off fast

/**
 * When a provider keeps failing, we don't want to emit a `provider_failure`
 * line on every single attempt (3 per request, every poll) — that floods the
 * logs into the thousands while telling us nothing new. Once a provider has
 * failed this many times consecutively, we log only 1-in-N failures plus the
 * circuit transitions.
 */
const LOG_THROTTLE_AFTER = 5;         // start throttling after this many consecutive failures
const LOG_THROTTLE_EVERY = 20;        // then log only 1-in-N repeated failures

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

/**
 * Capability dimension for capability-aware circuit breaking.
 *
 * A provider is NOT a single monolithic health unit. Angel One's historical
 * endpoint can be returning 503 while its live WebSocket is perfectly healthy.
 * The reliability spec requires that we degrade only the affected capability
 * ("Angel historical = DEGRADED, Angel live = HEALTHY") and route accordingly,
 * rather than downing the whole provider.
 */
export type Capability =
  | "liveQuotes"
  | "historicalCandles"
  | "optionChain"
  | "instrumentMaster"
  | "webSocket";

/**
 * Composite state key. When `capability` is omitted the key is the bare
 * provider id — this is the provider-wide circuit and preserves the original
 * behaviour for every existing caller. When a capability is supplied the key
 * becomes `${id}::${capability}`, giving that endpoint its own circuit.
 */
function stateKey(id: ProviderId, capability?: Capability): string {
  return capability ? `${id}::${capability}` : id;
}

// Global registry of health states, keyed by provider id or provider+capability.
const states = new Map<string, HealthState>();

function getState(id: ProviderId, capability?: Capability): HealthState {
  const key = stateKey(id, capability);
  let s = states.get(key);
  if (!s) {
    s = freshState();
    states.set(key, s);
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
export function isCircuitOpen(id: ProviderId, now = Date.now(), capability?: Capability): boolean {
  const s = getState(id, capability);
  if (!s.circuitOpen) return false;
  if (s.circuitRetryAt != null && now >= s.circuitRetryAt) {
    // Half-open: allow one probe call through.
    return false;
  }
  return true;
}

/**
 * Capability-aware circuit check. A capability is considered unavailable when
 * EITHER its own capability circuit is open OR the provider-wide circuit is
 * open (a provider-wide hard failure — e.g. auth — takes everything down).
 */
export function isCapabilityCircuitOpen(
  id: ProviderId,
  capability: Capability,
  now = Date.now(),
): boolean {
  return isCircuitOpen(id, now) || isCircuitOpen(id, now, capability);
}

/** Reset health state (used in tests and after manual provider re-enable). */
export function resetHealth(id: ProviderId, capability?: Capability): void {
  states.set(stateKey(id, capability), freshState());
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
export function recordSuccess(id: ProviderId, latencyMs: number, capability?: Capability): void {
  const s = getState(id, capability);
  s.consecutiveFailures = 0;
  s.consecutiveSuccesses += 1;
  s.lastSuccessAt = Date.now();
  s.score = Math.min(100, s.score + RECOVERY_PER_SUCCESS);
  recordLatency(s, latencyMs);

  // Close the circuit on a successful probe.
  if (s.circuitOpen) {
    s.circuitOpen = false;
    s.circuitRetryAt = null;
    mdLog("provider_recovery", { providerId: id, capability: capability ?? null, score: s.score });
  }
}

export type FailureKind =
  | "api_error"
  | "auth_failure"
  | "ws_disconnect"
  | "timeout"
  /** HTTP 429 — rate limited. Retryable only after the Retry-After cooldown. */
  | "rate_limit"
  /** HTTP 503 / 5xx — provider temporarily unavailable. Backoff + fail over. */
  | "unavailable"
  /** Network-level failure: ECONNRESET / DNS / connection refused. */
  | "network"
  /** Body present but failed validation/parse. */
  | "malformed"
  /** HTTP 403 / forbidden — an upstream WAF/gateway block. Non-retryable:
   *  hammering it won't help and usually flags the IP further. */
  | "hard_block";

/**
 * Map a MarketDataError code to the health-layer FailureKind.
 * Falls back to `api_error` for anything unmapped.
 */
export function codeToFailureKind(code: string | undefined): FailureKind {
  switch (code) {
    case "AUTH_FAILURE":
      return "auth_failure";
    case "AUTHORIZATION_FAILURE":
      return "hard_block";
    case "RATE_LIMIT":
      return "rate_limit";
    case "UNAVAILABLE":
      return "unavailable";
    case "TIMEOUT":
      return "timeout";
    case "NETWORK":
      return "network";
    case "MALFORMED_RESPONSE":
    case "INVALID_RESPONSE":
      return "malformed";
    default:
      return "api_error";
  }
}

/** Failure kinds that must NOT be retried within the same provider. */
export function isNonRetryableWithinProvider(kind: FailureKind): boolean {
  return kind === "auth_failure" || kind === "hard_block";
}

/** Escalating half-open window: the longer a provider stays down, the less
 *  often we probe it — 30s, 60s, 120s … capped at CIRCUIT_RETRY_MAX_MS. This
 *  is what stops the every-30s open/probe/re-open flapping loop. */
function circuitRetryDelayMs(consecutiveFailures: number): number {
  const openings = Math.max(0, consecutiveFailures - 4); // ~how many times it's re-opened
  const delay = CIRCUIT_RETRY_MS * 2 ** openings;
  return Math.min(CIRCUIT_RETRY_MAX_MS, delay);
}

/** True when this repeated failure should be suppressed from the log to avoid
 *  flooding. We always log the first few, then only 1-in-N after that. */
function shouldThrottleLog(consecutiveFailures: number): boolean {
  if (consecutiveFailures <= LOG_THROTTLE_AFTER) return false;
  return consecutiveFailures % LOG_THROTTLE_EVERY !== 0;
}

/**
 * Record a failed call. Increments consecutive failure count, applies a
 * progressive score penalty, and opens the circuit when score falls below
 * the threshold.
 */
export function recordFailure(
  id: ProviderId,
  kind: FailureKind,
  message?: string,
  capability?: Capability,
): void {
  const s = getState(id, capability);
  s.consecutiveSuccesses = 0;
  s.consecutiveFailures += 1;
  s.lastFailureAt = Date.now();

  // Progressive penalty: each additional failure hurts more.
  const base = Math.min(MAX_FAILURE_PENALTY, 5 * s.consecutiveFailures);
  const authExtra = kind === "auth_failure" ? AUTH_FAILURE_PENALTY : 0;
  // A hard block (403) is as bad as an auth failure — drive the score down
  // fast so we open the circuit and stop retrying immediately.
  const hardBlockExtra = kind === "hard_block" ? HARD_BLOCK_PENALTY : 0;
  // Rate-limit (429) and unavailable (503) are transient provider-pressure
  // signals. We still want to back off and eventually open the circuit under a
  // sustained storm, so apply a moderate extra penalty — enough that a burst of
  // 429/503 opens the circuit quickly (protecting the provider from a request
  // storm) without permanently condemning it the way a 403/auth failure does.
  const pressureExtra =
    kind === "rate_limit" || kind === "unavailable" ? RATE_PRESSURE_PENALTY : 0;
  s.score = Math.max(0, s.score - base - authExtra - hardBlockExtra - pressureExtra);

  if (!shouldThrottleLog(s.consecutiveFailures)) {
    mdLog("provider_failure", {
      providerId: id,
      capability: capability ?? null,
      kind,
      consecutiveFailures: s.consecutiveFailures,
      score: s.score,
      message,
    });
  }

  if (!s.circuitOpen && s.score < CIRCUIT_OPEN_THRESHOLD) {
    s.circuitOpen = true;
    s.circuitRetryAt = Date.now() + circuitRetryDelayMs(s.consecutiveFailures);
    mdLog(capability ? "capability_circuit_open" : "provider_circuit_open", {
      providerId: id,
      capability: capability ?? null,
      score: s.score,
      retryAt: new Date(s.circuitRetryAt).toISOString(),
    });
  } else if (s.circuitOpen) {
    // A half-open probe just failed. Push the retry window out again (with
    // escalating backoff) instead of re-probing every CIRCUIT_RETRY_MS — this
    // is what prevents the open → probe → re-open flapping under a sustained
    // outage. Not logged as a new circuit-open event to keep logs quiet.
    s.circuitRetryAt = Date.now() + circuitRetryDelayMs(s.consecutiveFailures);
  }
}

/**
 * Record a stale data event (data received but timestamps are too old).
 * Applies a flat score penalty without opening the circuit immediately.
 */
export function recordStaleData(
  id: ProviderId,
  ageMs: number,
  thresholdMs: number,
  capability?: Capability,
): void {
  const s = getState(id, capability);
  s.score = Math.max(0, s.score - STALE_DATA_PENALTY);
  mdLog("stale_data", { providerId: id, capability: capability ?? null, ageMs, thresholdMs, score: s.score });
}

// ── Snapshot ─────────────────────────────────────────────────────────────────

/** Return a read-only health snapshot for a provider (optionally a capability). */
export function getProviderHealth(id: ProviderId, capability?: Capability): ProviderHealth {
  const s = getState(id, capability);
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
  const allIds: ProviderId[] = ["scrapling", "angel_one", "upstox", "yahoo"];
  return allIds.map((id) => getProviderHealth(id));
}

/** The capabilities we track independent circuits for, per provider. */
export const TRACKED_CAPABILITIES: readonly Capability[] = [
  "liveQuotes",
  "historicalCandles",
  "optionChain",
  "instrumentMaster",
  "webSocket",
];

/**
 * Return a capability-resolved health map for a provider:
 *   { provider: <provider-wide>, capabilities: { liveQuotes: <health>, ... } }
 *
 * A capability's effective status is the WORSE of its own circuit and the
 * provider-wide circuit, so a provider-wide outage correctly shows every
 * capability as unhealthy even if that capability was never individually hit.
 */
export function getProviderCapabilityHealth(id: ProviderId): {
  provider: ProviderHealth;
  capabilities: Record<Capability, ProviderHealth>;
} {
  const provider = getProviderHealth(id);
  const capabilities = {} as Record<Capability, ProviderHealth>;
  for (const cap of TRACKED_CAPABILITIES) {
    const capHealth = getProviderHealth(id, cap);
    // Effective status/circuit is the worse of the two.
    const circuitOpen = provider.circuitOpen || capHealth.circuitOpen;
    const score = Math.min(provider.score, capHealth.score);
    const status: ProviderHealthStatus = circuitOpen
      ? "unhealthy"
      : score < DEGRADED_THRESHOLD
        ? "degraded"
        : "healthy";
    capabilities[cap] = { ...capHealth, status, score, circuitOpen };
  }
  return { provider, capabilities };
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
  | "provider_switch"
  | "provider_recovery"
  | "provider_circuit_open"
  | "provider_degraded"
  | "rate_limited"
  | "capability_circuit_open"
  | "stale_data"
  | "data_mismatch";

/** Structured log emitter. Replace with your observability sink as needed. */
export function mdLog(event: LogEvent, payload: Record<string, unknown>): void {
  console.log(
    JSON.stringify({ ts: new Date().toISOString(), event, ...payload }),
  );
}
