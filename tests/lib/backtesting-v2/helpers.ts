/**
 * Shared test helpers for backtesting-v2 unit tests.
 *
 * All helpers produce deterministic outputs — no random data, no network,
 * no DB. Timestamps use a fixed Monday 2024-01-08 IST week so that session
 * boundary and weekday logic fires predictably.
 */

import type { OHLCVBar, InstrumentId } from "@/lib/backtesting-v2/events/market-event";
import type { SignalEvent } from "@/lib/backtesting-v2/events/signal-event";
import type { StrategyContext } from "@/lib/backtesting-v2/engine/event-engine";
import type { StrategyHandler } from "@/lib/backtesting-v2/adapter/strategy-adapter";
import { buildSignalEvent } from "@/lib/backtesting-v2/events/signal-event";
import { EventEngine } from "@/lib/backtesting-v2/engine/event-engine";
import { DefaultRiskManager } from "@/lib/backtesting-v2/engine/risk-manager";
import { ExecutionModel } from "@/lib/backtesting-v2/execution/execution-model";
import { resetEventIdCounter } from "@/lib/backtesting-v2/events/market-event";
import { resetPositionCounter } from "@/lib/backtesting-v2/models/position";

// ── IST constants ─────────────────────────────────────────────────────────────

export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** UTC ms for a given IST date + time. */
export function istToUtcMs(
  year: number,
  month: number, // 1-based
  day: number,
  hour: number,
  minute: number,
): number {
  return Date.UTC(year, month - 1, day, hour, minute) - IST_OFFSET_MS;
}

/** Monday 2024-01-08 09:15 IST */
export const DAY1_OPEN_MS = istToUtcMs(2024, 1, 8, 9, 15);
/** Monday 2024-01-08 15:30 IST */
export const DAY1_CLOSE_MS = istToUtcMs(2024, 1, 8, 15, 30);
/** Tuesday 2024-01-09 09:15 IST */
export const DAY2_OPEN_MS = istToUtcMs(2024, 1, 9, 9, 15);
/** Tuesday 2024-01-09 15:30 IST */
export const DAY2_CLOSE_MS = istToUtcMs(2024, 1, 9, 15, 30);

// ── Instrument factories ──────────────────────────────────────────────────────

export function niftyInstrument(overrides: Partial<InstrumentId> = {}): InstrumentId {
  return {
    symbol: "NIFTY",
    exchange: "NFO",
    instrumentType: "FUTIDX",
    lotSize: 50,
    tickSize: 0.05,
    expiry: "2024-01-25",  // last Thursday of Jan 2024
    strike: null,
    optionType: null,
    ...overrides,
  };
}

export function equityInstrument(symbol = "RELIANCE"): InstrumentId {
  return {
    symbol,
    exchange: "NSE",
    instrumentType: "EQ",
    lotSize: 1,
    tickSize: 0.05,
    expiry: null,
    strike: null,
    optionType: null,
  };
}

// ── Bar builders ──────────────────────────────────────────────────────────────

/**
 * Build a single 1-minute NSE bar.
 *
 * `minuteOffset` is added to `baseOpenMs` to produce distinct bars.
 * Bars within the same session are automatically in chronological order.
 */
export function makeBar(opts: {
  openMs: number;
  close: number;
  open?: number;
  high?: number;
  low?: number;
  volume?: number;
}): OHLCVBar {
  const spread = 0.002;
  const o = opts.open ?? opts.close;
  const hi = opts.high ?? Math.max(o, opts.close) * (1 + spread);
  const lo = opts.low ?? Math.min(o, opts.close) * (1 - spread);
  return {
    openMs: opts.openMs,
    closeMs: opts.openMs + 60_000 - 1,
    open: o,
    high: hi,
    low: lo,
    close: opts.close,
    volume: opts.volume ?? 10_000,
  };
}

/**
 * Build a series of N 1-minute bars for a single NSE session.
 * Starts at `sessionOpenMs` (default: DAY1_OPEN_MS).
 * Prices track the `closes` array. If `closes` is shorter than N, the last
 * price is repeated.
 */
export function makeSessionBars(
  closes: number[],
  sessionOpenMs = DAY1_OPEN_MS,
): OHLCVBar[] {
  return closes.map((close, i) => {
    const openMs = sessionOpenMs + i * 60_000;
    const prevClose = i === 0 ? close : closes[i - 1];
    return makeBar({ openMs, close, open: prevClose });
  });
}

/**
 * Build bars that span two sessions separated by an overnight gap.
 */
export function makeTwoSessionBars(
  day1Closes: number[],
  day2Closes: number[],
): OHLCVBar[] {
  return [
    ...makeSessionBars(day1Closes, DAY1_OPEN_MS),
    ...makeSessionBars(day2Closes, DAY2_OPEN_MS),
  ];
}

/**
 * Build a bar with explicitly controlled high/low to trigger SL or TP.
 * - `hitStop = true`   → low goes below stopLoss
 * - `hitTarget = true` → high goes above target
 */
