/**
 * index.ts — Market Microstructure Intelligence Engine
 *
 * Composes all six sub-modules into a single stateful engine that:
 *
 *   1. Ingests raw MarketDepth ticks and OHLCV candles.
 *   2. Produces a composite MicrostructureSnapshot on every tick.
 *   3. Scores execution conditions as EXCELLENT / GOOD / FAIR / POOR.
 *   4. Persists aggregated features in a 1-minute and 5-minute feature store
 *      (ring-buffer — never retains raw ticks indefinitely).
 *
 * ── Integration guide ────────────────────────────────────────────────────────
 *
 * Meta Decision Engine (future):
 *   Pass `snapshot.execQuality` as a gate — skip or defer entries when POOR.
 *   Use `snapshot.toxicity.score` to reduce signal confidence before sizing.
 *
 * Portfolio Risk Engine (portfolio-risk.ts):
 *   const adjustedConfidence = adjustConfidenceForToxicity(rawConfidence, snapshot.toxicity);
 *   Feed `adjustedConfidence` into SizingInputs.confidence.
 *   Multiply final qty by `toxicitySizingMultiplier(snapshot.toxicity.tier)`.
 *
 * Execution Simulator (india-execution-engine.ts):
 *   After fill: annotate IndiaFillExtras.fillQuality using
 *   `execQualityToFillScore(snapshot.execQuality)` so ExecutionQualityReporter
 *   reflects live microstructure conditions rather than post-hoc slippage.
 *
 * ── Feature store ────────────────────────────────────────────────────────────
 *
 * Aggregated features (1m and 5m buckets) are stored in fixed-size ring
 * buffers.  Each bucket computes mean/min/max of the key microstructure
 * signals so downstream models get both level and range information.
 * Raw ticks are NOT retained after aggregation.
 */

import type { MarketDepth, OHLCVCandle } from "@/lib/market-data/types";

import {
  buildOrderBookSnapshot,
  type OrderBookSnapshot,
} from "./order-book";

import {
  computeImbalance,
  type ImbalanceResult,
  type ImbalanceConfig,
  DEFAULT_IMBALANCE_CONFIG,
} from "./imbalance";

import {
  SpreadTracker,
  type SpreadResult,
  type SpreadConfig,
  DEFAULT_SPREAD_CONFIG,
} from "./spread";

import {
  computeLiquidityScore,
  liquiditySizingMultiplier,
  type LiquidityScore,
  type LiquidityInputs,
  type LiquidityConfig,
  DEFAULT_LIQUIDITY_CONFIG,
} from "./liquidity";

import {
  computeVpin,
  computeToxicityScore,
  adjustConfidenceForToxicity,
  toxicitySizingMultiplier,
  type VpinConfig,
  type ToxicityScore,
  type ToxicityConfig,
  DEFAULT_VPIN_CONFIG,
  DEFAULT_TOXICITY_CONFIG,
} from "./toxicity";

import {
  PressureTracker,
  type PressureResult,
  type PressureConfig,
  DEFAULT_PRESSURE_CONFIG,
} from "./pressure";

// Re-export sub-module types and helpers so consumers import from one place.
export type { OrderBookSnapshot }  from "./order-book";
export { buildOrderBookSnapshot, bidQtyTopN, askQtyTopN, isEmptyBook } from "./order-book";

export type { ImbalanceResult, ImbalanceRegime, ImbalanceConfig } from "./imbalance";
export { computeImbalance, computeL1Imbalance, computeL5Imbalance,
         computeWeightedImbalance, classifyImbalance,
         DEFAULT_IMBALANCE_CONFIG } from "./imbalance";

export type { SpreadSample, SpreadResult, SpreadConfig } from "./spread";
export { SpreadTracker, sampleSpread, percentileRank,
         DEFAULT_SPREAD_CONFIG } from "./spread";

export type { LiquidityScore, LiquidityInputs, LiquidityTier,
              LiquidityConfig } from "./liquidity";
export { computeLiquidityScore, classifyLiquidityTier,
         liquiditySizingMultiplier, DEFAULT_LIQUIDITY_CONFIG } from "./liquidity";

export type { VpinResult, VpinConfig, ToxicityInputs, ToxicityScore,
              ToxicityTier, ToxicityConfig } from "./toxicity";
