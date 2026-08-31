/**
 * SignalEvent — emitted by a strategy after STRATEGY_EVALUATION.
 *
 * A signal represents intent to trade. It has NOT yet been risk-checked or
 * converted to an order. The engine's risk layer either promotes it to an
 * OrderEvent or rejects it with a reason attached to `rejectionReason`.
 *
 * Attribution fields
 * ──────────────────
 * Every signal permanently records the strategy that generated it, plus
 * optional ML model/feature versions and the market regime at signal time.
 * This allows later trade attribution without re-running the backtest.
 */

import type { BaseEvent, InstrumentId } from "./market-event";

export type SignalDirection = "LONG" | "SHORT";

export type SignalExitTiming =
  | "NEXT_BAR_OPEN"   // Execute at the open of the next bar (most realistic)
  | "NEXT_TICK"       // Execute at the very next tick / bar
  | "LIMIT_FILL"      // Use the specified limitPrice — fill when touched
  | "MARKET_FILL";    // Fill at the current bar's close (lookahead warning — use only for testing)

export interface SignalLevels {
  /** Intended entry price. Actual fill may differ based on SlippageModel. */
  entry: number;
  stopLoss: number;
  target: number;
  /** Reward / risk ratio at signal time. */
  riskReward: number;
  /** For LIMIT_FILL timing: the limit price to queue. */
  limitPrice?: number;
}

/** Market regime classification at signal time (from the ML regime model). */
export type MarketRegime =
  | "TRENDING_UP"
  | "TRENDING_DOWN"
  | "RANGING"
  | "HIGH_VOLATILITY"
  | "LOW_VOLATILITY"
  | "UNKNOWN";

/** Attribution metadata — every signal carries these for later analysis. */
export interface SignalAttribution {
  /** Id of the strategy that generated this signal. */
  strategyId: string;
  /** ML model version used for this signal (optional). */
  modelVersion?: string;
  /** Feature pipeline version (optional). */
  featureVersion?: string;
  /** Market regime at signal time (from ML regime model or rule-based). */
  marketRegime: MarketRegime;
  /**
   * Data quality score [0, 1]. Signals from thin / gapped data get a lower
   * score and the risk layer can reject them below a threshold.
   */
  dataQualityScore: number;
}

export interface SignalEvent extends BaseEvent {
  readonly type: "SIGNAL_EVENT";
  readonly instrument: InstrumentId;
  readonly direction: SignalDirection;
  readonly levels: SignalLevels;
  readonly exitTiming: SignalExitTiming;
  /**
   * Bar index at which the signal was generated (the bar whose close the
   * strategy evaluated). The execution model uses this to prevent same-bar
   * fills when `exitTiming` is NEXT_BAR_OPEN.
   */
  readonly signalBarIndex: number;
  /**
   * UTC ms when the signal was generated (= the close of `signalBarIndex`).
   * The fill model records this alongside `executionTimestampMs` so the
   * signal-to-execution latency is always auditable.
   */
  readonly signalTimestampMs: number;
  /**
   * ATR at signal time — drives stop / target sizing in the paper-trade and
   * live layers. Stored for audit; the levels are already sized.
   */
  readonly atr: number;
  /** Confidence in [0, 1] — strategy-specific scoring. */
  readonly confidence: number;
  readonly attribution: SignalAttribution;
  /** Strategy-specific metadata (e.g. OI ratio, PCR, IV rank). */
  readonly extras?: Record<string, number | string | boolean | null>;
  /** Set by the risk layer if this signal was rejected. */
  rejectionReason?: string;
}

// ── Builder ───────────────────────────────────────────────────────────────────

import { makeEventId } from "./market-event";

export function buildSignalEvent(opts: {
  sourceEventId: string;
  timestampMs: number;
  instrument: InstrumentId;
  direction: SignalDirection;
  levels: SignalLevels;
  exitTiming: SignalExitTiming;
  signalBarIndex: number;
  atr: number;
  confidence: number;
  attribution: SignalAttribution;
  extras?: Record<string, number | string | boolean | null>;
}): SignalEvent {
  return {
    id: makeEventId("sig"),
    type: "SIGNAL_EVENT",
    timestampMs: opts.timestampMs,
    sourceEventId: opts.sourceEventId,
    instrument: opts.instrument,
    direction: opts.direction,
    levels: opts.levels,
    exitTiming: opts.exitTiming,
    signalBarIndex: opts.signalBarIndex,
    signalTimestampMs: opts.timestampMs,
    atr: opts.atr,
    confidence: opts.confidence,
    attribution: opts.attribution,
    extras: opts.extras,
  };
}
