/**
 * Position model — tracks a single open or closed directional bet.
 *
 * A position is opened by a BUY/SELL fill and closed by the opposing fill.
 * It accumulates P&L mark-to-market on every bar and freezes realised P&L
 * on close. All monetary values are in INR.
 *
 * NSE lot-size semantics
 * ──────────────────────
 * For F&O instruments qty is in lots. The notional value of a position is:
 *   qty × lotSize × price
 * For cash equities lotSize = 1 and qty is share count.
 */

import type { InstrumentId } from "../events/market-event";
import type { SignalDirection } from "../events/signal-event";
import type { FillEvent } from "../events/fill-event";
import type { MarketRegime } from "../events/signal-event";

export type PositionStatus = "OPEN" | "CLOSED";

export type CloseReason =
  | "TARGET"
  | "STOP"
  | "SESSION_CLOSE"
  | "EXPIRY"
  | "MANUAL"
  | "PORTFOLIO_BREACH"
  | "EOD";

/** Immutable attribution snapshot copied from the originating signal. */
export interface PositionAttribution {
  readonly strategyId: string;
  readonly signalId: string;
  readonly modelVersion: string;
  readonly featureVersion: string;
  readonly marketRegime: MarketRegime;
  readonly dataQualityScore: number;
}

export interface Position {
  readonly id: string;
  readonly instrument: InstrumentId;
  readonly direction: SignalDirection;
  status: PositionStatus;

  /** Weighted-average entry price (updated if averaged-in). */
  avgEntryPrice: number;
  /** Current fill-level quantity (lots / shares). */
  qty: number;

  /** Active risk levels — may be trailed in future extensions. */
  stopLoss: number;
  target: number;

  /** Running financials (INR). */
  unrealisedPnl: number;
  realisedPnl: number;
  totalCommission: number;

  /** Margin reserved for this position (INR). */
  marginReserved: number;

  /** Lifecycle timestamps (UTC ms). */
  openedAtMs: number;
  closedAtMs: number | null;
  openBarIndex: number;
  closeBarIndex: number | null;
  closeReason: CloseReason | null;

  readonly attribution: PositionAttribution;

  /** Ordered list of fills that built this position (audit trail). */
  readonly fills: FillEvent[];
}

// ── Factory ──────────────────────────────────────────────────────────────────

let _posCounter = 0;

export function resetPositionCounter(): void {
  _posCounter = 0;
}

export function makePositionId(): string {
  return `pos_${(++_posCounter).toString(36).padStart(6, "0")}`;
}

export function openPosition(
  fill: FillEvent,
  opts: {
    stopLoss: number;
    target: number;
    marginReserved: number;
    attribution: PositionAttribution;
  },
): Position {
  return {
    id: makePositionId(),
    instrument: fill.instrument,
    direction: fill.direction,
    status: "OPEN",
    avgEntryPrice: fill.fillPrice,
    qty: fill.qty,
    stopLoss: opts.stopLoss,
    target: opts.target,
    unrealisedPnl: 0,
    realisedPnl: 0,
    totalCommission: fill.commission,
    marginReserved: opts.marginReserved,
    openedAtMs: fill.executionTimestampMs,
    closedAtMs: null,
    openBarIndex: fill.executionBarIndex,
    closeBarIndex: null,
    closeReason: null,
    attribution: opts.attribution,
    fills: [fill],
  };
}

// ── Mark-to-market ────────────────────────────────────────────────────────────

/**
 * Update unrealised P&L for an open position given the current market price.
 * Does NOT mutate the position — returns a new unrealisedPnl value.
 */
export function calcUnrealisedPnl(pos: Position, markPrice: number): number {
  if (pos.status === "CLOSED") return 0;
  const lotSize = pos.instrument.lotSize;
  const direction = pos.direction === "LONG" ? 1 : -1;
  return direction * (markPrice - pos.avgEntryPrice) * pos.qty * lotSize;
}

/**
 * Mark the position to a new price — mutates in place (the engine drives
 * this on every MARKET_EVENT for all open positions).
 */
export function markPosition(pos: Position, markPrice: number): void {
  pos.unrealisedPnl = calcUnrealisedPnl(pos, markPrice);
}

// ── Close ─────────────────────────────────────────────────────────────────────

/**
 * Close a position from a fill event. Computes realised P&L, freezes the
 * position, and records commission. Mutates in place.
 */
export function closePosition(
  pos: Position,
  fill: FillEvent,
  reason: CloseReason,
): void {
  if (pos.status === "CLOSED") {
    throw new Error(`Position ${pos.id} is already closed`);
  }
  const lotSize = pos.instrument.lotSize;
  const direction = pos.direction === "LONG" ? 1 : -1;
  const grossPnl =
    direction * (fill.fillPrice - pos.avgEntryPrice) * pos.qty * lotSize;

  pos.realisedPnl = grossPnl - fill.commission - pos.totalCommission;
  pos.totalCommission += fill.commission;
  pos.unrealisedPnl = 0;
  pos.status = "CLOSED";
  pos.closedAtMs = fill.executionTimestampMs;
  pos.closeBarIndex = fill.executionBarIndex;
  pos.closeReason = reason;
  pos.fills.push(fill);
}

// ── Intra-bar SL / TP check ───────────────────────────────────────────────────

export type IntraBarCheckResult =
  | { hit: false }
  | { hit: true; reason: "STOP" | "TARGET"; exitPrice: number };

/**
 * Conservative tie-break: if a bar touches BOTH stop and target, stop wins.
 * This matches the existing AlphaForge paper-trader convention.
 */
export function checkIntraBar(
  pos: Position,
  barHigh: number,
  barLow: number,
): IntraBarCheckResult {
  if (pos.status === "CLOSED") return { hit: false };
  const isLong = pos.direction === "LONG";

  const hitStop = isLong ? barLow <= pos.stopLoss : barHigh >= pos.stopLoss;
  const hitTarget = isLong ? barHigh >= pos.target : barLow <= pos.target;

  if (hitStop) return { hit: true, reason: "STOP", exitPrice: pos.stopLoss };
  if (hitTarget) return { hit: true, reason: "TARGET", exitPrice: pos.target };
  return { hit: false };
}
