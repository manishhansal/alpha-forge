/**
 * SimulationClock — the authoritative time source for the backtest engine.
 *
 * Responsibilities
 * ─────────────────
 * 1. Convert raw OHLCV bars into MarketEvents with correct NSE session metadata.
 * 2. Enforce the IST timezone for session boundary detection (09:15–15:30).
 * 3. Flag weekends, NSE holidays, expiry days, and shortened sessions.
 * 4. Guarantee strict chronological ordering — earlier bars always come first.
 *
 * Anti-lookahead guarantee
 * ────────────────────────
 * The clock advances one bar at a time and never returns to a previous bar.
 * `currentBarIndex` is the only index strategies may reference; accessing
 * any index > `currentBarIndex` in the candle array is an engine error.
 *
 * NSE Calendar
 * ────────────
 * A curated holiday list (from the NSE official calendar) is embedded here.
 * It covers 2020–2027. For production use, load an updated list at run time
 * by passing `holidays` to `ClockConfig`.
 *
 * Weekly expiry: Thursday for NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY.
 * Monthly expiry: last Thursday of every month (same underlyings).
 * Stock futures / options: last Thursday of the expiry month.
 */

import type { OHLCVBar, InstrumentId, MarketEvent } from "../events/market-event";
import {
  buildMarketEvent,
  makeEventId,
  resetEventIdCounter,
} from "../events/market-event";

// ── IST helpers ───────────────────────────────────────────────────────────────

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // UTC+5:30

/** Returns an object with IST date parts from a UTC epoch ms. */
export function toIst(utcMs: number): {
  year: number;
  month: number; // 1-12
  day: number;   // 1-31
  weekday: number; // 0=Sun 6=Sat
  hours: number;
  minutes: number;
  totalMinutes: number;
} {
  const d = new Date(utcMs + IST_OFFSET_MS);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    weekday: d.getUTCDay(),
    hours: d.getUTCHours(),
    minutes: d.getUTCMinutes(),
    totalMinutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
  };
}

