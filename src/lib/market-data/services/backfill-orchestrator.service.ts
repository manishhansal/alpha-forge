/**
 * backfill-orchestrator.service.ts — Data Foundation V3 §4/§5/§6/§44.
 *
 * Durable, resumable, chunked, idempotent intraday historical backfill.
 *
 * Design:
 *   - A job is (instrument, exchange, interval, [start,end]). It is planned into
 *     chunks whose size is the provider's `maxChunkDays` from the capability
 *     matrix (respecting API limits).
 *   - Progress is checkpointed to Redis after EVERY chunk: which chunk index we
 *     finished, how many bars persisted, and per-chunk outcome. A crash resumes
 *     at the checkpoint — never from zero, never re-persisting (idempotent via
 *     the CandleBar composite unique key).
 *   - Every chunk request records a `ProviderObservation` (latency, status,
 *     record count, outcome) so provider reliability is measured from real
 *     calls.
 *   - Valid candles are persisted with full provenance (provider +
 *     datasetVersion + sourceTimestamp) and OHLC-integrity checked.
 *   - NOTHING is fabricated. If the provider returns nothing (e.g. no
 *     credentials for a history-capable provider), the chunk is EMPTY and the
 *     job ends PARTIAL/BLOCKED — never filled with synthetic bars.
 *
 * State machine: PENDING → RUNNING → (PARTIAL | FAILED | COMPLETED | BLOCKED).
 *
 * Safety (§44): idempotent, resumable, cancellable, observable, retryable,
 * checkpointed. Never truncates, drops, or rebuilds the table.
 */

import "server-only";

import type { Redis } from "ioredis";
import type { OHLCVCandle, Interval, ProviderId } from "../types";
import { historyProvidersFor, capabilityRow } from "../provider-capability-matrix";
import { persistCandles } from "./candle-persist.service";
import { recordProviderObservation, type ObservationOutcome } from "./provider-observation.service";
import { datasetVersion } from "../dataset-version";
import { mdLog } from "../health";
import { IST_OFFSET_MS } from "@/lib/india/nse-trading-calendar";

export type BackfillState =
  | "PENDING"
  | "RUNNING"
  | "PARTIAL"
  | "FAILED"
  | "COMPLETED"
  | "BLOCKED";

export interface BackfillChunk {
  index: number;
  fromIstDate: string; // inclusive
  toIstDate: string; // inclusive
}

export interface BackfillCheckpoint {
  jobKey: string;
  instrumentId: string;
  exchange: string;
  interval: Interval;
  fromIstDate: string;
  toIstDate: string;
  totalChunks: number;
  /** Highest chunk index fully COMPLETED (persisted or confirmed-empty). -1 = none. */
  lastCompletedChunk: number;
  barsPersisted: number;
  state: BackfillState;
  provider: ProviderId | null;
  updatedAt: string;
  /** Per-chunk outcome log (bounded). */
  chunkOutcomes: Array<{ index: number; outcome: string; bars: number }>;
  lastError?: string | null;
}

/**
 * A candle fetcher the orchestrator calls per chunk. Injected so the
 * orchestrator is testable and provider-agnostic. Must return the candles the
 * provider actually served for the window (may be empty). Implementations
 * SHOULD attach `sourceTimestamp` per candle when the provider supplies it.
 */
export type ChunkFetcher = (args: {
  instrumentId: string;
  exchange: string;
  interval: Interval;
  fromIstDate: string;
  toIstDate: string;
  provider: ProviderId;
}) => Promise<{
  candles: OHLCVCandle[];
  httpStatus?: number | null;
  outcome: ObservationOutcome;
  latencyMs?: number | null;
  errorClass?: string | null;
}>;

export interface BackfillOptions {
  redis?: Redis;
  /** Chunk fetcher. Required to actually acquire data. */
  fetcher: ChunkFetcher;
  /** Override the chunk size (days). Defaults to the provider capability. */
  chunkDays?: number;
  /** Provider to use; default is the highest-priority history provider for the interval. */
  provider?: ProviderId;
  /** Abort signal for cancellation (§44 cancellable). */
  signal?: AbortSignal;
  /** Where to read the current session date from (testability). */
  now?: () => number;
}

const CHECKPOINT_PREFIX = "backfill:ckpt:";
const CHECKPOINT_TTL_SEC = 7 * 24 * 3600;

function jobKey(instrumentId: string, exchange: string, interval: Interval, from: string, to: string): string {
  return `${exchange}:${instrumentId}:${interval}:${from}:${to}`;
}

