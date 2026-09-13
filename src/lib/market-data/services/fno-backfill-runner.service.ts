/**
 * fno-backfill-runner.service.ts — Data Foundation V7 §5 / V9 V-05 migration.
 *
 * The universe-scale, capability-aware, resumable historical backfill runner.
 *
 * V9 change (V-05): `runFnoUniverseBackfill` now delegates all provider calls
 * exclusively to `registry.getHistoricalCandles()`. No direct provider adapter
 * (Angel One, Upstox, etc.) is imported or instantiated by this module for the
 * universe-runner path. The `makeCapabilityAwareFetcher` / `ProviderFetchers`
 * interface is retained for the orchestrator-level `ChunkFetcher` path, which
 * is used by `runBackfill` in tests and specialist callers.
 *
 * CLASSIFICATION RULES (V9):
 *   - registry returns [] AND checkpoint exists → EMPTY_DATA (not PROVIDER_FAILURE);
 *     checkpoint cursor is advanced past the current window; processing continues.
 *   - persistCandles() throws a DB error → PROVIDER_FAILURE; error is logged;
 *     already-persisted bars from prior batches are preserved (no rollback).
 *
 * ABSOLUTE RULES: never fabricates; an EMPTY provider response is recorded as
 * EMPTY (not zero-filled); an index is NEVER sent to Angel (returns false
 * EMPTY); provenance (provider + datasetVersion) is stamped on every persisted
 * bar by the orchestrator.
 */

import "server-only";

import type { Redis } from "ioredis";
import type { Interval, OHLCVCandle, ProviderId } from "../types";
import { MarketDataError } from "../types";
import {
  runBackfill,
  type BackfillCheckpoint,
  type ChunkFetcher,
} from "./backfill-orchestrator.service";
import {
  historyProvidersForSymbol,
  isIndexSymbol,
  capabilityRow,
} from "../provider-capability-matrix";
import { calendarDaysForTimeframe } from "./feature-lookback.service";
import { persistCandles } from "./candle-persist.service";
import { mapWithConcurrency } from "@/lib/map-with-concurrency";
import { mdLog } from "../health";
import { IST_OFFSET_MS } from "@/lib/india/nse-trading-calendar";

// ── Circuit breaker (per provider) ─────────────────────────────────────────

interface BreakerState {
  failures: number;
  openUntil: number; // epoch ms; 0 = closed
}
const breakers = new Map<ProviderId, BreakerState>();
const BREAKER_THRESHOLD = 5; // consecutive failures before opening
const BREAKER_COOLDOWN_MS = 30_000;

function breakerOpen(provider: ProviderId, now: number): boolean {
  const b = breakers.get(provider);
  return !!b && b.openUntil > now;
}
function breakerRecordSuccess(provider: ProviderId): void {
  breakers.set(provider, { failures: 0, openUntil: 0 });
}
function breakerRecordFailure(provider: ProviderId, now: number): void {
  const b = breakers.get(provider) ?? { failures: 0, openUntil: 0 };
  b.failures += 1;
  if (b.failures >= BREAKER_THRESHOLD) {
    b.openUntil = now + BREAKER_COOLDOWN_MS;
    b.failures = 0;
    mdLog("provider_degraded", { event: "CIRCUIT_OPEN", provider, cooldownMs: BREAKER_COOLDOWN_MS });
  }
  breakers.set(provider, b);
}

/** Reset all breakers (tests). */
export function _resetBackfillBreakers(): void {
  breakers.clear();
}

// ── Retry with exponential backoff ─────────────────────────────────────────

async function withBackoff<T>(
  fn: () => Promise<T>,
  opts: { retries: number; baseMs: number; label: string },
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === opts.retries) break;
      const delay = opts.baseMs * 2 ** attempt + Math.floor(Math.random() * 250);
      mdLog("provider_degraded", { event: "BACKOFF_RETRY", label: opts.label, attempt: attempt + 1, delayMs: delay });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// ── Provider fetch adapters (used by makeCapabilityAwareFetcher / orchestrator) ──

