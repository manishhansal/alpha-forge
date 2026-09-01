/**
 * PositionEvent — emitted by the Portfolio after it processes a FillEvent.
 *
 * Provides a point-in-time snapshot of a specific position after a change.
 * Downstream analytics subscribe to these to build equity curves, drawdown
 * charts, and attribution tables without having to re-walk the fill log.
 */

import { makeEventId } from "./market-event";
import type { BaseEvent, InstrumentId } from "./market-event";
import type { SignalDirection } from "./signal-event";

export type PositionEventStatus =
  | "OPEN"
  | "CLOSED"
  | "PARTIAL";  // Partially closed (future: partial exits)

export interface PositionEvent extends BaseEvent {
  readonly type: "PORTFOLIO_UPDATE";
  /** Unique id for this position (stable across OPEN/UPDATE/CLOSE events). */
  readonly positionId: string;
  readonly fillEventId: string;
  readonly instrument: InstrumentId;
  readonly direction: SignalDirection;
  readonly status: PositionEventStatus;
  /** Current quantity held (0 when CLOSED). */
  readonly qty: number;
  /** Weighted-average entry price across all fills for this position. */
  readonly avgEntryPrice: number;
  /** Current mark price (last bar close). */
  readonly markPrice: number;
  /** Unrealised P&L in INR at markPrice. */
  readonly unrealisedPnl: number;
  /** Realised P&L in INR (non-zero on close). */
  readonly realisedPnl: number;
  /** Total commission paid on this position so far. */
  readonly totalCommission: number;
  /** UTC ms when the position was opened. */
  readonly openedAtMs: number;
  /** UTC ms when the position was closed (null while open). */
  readonly closedAtMs: number | null;
  /** Bar index when opened. */
  readonly openBarIndex: number;
  /** Bar index when closed (null while open). */
  readonly closeBarIndex: number | null;
  /** Reason the position was closed (TARGET, STOP, EXPIRY, SESSION_CLOSE, MANUAL). */
  readonly closeReason?: string;
  /** Attribution carried forward from the originating signal. */
  readonly strategyId: string;
  readonly signalId: string;
  readonly marketRegime: string;
  readonly dataQualityScore: number;
  /** Stop and target levels for the position (set at open, may be updated). */
  readonly stopLoss: number;
  readonly target: number;
}

// ── Builder ───────────────────────────────────────────────────────────────────

export function buildPositionEvent(opts: {
  sourceEventId: string;
  timestampMs: number;
  positionId: string;
  fillEventId: string;
  instrument: InstrumentId;
  direction: SignalDirection;
  status: PositionEventStatus;
  qty: number;
  avgEntryPrice: number;
  markPrice: number;
  unrealisedPnl: number;
  realisedPnl: number;
  totalCommission: number;
  openedAtMs: number;
  closedAtMs: number | null;
  openBarIndex: number;
  closeBarIndex: number | null;
  closeReason?: string;
  strategyId: string;
  signalId: string;
  marketRegime: string;
  dataQualityScore: number;
  stopLoss: number;
  target: number;
}): PositionEvent {
  return {
    id: makeEventId("pos"),
    type: "PORTFOLIO_UPDATE",
    ...opts,
  };
}
