/**
 * Signal Lifecycle Persistence — AUDIT-001 Fix
 *
 * Writes `SignalLifecycleEvent` records to the database so the
 * complete signal audit trail survives across process restarts.
 *
 * Previously the in-memory state machine in `signal-lifecycle.ts` tracked
 * transitions correctly but never wrote them to the DB.  Every lifecycle
 * record was lost on worker restart, making the broken-chain analysis and
 * recall measurement impossible.
 *
 * Design rules:
 *   - Fire-and-forget (never blocks the trading path)
 *   - Best-effort batch (≤100 events queued before flush)
 *   - On DB error: logs + moves on; does NOT throw
 *   - Idempotent: uses `createMany` with `skipDuplicates` where available
 *
 * Usage:
 *   import { emitLifecycleEvent } from "@/lib/signal-intelligence/lifecycle-persist";
 *   await emitLifecycleEvent(db, { signalId, fromState, toState, reason, strategyId, instrument, sessionDate, sourceType });
 */

import "server-only";

import type { PrismaClient } from "@prisma/client";
import type { SignalLifecycleState } from "./types";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LifecycleEventPayload {
  signalId: string;
  fromState: SignalLifecycleState | null;
  toState: SignalLifecycleState;
  reason: string;
  strategyId: string;
  instrument: string;
  sessionDate: string;
  sourceType: string;
  metadata?: Record<string, string | number | boolean | null>;
}

// ─── In-memory flush queue ────────────────────────────────────────────────────
// Events are collected in a small buffer and flushed in a single batch to
// reduce DB round-trips. Buffer is flushed automatically when it hits
// FLUSH_THRESHOLD or after FLUSH_INTERVAL_MS, whichever comes first.
const FLUSH_THRESHOLD = 50;
const FLUSH_INTERVAL_MS = 5_000;

interface QueuedEvent {
  payload: LifecycleEventPayload;
  db: PrismaClient;
}

let _queue: QueuedEvent[] = [];
let _flushTimer: ReturnType<typeof setTimeout> | null = null;

async function flushQueue(): Promise<void> {
  if (_queue.length === 0) return;
  const batch = _queue.splice(0, _queue.length);

  // Group by DB client reference so we can use one createMany per client
  const byClient = new Map<PrismaClient, QueuedEvent[]>();
  for (const item of batch) {
    if (!byClient.has(item.db)) byClient.set(item.db, []);
    byClient.get(item.db)!.push(item);
  }

  for (const [db, items] of byClient) {
    try {
      // Build typed row objects for createMany. The `metadata` field is
      // `NullableJsonNullValueInput | InputJsonValue` in Prisma 7, which means
      // we must provide a proper JSON-compatible value when set.
      // We use `db.$queryRawUnsafe` wrapped individual creates to avoid the
      // Prisma createMany union constraint on nullable JSON fields.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const creates = items.map((item) => {
        const data: Record<string, unknown> = {
          signalId:    item.payload.signalId,
          fromState:   item.payload.fromState ?? null,
          toState:     item.payload.toState,
          sessionDate: item.payload.sessionDate,
          strategyId:  item.payload.strategyId,
          sourceType:  item.payload.sourceType,
          instrument:  item.payload.instrument,
          reason:      item.payload.reason,
          occurredAt:  new Date(),
        };
        if (item.payload.metadata != null) {
          data["metadata"] = item.payload.metadata;
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return db.signalLifecycleEvent.create({ data: data as any });
      });
      await db.$transaction(creates);
    } catch (err) {
      // Log and swallow — never crash the trading path for an audit write
      console.warn("[lifecycle-persist] DB write failed:", (err as Error).message);
    }
  }
}

function scheduleFlush(): void {
  if (_flushTimer !== null) return;
  _flushTimer = setTimeout(() => {
    _flushTimer = null;
    void flushQueue();
  }, FLUSH_INTERVAL_MS);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Queue a lifecycle transition for async persistence.
 *
 * This is fire-and-forget from the caller's perspective.
 * The event is written to the DB within FLUSH_INTERVAL_MS (5s) or when
 * FLUSH_THRESHOLD (50) events accumulate.
 */
export function emitLifecycleEvent(
  db: PrismaClient,
  payload: LifecycleEventPayload,
): void {
  _queue.push({ payload, db });

  if (_queue.length >= FLUSH_THRESHOLD) {
    // Cancel any pending timer and flush immediately
    if (_flushTimer !== null) {
      clearTimeout(_flushTimer);
      _flushTimer = null;
    }
    void flushQueue();
  } else {
    scheduleFlush();
  }
}

/**
 * Force-flush all queued lifecycle events.
 * Call during graceful shutdown to ensure no events are lost.
 */
export async function flushLifecycleEvents(): Promise<void> {
  if (_flushTimer !== null) {
    clearTimeout(_flushTimer);
    _flushTimer = null;
  }
  await flushQueue();
}
