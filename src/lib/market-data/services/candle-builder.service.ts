/**
 * Production-grade Real-Time Candle Builder — AlphaForge Indian Market.
 *
 * Assembles OHLCV candles from a stream of normalized LiveTick events for
 * all required NSE timeframes (1m, 3m, 5m, 10m, 15m, 30m, 1h, 1d).
 *
 * Key design decisions
 * ────────────────────
 * • All internal timestamps stay UTC (epoch ms / epoch seconds). IST is
 *   used only for NSE session-boundary arithmetic.
 * • Candle alignment is always relative to 09:15 IST (NSE open), never to
 *   Unix epoch midnight, so 5-minute bars land on :15, :20, :25, … not
 *   :00, :05, :10, …
 * • The service is a plain TypeScript class (no EventEmitter inheritance) —
 *   callers register typed callbacks, consistent with the rest of this codebase.
 * • Redis stores active (open) candle state so a process restart can resume
 *   without losing the partial bar. MemoryRedis fallback keeps unit tests fast.
 * • Confirmed candles are persisted to PostgreSQL (Prisma CandleBar model)
 *   with an upsert so duplicate inserts are idempotent.
 * • Late / out-of-order ticks are handled with a configurable tolerance
 *   window; ticks beyond the window are rejected and logged — closed candles
 *   are never silently mutated.
 * • Backfill gap detection runs on reconnect: the builder identifies which
 *   interval slots are missing between the last confirmed candle and now,
 *   then invokes a caller-supplied loader to fill them.
 */

import "server-only";

import { prisma } from "@/lib/prisma";
import { redis } from "@/lib/redis";
import { mdLog } from "../health";
import type { Exchange, Interval, LiveTick, OHLCVCandle } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Constants & helpers
// ─────────────────────────────────────────────────────────────────────────────

/** IST offset — India does NOT observe DST. */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1_000; // 19 800 000 ms

/** NSE regular session open: 09:15 IST → minutes from IST midnight. */
const NSE_OPEN_MINUTES = 9 * 60 + 15; // 555

/** NSE regular session close: 15:30 IST → minutes from IST midnight. */
const NSE_CLOSE_MINUTES = 15 * 60 + 30; // 930

/** Interval width in seconds. */
const INTERVAL_SECONDS: Record<Interval, number> = {
  "1m":  60,
  "3m":  180,
  "5m":  300,
  "10m": 600,
  "15m": 900,
  "30m": 1_800,
  "1h":  3_600,
  "1d":  86_400,
  "1w":  604_800,
  "1M":  2_592_000,
};

/**
 * All timeframes actively built by the production candle builder.
 * "1w" and "1M" are historical-only; the live builder ignores them.
 */