export { computeVpin, computeToxicityScore, adjustConfidenceForToxicity,
         toxicitySizingMultiplier, imbalanceExtremity, classifyToxicity,
         DEFAULT_VPIN_CONFIG, DEFAULT_TOXICITY_CONFIG } from "./toxicity";

export type { PressureFrame, PressureResult, PressureRegime,
              PressureConfig } from "./pressure";
export { PressureTracker, computePressureFrame, classifyPressureRegime,
         DEFAULT_PRESSURE_CONFIG } from "./pressure";

// ── Execution Quality Score ───────────────────────────────────────────────────

/**
 * Qualitative rating of current execution conditions.
 *
 *   EXCELLENT — tight spread, balanced book, clean flow, deep liquidity
 *   GOOD      — mostly favourable; some minor adverse factor
 *   FAIR      — one significant adverse factor (wide spread OR low liquidity OR elevated VPIN)
 *   POOR      — multiple adverse factors; execution is expensive / high-risk
 *
 * Integration:
 *   • Meta Decision Engine: skip entries when POOR; prefer EXCELLENT / GOOD.
 *   • Execution Simulator : use `execQualityToFillScore()` as fillQuality.
 *   • Portfolio Risk Engine: add toxicity/sizing adjustments on FAIR and POOR.
 */
export type ExecQuality = "EXCELLENT" | "GOOD" | "FAIR" | "POOR";

/**
 * Map ExecQuality to a [0, 1] fill-quality score compatible with
 * `FillQualityRecord.fillQuality` in execution-quality-report.ts.
 */
export function execQualityToFillScore(quality: ExecQuality): number {
  switch (quality) {
    case "EXCELLENT": return 1.00;
    case "GOOD":      return 0.75;
    case "FAIR":      return 0.50;
    case "POOR":      return 0.25;
  }
}

// ── Engine config ─────────────────────────────────────────────────────────────

export interface MicrostructureConfig {
  imbalance: ImbalanceConfig;
  spread:    SpreadConfig;
  liquidity: LiquidityConfig;
  vpin:      VpinConfig;
  toxicity:  ToxicityConfig;
  pressure:  PressureConfig;

  /**
   * Thresholds that gate the ExecQuality score.
   * Each field is a limit: *exceeding* it degrades the score.
   */
  qualityGates: {
    /** pctSpread above which quality drops one tier. Default: 0.005 (50 bps). */
    wideSpreads:           number;
    /** pctSpread above which quality drops two tiers. Default: 0.015. */
    veryWideSpreads:       number;
    /** Toxicity score above which quality drops one tier. Default: 0.40. */
    moderateToxicity:      number;
    /** Toxicity score above which quality drops two tiers. Default: 0.65. */
    highToxicity:          number;
    /** Liquidity score below which quality drops one tier. Default: 0.40. */
    lowLiquidity:          number;
    /** Liquidity score below which quality drops two tiers. Default: 0.20. */
    veryLowLiquidity:      number;
  };

  /**
   * Feature store bucket sizes in milliseconds.
   * Default: 60_000 (1m) and 300_000 (5m).
   */
  featureBucketMs: [number, number];

  /**
   * Max number of completed feature buckets to retain per resolution.
   * Default: 390 (≈ full NSE trading day at 1m resolution).
   */
  maxFeatureBuckets: number;
}

export const DEFAULT_MICROSTRUCTURE_CONFIG: MicrostructureConfig = {
  imbalance: DEFAULT_IMBALANCE_CONFIG,
  spread:    DEFAULT_SPREAD_CONFIG,
  liquidity: DEFAULT_LIQUIDITY_CONFIG,
  vpin:      DEFAULT_VPIN_CONFIG,
  toxicity:  DEFAULT_TOXICITY_CONFIG,
  pressure:  DEFAULT_PRESSURE_CONFIG,
  qualityGates: {
    wideSpreads:      0.005,
    veryWideSpreads:  0.015,
    moderateToxicity: 0.40,
    highToxicity:     0.65,
    lowLiquidity:     0.40,
    veryLowLiquidity: 0.20,
  },
  featureBucketMs:   [60_000, 300_000],
  maxFeatureBuckets: 390,
};

