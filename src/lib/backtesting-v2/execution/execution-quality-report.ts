/**
 * execution-quality-report.ts — Per-fill quality metrics and aggregate report.
 *
 * Two layers:
 *
 *   FillQualityRecord   — extracted metrics from a single FillEvent produced by
 *                         IndiaFillModel (reads the `.extras` payload).
 *
 *   ExecutionQualityReport — aggregate statistics across a backtest run:
 *     • average / median / p95 slippage
 *     • average / median fill quality score
 *     • partial fill rate
 *     • unfilled order count
 *     • total fees paid (with per-component totals)
 *     • latency distribution (avg, p95)
 *     • per-instrument-type breakdown
 *     • per-order-type breakdown
 *
 * Usage:
 *   const reporter = new ExecutionQualityReporter();
 *   reporter.record(fillEvent);           // call after each fill
 *   const report = reporter.build();      // call once at end of backtest
 */

import type { FillEvent } from "../events/fill-event";
import type { IndiaFillExtras } from "./india-fill-model";

// ── Per-fill record ───────────────────────────────────────────────────────────

export interface FillQualityRecord {
  fillEventId:        string;
  symbol:             string;
  instrumentType:     string;
  side:               "BUY" | "SELL";
  orderType:          string;
  qty:                number;
  filledQty:          number;
  unfilledQty:        number;
  isPartialFill:      boolean;
  expectedPrice:      number;
  actualFillPrice:    number;
  slippageAmount:     number;
  slippageFraction:   number;
  totalFees:          number;
  latencyTotalMs:     number;
  fillQuality:        number;
  liquidityTier:      string;
  spreadFraction:     number;
  timestampMs:        number;
}

// ── Aggregate statistics ──────────────────────────────────────────────────────

export interface SlippageStats {
  avgFraction:    number;   // mean slippage as fraction of price
  medianFraction: number;
  p95Fraction:    number;
  totalAmount:    number;   // INR total slippage cost
}

export interface FeeStats {
  totalFees:           number;
  avgFeesPerFill:      number;
  avgEffectiveCostPct: number;  // avg fees / turnover %
}

export interface LatencyStats {
  avgTotalMs:  number;
  medianMs:    number;
  p95Ms:       number;
}

export interface FillRateStats {
  totalOrders:       number;
  fullyFilled:       number;
  partiallyFilled:   number;
  unfilledOrNullFill: number;
  partialFillRate:   number;   // 0–1
}

export interface SegmentBreakdown {
  count:             number;
  avgSlippageFrac:   number;
  avgFillQuality:    number;
  totalFees:         number;
}

export interface ExecutionQualityReport {
  /** Total fills recorded. */
  totalFills:          number;
  /** Average fill quality score [0, 1]. */
  avgFillQuality:      number;
  /** Median fill quality score. */
  medianFillQuality:   number;
  slippage:            SlippageStats;
  fees:                FeeStats;
  latency:             LatencyStats;
  fillRate:            FillRateStats;
  /** Per instrument-type breakdown. */
  byInstrumentType:    Record<string, SegmentBreakdown>;
  /** Per order-type breakdown. */
  byOrderType:         Record<string, SegmentBreakdown>;
  /** All individual fill records (for external analysis). */
  fills:               FillQualityRecord[];
}

// ── Reporter ──────────────────────────────────────────────────────────────────

export class ExecutionQualityReporter {
  private readonly _fills: FillQualityRecord[] = [];
  private _unfilledCount = 0;

  /**
   * Record a fill event produced by IndiaFillModel.
   * Silently skips fills that lack IndiaFillExtras (e.g. legacy fills).
   */
  record(fill: FillEvent): void {
    const extras = fill.extras as Partial<IndiaFillExtras> | undefined;
    if (!extras || extras.actualFillPrice === undefined) return;

    this._fills.push({
      fillEventId:      fill.id,
      symbol:           fill.instrument.symbol,
      instrumentType:   fill.instrument.instrumentType,
      side:             fill.side,
      orderType:        extras.orderType ?? "MARKET",
      qty:              fill.qty,
      filledQty:        extras.filledQty  ?? fill.qty,
      unfilledQty:      extras.unfilledQty ?? 0,
      isPartialFill:    extras.isPartialFill ?? false,
      expectedPrice:    extras.expectedPrice ?? fill.fillPrice,
      actualFillPrice:  extras.actualFillPrice,
      slippageAmount:   extras.slippageAmount ?? fill.slippage,
      slippageFraction: extras.slippageFraction ?? 0,
      totalFees:        extras.totalFees ?? fill.commission,
      latencyTotalMs:   extras.latencyTotalMs ?? 0,
      fillQuality:      extras.fillQuality ?? 1,
      liquidityTier:    extras.liquidityTier ?? "LARGE_CAP",
      spreadFraction:   extras.spreadFraction ?? 0,
      timestampMs:      fill.timestampMs,
    });
  }