function toIstDateString(utcMs: number): string {
  const ist = new Date(utcMs + IST_OFFSET_MS);
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, "0")}-${String(ist.getUTCDate()).padStart(2, "0")}`;
}

function addDays(istDate: string, days: number): string {
  const [y, m, d] = istDate.split("-").map(Number);
  return toIstDateString(Date.UTC(y!, m! - 1, d!) + days * 86_400_000);
}

/** Plan chunks over [from,to] with a max span of `chunkDays` per chunk. */
export function planChunks(fromIstDate: string, toIstDate: string, chunkDays: number): BackfillChunk[] {
  const chunks: BackfillChunk[] = [];
  let start = fromIstDate;
  let index = 0;
  for (let guard = 0; guard < 5000; guard++) {
    if (start > toIstDate) break;
    let end = addDays(start, chunkDays - 1);
    if (end > toIstDate) end = toIstDate;
    chunks.push({ index, fromIstDate: start, toIstDate: end });
    index += 1;
    start = addDays(end, 1);
  }
  return chunks;
}

async function loadCheckpoint(redis: Redis | undefined, key: string): Promise<BackfillCheckpoint | null> {
  if (!redis) return null;
  try {
    const raw = await redis.get(CHECKPOINT_PREFIX + key);
    return raw ? (JSON.parse(raw) as BackfillCheckpoint) : null;
  } catch {
    return null;
  }
}

async function saveCheckpoint(redis: Redis | undefined, ckpt: BackfillCheckpoint): Promise<void> {
  if (!redis) return;
  try {
    await redis.set(CHECKPOINT_PREFIX + ckpt.jobKey, JSON.stringify(ckpt), "EX", CHECKPOINT_TTL_SEC);
  } catch (err) {
    mdLog("stale_data", { reason: "backfill_checkpoint_save_failed", jobKey: ckpt.jobKey, error: (err as Error).message });
  }
}

export interface RunBackfillInput {
  instrumentId: string;
  exchange: string;
  interval: Interval;
  fromIstDate: string;
  toIstDate: string;
}

/**
 * Run (or resume) a backfill job. Resumable: if a checkpoint exists for the
 * same job key, chunks up to `lastCompletedChunk` are skipped.
 */
export async function runBackfill(
  input: RunBackfillInput,
  opts: BackfillOptions,
): Promise<BackfillCheckpoint> {
  const key = jobKey(input.instrumentId, input.exchange, input.interval, input.fromIstDate, input.toIstDate);

  // Pick provider: explicit → first history-capable for the interval.
  const historyProviders = historyProvidersFor(input.interval);
  const provider = opts.provider ?? historyProviders[0] ?? null;

  // Chunk size from capability matrix (respect API limits).
  const capDays = provider ? capabilityRow(provider)?.intervals[input.interval]?.maxChunkDays ?? 30 : 30;
  const chunkDays = Math.max(1, opts.chunkDays ?? capDays);
  const chunks = planChunks(input.fromIstDate, input.toIstDate, chunkDays);

  const existing = await loadCheckpoint(opts.redis, key);
  const ckpt: BackfillCheckpoint = existing ?? {
    jobKey: key,
    instrumentId: input.instrumentId,
    exchange: input.exchange,
    interval: input.interval,
    fromIstDate: input.fromIstDate,
    toIstDate: input.toIstDate,
    totalChunks: chunks.length,
    lastCompletedChunk: -1,
    barsPersisted: 0,
    state: "PENDING",
    provider,
    updatedAt: new Date().toISOString(),
    chunkOutcomes: [],
  };

  // No history-capable provider available at all → BLOCKED (never fabricate).
  if (!provider) {
    ckpt.state = "BLOCKED";
    ckpt.lastError = `no history-capable provider for interval ${input.interval}`;
    ckpt.updatedAt = new Date().toISOString();
    await saveCheckpoint(opts.redis, ckpt);
    mdLog("provider_degraded", { event: "BACKFILL_BLOCKED", jobKey: key, reason: ckpt.lastError });
    return ckpt;
  }

  ckpt.state = "RUNNING";
  ckpt.provider = provider;
  await saveCheckpoint(opts.redis, ckpt);

  let anyPersisted = ckpt.barsPersisted > 0;
  let anyEmpty = false;
  let sawError = false;

  for (const chunk of chunks) {
    if (chunk.index <= ckpt.lastCompletedChunk) continue; // resume: skip done
    if (opts.signal?.aborted) {
      ckpt.state = "PARTIAL";
      ckpt.lastError = "cancelled";
      ckpt.updatedAt = new Date().toISOString();
      await saveCheckpoint(opts.redis, ckpt);
      return ckpt;
    }

    const dv = datasetVersion(chunk.fromIstDate, { kind: "provider", provider });
    const t0 = Date.now();
    let fetchOutcome: ObservationOutcome = "EMPTY";
    let httpStatus: number | null = null;
    let errorClass: string | null = null;
    let candles: OHLCVCandle[] = [];
    let latencyMs: number | null = null;
    let chunkHardFailed = false;

    try {
      const res = await opts.fetcher({
        instrumentId: input.instrumentId,
        exchange: input.exchange,
        interval: input.interval,
        fromIstDate: chunk.fromIstDate,
        toIstDate: chunk.toIstDate,
        provider,
      });
      candles = res.candles ?? [];
      fetchOutcome = res.outcome;
      httpStatus = res.httpStatus ?? null;
      errorClass = res.errorClass ?? null;
      latencyMs = res.latencyMs ?? Date.now() - t0;
    } catch (err) {
      sawError = true;
      chunkHardFailed = true;
      fetchOutcome = "UNAVAILABLE";
      errorClass = (err as Error).message;
      latencyMs = Date.now() - t0;
    }

    // A hard provider failure (exception, or a retryable error outcome) means
    // this chunk did NOT complete — it must remain resumable so a later run
    // retries it rather than silently skipping (no data is ever lost).
    const HARD_FAIL: ObservationOutcome[] = ["UNAVAILABLE", "AUTH_FAILED", "RATE_LIMITED", "TIMEOUT", "NETWORK"];
    if (HARD_FAIL.includes(fetchOutcome)) chunkHardFailed = true;

    // Persist valid candles with provenance (idempotent). Empty is fine.
    let bars = 0;
    if (candles.length > 0) {
      const stamped = candles.map((c) => ({ ...c, sourceTimestamp: c.sourceTimestamp }));
      const pr = await persistCandles(stamped, input.instrumentId, input.exchange, input.interval, {
        provider,
        datasetVersion: dv,
        recordIncidentOnFailure: true,
        strictOhlc: true,
      });
      bars = pr.upserted;
      if (pr.upserted > 0) anyPersisted = true;
    } else if (fetchOutcome === "EMPTY" || fetchOutcome === "SUCCESS") {
      anyEmpty = true;
    }

    // Record the real provider observation for the scorecard.
    await recordProviderObservation({
      provider,
      instrumentId: input.instrumentId,
      dataType: "CANDLE",
      requestType: "backfill-chunk",
      interval: input.interval,
      requestStart: chunk.fromIstDate,
      requestEnd: chunk.toIstDate,
      httpStatus,
      outcome: fetchOutcome,
      errorClass,
      latencyMs,
      recordCount: candles.length,
      qualityStatus: candles.length > 0 ? "AVAILABLE" : "UNAVAILABLE",
      failoverPosition: historyProviders.indexOf(provider),
    });

    // Checkpoint after every chunk (resumability). A hard-failed chunk is NOT
    // marked complete — bars persisted (if any) are recorded, but the chunk
    // stays retryable so resume re-attempts it. We stop here so resume picks up
    // at exactly this chunk rather than skipping ahead.
    ckpt.barsPersisted += bars;
    ckpt.chunkOutcomes.push({ index: chunk.index, outcome: fetchOutcome, bars });
    if (ckpt.chunkOutcomes.length > 500) ckpt.chunkOutcomes = ckpt.chunkOutcomes.slice(-500);
    if (!chunkHardFailed) {
      ckpt.lastCompletedChunk = chunk.index;
    }
    ckpt.updatedAt = new Date().toISOString();
    await saveCheckpoint(opts.redis, ckpt);

    if (chunkHardFailed) {
      ckpt.lastError = errorClass;
      break; // leave the job resumable at this chunk
    }

    // Respect provider rate budget between chunks.
    const rps = capabilityRow(provider)?.requestsPerSecond ?? 3;
    await new Promise((r) => setTimeout(r, Math.ceil(1000 / Math.max(1, rps))));
  }

  // Final state.
  if (sawError && !anyPersisted) ckpt.state = "FAILED";
  else if (anyPersisted && (anyEmpty || sawError)) ckpt.state = "PARTIAL";
  else if (anyPersisted) ckpt.state = "COMPLETED";
  else ckpt.state = "PARTIAL"; // ran to completion but acquired nothing (no fabrication)
  ckpt.updatedAt = new Date().toISOString();
  await saveCheckpoint(opts.redis, ckpt);

  mdLog("provider_selected", {
    event: "BACKFILL_DONE",
    jobKey: key,
    state: ckpt.state,
    barsPersisted: ckpt.barsPersisted,
    chunks: chunks.length,
    provider,
  });
  return ckpt;
}

/** Read the current checkpoint for a job (observability). */
export async function getBackfillCheckpoint(
  input: RunBackfillInput,
  redis?: Redis,
): Promise<BackfillCheckpoint | null> {
  const key = jobKey(input.instrumentId, input.exchange, input.interval, input.fromIstDate, input.toIstDate);
  return loadCheckpoint(redis, key);
}