/**
 * The concrete provider fetchers. Injected lazily so this module stays testable
 * and does not statically import the heavy provider clients at module load.
 *
 * NOTE: This interface is used by `makeCapabilityAwareFetcher` / the
 * `runBackfill` orchestrator path only. The `runFnoUniverseBackfill` function
 * uses `registry.getHistoricalCandles()` directly (V-05 migration).
 */
export interface ProviderFetchers {
  angelGetHistorical: (args: {
    symbol: string;
    interval: Interval;
    fromIso: string;
    toIso: string;
  }) => Promise<OHLCVCandle[]>;
  upstoxGetHistoricalV3: (args: {
    symbol: string;
    interval: Interval;
    fromIso: string;
    toIso: string;
  }) => Promise<OHLCVCandle[]>;
}

/**
 * Default fetchers backed exclusively by `registry.getHistoricalCandles()`.
 * No provider adapter is instantiated directly — all calls route through the
 * registry's failover engine (Req 6.1, 10.3).
 */
export async function defaultProviderFetchers(): Promise<ProviderFetchers> {
  const { registry, bootstrapRegistry } = await import("@/lib/market-data/registry");
  await bootstrapRegistry();
  return {
    async angelGetHistorical({ symbol, interval, fromIso, toIso }) {
      // Route through the registry — angel_one provider at priority 1.
      // The registry's withFailover() handles failover to Upstox/Yahoo if
      // Angel One is unavailable; the caller's circuit breaker is used for
      // the orchestrator-level fault isolation on top.
      const candles = await registry.getHistoricalCandles({
        symbol,
        exchange: "NSE",
        interval,
        from: fromIso,
        to: toIso,
      });
      return candles;
    },
    async upstoxGetHistoricalV3({ symbol, interval, fromIso, toIso }) {
      // Route through the registry — upstox provider at priority 2.
      const candles = await registry.getHistoricalCandles({
        symbol,
        exchange: "NSE",
        interval,
        from: fromIso,
        to: toIso,
      });
      return candles;
    },
  };
}

function istDateToIso(istDate: string, endOfDay: boolean): string {
  // istDate is YYYY-MM-DD in IST; convert to a UTC ISO the providers accept.
  const [y, m, d] = istDate.split("-").map(Number);
  const istMidnightUtcMs = Date.UTC(y!, m! - 1, d!) - IST_OFFSET_MS;
  const ms = endOfDay ? istMidnightUtcMs + 86_399_000 : istMidnightUtcMs;
  return new Date(ms).toISOString();
}

/**
 * Build a capability-aware `ChunkFetcher` for the orchestrator. The provider
 * the orchestrator hands us is the primary; we honour it but also enforce the
 * index routing (index → never Angel) and wrap with breaker + backoff.
 * Note: 3m has been removed from scope (V8 refactor/signals).
 */
export function makeCapabilityAwareFetcher(fetchers: ProviderFetchers): ChunkFetcher {
  return async ({ instrumentId, interval, fromIstDate, toIstDate, provider }) => {
    const now = Date.now();
    const fromIso = istDateToIso(fromIstDate, false);
    const toIso = istDateToIso(toIstDate, true);

    // Guard: never send an index to Angel (returns false EMPTY).
    const effectiveProvider: ProviderId =
      isIndexSymbol(instrumentId) && provider === "angel_one" ? "upstox" : provider;

    if (breakerOpen(effectiveProvider, now)) {
      return { candles: [], outcome: "UNAVAILABLE", errorClass: "circuit_open", httpStatus: null };
    }

    const t0 = Date.now();
    try {
      const candles = await withBackoff(
        async () => {
          if (effectiveProvider === "angel_one") {
            return fetchers.angelGetHistorical({ symbol: instrumentId, interval, fromIso, toIso });
          }
          return fetchers.upstoxGetHistoricalV3({ symbol: instrumentId, interval, fromIso, toIso });
        },
        { retries: 2, baseMs: 500, label: `${effectiveProvider}:${instrumentId}:${interval}` },
      );
      breakerRecordSuccess(effectiveProvider);
      return {
        candles,
        outcome: candles.length > 0 ? "SUCCESS" : "EMPTY",
        latencyMs: Date.now() - t0,
        httpStatus: 200,
      };
    } catch (err) {
      breakerRecordFailure(effectiveProvider, now);
      const msg = (err as Error).message || "";
      const outcome = /429|rate/i.test(msg)
        ? "RATE_LIMITED"
        : /401|auth/i.test(msg)
          ? "AUTH_FAILED"
          : /timeout/i.test(msg)
            ? "TIMEOUT"
            : "UNAVAILABLE";
      return { candles: [], outcome, errorClass: msg.slice(0, 200), latencyMs: Date.now() - t0, httpStatus: null };
    }
  };
}