// ── Snapshot (engine output per tick) ────────────────────────────────────────

export interface MicrostructureSnapshot {
  symbol:     string;
  timestampMs: number;

  book:       OrderBookSnapshot;
  imbalance:  ImbalanceResult;
  spread:     SpreadResult;
  liquidity:  LiquidityScore;
  toxicity:   ToxicityScore;
  pressure:   PressureResult | null;   // null until second tick

  /** Current VPIN (from last computeVpin call). */
  vpin:       number;

  /** Composite execution quality rating. */
  execQuality: ExecQuality;

  /**
   * Suggested combined sizing multiplier [0, 1].
   * Product of liquidity and toxicity multipliers.
   * Caller should further multiply by their drawdown/confidence factors.
   */
  sizingMultiplier: number;
}

// ── Feature store types ───────────────────────────────────────────────────────

export interface FeatureBucket {
  /** Bucket open time (UTC epoch ms). */
  openMs:  number;
  /** Bucket close time (UTC epoch ms). */
  closeMs: number;

  /** Number of ticks aggregated into this bucket. */
  tickCount: number;

  /** Order book imbalance (weighted) — mean, min, max. */
  imbalanceMean: number;
  imbalanceMin:  number;
  imbalanceMax:  number;

  /** Spread fraction — mean, min, max. */
  spreadMean: number;
  spreadMin:  number;
  spreadMax:  number;

  /** Liquidity score — mean, min. */
  liquidityMean: number;
  liquidityMin:  number;

  /** Toxicity score — mean, max. */
  toxicityMean: number;
  toxicityMax:  number;

  /** Net pressure [-1, 1] — mean. */
  pressureMean: number;

  /** VPIN — mean, max. */
  vpinMean: number;
  vpinMax:  number;

  /** Most common exec quality in this bucket. */
  dominantExecQuality: ExecQuality;
}

/** Two-resolution feature store. */
export interface FeatureStore {
  /** 1-minute completed buckets, oldest first. */
  "1m": FeatureBucket[];
  /** 5-minute completed buckets, oldest first. */
  "5m": FeatureBucket[];
}

// ── Internal accumulator for an in-progress bucket ───────────────────────────

interface BucketAccumulator {
  openMs:    number;
  bucketMs:  number;

  imbalances:  number[];
  spreads:     number[];
  liquidities: number[];
  toxicities:  number[];
  pressures:   number[];
  vpins:       number[];
  qualities:   ExecQuality[];
}

function emptyAccumulator(openMs: number, bucketMs: number): BucketAccumulator {
  return {
    openMs, bucketMs,
    imbalances:  [],
    spreads:     [],
    liquidities: [],
    toxicities:  [],
    pressures:   [],
    vpins:       [],
    qualities:   [],
  };
}

function flushAccumulator(acc: BucketAccumulator): FeatureBucket {
  const n = acc.imbalances.length;
  const mean   = (arr: number[]) => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
  const minOf  = (arr: number[]) => arr.length ? Math.min(...arr) : 0;
  const maxOf  = (arr: number[]) => arr.length ? Math.max(...arr) : 0;

  // Dominant exec quality: most frequent
  const qualCounts: Record<ExecQuality, number> = { EXCELLENT: 0, GOOD: 0, FAIR: 0, POOR: 0 };
  for (const q of acc.qualities) qualCounts[q]++;
  const dominantExecQuality = (Object.keys(qualCounts) as ExecQuality[])
    .reduce((best, q) => qualCounts[q] > qualCounts[best] ? q : best, "GOOD" as ExecQuality);

  return {
    openMs:              acc.openMs,
    closeMs:             acc.openMs + acc.bucketMs,
    tickCount:           n,
    imbalanceMean:       mean(acc.imbalances),
    imbalanceMin:        minOf(acc.imbalances),
    imbalanceMax:        maxOf(acc.imbalances),
    spreadMean:          mean(acc.spreads),
    spreadMin:           minOf(acc.spreads),
    spreadMax:           maxOf(acc.spreads),
    liquidityMean:       mean(acc.liquidities),
    liquidityMin:        minOf(acc.liquidities),
    toxicityMean:        mean(acc.toxicities),
    toxicityMax:         maxOf(acc.toxicities),
    pressureMean:        mean(acc.pressures),
    vpinMean:            mean(acc.vpins),
    vpinMax:             maxOf(acc.vpins),
    dominantExecQuality,
  };
}