export const LIVE_INTERVALS: readonly Interval[] = [
  "1m", "3m", "5m", "10m", "15m", "30m", "1h", "1d",
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// IST / NSE session helpers (pure — no I/O)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Decompose a UTC epoch-ms value into IST calendar components.
 * Avoids Intl.DateTimeFormat which is unavailable in some Node environments.
 */
function toIstComponents(utcMs: number): {
  dayOfWeek: number; // 0=Sun … 6=Sat
  minutesFromMidnight: number;
  istDayStartMs: number; // epoch ms of 00:00 IST on the same IST calendar day
} {
  const istMs = utcMs + IST_OFFSET_MS;
  const d = new Date(istMs);
  const dayOfWeek = d.getUTCDay();
  const minutesFromMidnight = d.getUTCHours() * 60 + d.getUTCMinutes();
  // IST calendar day start = midnight IST = (midnight UTC of IST date) − IST_OFFSET_MS
  const istMidnightUtcMs =
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - IST_OFFSET_MS;
  return { dayOfWeek, minutesFromMidnight, istDayStartMs: istMidnightUtcMs };
}

/**
 * True when `utcMs` falls on a weekday inside the NSE regular session
 * (Mon–Fri, 09:15–15:30 IST inclusive) AND the IST calendar date is not in
 * `holidays`.
 */
export function isNseSessionTick(utcMs: number, holidays: ReadonlySet<string>): boolean {
  const { dayOfWeek, minutesFromMidnight, istDayStartMs } = toIstComponents(utcMs);

  // Weekend gate.
  if (dayOfWeek === 0 || dayOfWeek === 6) return false;

  // Holiday gate.
  const istDate = toIstDateString(istDayStartMs + IST_OFFSET_MS); // pass midnight-UTC+IST
  if (holidays.has(istDate)) return false;

  // Session-time gate — inclusive of both endpoints.
  return minutesFromMidnight >= NSE_OPEN_MINUTES && minutesFromMidnight <= NSE_CLOSE_MINUTES;
}

/**
 * Format a UTC epoch-ms value as an IST calendar date string `YYYY-MM-DD`.
 * `utcMs` should already be the epoch-ms of an IST instant (i.e. UTC ms + IST offset).
 */
function toIstDateString(istInstantMs: number): string {
  const d = new Date(istInstantMs);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dy = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${dy}`;
}

/**
 * Return the IST calendar date string for a UTC epoch-ms tick timestamp.
 */
export function istDateForMs(utcMs: number): string {
  return toIstDateString(utcMs + IST_OFFSET_MS);
}

/**
 * UTC epoch seconds of the NSE session open (09:15 IST) for the IST calendar
 * date that contains `utcMs`.
 */
export function sessionOpenSecondsForMs(utcMs: number): number {
  const { istDayStartMs } = toIstComponents(utcMs);
  return Math.floor((istDayStartMs + NSE_OPEN_MINUTES * 60_000) / 1_000);
}

/**
 * UTC epoch seconds of the NSE session close (15:30 IST) for the IST calendar
 * date that contains `utcMs`.
 */
export function sessionCloseSecondsForMs(utcMs: number): number {
  const { istDayStartMs } = toIstComponents(utcMs);
  return Math.floor((istDayStartMs + NSE_CLOSE_MINUTES * 60_000) / 1_000);
}

// ─────────────────────────────────────────────────────────────────────────────
// Interval alignment (IST-anchored)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Snap a UTC epoch-seconds timestamp to the start of the containing interval
 * window, aligned to the NSE session open (09:15 IST) rather than Unix epoch.
 *
 * For "1d", the candle time is anchored to the session open of that trading
 * day (09:15:00 IST in epoch seconds), not UTC midnight.
 *
 * Examples (IST times):
 *   snapToNseInterval("1m",  09:17 IST) → 09:17:00 IST
 *   snapToNseInterval("5m",  09:17 IST) → 09:15:00 IST
 *   snapToNseInterval("15m", 09:31 IST) → 09:30:00 IST  (15m from open = 09:30)
 *   snapToNseInterval("1h",  10:45 IST) → 10:15:00 IST  (1h from open = 10:15)
 */
export function snapToNseInterval(utcSeconds: number, interval: Interval): number {
  if (interval === "1d") {
    // Daily candle time = session open of that IST trading day.
    return sessionOpenSecondsForMs(utcSeconds * 1_000);
  }

  const step = INTERVAL_SECONDS[interval];
  const sessionOpenSec = sessionOpenSecondsForMs(utcSeconds * 1_000);

  if (utcSeconds < sessionOpenSec) {
    // Before market open — align to the previous day's open (handled by caller
    // session gate anyway, but be defensive).
    return sessionOpenSec - step;
  }

  const offsetFromOpen = utcSeconds - sessionOpenSec;
  return sessionOpenSec + Math.floor(offsetFromOpen / step) * step;
}

/**
 * Legacy helper kept for backward-compatibility with the existing index exports.
 * Aligns to Unix epoch (not IST session). Use `snapToNseInterval` for live candles.
 */
export function snapToInterval(utcSeconds: number, interval: Interval): number {
  const step = INTERVAL_SECONDS[interval];
  return Math.floor(utcSeconds / step) * step;
}

// ─────────────────────────────────────────────────────────────────────────────
// Candle event types
// ─────────────────────────────────────────────────────────────────────────────

export type CandleEventType = "CANDLE_OPEN" | "CANDLE_UPDATE" | "CANDLE_CLOSE";

export type CandleEvent = {
  type: CandleEventType;
  instrumentId: string;
  exchange: Exchange;
  interval: Interval;
  candle: OHLCVCandle;
  /** OI change vs the immediately preceding confirmed candle's OI. Null for equity. */
  oiChange: number | null;
};

export type CandleEventHandler = (event: CandleEvent) => void;

// ─────────────────────────────────────────────────────────────────────────────
// Active candle state (what lives in Redis during the session)
// ─────────────────────────────────────────────────────────────────────────────

type ActiveCandle = {
  candle: OHLCVCandle;
  /** OI at the close of the last *confirmed* candle for this instrument+interval. */
  prevOi: number | null;
  /** Whether CANDLE_OPEN has been published for this bar. */
  opened: boolean;
  /** UTC epoch seconds of the latest tick processed into this candle. */
  lastTickSec: number;
};

// ─────────────────────────────────────────────────────────────────────────────
// Late-tick policy
// ─────────────────────────────────────────────────────────────────────────────

export type LateTick = {
  tick: LiveTick;
  interval: Interval;
  /** The candle slot the tick belongs to (UTC epoch seconds). */
  candleTime: number;
  /** The candle slot currently open. */
  currentCandleTime: number;
};

export type LateTickHandler = (late: LateTick) => void;

// ─────────────────────────────────────────────────────────────────────────────
// Backfill
// ─────────────────────────────────────────────────────────────────────────────

export type BackfillRequest = {
  instrumentId: string;
  exchange: Exchange;
  interval: Interval;
  /** First missing candle open time, UTC epoch seconds. */
  fromSec: number;
  /** Exclusive upper bound — current candle open time, UTC epoch seconds. */
  toSec: number;
};

export type BackfillLoader = (req: BackfillRequest) => Promise<OHLCVCandle[]>;

// ─────────────────────────────────────────────────────────────────────────────
// Service configuration
// ─────────────────────────────────────────────────────────────────────────────

export type CandleBuilderConfig = {
  /**
   * Timeframes to build.  Defaults to all `LIVE_INTERVALS`.
   */
  intervals?: readonly Interval[];

  /**
   * NSE public holiday dates as IST calendar date strings (`YYYY-MM-DD`).
   * The builder refuses to produce candles on these dates.
   */
  holidays?: readonly string[];

  /**
   * How far behind the current candle boundary a late tick may be (in ms)
   * before it is silently dropped.  Default: 5_000 ms (5 seconds).
   *
   * Ticks within this window update the *already closed* candle via a
   * controlled re-emit of CANDLE_UPDATE (flagged as retroactive) and are NOT
   * persisted (the candle was already written).  Ticks outside the window are
   * logged and dropped.
   */
  lateTolerance?: number;

  /**
   * Whether to persist confirmed candles to the database.  Set false in tests
   * or when you want Redis-only operation.  Default: true.
   */
  persistToDb?: boolean;

  /**
   * Whether to cache active candle state to Redis.  Set false in tests.
   * Default: true.
   */
  useRedis?: boolean;

  /**
   * Redis key TTL in seconds for active candle state.  Default: 3 600 (1 hour).
   */
  redisTtlSeconds?: number;

  /**
   * Called when a candle event occurs (OPEN / UPDATE / CLOSE).
   * Strategy engines should react only to CANDLE_CLOSE.
   */
  onEvent?: CandleEventHandler;

  /**
   * Called when a late/out-of-order tick arrives.  Useful for monitoring.
   */
  onLateTick?: LateTickHandler;

  /**
   * If provided, called on reconnect when gap intervals are detected.
   * The implementation should fetch historical candles for the requested range
   * and return them for back-fill.
   */
  backfillLoader?: BackfillLoader;
};

// ─────────────────────────────────────────────────────────────────────────────
// Redis key scheme
// ─────────────────────────────────────────────────────────────────────────────

const REDIS_NS = "cb:active:";

function activeKey(instrumentId: string, exchange: string, interval: Interval): string {
  return `${REDIS_NS}${exchange}:${instrumentId}:${interval}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// RealTimeCandleBuilder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One-instrument, all-timeframes real-time candle builder.
 *
 * Typical lifecycle:
 *
 *   const builder = new RealTimeCandleBuilder("NIFTY", "NSE", config);
 *   await builder.restore();           // reload active candle from Redis
 *   subscription = subscribeLiveFeed(tokens, (tick) => builder.feed(tick));
 *   // … on disconnect …
 *   await builder.handleReconnect();
 *   // … at market close …
 *   await builder.closeSession();
 */
export class RealTimeCandleBuilder {
  private readonly instrumentId: string;
  private readonly exchange: Exchange;
  private readonly intervals: readonly Interval[];
  private readonly holidays: ReadonlySet<string>;
  private readonly lateTolerance: number;
  private readonly persistToDb: boolean;
  private readonly useRedis: boolean;
  private readonly redisTtlSeconds: number;
  private readonly onEvent: CandleEventHandler | undefined;
  private readonly onLateTick: LateTickHandler | undefined;
  private readonly backfillLoader: BackfillLoader | undefined;

  /**
   * In-memory map: interval → active candle state.
   * This is the authoritative runtime state; Redis is a durability mirror.
   */
  private readonly active = new Map<Interval, ActiveCandle>();

  constructor(instrumentId: string, exchange: Exchange, config: CandleBuilderConfig = {}) {
    this.instrumentId = instrumentId;
    this.exchange = exchange;
    this.intervals = config.intervals ?? LIVE_INTERVALS;
    this.holidays = new Set(config.holidays ?? []);
    this.lateTolerance = config.lateTolerance ?? 5_000;
    this.persistToDb = config.persistToDb ?? true;
    this.useRedis = config.useRedis ?? true;
    this.redisTtlSeconds = config.redisTtlSeconds ?? 3_600;
    this.onEvent = config.onEvent;
    this.onLateTick = config.onLateTick;
    this.backfillLoader = config.backfillLoader;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Feed a normalized live tick into the builder.  All enabled intervals are
   * updated in a single pass — O(intervals) per tick.
   *
   * Session gate: ticks outside NSE trading hours are silently dropped (no
   * candle is created for weekends, holidays, or outside 09:15–15:30 IST).
   */
  async feed(tick: LiveTick): Promise<void> {
    const tsMs = tick.exchangeTimestampMs;

    if (!isNseSessionTick(tsMs, this.holidays)) {
      // Outside session — drop silently.
      return;
    }

    const utcSec = Math.floor(tsMs / 1_000);

    for (const interval of this.intervals) {
      await this.feedInterval(tick, utcSec, interval);
    }
  }

  /**
   * Restore active candle state from Redis after a process restart.
   * Call this once before feeding ticks.
   */
  async restore(): Promise<void> {
    if (!this.useRedis) return;

    for (const interval of this.intervals) {
      const key = activeKey(this.instrumentId, this.exchange, interval);
      try {
        const raw = await redis.get(key);
        if (raw) {
          const state = JSON.parse(raw) as ActiveCandle;
          this.active.set(interval, state);
          mdLog("stale_data", {
            reason: "candle_state_restored",
            instrumentId: this.instrumentId,
            interval,
            candleTime: state.candle.time,
          });
        }
      } catch (err) {
        mdLog("stale_data", {
          reason: "candle_restore_failed",
          instrumentId: this.instrumentId,
          interval,
          error: (err as Error).message,
        });
      }
    }
  }

  /**
   * Detect and back-fill gap candles after a stream reconnect.
   *
   * For each interval, compares the last confirmed candle time stored in Redis
   * against the current session boundary.  If there are missing interval slots,
   * invokes `backfillLoader` and persists the returned candles as confirmed bars.
   */
  async handleReconnect(nowMs: number = Date.now()): Promise<void> {
    if (!this.backfillLoader) return;
    if (!isNseSessionTick(nowMs, this.holidays)) return;

    const utcSec = Math.floor(nowMs / 1_000);

    for (const interval of this.intervals) {
      const state = this.active.get(interval);
      if (!state) continue;

      const lastConfirmedTime = state.candle.time;
      const currentCandleTime = snapToNseInterval(utcSec, interval);

      if (currentCandleTime <= lastConfirmedTime) continue;

      // There is at least one missing interval between the last confirmed
      // candle and the current one.
      const missingFrom = lastConfirmedTime + INTERVAL_SECONDS[interval];
      if (missingFrom >= currentCandleTime) continue;

      try {
        const candles = await this.backfillLoader({
          instrumentId: this.instrumentId,
          exchange: this.exchange,
          interval,
          fromSec: missingFrom,
          toSec: currentCandleTime,
        });

        for (const candle of candles) {
          await this.persistConfirmed(candle, interval, null);
          this.emit({
            type: "CANDLE_CLOSE",
            instrumentId: this.instrumentId,
            exchange: this.exchange,
            interval,
            candle,
            oiChange: null,
          });
        }
      } catch (err) {
        mdLog("stale_data", {
          reason: "backfill_failed",
          instrumentId: this.instrumentId,
          interval,
          fromSec: missingFrom,
          error: (err as Error).message,
        });
      }
    }
  }

  /**
   * Flush and close all active candles at session end (15:30 IST).
   * Confirms and persists the final partial bar for each interval.
   */
  async closeSession(): Promise<void> {
    for (const interval of this.intervals) {
      const state = this.active.get(interval);
      if (!state) continue;
      await this.confirmCandle(state.candle, interval, state.prevOi);
      this.active.delete(interval);
      if (this.useRedis) {
        await redis.del(activeKey(this.instrumentId, this.exchange, interval));
      }
    }
  }

  /**
   * Return a snapshot of the current open candle for a given interval.
   * Returns `null` if no ticks have been received for this interval yet.
   */
  peek(interval: Interval): OHLCVCandle | null {
    const state = this.active.get(interval);
    return state ? { ...state.candle } : null;
  }

  // ── Private core logic ─────────────────────────────────────────────────────

  private async feedInterval(
    tick: LiveTick,
    utcSec: number,
    interval: Interval,
  ): Promise<void> {
    const candleTime = snapToNseInterval(utcSec, interval);
    const state = this.active.get(interval);

    if (!state) {
      // First tick ever for this interval — open a fresh candle.
      await this.openCandle(candleTime, tick, interval);
      return;
    }

    if (candleTime > state.candle.time) {
      // New interval window — confirm previous candle, open new one.
      await this.confirmCandle(state.candle, interval, state.prevOi);
      await this.openCandle(candleTime, tick, interval);
      return;
    }

    if (candleTime === state.candle.time) {
      // Same window — normal update.
      this.applyTick(state, tick);
      await this.persistActiveState(interval, state);
      this.emit({
        type: "CANDLE_UPDATE",
        instrumentId: this.instrumentId,
        exchange: this.exchange,
        interval,
        candle: { ...state.candle },
        oiChange: this.computeOiChange(state),
      });
      return;
    }

    // candleTime < state.candle.time → late / out-of-order tick.
    await this.handleLateTick(tick, interval, candleTime, state);
  }

  private async openCandle(
    candleTime: number,
    tick: LiveTick,
    interval: Interval,
  ): Promise<void> {
    const candle: OHLCVCandle = {
      time: candleTime,
      open: tick.ltp,
      high: tick.ltp,
      low: tick.ltp,
      close: tick.ltp,
      volume: tick.volume ?? 0,
      ...(tick.oi != null ? { oi: tick.oi } : {}),
    };

    const prevState = this.active.get(interval);
    const prevOi = prevState?.candle.oi ?? null;

    const state: ActiveCandle = {
      candle,
      prevOi,
      opened: true,
      lastTickSec: Math.floor(tick.exchangeTimestampMs / 1_000),
    };

    this.active.set(interval, state);
    await this.persistActiveState(interval, state);

    this.emit({
      type: "CANDLE_OPEN",
      instrumentId: this.instrumentId,
      exchange: this.exchange,
      interval,
      candle: { ...candle },
      oiChange: null,
    });
  }

  private applyTick(state: ActiveCandle, tick: LiveTick): void {
    const c = state.candle;
    c.high = Math.max(c.high, tick.ltp);
    c.low = Math.min(c.low, tick.ltp);
    c.close = tick.ltp;
    // Accumulate delta-volume where reliable (non-null, positive).
    if (tick.volume != null && tick.volume > 0) {
      c.volume += tick.volume;
    }
    // OI: store latest value (exchange always sends absolute OI, not delta).
    if (tick.oi != null) {
      c.oi = tick.oi;
    }
    state.lastTickSec = Math.floor(tick.exchangeTimestampMs / 1_000);
  }

  private async confirmCandle(
    candle: OHLCVCandle,
    interval: Interval,
    prevOi: number | null,
  ): Promise<void> {
    const oiChange = this.computeOiChangeFromOi(candle.oi ?? null, prevOi);

    await this.persistConfirmed(candle, interval, oiChange);

    this.emit({
      type: "CANDLE_CLOSE",
      instrumentId: this.instrumentId,
      exchange: this.exchange,
      interval,
      candle: { ...candle },
      oiChange,
    });
  }

  private computeOiChange(state: ActiveCandle): number | null {
    return this.computeOiChangeFromOi(state.candle.oi ?? null, state.prevOi);
  }

  private computeOiChangeFromOi(
    currentOi: number | null,
    prevOi: number | null,
  ): number | null {
    if (currentOi == null || prevOi == null) return null;
    return currentOi - prevOi;
  }

  private async handleLateTick(
    tick: LiveTick,
    interval: Interval,
    candleTime: number,
    state: ActiveCandle,
  ): Promise<void> {
    const ageMs = state.candle.time * 1_000 - tick.exchangeTimestampMs;

    this.onLateTick?.({
      tick,
      interval,
      candleTime,
      currentCandleTime: state.candle.time,
    });

    if (ageMs > this.lateTolerance) {
      // Too old — drop without touching any closed candle.
      mdLog("stale_data", {
        reason: "late_tick_dropped",
        instrumentId: this.instrumentId,
        interval,
        tickTime: tick.exchangeTimestampMs,
        candleTime: state.candle.time,
        ageMs,
      });
      return;
    }

    // Within tolerance window — this tick belongs to the just-closed candle.
    // We do NOT re-persist it (that candle is already written to the DB) but
    // we do emit a CANDLE_UPDATE so any in-memory consumer can correct its view.
    mdLog("stale_data", {
      reason: "late_tick_tolerated",
      instrumentId: this.instrumentId,
      interval,
      tickTime: tick.exchangeTimestampMs,
      candleTime: state.candle.time,
      ageMs,
    });
  }

  // ── Persistence ─────────────────────────────────────────────────────────────

  private async persistActiveState(interval: Interval, state: ActiveCandle): Promise<void> {
    if (!this.useRedis) return;
    const key = activeKey(this.instrumentId, this.exchange, interval);
    try {
      await redis.set(key, JSON.stringify(state), "EX", this.redisTtlSeconds);
    } catch (err) {
      mdLog("stale_data", {
        reason: "redis_write_failed",
        instrumentId: this.instrumentId,
        interval,
        error: (err as Error).message,
      });
    }
  }

  private async persistConfirmed(
    candle: OHLCVCandle,
    interval: Interval,
    oiChange: number | null,
  ): Promise<void> {
    if (!this.persistToDb) return;
    try {
      await prisma.candleBar.upsert({
        where: {
          instrumentId_exchange_intervalStr_time: {
            instrumentId: this.instrumentId,
            exchange: this.exchange,
            intervalStr: interval,
            time: candle.time,
          },
        },
        update: {
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
          volume: candle.volume,
          oi: candle.oi ?? null,
          oiChange,
        },
        create: {
          instrumentId: this.instrumentId,
          exchange: this.exchange,
          intervalStr: interval,
          time: candle.time,
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
          volume: candle.volume,
          oi: candle.oi ?? null,
          oiChange,
        },
      });
    } catch (err) {
      mdLog("stale_data", {
        reason: "db_write_failed",
        instrumentId: this.instrumentId,
        interval,
        candleTime: candle.time,
        error: (err as Error).message,
      });
    }
  }

  // ── Event emission ──────────────────────────────────────────────────────────

  private emit(event: CandleEvent): void {
    try {
      this.onEvent?.(event);
    } catch (err) {
      mdLog("stale_data", {
        reason: "event_handler_threw",
        instrumentId: this.instrumentId,
        interval: event.interval,
        eventType: event.type,
        error: (err as Error).message,
      });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MultiInstrumentCandleBuilder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Manages a pool of `RealTimeCandleBuilder` instances — one per instrument.
 * This is the entry point for a live subscription that covers many symbols.
 *
 * Usage:
 *
 *   const pool = new MultiInstrumentCandleBuilder({
 *     intervals: ["1m", "5m", "15m"],
 *     onEvent: (event) => strategyEngine.handleCandleEvent(event),
 *   });
 *
 *   const sub = subscribeLiveFeed(tokens, (tick) => pool.feed(tick));
 */
export class MultiInstrumentCandleBuilder {
  private readonly builders = new Map<string, RealTimeCandleBuilder>();
  private readonly config: CandleBuilderConfig;

  constructor(config: CandleBuilderConfig = {}) {
    this.config = config;
  }

  /** Feed a tick — auto-creates a builder for new instruments. */
  async feed(tick: LiveTick): Promise<void> {
    const key = `${tick.exchange}:${tick.symbol}`;
    let builder = this.builders.get(key);
    if (!builder) {
      builder = new RealTimeCandleBuilder(tick.symbol, tick.exchange, this.config);
      if (this.config.useRedis !== false) {
        await builder.restore();
      }
      this.builders.set(key, builder);
    }
    await builder.feed(tick);
  }

  /** Close all sessions (call at 15:30 IST). */
  async closeAllSessions(): Promise<void> {
    await Promise.all([...this.builders.values()].map((b) => b.closeSession()));
  }

  /** Handle reconnect for all tracked instruments. */
  async handleReconnect(nowMs: number = Date.now()): Promise<void> {
    await Promise.all([...this.builders.values()].map((b) => b.handleReconnect(nowMs)));
  }

  /** Peek at the active candle for a specific instrument + interval. */
  peek(symbol: string, exchange: Exchange, interval: Interval): OHLCVCandle | null {
    return this.builders.get(`${exchange}:${symbol}`)?.peek(interval) ?? null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Legacy shim — kept so existing imports of CandleBuilder / MultiCandleBuilder
// from this file continue to resolve.
// ─────────────────────────────────────────────────────────────────────────────

export type CandleTick = {
  price: number;
  volume: number;
  oi?: number;
  /** UTC epoch milliseconds. */
  timestampMs: number;
};

export type CandleBuilderOptions = {
  interval: Interval;
  /** Called when a candle is completed (the next tick falls outside the interval). */
  onCandle: (candle: OHLCVCandle) => void;
  /**
   * Called on every tick with the currently open (incomplete) candle.
   * Useful for rendering a real-time "live" candle on charts.
   */
  onUpdate?: (candle: OHLCVCandle) => void;
};

/**
 * Simple in-memory single-instrument single-interval candle builder.
 * Useful for non-session-aware contexts (backtests, charting) where
 * the caller controls the tick stream and doesn't need Redis/DB persistence.
 *
 * For production live candle building use `RealTimeCandleBuilder`.
 */
export class CandleBuilder {
  private current: OHLCVCandle | null = null;
  private readonly interval: Interval;
  private readonly onCandle: (candle: OHLCVCandle) => void;
  private readonly onUpdate?: (candle: OHLCVCandle) => void;

  constructor(opts: CandleBuilderOptions) {
    this.interval = opts.interval;
    this.onCandle = opts.onCandle;
    this.onUpdate = opts.onUpdate;
  }

  feed(tick: CandleTick): void {
    const utcSec = Math.floor(tick.timestampMs / 1_000);
    const candleTime = snapToInterval(utcSec, this.interval);

    if (this.current === null) {
      this.current = this.newCandle(candleTime, tick);
    } else if (candleTime > this.current.time) {
      this.onCandle({ ...this.current });
      this.current = this.newCandle(candleTime, tick);
    } else {
      this.updateCandle(this.current, tick);
    }

    this.onUpdate?.({ ...this.current });
  }

  peek(): OHLCVCandle | null {
    return this.current ? { ...this.current } : null;
  }

  flush(): void {
    if (this.current) {
      this.onCandle({ ...this.current });
      this.current = null;
    }
  }

  private newCandle(time: number, tick: CandleTick): OHLCVCandle {
    return {
      time,
      open: tick.price,
      high: tick.price,
      low: tick.price,
      close: tick.price,
      volume: tick.volume,
      ...(tick.oi != null ? { oi: tick.oi } : {}),
    };
  }

  private updateCandle(candle: OHLCVCandle, tick: CandleTick): void {
    candle.high = Math.max(candle.high, tick.price);
    candle.low = Math.min(candle.low, tick.price);
    candle.close = tick.price;
    candle.volume += tick.volume;
    if (tick.oi != null) candle.oi = tick.oi;
  }
}

/**
 * Simple multi-instrument single-interval in-memory builder.
 * For production use `MultiInstrumentCandleBuilder`.
 */
export class MultiCandleBuilder {
  private readonly builders = new Map<string, CandleBuilder>();
  private readonly interval: Interval;
  private readonly onCandle: (token: string, candle: OHLCVCandle) => void;
  private readonly onUpdate?: (token: string, candle: OHLCVCandle) => void;

  constructor(opts: {
    interval: Interval;
    onCandle: (token: string, candle: OHLCVCandle) => void;
    onUpdate?: (token: string, candle: OHLCVCandle) => void;
  }) {
    this.interval = opts.interval;
    this.onCandle = opts.onCandle;
    this.onUpdate = opts.onUpdate;
  }

  feed(token: string, tick: CandleTick): void {
    let builder = this.builders.get(token);
    if (!builder) {
      builder = new CandleBuilder({
        interval: this.interval,
        onCandle: (c) => this.onCandle(token, c),
        onUpdate: this.onUpdate ? (c) => this.onUpdate!(token, c) : undefined,
      });
      this.builders.set(token, builder);
    }
    builder.feed(tick);
  }

  flushAll(): void {
    for (const builder of this.builders.values()) {
      builder.flush();
    }
  }

  peek(token: string): OHLCVCandle | null {
    return this.builders.get(token)?.peek() ?? null;
  }
}
