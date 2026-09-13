/**
 * Automatic failover engine for the Indian Market Data layer.
 *
 * Design decisions:
 *   - Do NOT immediately switch providers on one failure.
 *   - Retry up to RETRY_COUNT times with exponential backoff within a provider.
 *   - Switch providers only when retries are exhausted OR circuit is open.
 *   - A cooldown period prevents oscillating between providers rapidly.
 *   - Structured logs are emitted for every significant event.
 *   - DataProvenance is stamped on every successful provider call.
 *
 * Provider priority: DATA_SERVICE → ANGEL_ONE → UPSTOX → YAHOO
 * NSE is NOT in the chain. Direct NSE data acquisition is forbidden in production.
 *
 * Requirements: 12.7, 15.6, 16.1, 16.4
 */

import type { MarketDataProvider, RegisteredProvider } from "./provider";
import type { DataProvenance, ProviderId } from "./types";
import {
  isCircuitOpen,
  isCapabilityCircuitOpen,
  mdLog,
  recordFailure,
  recordSuccess,
  codeToFailureKind,
  isNonRetryableWithinProvider,
  type FailureKind,
  type Capability,
} from "./health";
import { MarketDataError } from "./types";
import { stampLiveProvenance } from "./provenance";

// ── Retry policy ─────────────────────────────────────────────────────────────

/** Maximum number of attempts on a single provider before failing over. */
const RETRY_COUNT = 3;
/** Base delay for exponential backoff (ms). */
const BACKOFF_BASE_MS = 300;
/** Maximum backoff delay (ms). */
const BACKOFF_MAX_MS = 5_000;
/** Jitter factor — adds up to 20% random spread to avoid thundering herd. */
const JITTER_FACTOR = 0.2;

/**
 * Backoff schedule for 503 / unavailable failures, per the reliability spec:
 * 1s, 2s, 4s, 8s, 16s, 30s, 60s (with jitter). Indexed by consecutive attempt.
 * We keep the within-request retry count small (RETRY_COUNT) so a single caller
 * never blocks for the whole ladder; the circuit breaker enforces the longer
 * cooldowns across requests.
 */
const UNAVAILABLE_BACKOFF_LADDER_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 60_000];
/** Hard cap on any single honoured Retry-After sleep inside a request (ms). */
const MAX_RETRY_AFTER_SLEEP_MS = 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withJitter(ms: number): number {
  return Math.floor(ms + ms * JITTER_FACTOR * Math.random());
}

function backoffMs(attempt: number): number {
  const exp = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt);
  return withJitter(exp);
}

/**
 * Choose the backoff before the next attempt given the failure kind and any
 * provider-supplied Retry-After. Rate-limit and unavailable failures back off
 * on a longer ladder so we never hammer a pressured provider; a Retry-After
 * (capped) always takes precedence when present.
 */
function backoffForKind(
  kind: FailureKind,
  attempt: number,
  retryAfterMs: number | null,
): number {
  if (retryAfterMs != null && retryAfterMs > 0) {
    return Math.min(MAX_RETRY_AFTER_SLEEP_MS, retryAfterMs);
  }
  if (kind === "unavailable" || kind === "rate_limit") {
    const idx = Math.min(attempt, UNAVAILABLE_BACKOFF_LADDER_MS.length - 1);
    return withJitter(UNAVAILABLE_BACKOFF_LADDER_MS[idx]!);
  }
  return backoffMs(attempt);
}

// ── Provenance store ──────────────────────────────────────────────────────────

/**
 * Per-operation provenance from the most recent `withFailover()` call.
 *
 * Keyed by `operationId` (e.g. "getQuotes", "getHistoricalCandles").
 * Consumers that need the full `DataProvenance` object for a call they just
 * made should call `getLastCallProvenance(operationId)` immediately after the
 * `withFailover` call resolves.  The entry is overwritten on the next call
 * with the same operationId, so it is NOT safe to use across asynchronous
 * boundaries unless the caller awaits the registry method before reading.
 *
 * Requirements 16.1, 16.4
 */