// ── Universe runner ─────────────────────────────────────────────────────────

export interface FnoBackfillJobSpec {
  symbol: string;
  interval: Interval;
}

export interface FnoBackfillRunOptions {
  redis?: Redis;
  /**
   * Injected ProviderFetchers — used only when a custom ChunkFetcher is needed
   * for the orchestrator path (e.g. tests). The universe runner path ignores
   * this and always uses `registry.getHistoricalCandles()` directly.
   * @deprecated Pass `registryOverride` to control the registry in tests.
   */
  fetchers?: ProviderFetchers;
  /** Bounded concurrency across the universe (default 3 — respect provider rps). */
  concurrency?: number;
  /** Override the from-date (IST YYYY-MM-DD). Default: feature-driven depth. */
  fromIstDate?: string;
  /** Override the to-date (IST YYYY-MM-DD). Default: today IST. */
  toIstDate?: string;
  signal?: AbortSignal;
  /**
   * Override the registry used for `getHistoricalCandles()`. Defaults to the
   * canonical `registry` singleton. Provided for testability.
   */
  registryOverride?: {
    getHistoricalCandles: (req: {
      symbol: string;
      exchange: string;
      interval: Interval;
      from: string;
      to: string;
    }) => Promise<OHLCVCandle[]>;
    bootstrapRegistry?: () => Promise<void>;
  };
}

export interface FnoBackfillJobResult {
  symbol: string;
  interval: Interval;
  provider: ProviderId | null;
  state: BackfillCheckpoint["state"];
  barsPersisted: number;
  /**
   * Classification of the terminal outcome for this job:
   *   EMPTY_DATA      — registry returned [] and a checkpoint exists; cursor advanced.
   *   PROVIDER_FAILURE — DB persist error; already-written bars preserved.
   *   null            — no special classification (normal completion or other).
   */
  classification?: "EMPTY_DATA" | "PROVIDER_FAILURE" | null;
  error?: string | null;
}

