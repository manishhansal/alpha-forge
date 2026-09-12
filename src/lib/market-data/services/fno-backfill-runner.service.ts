/**
 * fno-backfill-runner.service.ts — Data Foundation V7 §5.
 *
 * The universe-scale, capability-aware, resumable historical backfill runner.
 *
 * It composes the existing durable orchestrator (`runBackfill`, which already
 * gives chunking / checkpointing / resumability / per-chunk provider
 * observations) with:
 *
 *   - a REAL capability-aware `ChunkFetcher` that calls Angel One (equities)
 *     and Upstox V3 (indices + 1m/3m + fallback), grounded in the live-probed
 *     provider capabilities (2026-09-12);
 *   - retry with exponential backoff + a lightweight per-provider circuit
 *     breaker (the two capabilities the orchestrator lacked);
 *   - request deduplication within a run;
 *   - a bounded concurrency pool across the universe (never a request storm);
 *   - feature-driven depth: the backfill range per interval is derived from
 *     `feature-lookback.service` (longest actual dependency), never a fixed
 *     5-day window.
 *
 * ABSOLUTE RULES: never fabricates; an EMPTY provider response is recorded as
 * EMPTY (not zero-filled); an index is NEVER sent to Angel (returns false
 * EMPTY); provenance (provider + datasetVersion) is stamped on every persisted
 * bar by the orchestrator.
 */

import "server-only";

import type { Redis } from "ioredis";
import type { Interval, OHLCVCandle, ProviderId } from "../types";
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

// ── Provider fetch adapters ────────────────────────────────────────────────

/**
 * The concrete provider fetchers. Injected lazily so this module stays testable
 * and does not statically import the heavy provider clients at module load.
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

/** Default fetchers backed by the real provider clients. */
export async function defaultProviderFetchers(): Promise<ProviderFetchers> {
  const { angel } = await import("@/services/india/angelone");
  const { UpstoxProvider } = await import("../providers/upstox");
  const upstox = new UpstoxProvider();
  return {
    async angelGetHistorical({ symbol, interval, fromIso, toIso }) {
      // Angel takes a range string; compute day-span from the window.
      const days = Math.max(
        1,
        Math.ceil((Date.parse(toIso) - Date.parse(fromIso)) / 86_400_000),
      );
      const res = (await angel.getHistorical(
        { symbol, interval, range: `${days}d` } as never,
        { allowFallback: false },
      )) as OHLCVCandle[];
      return res;
    },
    async upstoxGetHistoricalV3({ symbol, interval, fromIso, toIso }) {
      const res = (await upstox.getHistoricalCandlesV3({
        symbol,
        exchange: "NSE",
        interval: interval as never,
        from: fromIso,
        to: toIso,
      } as never)) as OHLCVCandle[];
      return res;
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
 * index/3m routing (index → never Angel) and wrap with breaker + backoff.
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
  fetchers?: ProviderFetchers;
  /** Bounded concurrency across the universe (default 3 — respect provider rps). */
  concurrency?: number;
  /** Override the from-date (IST YYYY-MM-DD). Default: feature-driven depth. */
  fromIstDate?: string;
  /** Override the to-date (IST YYYY-MM-DD). Default: today IST. */
  toIstDate?: string;
  signal?: AbortSignal;
}

export interface FnoBackfillJobResult {
  symbol: string;
  interval: Interval;
  provider: ProviderId | null;
  state: BackfillCheckpoint["state"];
  barsPersisted: number;
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
 * Run (or resume) a universe-scale backfill. Each (symbol, interval) job is a
 * resumable orchestrator job; jobs run through a bounded concurrency pool.
 * De-duplicates identical (symbol, interval) pairs. Never throws — a failed job
 * is captured in its result row.
 */
export async function runFnoUniverseBackfill(
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
        return { symbol: job.symbol, interval: job.interval, provider: null, state: "PARTIAL", barsPersisted: 0, error: "aborted" };
      }
      const fromIstDate = opts.fromIstDate ?? fromIstDateForInterval(job.interval);
      // Capability-aware provider order for this concrete symbol+interval.
      const providers = historyProvidersForSymbol(job.symbol, job.interval);
      const primary = providers[0] ?? null;
      if (!primary) {
        return { symbol: job.symbol, interval: job.interval, provider: null, state: "BLOCKED", barsPersisted: 0, error: `no history provider for ${job.symbol} ${job.interval}` };
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
          error: ckpt.lastError ?? null,
        };
      } catch (err) {
        return { symbol: job.symbol, interval: job.interval, provider: primary, state: "FAILED", barsPersisted: 0, error: (err as Error).message.slice(0, 200) };
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