export function makeBarWithHit(opts: {
  openMs: number;
  close: number;
  stopLoss?: number;
  target?: number;
  hitStop?: boolean;
  hitTarget?: boolean;
}): OHLCVBar {
  const base = makeBar({ openMs: opts.openMs, close: opts.close });
  return {
    ...base,
    low: opts.hitStop && opts.stopLoss !== undefined
      ? opts.stopLoss - 1
      : base.low,
    high: opts.hitTarget && opts.target !== undefined
      ? opts.target + 1
      : base.high,
  };
}

// ── Strategy factories ────────────────────────────────────────────────────────

/**
 * A strategy that emits a LONG signal on every bar that is NOT a session
 * close, with configurable SL/TP.
 */
export function alwaysLongStrategy(opts: {
  strategyId?: string;
  stopLoss?: number;
  target?: number;
  confidence?: number;
  dataQuality?: number;
  /** If set, only emit on bars where barIndex % emitEvery === 0. */
  emitEvery?: number;
} = {}): StrategyHandler {
  const id = opts.strategyId ?? "always-long";
  return {
    id,
    name: id,
    onBar(ctx: StrategyContext) {
      if (ctx.isSessionClose) return;
      if (opts.emitEvery && ctx.barIndex % opts.emitEvery !== 0) return;
      const entry = ctx.currentBar.close;
      const sl = opts.stopLoss ?? entry * 0.98;
      const tgt = opts.target ?? entry * 1.04;
      ctx.emit(
        buildSignalEvent({
          sourceEventId: `mkt_${ctx.barIndex}`,
          timestampMs: ctx.currentBar.closeMs,
          instrument: ctx.instrument as InstrumentId,
          direction: "LONG",
          levels: {
            entry,
            stopLoss: sl,
            target: tgt,
            riskReward:
              Math.abs(tgt - entry) / Math.abs(entry - sl),
          },
          exitTiming: "NEXT_BAR_OPEN",
          signalBarIndex: ctx.barIndex,
          atr: Math.abs(entry - sl),
          confidence: opts.confidence ?? 0.8,
          attribution: {
            strategyId: id,
            modelVersion: "test-v1",
            featureVersion: "test-features-v1",
            marketRegime: "UNKNOWN",
            dataQualityScore: opts.dataQuality ?? 0.9,
          },
        }),
      );
    },
  };
}

/**
 * A strategy that emits a LONG signal on bar `triggerBarIndex` only.
 * Useful for precise single-trade tests.
 */
export function singleSignalStrategy(opts: {
  triggerBarIndex: number;
  entry: number;
  stopLoss: number;
  target: number;
  strategyId?: string;
  direction?: "LONG" | "SHORT";
}): StrategyHandler {
  const id = opts.strategyId ?? "single-signal";
  return {
    id,
    name: id,
    onBar(ctx: StrategyContext) {
      if (ctx.barIndex !== opts.triggerBarIndex) return;
      ctx.emit(
        buildSignalEvent({
          sourceEventId: `mkt_${ctx.barIndex}`,
          timestampMs: ctx.currentBar.closeMs,
          instrument: ctx.instrument as InstrumentId,
          direction: opts.direction ?? "LONG",
          levels: {
            entry: opts.entry,
            stopLoss: opts.stopLoss,
            target: opts.target,
            riskReward:
              Math.abs(opts.target - opts.entry) /
              Math.abs(opts.entry - opts.stopLoss),
          },
          exitTiming: "NEXT_BAR_OPEN",
          signalBarIndex: ctx.barIndex,
          atr: Math.abs(opts.entry - opts.stopLoss),
          confidence: 0.85,
          attribution: {
            strategyId: id,
            modelVersion: "test-v1",
            featureVersion: "test-features-v1",
            marketRegime: "UNKNOWN",
            dataQualityScore: 0.95,
          },
        }),
      );
    },
  };
}

// ── Engine factory ────────────────────────────────────────────────────────────

/**
 * Build a zero-cost engine for unit tests (zero slippage, zero commission).
 * Strategies, risk config, and portfolio config can all be overridden.
 */
export function makeTestEngine(opts: {
  initialCapital?: number;
  strategies?: StrategyHandler[];
  maxOpenPositions?: number;
  riskPerTrade?: number;
  minRR?: number;
} = {}): EventEngine {
  const engine = new EventEngine({
    portfolioConfig: {
      initialCapital: opts.initialCapital ?? 1_000_000,
      marginFactor: 0.1,
      maxOpenPositions: opts.maxOpenPositions ?? 5,
    },
    clockConfig: {
      filterToSession: false, // tests use hand-crafted bars; don't filter
      filterWeekends: false,
      filterHolidays: false,
    },
    logEvents: true,
  })
    .setFillModel(ExecutionModel.ideal())
    .setRiskManager(
      new DefaultRiskManager({
        riskPerTradeFraction: opts.riskPerTrade ?? 0.02,
        minRiskReward: opts.minRR ?? 1.0,
        maxOpenPositions: opts.maxOpenPositions ?? 5,
        minDataQuality: 0.0,
      }),
    );

  for (const s of opts.strategies ?? []) {
    engine.addStrategy(s);
  }

  return engine;
}

// ── Determinism helpers ───────────────────────────────────────────────────────

/** Reset all engine counters before each test for deterministic ids. */
export function resetCounters(): void {
  resetEventIdCounter();
  resetPositionCounter();
}
