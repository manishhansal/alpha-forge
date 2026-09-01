/**
 * RiskEvent — emitted by the RiskManager when a signal is evaluated.
 *
 * Every signal produces exactly one RiskEvent: either APPROVED (which
 * promotes it to an OrderEvent) or REJECTED (which records the reason and
 * terminates the processing chain for that signal).
 *
 * The risk layer also emits RISK_BREACH events when an open position
 * violates portfolio-level risk limits (max drawdown, margin call, etc.),
 * which triggers forced position closure.
 */

import { makeEventId } from "./market-event";
import type { BaseEvent, InstrumentId } from "./market-event";

export type RiskDecision = "APPROVED" | "REJECTED";

export type RiskRejectReason =
  | "INSUFFICIENT_CAPITAL"          // Not enough cash / margin
  | "MAX_OPEN_POSITIONS_REACHED"    // Portfolio position count limit
  | "MAX_SYMBOL_EXPOSURE_REACHED"   // Too much exposure to one symbol
  | "MAX_SECTOR_EXPOSURE_REACHED"   // Sector concentration limit
  | "DATA_QUALITY_TOO_LOW"          // dataQualityScore below threshold
  | "OUTSIDE_SESSION"               // Signal generated outside 09:15–15:30 IST
  | "EXPIRY_COOLDOWN"               // Within the expiry-day cooldown window
  | "RISK_REWARD_TOO_LOW"           // RR ratio below configured minimum
  | "DAILY_LOSS_LIMIT_HIT"          // Daily loss cap exhausted
  | "MARGIN_UTILISATION_TOO_HIGH"   // Margin utilisation above limit
  | "DUPLICATE_SIGNAL"              // Already in a position for this symbol
  | "STRATEGY_DISABLED"             // Strategy flagged as disabled in config
  | "CUSTOM";                       // Strategy-provided reason

export type RiskBreachType =
  | "MAX_DRAWDOWN_BREACH"
  | "MARGIN_CALL"
  | "DAILY_LOSS_LIMIT"
  | "POSITION_STOP_HIT"
  | "POSITION_TARGET_HIT"
  | "SESSION_CLOSE_FORCE"
  | "EXPIRY_FORCE_CLOSE";

export interface RiskCheckEvent extends BaseEvent {
  readonly type: "RISK_CHECK";
  readonly signalEventId: string;
  readonly instrument: InstrumentId;
  readonly decision: RiskDecision;
  readonly rejectReason?: RiskRejectReason;
  readonly rejectDetail?: string;
  /**
   * Snapshot of the portfolio risk state at the moment of the check.
   * Stored for audit so we can replay which limits triggered the decision.
   */
  readonly portfolioSnapshot: RiskSnapshot;
}

export interface RiskBreachEvent extends BaseEvent {
  readonly type: "RISK_CHECK";
  readonly breachType: RiskBreachType;
  readonly instrument?: InstrumentId;
  readonly positionId?: string;
  /** INR value of the breach (e.g. current drawdown, margin deficit). */
  readonly breachValue: number;
  /** The limit that was exceeded. */
  readonly limitValue: number;
  readonly detail: string;
}

/** Portfolio-level risk metrics captured at risk-check time. */
export interface RiskSnapshot {
  /** Total portfolio equity in INR. */
  equity: number;
  /** Free cash available (margin-adjusted). */
  availableCash: number;
  /** Margin currently in use (INR). */
  marginUsed: number;
  /** Number of open positions. */
  openPositions: number;
  /** Peak-to-current drawdown (0..1). */
  currentDrawdown: number;
  /** Today's realised P&L. */
  dailyPnl: number;
  /** Margin utilisation ratio (0..1). */
  marginUtilisation: number;
}

// ── Builders ──────────────────────────────────────────────────────────────────

export function buildRiskCheckEvent(opts: {
  sourceEventId: string;
  timestampMs: number;
  signalEventId: string;
  instrument: InstrumentId;
  decision: RiskDecision;
  rejectReason?: RiskRejectReason;
  rejectDetail?: string;
  portfolioSnapshot: RiskSnapshot;
}): RiskCheckEvent {
  return {
    id: makeEventId("risk"),
    type: "RISK_CHECK",
    timestampMs: opts.timestampMs,
    sourceEventId: opts.sourceEventId,
    signalEventId: opts.signalEventId,
    instrument: opts.instrument,
    decision: opts.decision,
    rejectReason: opts.rejectReason,
    rejectDetail: opts.rejectDetail,
    portfolioSnapshot: opts.portfolioSnapshot,
  };
}
