/**
 * FillEvent — confirms that an order has been executed.
 *
 * Produced by the FillModel after slippage and commission have been applied.
 * The FillEvent is the single source of truth for actual trade economics —
 * the Portfolio model updates itself exclusively from fills, never from orders.
 *
 * Lookahead audit fields
 * ──────────────────────
 * `signalTimestampMs` and `executionTimestampMs` are always stored so any
 * post-run audit can verify that execution never preceded signal generation.
 */

import { makeEventId } from "./market-event";
import type { BaseEvent, InstrumentId } from "./market-event";
import type { OrderSide, OrderIntent } from "./order-event";
import type { SignalDirection } from "./signal-event";

export interface FillEvent extends BaseEvent {
  readonly type: "FILL_EVENT";
  /** Back-references for full audit trail. */
  readonly orderEventId: string;
  readonly signalEventId: string;
  readonly instrument: InstrumentId;
  readonly side: OrderSide;
  readonly intent: OrderIntent;
  readonly direction: SignalDirection;
  /** Quantity actually filled (lots / shares). */
  readonly qty: number;
  /** Gross fill price before commission (post-slippage). */
  readonly fillPrice: number;
  /** Commission charged on this fill (INR). */
  readonly commission: number;
  /** Slippage cost in price units (fillPrice − idealPrice). */
  readonly slippage: number;
  /** Net cost: qty × fillPrice × lotSize + commission. */
  readonly netCost: number;
  /**
   * UTC ms when the underlying signal was generated.
   * INVARIANT: signalTimestampMs < executionTimestampMs
   */
  readonly signalTimestampMs: number;
  /**
   * UTC ms of the bar on which the fill occurred.
   * For NEXT_BAR_OPEN fills this is the open of bar N+1.
   */
  readonly executionTimestampMs: number;
  /** Bar index on which the fill occurred. */
  readonly executionBarIndex: number;
  /**
   * Optional execution-layer metadata (e.g. IndiaFillExtras).
   * Typed as a loose record so the events layer stays decoupled from
   * the execution layer's specific extras types.
   */
  readonly extras?: Record<string, number | string | boolean | null | undefined>;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function buildFillEvent(opts: {
  sourceEventId: string;
  orderEventId: string;
  signalEventId: string;
  timestampMs: number;
  instrument: InstrumentId;
  side: OrderSide;
  intent: OrderIntent;
  direction: SignalDirection;
  qty: number;
  fillPrice: number;
  commission: number;
  slippage: number;
  signalTimestampMs: number;
  executionTimestampMs: number;
  executionBarIndex: number;
  extras?: Record<string, number | string | boolean | null | undefined>;
}): FillEvent {
  const netCost =
    opts.qty * opts.fillPrice * opts.instrument.lotSize + opts.commission;
  return {
    id: makeEventId("fill"),
    type: "FILL_EVENT",
    timestampMs: opts.timestampMs,
    sourceEventId: opts.sourceEventId,
    orderEventId: opts.orderEventId,
    signalEventId: opts.signalEventId,
    instrument: opts.instrument,
    side: opts.side,
    intent: opts.intent,
    direction: opts.direction,
    qty: opts.qty,
    fillPrice: opts.fillPrice,
    commission: opts.commission,
    slippage: opts.slippage,
    netCost: opts.side === "BUY" ? netCost : -netCost,
    signalTimestampMs: opts.signalTimestampMs,
    executionTimestampMs: opts.executionTimestampMs,
    executionBarIndex: opts.executionBarIndex,
    extras: opts.extras,
  };
}