/** ISO date string in IST (YYYY-MM-DD). */
export function istDateStr(utcMs: number): string {
  const { year, month, day } = toIst(utcMs);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// ── NSE session constants ─────────────────────────────────────────────────────

export const NSE_OPEN_MINUTES = 9 * 60 + 15;   // 555
export const NSE_CLOSE_MINUTES = 15 * 60 + 30;  // 930

/** True when the bar's close time falls inside a regular NSE session. */
export function isWithinNseSession(utcMs: number): boolean {
  const { weekday, totalMinutes } = toIst(utcMs);
  if (weekday === 0 || weekday === 6) return false;
  return totalMinutes >= NSE_OPEN_MINUTES && totalMinutes <= NSE_CLOSE_MINUTES;
}

// ── NSE public holiday list (2020–2027) ───────────────────────────────────────

/**
 * NSE trading holidays (IST dates, YYYY-MM-DD format).
 * Source: NSE India official holiday calendar.
 * Extend `ClockConfig.holidays` to override or append.
 */
export const NSE_HOLIDAYS_2020_2027: ReadonlySet<string> = new Set([
  // 2020
  "2020-01-26","2020-02-21","2020-03-10","2020-04-02","2020-04-06",
  "2020-04-10","2020-04-14","2020-05-01","2020-10-02","2020-11-16",
  "2020-11-30","2020-12-25",
  // 2021
  "2021-01-26","2021-03-11","2021-03-29","2021-04-02","2021-04-14",
  "2021-04-21","2021-05-13","2021-07-21","2021-08-19","2021-09-10",
  "2021-10-15","2021-11-04","2021-11-05","2021-11-19","2021-12-25",
  // 2022
  "2022-01-26","2022-03-01","2022-03-18","2022-04-14","2022-04-15",
  "2022-05-03","2022-08-09","2022-08-15","2022-08-31","2022-10-02",
  "2022-10-05","2022-10-24","2022-10-26","2022-11-08","2022-12-25",
  // 2023
  "2023-01-26","2023-03-07","2023-03-30","2023-04-04","2023-04-07",
  "2023-04-14","2023-04-22","2023-05-01","2023-06-29","2023-08-15",
  "2023-09-19","2023-10-02","2023-10-24","2023-11-14","2023-11-27",
  "2023-12-25",
  // 2024
  "2024-01-22","2024-01-26","2024-03-08","2024-03-25","2024-03-29",
  "2024-04-11","2024-04-14","2024-04-17","2024-04-21","2024-05-01",
  "2024-05-20","2024-06-17","2024-07-17","2024-08-15","2024-10-02",
  "2024-10-12","2024-10-14","2024-11-01","2024-11-15","2024-11-20",
  "2024-12-25",
  // 2025
  "2025-01-26","2025-02-26","2025-03-14","2025-03-31","2025-04-10",
  "2025-04-14","2025-04-18","2025-05-01","2025-08-15","2025-08-27",
  "2025-10-02","2025-10-02","2025-10-21","2025-10-22","2025-11-05",
  "2025-12-25",
  // 2026
  "2026-01-26","2026-03-20","2026-04-03","2026-04-06","2026-04-14",
  "2026-05-01","2026-08-15","2026-09-14","2026-10-02","2026-10-09",
  "2026-10-28","2026-11-12","2026-11-25","2026-12-25",
  // 2027
  "2027-01-26","2027-03-10","2027-03-26","2027-03-29","2027-04-14",
  "2027-05-01","2027-06-01","2027-07-20","2027-08-15","2027-09-01",
  "2027-10-02","2027-10-19","2027-10-30","2027-11-19","2027-12-25",
]);

// ── Expiry logic ──────────────────────────────────────────────────────────────

/** Symbols that have weekly expiry on Thursday. */
export const WEEKLY_EXPIRY_UNDERLYINGS = new Set([
  "NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY",
]);

/**
 * True when `utcMs` falls on a weekly (Thursday) expiry day for the given
 * underlying. Skips to the previous Wednesday when Thursday is a holiday.
 */
export function isWeeklyExpiryDay(
  utcMs: number,
  underlying: string,
  holidays: ReadonlySet<string> = NSE_HOLIDAYS_2020_2027,
): boolean {
  if (!WEEKLY_EXPIRY_UNDERLYINGS.has(underlying)) return false;
  const { weekday } = toIst(utcMs);
  const dateStr = istDateStr(utcMs);

  // Standard Thursday
  if (weekday === 4) return !holidays.has(dateStr);

  // Wednesday: check if Thursday is a holiday → expiry moves to Wednesday
  if (weekday === 3) {
    const thursMs = utcMs + 24 * 60 * 60 * 1000;
    const thursDate = istDateStr(thursMs);
    return holidays.has(thursDate);
  }
  return false;
}

/**
 * True when `utcMs` is the last Thursday (or shifted day) of its month —
 * the monthly expiry day.
 */
export function isMonthlyExpiryDay(
  utcMs: number,
  holidays: ReadonlySet<string> = NSE_HOLIDAYS_2020_2027,
): boolean {
  const { weekday, year, month } = toIst(utcMs);

  // Find all Thursdays in this IST month
  const thursdays: number[] = [];
  // Iterate days 1..28+
  for (let d = 1; d <= 31; d++) {
    const candidate = Date.UTC(year, month - 1, d) - IST_OFFSET_MS;
    const cIst = toIst(candidate);
    if (cIst.month !== month) break;
    if (cIst.weekday === 4) thursdays.push(candidate);
  }
  if (thursdays.length === 0) return false;

  // Last Thursday
  const lastThurs = thursdays[thursdays.length - 1];
  const lastThursDate = istDateStr(lastThurs);

  // If last Thursday is a holiday, check Wednesday
  const effectiveExpiry = holidays.has(lastThursDate)
    ? lastThurs - 24 * 60 * 60 * 1000
    : lastThurs;

  return istDateStr(utcMs) === istDateStr(effectiveExpiry);
}

/**
 * True if `utcMs` is an expiry day for the given instrument.
 * For indices with weekly expiry: any weekly Thursday.
 * For stock F&O / monthly: the last Thursday of the expiry month.
 */
export function isExpiryDay(
  utcMs: number,
  instrument: InstrumentId,
  holidays: ReadonlySet<string> = NSE_HOLIDAYS_2020_2027,
): boolean {
  if (instrument.expiry === null) return false;

  const underlying = instrument.symbol.replace(/\d.*$/, ""); // strip strike/date suffix

  if (
    instrument.instrumentType === "OPTIDX" ||
    instrument.instrumentType === "FUTIDX"
  ) {
    // Check if expiry date matches today's IST date
    const todayIst = istDateStr(utcMs);
    return instrument.expiry === todayIst;
  }

  // For stock F&O: expiry field matches the date
  return instrument.expiry === istDateStr(utcMs);
}

// ── Clock configuration ───────────────────────────────────────────────────────

export interface ClockConfig {
  /**
   * Additional or override holidays in IST YYYY-MM-DD format.
   * Merged with the built-in NSE_HOLIDAYS_2020_2027 set.
   */
  holidays?: string[];
  /**
   * If true, the clock skips bars outside NSE session hours (09:15–15:30 IST).
   * Default: true. Set false for daily candles that represent full-day data.
   */
  filterToSession?: boolean;
  /**
   * Skip weekends even if candles are present (default: true).
   */
  filterWeekends?: boolean;
  /**
   * Skip NSE holidays even if candles are present (default: true).
   */
  filterHolidays?: boolean;
}

// ── SimulationClock ───────────────────────────────────────────────────────────

export interface ClockTickResult {
  event: MarketEvent;
  /** IST date string for the session this bar belongs to. */
  tradeDate: string;
  /** True when this is the first bar of a new session (new IST day). */
  isNewSession: boolean;
}

export class SimulationClock {
  private readonly _holidays: ReadonlySet<string>;
  private readonly _filterToSession: boolean;
  private readonly _filterWeekends: boolean;
  private readonly _filterHolidays: boolean;

  private _currentBarIndex = -1;
  private _lastTradeDate = "";
  private _bars: OHLCVBar[] = [];
  private _instrument!: InstrumentId;

  constructor(config: ClockConfig = {}) {
    const merged = new Set(NSE_HOLIDAYS_2020_2027);
    for (const h of config.holidays ?? []) merged.add(h);
    this._holidays = merged;
    this._filterToSession = config.filterToSession ?? true;
    this._filterWeekends = config.filterWeekends ?? true;
    this._filterHolidays = config.filterHolidays ?? true;
  }

  /** Load bars and instrument for a new simulation run. Resets the clock. */
  load(bars: OHLCVBar[], instrument: InstrumentId): void {
    // Enforce strict chronological order
    for (let i = 1; i < bars.length; i++) {
      if (bars[i].closeMs <= bars[i - 1].closeMs) {
        throw new Error(
          `Clock: bars must be strictly chronological. Bar ${i} closeMs (${bars[i].closeMs}) <= bar ${i - 1} closeMs (${bars[i - 1].closeMs})`,
        );
      }
    }
    this._bars = bars;
    this._instrument = instrument;
    this._currentBarIndex = -1;
    this._lastTradeDate = "";
    resetEventIdCounter();
  }

  get currentBarIndex(): number {
    return this._currentBarIndex;
  }

  get totalBars(): number {
    return this._bars.length;
  }

  get hasNext(): boolean {
    return this._currentBarIndex < this._bars.length - 1;
  }

  /**
   * Advance to the next valid bar.
   * Returns null when there are no more bars.
   * Skipped bars (weekends, holidays, outside session) are consumed silently.
   */
  next(): ClockTickResult | null {
    while (this._currentBarIndex < this._bars.length - 1) {
      this._currentBarIndex++;
      const bar = this._bars[this._currentBarIndex];

      const { weekday, totalMinutes } = toIst(bar.closeMs);
      const dateStr = istDateStr(bar.closeMs);

      // Filter weekends
      if (this._filterWeekends && (weekday === 0 || weekday === 6)) continue;

      // Filter holidays
      if (this._filterHolidays && this._holidays.has(dateStr)) continue;

      // Filter outside session (for intraday bars)
      if (this._filterToSession) {
        if (
          totalMinutes < NSE_OPEN_MINUTES ||
          totalMinutes > NSE_CLOSE_MINUTES
        ) continue;
      }

      const isNewSession = dateStr !== this._lastTradeDate;
      this._lastTradeDate = dateStr;

      const isSessionOpen = isNewSession;
      const isSessionClose = totalMinutes >= NSE_CLOSE_MINUTES;
      const expiryDay = isExpiryDay(bar.closeMs, this._instrument, this._holidays);

      const event = buildMarketEvent({
        instrument: this._instrument,
        bar,
        barIndex: this._currentBarIndex,
        isSessionOpen,
        isSessionClose,
        isExpiryDay: expiryDay,
      });

      return { event, tradeDate: dateStr, isNewSession };
    }
    return null;
  }

  /**
   * Return a read-only view of bars [0..barIndex] — the only window a
   * strategy is allowed to access when processing bar `barIndex`.
   * Throws if barIndex > currentBarIndex (anti-lookahead enforcement).
   */
  candleSlice(barIndex: number): ReadonlyArray<OHLCVBar> {
    if (barIndex > this._currentBarIndex) {
      throw new Error(
        `Anti-lookahead violation: requested barIndex ${barIndex} but currentBarIndex is ${this._currentBarIndex}`,
      );
    }
    return this._bars.slice(0, barIndex + 1);
  }

  /** The bar at the given index (read-only). Throws on lookahead. */
  barAt(barIndex: number): Readonly<OHLCVBar> {
    if (barIndex > this._currentBarIndex) {
      throw new Error(
        `Anti-lookahead violation: requested barIndex ${barIndex} > currentBarIndex ${this._currentBarIndex}`,
      );
    }
    return this._bars[barIndex];
  }

  /** Current IST trade date. */
  currentTradeDate(): string {
    return this._lastTradeDate;
  }

  holidays(): ReadonlySet<string> {
    return this._holidays;
  }
}
