/**
 * EventQueue — a strictly-ordered, priority-aware event bus.
 *
 * Ordering guarantee
 * ──────────────────
 * Events are processed in pipeline stage order within the same bar:
 *
 *   MARKET_EVENT(0) → FEATURE_UPDATE(1) → STRATEGY_EVALUATION(2)
 *   → SIGNAL_EVENT(3) → RISK_CHECK(4) → ORDER_EVENT(5)
 *   → EXECUTION(6) → FILL_EVENT(7) → PORTFOLIO_UPDATE(8)
 *
 * Within the same priority level, events are FIFO (insertion order).
 * Events from different bars never interleave — the engine drains the
 * entire queue for bar N before advancing to bar N+1.
 *
 * Synchronous dispatch model
 * ──────────────────────────
 * The backtesting engine is single-threaded and fully synchronous.
 * `dispatch()` invokes handlers in priority order immediately. This makes
 * the event ordering deterministic and the output reproducible.
 */

import type { AnyEvent } from "../events/index";
import type { EventType } from "../events/market-event";

// ── Priority map ──────────────────────────────────────────────────────────────

/** Lower number = processed first. */
const EVENT_PRIORITY: Record<EventType, number> = {
  MARKET_EVENT: 0,
  FEATURE_UPDATE: 1,
  STRATEGY_EVALUATION: 2,
  SIGNAL_EVENT: 3,
  RISK_CHECK: 4,
  ORDER_EVENT: 5,
  EXECUTION: 6,
  FILL_EVENT: 7,
  PORTFOLIO_UPDATE: 8,
  // Session lifecycle — processed immediately before MARKET_EVENT
  SESSION_OPEN: -1,
  SESSION_CLOSE: 9,
  EXPIRY_WARNING: 2,         // same level as STRATEGY_EVALUATION — fires first due to insertion order
  EXPIRY_FORCED_CLOSE: 9,    // same as SESSION_CLOSE
};

export function eventPriority(type: EventType): number {
  return EVENT_PRIORITY[type] ?? 99;
}

// ── Handler types ─────────────────────────────────────────────────────────────

export type EventHandler<T extends AnyEvent = AnyEvent> = (event: T) => void;

export interface HandlerRegistration {
  readonly type: EventType;
  readonly handler: EventHandler;
  readonly label?: string;
}

// ── Queued item ───────────────────────────────────────────────────────────────

interface QueueItem {
  event: AnyEvent;
  priority: number;
  seq: number; // insertion sequence for stable sort within same priority
}

// ── EventQueue ────────────────────────────────────────────────────────────────

export class EventQueue {
  private _queue: QueueItem[] = [];
  private _seq = 0;
  private readonly _handlers = new Map<EventType, EventHandler[]>();

  /** The ordered event log for this simulation run. */
  private readonly _log: AnyEvent[] = [];
  private _logEnabled = true;

  constructor(opts: { logEnabled?: boolean } = {}) {
    this._logEnabled = opts.logEnabled ?? true;
  }

  // ── Registration ────────────────────────────────────────────────────────

  on<T extends AnyEvent>(type: EventType, handler: EventHandler<T>): void {
    const existing = this._handlers.get(type) ?? [];
    existing.push(handler as EventHandler);
    this._handlers.set(type, existing);
  }

  off(type: EventType, handler: EventHandler): void {
    const existing = this._handlers.get(type);
    if (!existing) return;
    const idx = existing.indexOf(handler);
    if (idx !== -1) existing.splice(idx, 1);
  }

  // ── Enqueue ──────────────────────────────────────────────────────────────

  /**
   * Enqueue an event. It will be dispatched when `flush()` is called.
   * Multiple events of the same type are dispatched in FIFO order.
   */
  enqueue(event: AnyEvent): void {
    this._queue.push({
      event,
      priority: eventPriority(event.type),
      seq: this._seq++,
    });
  }

  /**
   * Enqueue and immediately dispatch — bypasses the priority sort.
   * Use only for top-level MARKET_EVENT injection where the caller
   * controls ordering externally.
   */
  dispatchDirect(event: AnyEvent): void {
    if (this._logEnabled) this._log.push(event);
    const handlers = this._handlers.get(event.type) ?? [];
    for (const h of handlers) h(event);
  }

  // ── Flush ────────────────────────────────────────────────────────────────

  /**
   * Drain the queue in priority order, dispatching each event to registered
   * handlers. Handlers may enqueue new events during dispatch — these are
   * picked up in the same flush cycle as long as they have a higher priority
   * than the currently-dispatching event.
   *
   * The flush completes when the queue is empty.
   */
  flush(): void {
    while (this._queue.length > 0) {
      // Stable sort by (priority ASC, seq ASC)
      this._queue.sort((a, b) =>
        a.priority !== b.priority
          ? a.priority - b.priority
          : a.seq - b.seq,
      );

      const item = this._queue.shift()!;
      if (this._logEnabled) this._log.push(item.event);

      const handlers = this._handlers.get(item.event.type) ?? [];
      for (const h of handlers) h(item.event);
    }
  }

  // ── Utility ──────────────────────────────────────────────────────────────

  /** True when the queue has pending events. */
  get hasPending(): boolean {
    return this._queue.length > 0;
  }

  /** Discard all pending events without dispatching. */
  clear(): void {
    this._queue = [];
  }

  /** Ordered log of all dispatched events (for audit / tests). */
  eventLog(): ReadonlyArray<AnyEvent> {
    return this._log;
  }

  clearLog(): void {
    this._log.length = 0;
  }

  /**
   * Extract the ordered type sequence from the event log.
   * Useful for asserting exact pipeline ordering in tests.
   */
  loggedTypes(): EventType[] {
    return this._log.map((e) => e.type);
  }

  /** Count of events dispatched so far. */
  dispatchCount(): number {
    return this._log.length;
  }
}
