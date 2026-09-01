/**
 * MarketEvent — the root event in every bar cycle.
 *
 * Emitted once per OHLCV candle by the SimulationClock. All downstream
 * events in a bar's processing chain are causally linked to the
 * MarketEvent that triggered them via `sourceEventId`.
 *
 * Timestamp semantics
 * ───────────────────
 * `timestampMs` is ALWAYS UTC epoch milliseconds.
 * `barOpenMs` / `barCloseMs` bracket the candle that just closed.
 * Strategies receive `barCloseMs` as their "now" — the earliest moment
 * they could have acted on this candle's information.
 *
 * Anti-lookahead contract
 * ───────────────────────
 * A strategy evaluating bar N may only access candles with
 * `barCloseMs <= timestampMs`. The engine enforces this by passing a
 * read-only candle slice [0..N] and refusing any random-access outside it.
 */

export type EventType =
  | "MARKET_EVENT"
  | "FEATURE_UPDATE"
  | "STRATEGY_EVALUATION"
  | "SIGNAL_EVENT"
  | "RISK_CHECK"
  | "ORDER_EVENT"
  | "EXECUTION"
  | "FILL_EVENT"
  | "PORTFOLIO_UPDATE"
  | "SESSION_OPEN"
  | "SESSION_CLOSE"
  | "EXPIRY_WARNING"
  | "EXPIRY_FORCED_CLOSE";

export type InstrumentType =
  | "EQ"       // Equity / cash
  | "FUTIDX"   // Index future  (NIFTY, BANKNIFTY …)
  | "FUTSTK"   // Stock future
  | "OPTIDX"   // Index option
  | "OPTSTK"   // Stock option
  | "IDX";     // Spot index (non-tradeable reference)

export type OptionType = "CE" | "PE";

/** Minimal instrument identity — enough to route events and size lots. */
export interface InstrumentId {
  /** NSE/NFO trading symbol (e.g. "RELIANCE", "NIFTY28MAY2624000CE"). */
  symbol: string;
  /** Exchange segment: "NSE" for cash, "NFO" for F&O. */
  exchange: "NSE" | "NFO" | "BSE" | "BFO";
  instrumentType: InstrumentType;
  lotSize: number;
  tickSize: number;
  /** Expiry as ISO-8601 date (YYYY-MM-DD) in IST. Null for equities. */
  expiry: string | null;
  strike: number | null;
  optionType: OptionType | null;
}

/** Single OHLCV bar attached to a market event. */
export interface OHLCVBar {
  /** UTC epoch milliseconds — open of the candle. */
  openMs: number;
  /** UTC epoch milliseconds — close of the candle. */
  closeMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Open interest (contracts). Populated for F&O candles. */
  oi?: number;
}

/** Base fields shared by every event in the pipeline. */
export interface BaseEvent {
  readonly id: string;
  readonly type: EventType;
  /**
   * UTC epoch ms when this event was emitted. For market events this equals
   * `bar.closeMs`. For derived events (signal, order …) it is the same bar's
   * close time — events within the same bar share the same `timestampMs`.
   */
  readonly timestampMs: number;
  /**
   * Id of the MarketEvent that spawned this processing chain. Lets the
   * analytics layer group all events that belong to one bar cycle.
   */
  readonly sourceEventId: string;
}

/** The primary market event carrying a closed OHLCV bar. */
export interface MarketEvent extends BaseEvent {
  readonly type: "MARKET_EVENT";
  readonly instrument: InstrumentId;
  readonly bar: OHLCVBar;
  /**
   * Zero-based index of this bar in the candle series (0 = first bar ever).
   * Strategies use this to index into the immutable candle slice they receive
   * — they must never access index > `barIndex`.
   */
  readonly barIndex: number;
  /**
   * True when this bar is the first bar after market open for the session.
   * Strategies can use this to initialise intra-day state.
   */
  readonly isSessionOpen: boolean;
  /**
   * True when this bar is the last bar before market close (15:30 IST).
   * An open position that has not hit SL/TP should be force-closed after
   * the processing chain for this bar completes.
   */
  readonly isSessionClose: boolean;
  /**
   * True for the weekly/monthly expiry day of this instrument (Thursday for
   * NIFTY/BANKNIFTY/FINNIFTY weekly). The engine emits an EXPIRY_WARNING
   * on the first bar of an expiry day and EXPIRY_FORCED_CLOSE at session close.
   */
  readonly isExpiryDay: boolean;
}

/** Session lifecycle events emitted around the trading window. */
export interface SessionOpenEvent extends BaseEvent {
  readonly type: "SESSION_OPEN";
  /** IST date string (YYYY-MM-DD) for this session. */
  readonly tradeDate: string;
}

export interface SessionCloseEvent extends BaseEvent {
  readonly type: "SESSION_CLOSE";
  readonly tradeDate: string;
}

export interface ExpiryWarningEvent extends BaseEvent {
  readonly type: "EXPIRY_WARNING";
  readonly instrument: InstrumentId;
  readonly expiryDate: string;
  /** Minutes remaining until 15:30 IST expiry close. */
  readonly minutesRemaining: number;
}

export interface ExpiryForcedCloseEvent extends BaseEvent {
  readonly type: "EXPIRY_FORCED_CLOSE";
  readonly instrument: InstrumentId;
  readonly expiryDate: string;
  readonly settlementPrice: number;
}

/** Narrow union of all market-lifecycle events for handler dispatch. */
export type AnyMarketEvent =
  | MarketEvent
  | SessionOpenEvent
  | SessionCloseEvent
  | ExpiryWarningEvent
  | ExpiryForcedCloseEvent;

// ── Helpers ──────────────────────────────────────────────────────────────────

let _counter = 0;

/** Generate a deterministic, collision-free event id for backtesting. */
export function makeEventId(prefix = "ev"): string {
  return `${prefix}_${(++_counter).toString(36).padStart(6, "0")}`;
}

/** Reset the counter — call once at the start of each backtest run. */
export function resetEventIdCounter(): void {
  _counter = 0;
}

/** True when the bar's close falls on a weekday (Mon–Fri in IST). */
export function isWeekdayIST(timestampMs: number): boolean {
  // Add IST offset to get IST "day"
  const ist = new Date(timestampMs + 5.5 * 60 * 60 * 1000);
  const day = ist.getUTCDay(); // 0=Sun 6=Sat
  return day >= 1 && day <= 5;
}

/** Build a MarketEvent from raw bar data. */
export function buildMarketEvent(opts: {
  instrument: InstrumentId;
  bar: OHLCVBar;
  barIndex: number;
  isSessionOpen: boolean;
  isSessionClose: boolean;
  isExpiryDay: boolean;
  sourceEventId?: string;
}): MarketEvent {
  const id = makeEventId("mkt");
  return {
    id,
    type: "MARKET_EVENT",
    timestampMs: opts.bar.closeMs,
    sourceEventId: opts.sourceEventId ?? id,
    instrument: opts.instrument,
    bar: opts.bar,
    barIndex: opts.barIndex,
    isSessionOpen: opts.isSessionOpen,
    isSessionClose: opts.isSessionClose,
    isExpiryDay: opts.isExpiryDay,
  };
}
