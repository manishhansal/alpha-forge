/**
 * Candle builder service.
 *
 * Assembles real-time OHLCV candles from a stream of live ticks. Useful when
 * the provider doesn't natively push completed candles (e.g. Angel One
 * SmartStream pushes LTP ticks, not candles).
 *
 * Each builder instance maintains a single "current" open candle for one
 * instrument and one interval. When the candle closes (wall-clock crosses the
 * interval boundary), it emits the completed candle via the `onCandle` callback
 * and opens a new one.
 *
 * Timestamps are always UTC epoch seconds (candle open time).
 */

import type { Interval, OHLCVCandle } from "../types";

// ── Interval to seconds ───────────────────────────────────────────────────────

const INTERVAL_SECONDS: Record<Interval, number> = {
  "1m": 60,
  "3m": 180,
  "5m": 300,
  "10m": 600,
  "15m": 900,
  "30m": 1_800,
  "1h": 3_600,
  "1d": 86_400,
  "1w": 604_800,
  "1M": 2_592_000, // 30 days approximation
};

/** Snap a UTC epoch seconds timestamp to the start of the containing interval. */
export function snapToInterval(utcSeconds: number, interval: Interval): number {
  const step = INTERVAL_SECONDS[interval];
  return Math.floor(utcSeconds / step) * step;
}

// ── Candle builder ────────────────────────────────────────────────────────────

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

  /**
   * Feed a new price tick into the builder.
   * Thread-safety note: JavaScript is single-threaded — no locking needed.
   */
  feed(tick: CandleTick): void {
    const utcSec = Math.floor(tick.timestampMs / 1_000);
    const candleTime = snapToInterval(utcSec, this.interval);

    if (this.current === null) {
      // First tick — open the first candle.
      this.current = this.newCandle(candleTime, tick);
    } else if (candleTime > this.current.time) {
      // New interval — emit the completed candle and start fresh.
      this.onCandle({ ...this.current });
      this.current = this.newCandle(candleTime, tick);
    } else {
      // Update the current candle.
      this.updateCandle(this.current, tick);
    }

    this.onUpdate?.({ ...this.current });
  }

  /** Return the current open candle without closing it, or null if no ticks yet. */
  peek(): OHLCVCandle | null {
    return this.current ? { ...this.current } : null;
  }

  /** Close the current candle and reset state (e.g. on market close). */
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
 * Build a map of candle builders keyed by token, suitable for managing a
 * multi-instrument subscription.
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