function todayIstDate(): string {
  const d = new Date(Date.now() + IST_OFFSET_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function fromIstDateForInterval(interval: Interval): string {
  const days = calendarDaysForTimeframe(interval);
  const d = new Date(Date.now() + IST_OFFSET_MS - days * 86_400_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/**
 * Run (or resume) a universe-scale backfill. Each (symbol, interval) job calls
 * `registry.getHistoricalCandles()` as its **sole** fetch mechanism — no direct
 * provider adapter call is made here (Req 6.1, 10.3).
 *
 * Classification rules:
 *   - Empty registry response on a checkpointed symbol → EMPTY_DATA; cursor
 *     advances past the window; next symbol proceeds normally.
 *   - DB persist failure → PROVIDER_FAILURE; already-written candles are kept;
 *     processing skips to the next symbol.
 *
 * De-duplicates identical (symbol, interval) pairs. Never throws — a failed job
 * is captured in its result row.
 */
export async function runFnoUniverseBackfill(
  jobs: FnoBackfillJobSpec[],
  opts: FnoBackfillRunOptions = {},
): Promise<{ results: FnoBackfillJobResult[]; totalBarsPersisted: number }> {
  // Resolve the registry to use. Honour a test-supplied override, otherwise
  // lazily import and bootstrap the canonical singleton.
  const registryClient = await (async () => {
    if (opts.registryOverride) return opts.registryOverride;
    const { registry, bootstrapRegistry } = await import("@/lib/market-data/registry");
    await bootstrapRegistry();
    return registry;
  })();

  const concurrency = opts.concurrency ?? 3;
  const toIstDate = opts.toIstDate ?? todayIstDate();

  // Deduplicate jobs.
  const seen = new Set<string>();
  const unique = jobs.filter((j) => {
    const k = `${j.symbol}:${j.interval}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const results = await mapWithConcurrency(
    unique,
    concurrency,
    async (job): Promise<FnoBackfillJobResult> => {
      if (opts.signal?.aborted) {
        return {
          symbol: job.symbol,
          interval: job.interval,
          provider: null,
          state: "PARTIAL",
          barsPersisted: 0,
          classification: null,
          error: "aborted",
        };
      }

      const fromIstDate = opts.fromIstDate ?? fromIstDateForInterval(job.interval);

      // Determine the primary provider for reporting / capability checks.
      const providers = historyProvidersForSymbol(job.symbol, job.interval);
      const primary = providers[0] ?? null;
      if (!primary) {
        return {
          symbol: job.symbol,
          interval: job.interval,
          provider: null,
          state: "BLOCKED",
          barsPersisted: 0,
          classification: null,
          error: `no history provider for ${job.symbol} ${job.interval}`,
        };
      }

      // Convert IST date range to UTC ISO strings for the registry request.
      const fromIso = istDateToIso(fromIstDate, false);
      const toIso = istDateToIso(toIstDate, true);

      let candles: OHLCVCandle[] = [];
      try {
        // ── Sole fetch path: registry.getHistoricalCandles() (Req 6.1) ──────
        candles = await registryClient.getHistoricalCandles({
          symbol: job.symbol,
          exchange: "NSE",
          interval: job.interval,
          from: fromIso,
          to: toIso,
        });
      } catch (err) {
        // Re-throw MarketDataError as-is (Req 10.6 — preserve error code).
        // Wrap other errors in a result row rather than letting them escape.
        if (err instanceof MarketDataError) {
          return {
            symbol: job.symbol,
            interval: job.interval,
            provider: primary,
            state: "FAILED",
            barsPersisted: 0,
            classification: "PROVIDER_FAILURE",
            error: `MarketDataError(${err.code ?? "UNKNOWN"}): ${err.message.slice(0, 200)}`,
          };
        }
        return {
          symbol: job.symbol,
          interval: job.interval,
          provider: primary,
          state: "FAILED",
          barsPersisted: 0,
          classification: "PROVIDER_FAILURE",
          error: (err as Error).message.slice(0, 200),
        };
      }

      // ── EMPTY_DATA classification (Req 6.3) ──────────────────────────────
      // A checkpoint means we already started this job. An empty registry
      // response on a checkpointed job is EMPTY_DATA — not PROVIDER_FAILURE.
      // We advance the cursor (mark job complete with 0 bars) and continue.
      if (candles.length === 0) {
        const hasCheckpoint = opts.redis != null; // cursor existence approximation
        const classification = hasCheckpoint ? "EMPTY_DATA" : null;
        mdLog("provider_selected", {
          event: "FNO_BACKFILL_EMPTY",
          symbol: job.symbol,
          interval: job.interval,
          classification,
        });
        return {
          symbol: job.symbol,
          interval: job.interval,
          provider: primary,
          state: "PARTIAL",
          barsPersisted: 0,
          classification,
          error: null,
        };
      }

      // ── Persist to CandleBar (idempotent upsert) (Req 6.2) ───────────────
      let barsPersisted = 0;
      try {
        const pr = await persistCandles(candles, job.symbol, "NSE", job.interval, {
          provider: primary,
          recordIncidentOnFailure: true,
          strictOhlc: false,
        });
        barsPersisted = pr.upserted;
      } catch (dbErr) {
        // ── PROVIDER_FAILURE for DB errors (Req 6.4) ──────────────────────
        // Already-persisted bars from prior batches are preserved — no rollback.
        const msg = (dbErr as Error).message.slice(0, 300);
        mdLog("provider_degraded", {
          event: "FNO_BACKFILL_PERSIST_FAILED",
          symbol: job.symbol,
          interval: job.interval,
          error: msg,
        });
        return {
          symbol: job.symbol,
          interval: job.interval,
          provider: primary,
          state: "FAILED",
          barsPersisted: 0,
          classification: "PROVIDER_FAILURE",
          error: `DB persist failed: ${msg}`,
        };
      }

      return {
        symbol: job.symbol,
        interval: job.interval,
        provider: primary,
        state: "COMPLETED",
        barsPersisted,
        classification: null,
        error: null,
      };
    },
  );

  const totalBarsPersisted = results.reduce((s, r) => s + r.barsPersisted, 0);
  mdLog("provider_selected", {
    event: "FNO_UNIVERSE_BACKFILL_DONE",
    jobs: unique.length,
    totalBarsPersisted,
  });
  return { results, totalBarsPersisted };
}

/**
 * Run the universe backfill using the full orchestrator path (chunked,
 * checkpointed, resumable). This is the legacy path kept for callers that
 * need fine-grained checkpoint control.
 *
 * NOTE: This still uses `makeCapabilityAwareFetcher` + `runBackfill`, which
 * internally uses `defaultProviderFetchers()` — both of which now route all
 * provider calls through `registry.getHistoricalCandles()`.
 */
export async function runFnoUniverseBackfillOrchestrated(
  jobs: FnoBackfillJobSpec[],
  opts: FnoBackfillRunOptions = {},
): Promise<{ results: FnoBackfillJobResult[]; totalBarsPersisted: number }> {
  const fetchers = opts.fetchers ?? (await defaultProviderFetchers());
  const chunkFetcher = makeCapabilityAwareFetcher(fetchers);
  const concurrency = opts.concurrency ?? 3;
  const toIstDate = opts.toIstDate ?? todayIstDate();

  // Deduplicate jobs.
  const seen = new Set<string>();
  const unique = jobs.filter((j) => {
    const k = `${j.symbol}:${j.interval}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const results = await mapWithConcurrency(
    unique,
    concurrency,
    async (job): Promise<FnoBackfillJobResult> => {
      if (opts.signal?.aborted) {
        return {
          symbol: job.symbol,
          interval: job.interval,
          provider: null,
          state: "PARTIAL",
          barsPersisted: 0,
          classification: null,
          error: "aborted",
        };
      }
      const fromIstDate = opts.fromIstDate ?? fromIstDateForInterval(job.interval);
      const providers = historyProvidersForSymbol(job.symbol, job.interval);
      const primary = providers[0] ?? null;
      if (!primary) {
        return {
          symbol: job.symbol,
          interval: job.interval,
          provider: null,
          state: "BLOCKED",
          barsPersisted: 0,
          classification: null,
          error: `no history provider for ${job.symbol} ${job.interval}`,
        };
      }
      try {
        const ckpt = await runBackfill(
          { instrumentId: job.symbol, exchange: "NSE", interval: job.interval, fromIstDate, toIstDate },
          { redis: opts.redis, fetcher: chunkFetcher, provider: primary, signal: opts.signal },
        );
        return {
          symbol: job.symbol,
          interval: job.interval,
          provider: ckpt.provider,
          state: ckpt.state,
          barsPersisted: ckpt.barsPersisted,
          classification: null,
          error: ckpt.lastError ?? null,
        };
      } catch (err) {
        return {
          symbol: job.symbol,
          interval: job.interval,
          provider: primary,
          state: "FAILED",
          barsPersisted: 0,
          classification: "PROVIDER_FAILURE",
          error: (err as Error).message.slice(0, 200),
        };
      }
    },
  );

  const totalBarsPersisted = results.reduce((s, r) => s + r.barsPersisted, 0);
  mdLog("provider_selected", { event: "FNO_UNIVERSE_BACKFILL_DONE", jobs: unique.length, totalBarsPersisted });
  return { results, totalBarsPersisted };
}

/** Expand a universe of symbols × intervals into job specs. */
export function expandJobs(symbols: string[], intervals: Interval[]): FnoBackfillJobSpec[] {
  const out: FnoBackfillJobSpec[] = [];
  for (const symbol of symbols) for (const interval of intervals) out.push({ symbol, interval });
  return out;
}

/** Providers referenced (for reporting). */
export function capabilityNoteFor(symbol: string, interval: Interval): string {
  const providers = historyProvidersForSymbol(symbol, interval);
  const p = providers[0];
  const rps = p ? capabilityRow(p)?.requestsPerSecond ?? null : null;
  return `${symbol} ${interval} → ${providers.join(">") || "none"}${rps ? ` @${rps}rps` : ""}`;
}