const lastProvenanceByOperation = new Map<string, DataProvenance>();

/**
 * Return the `DataProvenance` stamped by the most recent successful
 * `withFailover()` call for the given `operationId`, or `null` when no
 * successful call has been recorded yet.
 */
export function getLastCallProvenance(operationId: string): DataProvenance | null {
  return lastProvenanceByOperation.get(operationId) ?? null;
}

/** Clear all stored provenance entries (used in tests to reset state). */
export function clearLastCallProvenance(): void {
  lastProvenanceByOperation.clear();
}

/** Reset the failover cooldown state (used in tests). */
export function resetFailoverState(): void {
  lastProvenanceByOperation.clear();
  providerLastSuccessMs.clear();
  lastFailover = null;
}

// ── Per-provider last-success timestamp (for gapMs computation) ───────────────

/**
 * Tracks the UTC epoch-ms of the last successful response from each provider.
 * Used to compute `gapMs` in the PROVIDER_SWITCH structured log (Req 12.7).
 *
 * gapMs = time between the last successful response from the outgoing provider
 *         and the moment the incoming provider is first invoked.
 */
const providerLastSuccessMs = new Map<ProviderId, number>();

// ── Failover cooldown ─────────────────────────────────────────────────────────

/** Minimum time between provider switches (prevents oscillation). */
const FAILOVER_COOLDOWN_MS = 10_000;

interface LastFailover {
  from: ProviderId;
  to: ProviderId;
  at: number; // epoch ms
}

let lastFailover: LastFailover | null = null;

function isFailoverCoolingDown(
  from: ProviderId,
  to: ProviderId,
  now = Date.now(),
): boolean {
  if (!lastFailover) return false;
  if (lastFailover.from !== from || lastFailover.to !== to) return false;
  return now - lastFailover.at < FAILOVER_COOLDOWN_MS;
}

// ── Classify errors ───────────────────────────────────────────────────────────

/**
 * Classify a thrown error into a FailureKind.
 *
 * Preference order:
 *   1. A typed `MarketDataError` carries an authoritative `code` (and often an
 *      `httpStatus`) — use it directly. This is the reliable path.
 *   2. Otherwise fall back to string matching on the message (covers raw
 *      `Error`s thrown by `fetch`, adapters, and third-party libs).
 *
 * The HTTP status codes 403 / 429 / 503 each map to a distinct FailureKind so
 * the retry/backoff/failover policy can differ per status (see withFailover).
 */
export function classifyError(err: unknown): FailureKind {
  // 1. Authoritative: typed MarketDataError. Prefer an explicit HTTP status,
  //    then the typed code; both are far more reliable than message matching.
  if (err instanceof MarketDataError) {
    if (typeof err.httpStatus === "number") {
      return httpStatusToFailureKind(err.httpStatus);
    }
    if (err.code) {
      const kind = codeToFailureKind(err.code);
      if (kind !== "api_error") return kind;
    }
  }

  // 2. Fallback: message-based heuristics for untyped errors.
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();

  // Angel One's historical endpoint returns HTTP 403 (not 429) with the body
  // "Access denied because of exceeding access rate" when its ~3 req/s limit is
  // breached. This is a TRANSIENT rate limit, not a permanent block — classify
  // it as rate_limit so we back off and retry rather than opening the circuit.
  // MUST run before the generic 403→hard_block status match below.
  if (
    msg.includes("exceeding access rate") ||
    msg.includes("access rate") ||
    msg.includes("too many requests") ||
    msg.includes("rate limit")
  ) {
    return "rate_limit";
  }

  // Extract an HTTP status from common "HTTP 503" / "status 429" phrasings.
  const statusMatch = /\b(?:http|status)\s*[:=]?\s*(\d{3})\b/.exec(msg) ?? /\b(\d{3})\b/.exec(msg);
  if (statusMatch) {
    const status = Number(statusMatch[1]);
    if (status === 403) return "hard_block";
    if (status === 401) return "auth_failure";
    if (status === 429) return "rate_limit";
    if (status === 408) return "timeout";
    if (status >= 500) return "unavailable";
  }

  if (msg.includes("forbidden") || msg.includes("blocked")) {
    return "hard_block";
  }
  if (
    msg.includes("service unavailable") ||
    msg.includes("unavailable") ||
    msg.includes("bad gateway") ||
    msg.includes("gateway timeout")
  ) {
    return "unavailable";
  }
  if (
    msg.includes("auth") ||
    msg.includes("jwt") ||
    msg.includes("unauthorized") ||
    msg.includes("totp") ||
    msg.includes("login")
  ) {
    return "auth_failure";
  }
  if (msg.includes("timeout") || msg.includes("abort") || msg.includes("timed out")) {
    return "timeout";
  }
  if (
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("enotfound") ||
    msg.includes("eai_again") ||
    msg.includes("dns") ||
    msg.includes("network")
  ) {
    return "network";
  }
  if (msg.includes("websocket") || msg.includes("ws ") || msg.includes("socket")) {
    return "ws_disconnect";
  }
  return "api_error";
}

