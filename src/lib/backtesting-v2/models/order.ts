/**
 * Order model — mutable lifecycle record for a pending or filled order.
 *
 * The engine maintains an order book of pending orders between bars.
 * Each OrderEvent spawns one OrderRecord. The ExecutionModel promotes it to
 * FILLED (producing a FillEvent) or cancels it when its expiry bar passes.
 */

import type { OrderEvent, OrderType, OrderSide, OrderIntent } from "../events/order-event";
import type { SignalDirection } from "../events/signal-event";
import type { InstrumentId } from "../events/market-event";

export type OrderStatus =
  | "PENDING"    // Waiting for its validFromBarIndex
  | "OPEN"       // Active — within validity window, not yet filled
  | "FILLED"     // Fully executed
  | "CANCELLED"  // Expired without fill or manually cancelled
  | "REJECTED";  // Rejected by risk or execution layer

export interface OrderRecord {
  readonly id: string;           // same as OrderEvent.id
  readonly orderEventId: string;
  readonly signalEventId: string;
  readonly instrument: InstrumentId;
  readonly side: OrderSide;
  readonly intent: OrderIntent;
  readonly direction: SignalDirection;
  readonly orderType: OrderType;
  readonly qty: number;
  readonly limitPrice: number | undefined;
  readonly stopTriggerPrice: number | undefined;
  readonly validFromBarIndex: number;
  readonly expiryBarIndex: number;
  readonly maxSlippage: number | undefined;
  /** UTC ms when the originating signal fired — stored for lookahead audit. */
  readonly signalTimestampMs: number;

  /** Mutable state. */
  status: OrderStatus;
  fillEventId: string | null;
  fillPrice: number | null;
  filledAtBarIndex: number | null;
  cancelReason: string | null;
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function orderEventToRecord(evt: OrderEvent): OrderRecord {
  return {
    id: evt.id,
    orderEventId: evt.id,
    signalEventId: evt.signalEventId,
    instrument: evt.instrument,
    side: evt.side,
    intent: evt.intent,
    direction: evt.direction,
    orderType: evt.orderType,
    qty: evt.qty,
    limitPrice: evt.limitPrice,
    stopTriggerPrice: evt.stopTriggerPrice,
    validFromBarIndex: evt.validFromBarIndex,
    expiryBarIndex: evt.expiryBarIndex,
    maxSlippage: evt.maxSlippage,
    signalTimestampMs: evt.timestampMs,  // order was created at signal bar close
    status: "PENDING",
    fillEventId: null,
    fillPrice: null,
    filledAtBarIndex: null,
    cancelReason: null,
  };
}

// ── Order book ────────────────────────────────────────────────────────────────

/**
 * Simple order book: keyed by order id, iterable by insert order.
 * The engine holds exactly one OrderBook per simulation run.
 */
export class OrderBook {
  private readonly _orders = new Map<string, OrderRecord>();

  add(record: OrderRecord): void {
    this._orders.set(record.id, record);
  }

  get(id: string): OrderRecord | undefined {
    return this._orders.get(id);
  }

  /** All orders in insertion order. */
  all(): OrderRecord[] {
    return Array.from(this._orders.values());
  }

  /** Orders eligible for execution at `barIndex`. */
  activeAt(barIndex: number): OrderRecord[] {
    return this.all().filter(
      (o) =>
        (o.status === "PENDING" || o.status === "OPEN") &&
        barIndex >= o.validFromBarIndex &&
        barIndex <= o.expiryBarIndex,
    );
  }

  /** Expire stale orders whose expiryBarIndex has passed. */
  expireStale(barIndex: number): OrderRecord[] {
    const expired: OrderRecord[] = [];
    for (const o of this._orders.values()) {
      if (
        (o.status === "PENDING" || o.status === "OPEN") &&
        barIndex > o.expiryBarIndex
      ) {
        o.status = "CANCELLED";
        o.cancelReason = "EXPIRED_BAR";
        expired.push(o);
      }
    }
    return expired;
  }

  /** Promote PENDING → OPEN for orders that have reached their validFromBarIndex. */
  activateReady(barIndex: number): void {
    for (const o of this._orders.values()) {
      if (o.status === "PENDING" && barIndex >= o.validFromBarIndex) {
        o.status = "OPEN";
      }
    }
  }

  pending(): OrderRecord[] {
    return this.all().filter((o) => o.status === "PENDING" || o.status === "OPEN");
  }

  size(): number {
    return this._orders.size;
  }

  clear(): void {
    this._orders.clear();
  }
}
