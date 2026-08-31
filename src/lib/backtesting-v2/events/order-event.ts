/**
 * OrderEvent — a risk-checked, exchange-ready order.
 *
 * Produced by the risk layer from a SignalEvent. The order carries the full
 * quantity (in lots/shares) already sized by the PositionSizer, and the
 * price constraints the ExecutionModel must honour.
 */

import { makeEventId } from "./market-event";
import type { BaseEvent, InstrumentId } from "./market-event";
import type { SignalDirection } from "./signal-event";

export type OrderType =
  | "MARKET"  // Fill at best available price
  | "LIMIT"   // Fill only at limitPrice or better
  | "STOP"    // Triggered when price crosses stopTrigger, then market fill
  | "STOP_LIMIT"; // Triggered like STOP, fill at limitPrice or better

export type OrderSide = "BUY" | "SELL";

/** Whether this order opens or closes a position. */
export type OrderIntent = "OPEN" | "CLOSE" | "STOP_LOSS" | "TAKE_PROFIT";

export interface OrderEvent extends BaseEvent {
  readonly type: "ORDER_EVENT";
  /** Back-reference to the signal that spawned this order. */
  readonly signalEventId: string;
  readonly instrument: InstrumentId;
  readonly side: OrderSide;
  readonly intent: OrderIntent;
  readonly direction: SignalDirection;
  readonly orderType: OrderType;
  /** Quantity in lots (F&O) or shares (cash equity). Always positive. */
  readonly qty: number;
  /** For LIMIT / STOP_LIMIT orders. */
  readonly limitPrice?: number;
  /** For STOP / STOP_LIMIT orders — the trigger price. */
  readonly stopTriggerPrice?: number;
  /**
   * The bar index AFTER which this order is valid for execution.
   * For NEXT_BAR_OPEN timing this is `signalBarIndex + 1`.
   * ExecutionModel must refuse to fill this order at barIndex <= validFromBar.
   */
  readonly validFromBarIndex: number;
  /**
   * Expiry: if not filled by this bar index, cancel the order.
   * Default: validFromBarIndex (good-for-bar; fill the next bar or cancel).
   */
  readonly expiryBarIndex: number;
  /** Optional: maximum acceptable slippage in price units. */
  readonly maxSlippage?: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function buildOrderEvent(opts: {
  sourceEventId: string;
  timestampMs: number;
  signalEventId: string;
  instrument: InstrumentId;
  side: OrderSide;
  intent: OrderIntent;
  direction: SignalDirection;
  orderType: OrderType;
  qty: number;
  limitPrice?: number;
  stopTriggerPrice?: number;
  validFromBarIndex: number;
  expiryBarIndex?: number;
  maxSlippage?: number;
}): OrderEvent {
  return {
    id: makeEventId("ord"),
    type: "ORDER_EVENT",
    timestampMs: opts.timestampMs,
    sourceEventId: opts.sourceEventId,
    signalEventId: opts.signalEventId,
    instrument: opts.instrument,
    side: opts.side,
    intent: opts.intent,
    direction: opts.direction,
    orderType: opts.orderType,
    qty: opts.qty,
    limitPrice: opts.limitPrice,
    stopTriggerPrice: opts.stopTriggerPrice,
    validFromBarIndex: opts.validFromBarIndex,
    expiryBarIndex: opts.expiryBarIndex ?? opts.validFromBarIndex,
    maxSlippage: opts.maxSlippage,
  };
}