/** Map an HTTP status to a FailureKind (used when only a status is available). */
function httpStatusToFailureKind(status: number): FailureKind {
  if (status === 401) return "auth_failure";
  if (status === 403) return "hard_block";
  if (status === 408) return "timeout";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "unavailable";
  return "api_error";
}

/** Extract a provider-supplied Retry-After (ms) from a typed error, if present. */
function retryAfterMsOf(err: unknown): number | null {
  if (err instanceof MarketDataError && typeof err.retryAfterMs === "number") {
    return err.retryAfterMs;
  }
  return null;
}

/**
 * Emit the failover / provider-switch structured logs when we are about to move
 * from `fromId` to the next eligible provider. Respects the failover cooldown so
 * we don't spam a switch line on every attempt during a sustained outage.
 *
 * Emits two events:
 *   - `provider_failover` (legacy, kept for existing log consumers / tests)
 *   - `provider_switch`   (the richer, traceable event required by the spec:
 *      from / to / reason / instrument / gapMs / timestamp — a permanent audit
 *      record emitted at WARN level per Requirements 12.7 and 15.6)
 *
 * `gapMs` is the elapsed time in ms between the last successful response from
 * the outgoing provider and the moment the incoming provider is first invoked
 * (i.e. now).  It is 0 when the outgoing provider has never succeeded in this
 * process lifetime (hot-failover from an uninitialized provider).
 */
function maybeLogFailover(
  eligible: RegisteredProvider[],
  pi: number,
  fromId: ProviderId,
  operationId: string,
  kind: FailureKind,
  err: unknown,
): void {
  if (pi >= eligible.length - 1) return; // no next provider — nothing to switch to
  const nextEntry = eligible[pi + 1];
  if (!nextEntry) return;
  const toId = nextEntry.provider.id;
  if (isFailoverCoolingDown(fromId, toId)) return;

  const now = Date.now();
  lastFailover = { from: fromId, to: toId, at: now };
  const httpStatus = err instanceof MarketDataError ? err.httpStatus ?? null : null;

  // Compute gapMs: elapsed ms since the outgoing provider last succeeded.
  // 0 when the provider has never succeeded (first failover in this process).
  const lastOkMs = providerLastSuccessMs.get(fromId);
  const gapMs = lastOkMs != null ? Math.max(0, now - lastOkMs) : 0;

  // instrument is the operationId label (e.g. "getQuotes::NIFTY" if the caller
  // passes it; otherwise fall back to the operationId itself).
  const instrument = operationId;

  mdLog("provider_failover", {
    operationId,
    from: fromId,
    to: toId,
    reason: kind,
    consecutiveAttempts: RETRY_COUNT,
  });

  // Traceable, never-silent provider switch record — emitted at WARN level.
  // Fields: event, from, to, reason, instrument, gapMs, timestamp (Req 12.7, 15.6).
  const switchPayload = {
    event: "PROVIDER_SWITCH",
    from: fromId,
    to: toId,
    reason: httpStatus ? `HTTP_${httpStatus}` : kind.toUpperCase(),
    instrument,
    gapMs,
    operationId,
    httpStatus,
    timestamp: new Date(now).toISOString(),
  };
  // Use console.warn so PROVIDER_SWITCH events are distinguishable at WARN
  // level in observability pipelines (Requirement 15.6).
  console.warn(JSON.stringify({ ts: new Date(now).toISOString(), level: "WARN", ...switchPayload }));
  // Also route through mdLog so existing log consumers / tests still work.
  mdLog("provider_switch", switchPayload);
}