// ── MicrostructureEngine ──────────────────────────────────────────────────────

/**
 * Stateful per-symbol microstructure intelligence engine.
 *
 * One instance per instrument.  Feed market depth ticks via `onDepthTick()`.
 * Periodically call `onCandles()` to refresh the VPIN score.
 *
 * Example (live trading loop):
 *
 *   const engine = new MicrostructureEngine("NIFTY-FUT");
 *   // on every depth update:
 *   const snap = engine.onDepthTick(depth, { volume, openInterest, isFnO: true });
 *   if (snap.execQuality === "POOR") return;  // skip entry
 *   const adjustedConfidence = adjustConfidenceForToxicity(rawConf, snap.toxicity);
 *   // on each new OHLCV candle batch:
 *   engine.onCandles(candles);
 */
export class MicrostructureEngine {
  readonly symbol:  string;
  readonly config:  MicrostructureConfig;

  private readonly _spreadTracker:   SpreadTracker;
  private readonly _pressureTracker: PressureTracker;

  private _currentVpin = 0;

  /** Accumulators for each configured resolution. */
  private readonly _accumulators: BucketAccumulator[];

  /** Completed buckets ring-buffer per resolution. */
  private readonly _store: FeatureBucket[][];

  constructor(
    symbol: string,
    config: Partial<MicrostructureConfig> = {},
  ) {
    this.symbol = symbol;
    this.config = {
      ...DEFAULT_MICROSTRUCTURE_CONFIG,
      ...config,
      qualityGates: {
        ...DEFAULT_MICROSTRUCTURE_CONFIG.qualityGates,
        ...config.qualityGates,
      },
    };

    this._spreadTracker   = new SpreadTracker(this.config.spread);
    this._pressureTracker = new PressureTracker(this.config.pressure);

    const [bucketMs1, bucketMs2] = this.config.featureBucketMs;
    this._accumulators = [
      emptyAccumulator(0, bucketMs1),
      emptyAccumulator(0, bucketMs2),
    ];
    this._store = [[], []];
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Ingest a raw depth tick.
   *
   * @param depth           Raw MarketDepth from market-data provider.
   * @param liquidityInputs Volume, OI, and isFnO for liquidity scoring.
   * @param timestampMs     Tick timestamp (default: Date.now()).
   */
  onDepthTick(
    depth: MarketDepth,
    liquidityInputs: Pick<LiquidityInputs, "volume" | "openInterest" | "isFnO" | "avgTradeSize">,
    timestampMs = Date.now(),
  ): MicrostructureSnapshot {
    const book = buildOrderBookSnapshot(depth, timestampMs);

    // Spread
    const spread = this._spreadTracker.update(book);

    // Imbalance
    const imbalance = computeImbalance(book, this.config.imbalance);

    // Liquidity
    const liquidity = computeLiquidityScore(
      { ...liquidityInputs, snapshot: book, pctSpread: spread.pctSpread },
      this.config.liquidity,
    );

    // Toxicity
    const toxicity = computeToxicityScore(
      {
        vpin:              this._currentVpin,
        weightedImbalance: imbalance.weighted,
        spreadPercentile:  spread.spreadPercentile,
      },
      this.config.toxicity,
    );

    // Pressure
    const pressure = this._pressureTracker.push(book);

    // Execution quality
    const execQuality = this._scoreExecQuality(spread, liquidity, toxicity);

    // Sizing multiplier
    const sizingMultiplier =
      liquiditySizingMultiplier(liquidity.tier) *
      toxicitySizingMultiplier(toxicity.tier);

    const snapshot: MicrostructureSnapshot = {
      symbol: this.symbol,
      timestampMs,
      book,
      imbalance,
      spread,
      liquidity,
      toxicity,
      pressure,
      vpin:     this._currentVpin,
      execQuality,
      sizingMultiplier,
    };

    // Feed feature store
    this._accumulate(snapshot);

    return snapshot;
  }

  /**
   * Refresh the VPIN score from a batch of OHLCV candles.
   * Call this whenever new candles are available (e.g. on each bar close).
   */
  onCandles(candles: readonly OHLCVCandle[]): number {
    const result = computeVpin(candles, this.config.vpin);
    this._currentVpin = result.currentVpin;
    return this._currentVpin;
  }

  /** Current VPIN score (last updated by `onCandles`). */
  get currentVpin(): number {
    return this._currentVpin;
  }

  /**
   * Access the feature store.
   *
   * featureStore["1m"] — array of completed 1-minute buckets, oldest first.
   * featureStore["5m"] — array of completed 5-minute buckets, oldest first.
   */
  get featureStore(): FeatureStore {
    return {
      "1m": [...this._store[0]],
      "5m": [...this._store[1]],
    };
  }

  /** Reset all state — useful between trading sessions. */
  reset(): void {
    this._spreadTracker.reset();
    this._pressureTracker.reset();
    this._currentVpin = 0;
    const [ms1, ms2] = this.config.featureBucketMs;
    this._accumulators[0] = emptyAccumulator(0, ms1);
    this._accumulators[1] = emptyAccumulator(0, ms2);
    this._store[0].length = 0;
    this._store[1].length = 0;
  }

  // ── Execution quality scoring ───────────────────────────────────────────────

  private _scoreExecQuality(
    spread:    SpreadResult,
    liquidity: LiquidityScore,
    toxicity:  ToxicityScore,
  ): ExecQuality {
    const g = this.config.qualityGates;
    let demerits = 0;

    // Spread contribution
    if (spread.pctSpread >= g.veryWideSpreads) demerits += 2;
    else if (spread.pctSpread >= g.wideSpreads) demerits += 1;

    // Toxicity contribution
    if (toxicity.score >= g.highToxicity)     demerits += 2;
    else if (toxicity.score >= g.moderateToxicity) demerits += 1;

    // Liquidity contribution
    if (liquidity.score <= g.veryLowLiquidity) demerits += 2;
    else if (liquidity.score <= g.lowLiquidity) demerits += 1;

    if (demerits === 0) return "EXCELLENT";
    if (demerits === 1) return "GOOD";
    if (demerits <= 3)  return "FAIR";
    return "POOR";
  }

  // ── Feature store accumulation ──────────────────────────────────────────────

  private _accumulate(snap: MicrostructureSnapshot): void {
    for (let ri = 0; ri < this._accumulators.length; ri++) {
      const acc = this._accumulators[ri];

      // Initialise bucket open time on first tick
      if (acc.openMs === 0) {
        this._accumulators[ri] = emptyAccumulator(snap.timestampMs, acc.bucketMs);
      }

      const curr = this._accumulators[ri];
      const bucketEnd = curr.openMs + curr.bucketMs;

      if (snap.timestampMs >= bucketEnd && curr.imbalances.length > 0) {
        // Flush completed bucket into ring buffer
        const completed = flushAccumulator(curr);
        const ring = this._store[ri];
        if (ring.length >= this.config.maxFeatureBuckets) {
          ring.shift();
        }
        ring.push(completed);

        // Start fresh bucket aligned to bucket boundary
        const newOpen = Math.floor(snap.timestampMs / curr.bucketMs) * curr.bucketMs;
        this._accumulators[ri] = emptyAccumulator(newOpen, curr.bucketMs);
      }

      // Append to active accumulator
      const active = this._accumulators[ri];
      active.imbalances.push(snap.imbalance.weighted);
      active.spreads.push(snap.spread.pctSpread);
      active.liquidities.push(snap.liquidity.score);
      active.toxicities.push(snap.toxicity.score);
      active.pressures.push(snap.pressure?.netPressure ?? 0);
      active.vpins.push(snap.vpin);
      active.qualities.push(snap.execQuality);
    }
  }
}

// ── Convenience factory ───────────────────────────────────────────────────────

/**
 * Create a MicrostructureEngine with default config.
 * Mirrors the `createRiskEngine()` factory pattern in portfolio-risk.ts.
 */
export function createMicrostructureEngine(
  symbol: string,
  config?: Partial<MicrostructureConfig>,
): MicrostructureEngine {
  return new MicrostructureEngine(symbol, config);
}
