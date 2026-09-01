/**
 * IndiaPriceStrategyAdapter — wraps the existing AlphaForge
 * `IndiaPriceStrategyModule` (src/features/india/scalping/strategies/
 * price-modules.ts) so it can run inside the v2 event engine without
 * any changes to the original strategy code.
 *
 * Bridge contract
 * ───────────────
 *   v1 interface:  mod.run(window: ReadonlyArray<Candle>) → IndiaPriceSignal | null
 *   v2 interface:  strategy.onBar(ctx: StrategyContext) → void (emit via ctx)
 *
 * The adapter converts OHLCVBar[] → Candle[] (time in seconds), calls
 * mod.run(), and if a signal fires, converts IndiaPriceSignal → SignalEvent
 * complete with attribution fields, then calls ctx.emit().
 *
 * Anti-lookahead guarantee
 * ────────────────────────
 * The adapter passes `ctx.candles` (already bounded to [0..barIndex]) to
 * mod.run(), so the underlying strategy can never access future bars.
 * The mod's own `warmup` field is respected — we only call run() once
 * enough bars are available.
 *
 * Migration path
 * ──────────────
 * 1. Existing strategies continue running via backtest-core.ts unchanged.
 * 2. To migrate a strategy to v2, wrap it here and pass to EventEngine.
 * 3. After validation parity, the v1 path can be retired.
 */

import type { IndiaPriceStrategyModule } from "@/features/india/scalping/strategies/price-modules";
import type { OHLCVBar, InstrumentId } from "../events/market-event";
import type { StrategyContext } from "../engine/event-engine";
import type { SignalDirection } from "../events/signal-event";
import type { SignalExitTiming, SignalLevels, MarketRegime } from "../events/signal-event";
import { buildSignalEvent } from "../events/signal-event";
import { BaseStrategy } from "./strategy-adapter";

// ── Candle bridge ─────────────────────────────────────────────────────────────

/**
 * Convert the v2 OHLCVBar (timestamps in ms) to the legacy Candle format
 * (time in epoch SECONDS) used by all existing India strategy modules.
 */
function toLegacyCandle(bar: OHLCVBar): { time: number; open: number; high: number; low: number; close: number; volume: number } {
  return {
    time: Math.floor(bar.closeMs / 1000),
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume ?? 0,
  };
}

// ── Adapter configuration ─────────────────────────────────────────────────────

export interface IndiaPriceAdapterConfig {
  /**
   * How generated orders should be executed. Default: NEXT_BAR_OPEN.
   * Use NEXT_BAR_OPEN for realistic backtesting to avoid lookahead.
   */
  exitTiming?: SignalExitTiming;
  /** Market regime to tag signals with. Default: "UNKNOWN". */
  marketRegime?: MarketRegime;
  /** ML model version for attribution. Default: "v1-legacy". */
  modelVersion?: string;
  /** Feature pipeline version. Default: "price-ohlcv-v1". */
  featureVersion?: string;
  /**
   * Data quality score [0, 1] — can be overridden per-bar by passing a
   * function. Default: 0.8 (legacy strategies have verified data pipelines).
   */
  dataQualityScore?: number | ((ctx: StrategyContext) => number);
  /**
   * Minimum confidence threshold — signals below this are not emitted.
   * Default: 0.0 (emit all).
   */
  minConfidence?: number;
}

// ── Adapter ───────────────────────────────────────────────────────────────────

export class IndiaPriceStrategyAdapter extends BaseStrategy {
  readonly id: string;
  readonly name: string;

  private readonly mod: IndiaPriceStrategyModule;
  private readonly cfg: Required<IndiaPriceAdapterConfig>;

  constructor(
    mod: IndiaPriceStrategyModule,
    config: IndiaPriceAdapterConfig = {},
  ) {
    super();
    this.mod = mod;
    this.id = mod.id;
    this.name = `India Price Strategy: ${mod.id}`;
    this.cfg = {
      exitTiming: config.exitTiming ?? "NEXT_BAR_OPEN",
      marketRegime: config.marketRegime ?? "UNKNOWN",
      modelVersion: config.modelVersion ?? "v1-legacy",
      featureVersion: config.featureVersion ?? "price-ohlcv-v1",
      dataQualityScore: config.dataQualityScore ?? 0.8,
      minConfidence: config.minConfidence ?? 0.0,
    };
  }

  onBar(ctx: StrategyContext): void {
    // Need at least `warmup` bars before the strategy can fire
    if (ctx.barIndex < this.mod.warmup - 1) return;

    // Don't generate new entries on session close or expiry day
    if (ctx.isSessionClose || ctx.isExpiryDay) return;

    // Convert v2 candle slice to legacy Candle format (bounded by ctx.candles)
    const window = Array.from(ctx.candles).map(toLegacyCandle);

    let signal = null;
    try {
      signal = this.mod.run(window);
    } catch {
      return; // strategy errors must not crash the engine
    }

    if (!signal) return;
    if (signal.confidence < this.cfg.minConfidence) return;

    const direction: SignalDirection = signal.direction;
    const levels: SignalLevels = {
      entry: signal.entry,
      stopLoss: signal.stopLoss,
      target: signal.target,
      riskReward:
        Math.abs(signal.entry - signal.stopLoss) > 0
          ? Math.abs(signal.target - signal.entry) /
            Math.abs(signal.entry - signal.stopLoss)
          : 0,
    };

    const dataQuality =
      typeof this.cfg.dataQualityScore === "function"
        ? this.cfg.dataQualityScore(ctx)
        : this.cfg.dataQualityScore;

    const signalEvent = buildSignalEvent({
      sourceEventId: ctx.currentBar.closeMs.toString(),
      timestampMs: ctx.currentBar.closeMs,
      instrument: ctx.instrument as InstrumentId,
      direction,
      levels,
      exitTiming: this.cfg.exitTiming,
      signalBarIndex: ctx.barIndex,
      atr: Math.abs(signal.entry - signal.stopLoss), // fallback ATR estimate
      confidence: signal.confidence,
      attribution: {
        strategyId: this.id,
        modelVersion: this.cfg.modelVersion,
        featureVersion: this.cfg.featureVersion,
        marketRegime: this.cfg.marketRegime,
        dataQualityScore: dataQuality,
      },
    });

    ctx.emit(signalEvent);
  }
}