// ── Core failover executor ────────────────────────────────────────────────────

/**
 * Execute an operation against an ordered list of providers, retrying within
 * each provider before failing over to the next.
 *
 * @param providers   Ordered list of registered providers (highest priority first).
 * @param operation   Async function that takes a `MarketDataProvider` and returns T.
 * @param operationId Human-readable label for structured logs (e.g. "getQuotes").
 * @returns           The result from the first provider that succeeds.
 * @throws            `MarketDataError` when all providers are exhausted.
 *
 * Provenance (Requirements 16.1, 16.4):
 *   After every successful provider call, a `DataProvenance` object is computed
 *   and stored in `lastProvenanceByOperation` keyed by `operationId`.
 *   Callers retrieve it via `getLastCallProvenance(operationId)`.
 */
export async function withFailover<T>(
  providers: RegisteredProvider[],
  operation: (provider: MarketDataProvider) => Promise<T>,
  operationId: string,
  capability?: Capability,
): Promise<T> {
  const { MarketDataError } = await import("./types");

  const eligible = providers.filter((p) => p.enabled);
  if (eligible.length === 0) {
    throw new MarketDataError(
      `No providers enabled for ${operationId}`,
      null,
      "NO_PROVIDER",
    );
  }

  // Track the providers attempted so far for sourceChain in provenance.
  const attemptedProviders: ProviderId[] = [];
  const requestedAtMs = Date.now();

  let lastError: unknown = null;

  for (let pi = 0; pi < eligible.length; pi++) {
    const entry = eligible[pi]!;
    const provider = entry.provider;
    const id = provider.id;

    // Capability-aware skip: a provider is skipped when its provider-wide
    // circuit OR the circuit for this specific capability is open. This lets
    // "Angel historical" be OPEN while "Angel live" stays CLOSED.
    const circuitBlocked = capability
      ? isCapabilityCircuitOpen(id, capability)
      : isCircuitOpen(id);
    if (circuitBlocked) {
      mdLog("provider_selected", {
        providerId: id,
        capability: capability ?? null,
        operationId,
        skipped: true,
        reason: "circuit_open",
      });
      // A downstream provider becoming primary because this one's circuit is
      // open is still a switch worth recording (once, respecting cooldown).
      maybeLogFailover(eligible, pi, id, operationId, "unavailable", lastError);
      continue;
    }

    mdLog("provider_selected", { providerId: id, capability: capability ?? null, operationId });

    // Track this provider as attempted for sourceChain provenance.
    if (!attemptedProviders.includes(id)) {
      attemptedProviders.push(id);
    }

    // Tracks the failure kind + retry-after from the *previous* attempt so the
    // pre-attempt sleep can back off appropriately (503/429 ladder, Retry-After).
    let pendingKind: FailureKind | null = null;
    let pendingRetryAfterMs: number | null = null;

    for (let attempt = 0; attempt < RETRY_COUNT; attempt++) {
      if (attempt > 0) {
        const delay = backoffForKind(pendingKind ?? "api_error", attempt - 1, pendingRetryAfterMs);
        await sleep(delay);
      }

      const startMs = Date.now();
      try {
        const result = await operation(provider);
        const latency = Date.now() - startMs;
        recordSuccess(id, latency, capability);

        // ── Provenance stamping (Requirements 16.1, 16.4) ─────────────────
        // Classify the operation for isLive / isHistorical flags.
        const isLive =
          operationId === "getQuotes" || operationId === "getLatestQuote";
        const isHistorical = operationId === "getHistoricalCandles";

        // Extract dataAsOf from the result when available.
        // MDQuote[] → first element's fetchedAt; OHLCVCandle[] → first candle's time; OptionChain → fetchedAt.
        let dataAsOf: string | number | null = null;
        if (Array.isArray(result)) {
          const first = result[0];
          if (first && typeof (first as Record<string, unknown>)["fetchedAt"] === "string") {
            dataAsOf = (first as Record<string, unknown>)["fetchedAt"] as string;
          } else if (first && typeof (first as Record<string, unknown>)["time"] === "number") {
            // OHLCVCandle: time is epoch seconds → convert to ms
            dataAsOf = ((first as Record<string, unknown>)["time"] as number) * 1_000;
          }
        } else if (result && typeof (result as Record<string, unknown>)["fetchedAt"] === "string") {
          dataAsOf = (result as Record<string, unknown>)["fetchedAt"] as string;
        }

        const provenance = stampLiveProvenance({
          providerId: id,
          dataAsOf,
          isLive,
          isHistorical,
          requestedAtMs,
          sourceChain: attemptedProviders.slice(0, -1), // providers before the current one
        });

        lastProvenanceByOperation.set(operationId, provenance);
        providerLastSuccessMs.set(id, Date.now());
        // ── End provenance stamping ────────────────────────────────────────

        return result;
      } catch (err) {
        lastError = err;
        const kind = classifyError(err);
        const retryAfterMs = retryAfterMsOf(err);
        recordFailure(id, kind, err instanceof Error ? err.message : String(err), capability);
        pendingKind = kind;
        pendingRetryAfterMs = retryAfterMs;

        // 429 gets a dedicated structured log so ops can see rate-limit pressure
        // distinctly from generic failures, including the honoured cooldown.
        if (kind === "rate_limit") {
          mdLog("rate_limited", {
            providerId: id,
            operationId,
            retryAfterMs: retryAfterMs ?? null,
            attempt,
          });
        }

        // Non-retryable within the provider: auth failures and hard blocks (403).
        // Also stop if the circuit just opened. In every case, do NOT keep
        // hammering this provider — fail over immediately.
        const circuitNowOpen = capability
          ? isCapabilityCircuitOpen(id, capability)
          : isCircuitOpen(id);
        if (isNonRetryableWithinProvider(kind) || circuitNowOpen) {
          maybeLogFailover(eligible, pi, id, operationId, kind, err);
          break;
        }

        // Exhausted retries on a retryable failure — announce the failover.
        if (attempt === RETRY_COUNT - 1) {
          maybeLogFailover(eligible, pi, id, operationId, kind, err);
        }
      }
    }
  }

  const { MarketDataError: MDErr } = await import("./types");
  throw new MDErr(
    `All providers exhausted for ${operationId}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    null,
    "NO_PROVIDER",
  );
}

/**
 * Lightweight single-provider wrapper with retry + backoff, no failover.
 * Used internally by provider adapters for individual API calls.
 */
export async function withRetry<T>(
  providerId: ProviderId,
  operation: () => Promise<T>,
  operationId: string,
  maxAttempts = RETRY_COUNT,
): Promise<T> {
  let lastError: unknown = null;

  let pendingKind: FailureKind | null = null;
  let pendingRetryAfterMs: number | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      await sleep(backoffForKind(pendingKind ?? "api_error", attempt - 1, pendingRetryAfterMs));
    }
    const startMs = Date.now();
    try {
      const result = await operation();
      recordSuccess(providerId, Date.now() - startMs);
      return result;
    } catch (err) {
      lastError = err;
      const kind = classifyError(err);
      recordFailure(providerId, kind, err instanceof Error ? err.message : String(err));
      pendingKind = kind;
      pendingRetryAfterMs = retryAfterMsOf(err);

      if (isNonRetryableWithinProvider(kind) || isCircuitOpen(providerId)) {
        break;
      }
    }
  }

  const { MarketDataError } = await import("./types");
  throw new MarketDataError(
    `${providerId} ${operationId} failed after ${maxAttempts} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    providerId,
  );
}
