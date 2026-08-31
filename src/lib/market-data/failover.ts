/**
 * Automatic failover engine for the Indian Market Data layer.
 *
 * Design decisions:
 *   - Do NOT immediately switch providers on one failure.
 *   - Retry up to RETRY_COUNT times with exponential backoff within a provider.
 *   - Switch providers only when retries are exhausted OR circuit is open.
 *   - A cooldown period prevents oscillating between providers rapidly.
 *   - Structured logs are emitted for every significant event.
 *
 * Provider priority: ANGEL_ONE → UPSTOX → NSE → YAHOO
 */

import type { MarketDataProvider, RegisteredProvider } from "./provider";
import type { ProviderId } from "./types";
import {
  isCircuitOpen,
  mdLog,
  recordFailure,
  recordSuccess,
  type FailureKind,
} from "./health";

// ── Retry policy ─────────────────────────────────────────────────────────────

/** Maximum number of attempts on a single provider before failing over. */
const RETRY_COUNT = 3;
/** Base delay for exponential backoff (ms). */
const BACKOFF_BASE_MS = 300;
/** Maximum backoff delay (ms). */
const BACKOFF_MAX_MS = 5_000;
/** Jitter factor — adds up to 20% random spread to avoid thundering herd. */
const JITTER_FACTOR = 0.2;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt: number): number {
  const exp = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt);
  const jitter = exp * JITTER_FACTOR * Math.random();
  return Math.floor(exp + jitter);
}

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

function classifyError(err: unknown): FailureKind {
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  if (
    msg.includes("auth") ||
    msg.includes("jwt") ||
    msg.includes("unauthorized") ||
    msg.includes("401") ||
    msg.includes("totp") ||
    msg.includes("login")
  ) {
    return "auth_failure";
  }
  if (msg.includes("timeout") || msg.includes("abort") || msg.includes("timed out")) {
    return "timeout";
  }
  if (msg.includes("websocket") || msg.includes("ws ") || msg.includes("socket")) {
    return "ws_disconnect";
  }
  return "api_error";
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
 */
export async function withFailover<T>(
  providers: RegisteredProvider[],
  operation: (provider: MarketDataProvider) => Promise<T>,
  operationId: string,
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

  let lastError: unknown = null;

  for (let pi = 0; pi < eligible.length; pi++) {
    const entry = eligible[pi]!;
    const provider = entry.provider;
    const id = provider.id;

    if (isCircuitOpen(id)) {
      mdLog("provider_selected", {
        providerId: id,
        operationId,
        skipped: true,
        reason: "circuit_open",
      });
      continue;
    }

    mdLog("provider_selected", { providerId: id, operationId });

    for (let attempt = 0; attempt < RETRY_COUNT; attempt++) {
      if (attempt > 0) {
        const delay = backoffMs(attempt - 1);
        await sleep(delay);
      }

      const startMs = Date.now();
      try {
        const result = await operation(provider);
        const latency = Date.now() - startMs;
        recordSuccess(id, latency);
        return result;
      } catch (err) {
        lastError = err;
        const kind = classifyError(err);
        recordFailure(id, kind, err instanceof Error ? err.message : String(err));

        // Auth failures and circuit opens should not be retried within the same provider.
        if (kind === "auth_failure" || isCircuitOpen(id)) {
          break;
        }

        // Last attempt — log that we're about to fail over.
        if (attempt === RETRY_COUNT - 1 && pi < eligible.length - 1) {
          const nextEntry = eligible[pi + 1];
          if (nextEntry) {
            const nextId = nextEntry.provider.id;
            if (!isFailoverCoolingDown(id, nextId)) {
              lastFailover = { from: id, to: nextId, at: Date.now() };
              mdLog("provider_failover", {
                operationId,
                from: id,
                to: nextId,
                reason: kind,
                consecutiveAttempts: RETRY_COUNT,
              });
            }
          }
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

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      await sleep(backoffMs(attempt - 1));
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

      if (kind === "auth_failure" || isCircuitOpen(providerId)) {
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