  /** Mark an order as unfilled (for fill-rate tracking). */
  recordUnfilled(): void {
    this._unfilledCount++;
  }

  /** Build the aggregate execution quality report. */
  build(): ExecutionQualityReport {
    const fills = this._fills;
    const n = fills.length;

    if (n === 0) {
      return this._emptyReport();
    }

    // ── Quality scores ───────────────────────────────────────────────────
    const qualities = fills.map(f => f.fillQuality).sort((a, b) => a - b);
    const avgFillQuality    = _mean(qualities);
    const medianFillQuality = _median(qualities);

    // ── Slippage ─────────────────────────────────────────────────────────
    const slippageFracs = fills.map(f => f.slippageFraction).sort((a, b) => a - b);
    const totalSlippageAmount = fills.reduce((s, f) => s + f.slippageAmount * f.filledQty * f.qty, 0);
    const slippage: SlippageStats = {
      avgFraction:    _mean(slippageFracs),
      medianFraction: _median(slippageFracs),
      p95Fraction:    _percentile(slippageFracs, 95),
      totalAmount:    fills.reduce((s, f) => s + f.slippageAmount, 0),
    };

    // ── Fees ─────────────────────────────────────────────────────────────
    const totalFees     = fills.reduce((s, f) => s + f.totalFees, 0);
    const totalTurnover = fills.reduce(
      (s, f) => s + f.actualFillPrice * f.filledQty, 0,
    );
    const fees: FeeStats = {
      totalFees,
      avgFeesPerFill:      n > 0 ? totalFees / n : 0,
      avgEffectiveCostPct: totalTurnover > 0 ? (totalFees / totalTurnover) * 100 : 0,
    };

    // ── Latency ──────────────────────────────────────────────────────────
    const latencies = fills.map(f => f.latencyTotalMs).sort((a, b) => a - b);
    const latency: LatencyStats = {
      avgTotalMs: _mean(latencies),
      medianMs:   _median(latencies),
      p95Ms:      _percentile(latencies, 95),
    };

    // ── Fill rate ─────────────────────────────────────────────────────────
    const partialFills = fills.filter(f => f.isPartialFill).length;
    const totalOrders  = n + this._unfilledCount;
    const fillRate: FillRateStats = {
      totalOrders,
      fullyFilled:        n - partialFills,
      partiallyFilled:    partialFills,
      unfilledOrNullFill: this._unfilledCount,
      partialFillRate:    totalOrders > 0 ? partialFills / totalOrders : 0,
    };

    // ── Per-segment breakdowns ────────────────────────────────────────────
    const byInstrumentType = this._buildBreakdown(fills, f => f.instrumentType);
    const byOrderType      = this._buildBreakdown(fills, f => f.orderType);

    return {
      totalFills: n,
      avgFillQuality,
      medianFillQuality,
      slippage,
      fees,
      latency,
      fillRate,
      byInstrumentType,
      byOrderType,
      fills,
    };
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private _buildBreakdown(
    fills: FillQualityRecord[],
    keyFn: (f: FillQualityRecord) => string,
  ): Record<string, SegmentBreakdown> {
    const groups = new Map<string, FillQualityRecord[]>();
    for (const f of fills) {
      const key = keyFn(f);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(f);
    }
    const result: Record<string, SegmentBreakdown> = {};
    for (const [key, group] of groups) {
      result[key] = {
        count:           group.length,
        avgSlippageFrac: _mean(group.map(f => f.slippageFraction)),
        avgFillQuality:  _mean(group.map(f => f.fillQuality)),
        totalFees:       group.reduce((s, f) => s + f.totalFees, 0),
      };
    }
    return result;
  }

  private _emptyReport(): ExecutionQualityReport {
    const empty0: SlippageStats = { avgFraction: 0, medianFraction: 0, p95Fraction: 0, totalAmount: 0 };
    const empty1: FeeStats      = { totalFees: 0, avgFeesPerFill: 0, avgEffectiveCostPct: 0 };
    const empty2: LatencyStats  = { avgTotalMs: 0, medianMs: 0, p95Ms: 0 };
    const empty3: FillRateStats = { totalOrders: this._unfilledCount, fullyFilled: 0, partiallyFilled: 0, unfilledOrNullFill: this._unfilledCount, partialFillRate: 0 };
    return {
      totalFills: 0, avgFillQuality: 0, medianFillQuality: 0,
      slippage: empty0, fees: empty1, latency: empty2, fillRate: empty3,
      byInstrumentType: {}, byOrderType: {}, fills: [],
    };
  }
}

// ── Math helpers ──────────────────────────────────────────────────────────────

function _mean(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  return sorted.reduce((s, v) => s + v, 0) / sorted.length;
}

function _median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function _percentile(sorted: number[], pct: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.floor((pct / 100) * (sorted.length - 1));
  return sorted[Math.min(idx, sorted.length - 1)];
}
