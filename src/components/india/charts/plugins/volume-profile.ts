/**
 * Volume Profile chart plugin — src/components/india/charts/plugins/volume-profile.ts
 *
 * Provides both the pure `getPocPrice` function used by tests and a full
 * plugin class that renders POC/VAH/VAL horizontal price lines on an
 * existing lightweight-charts v5 price series.
 *
 * `getPocPrice` is a thin adapter over `computeVolumeProfile` from the
 * indicator adapter layer — ensuring consistency between the chart plugin
 * and the worker-side indicator computation.
 *
 * Requirements: 2.2, 2.4
 */

import {
  LineStyle,
  type IPriceLine,
  type ISeriesApi,
  type SeriesType,
  type Time,
} from "lightweight-charts";

import { computeVolumeProfile, type OHLCVBar } from "@/features/indicators";

// ─────────────────────────────────────────────────────────────────────────────
// Shared bar type
// ─────────────────────────────────────────────────────────────────────────────

export interface ProfileBar {
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface ProfileBarWithTime extends ProfileBar {
  time: Time;
  open: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure function (exported for tests)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Return the price bucket (tick-rounded) with the highest cumulative volume
 * across all provided bars.
 *
 * Internally calls `computeVolumeProfile` from `@/features/indicators` so
 * the result is consistent with the worker-side indicator POC computation.
 *
 * @param bars     Array of OHLCV-like bars (high/low/close/volume).
 * @param opts     `tickSize` — NSE calibration (0.05 for stocks, 1 for NIFTY, 5 for BANKNIFTY).
 * @returns        The POC price (tick-aligned).
 */
export function getPocPrice(
  bars: Array<{ high: number; low: number; close: number; volume: number }>,
  opts: { tickSize: number },
): number {
  if (bars.length === 0) return 0;

  // Convert minimal bar shape into the OHLCVBar shape expected by computeVolumeProfile.
  // We synthesise openTime/closeTime from the bar index — only price/volume fields matter.
  const ohlcvBars: OHLCVBar[] = bars.map((b, i) => ({
    openTime:  i * 60_000,
    closeTime: (i + 1) * 60_000 - 1,
    open:  b.low,   // open is unused for volume profile; use low as a safe default
    high:  b.high,
    low:   b.low,
    close: b.close,
    volume: b.volume,
  }));

  const result = computeVolumeProfile(ohlcvBars, { tickSize: opts.tickSize });
  return result.poc;
}

// ─────────────────────────────────────────────────────────────────────────────
// VolumeProfilePlugin — horizontal price-line overlays on a price series
// ─────────────────────────────────────────────────────────────────────────────

export interface VolumeProfilePalette {
  pocColor:  string;  // POC line colour (orange by default)
  vahColor:  string;  // VAH line colour (dashed)
  valColor:  string;  // VAL line colour (dashed)
}

const DEFAULT_PROFILE_PALETTE: VolumeProfilePalette = {
  pocColor: "#f97316",  // orange
  vahColor: "#94a3b8",  // slate — dashed
  valColor: "#94a3b8",  // slate — dashed
};

/**
 * Renders POC (solid orange), VAH and VAL (dashed) as horizontal price lines
 * on any existing lightweight-charts v5 series.
 *
 * Usage:
 *   const plugin = new VolumeProfilePlugin();
 *   plugin.attach(candleSeries, bars, { tickSize: 1 });
 *   // later:
 *   plugin.detach();
 */
export class VolumeProfilePlugin {
  private series: ISeriesApi<SeriesType> | null = null;
  private palette: VolumeProfilePalette = { ...DEFAULT_PROFILE_PALETTE };

  private pocLine: IPriceLine | null = null;
  private vahLine: IPriceLine | null = null;
  private valLine: IPriceLine | null = null;

  // Stored values for external consumers
  poc = 0;
  vah = 0;
  val = 0;

  // ── lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Attach the Volume Profile price lines to an existing series.
   */
  attach(
    series: ISeriesApi<SeriesType>,
    bars: ProfileBarWithTime[],
    opts: { tickSize: number },
  ): void {
    this.series = series;
    this.updateData(bars, opts);
  }

  /**
   * Remove all price lines and release refs.
   */
  detach(): void {
    if (!this.series) return;
    if (this.pocLine) { this.series.removePriceLine(this.pocLine); this.pocLine = null; }
    if (this.vahLine) { this.series.removePriceLine(this.vahLine); this.vahLine = null; }
    if (this.valLine) { this.series.removePriceLine(this.valLine); this.valLine = null; }
    this.series = null;
  }

  // ── data ───────────────────────────────────────────────────────────────────

  /**
   * Recompute Volume Profile and update (or create) price lines.
   * Call whenever bars change (e.g. on timeframe switch).
   */
  updateData(bars: ProfileBarWithTime[], opts: { tickSize: number }): void {
    if (!this.series) return;
    if (bars.length === 0) return;

    const ohlcvBars: OHLCVBar[] = bars.map((b, i) => ({
      openTime:  i * 60_000,
      closeTime: (i + 1) * 60_000 - 1,
      open:  b.open ?? b.low,
      high:  b.high,
      low:   b.low,
      close: b.close,
      volume: b.volume,
    }));

    const vp = computeVolumeProfile(ohlcvBars, opts);
    this.poc = vp.poc;
    this.vah = vp.vah;
    this.val = vp.val;

    this._applyLines();
  }

  // ── theme ──────────────────────────────────────────────────────────────────

  /**
   * Re-apply colour palette — call on theme toggle.
   */
  setTheme(palette: Partial<VolumeProfilePalette>): void {
    this.palette = { ...this.palette, ...palette };
    this._applyLines();
  }

  // ── visibility ────────────────────────────────────────────────────────────

  setVisible(visible: boolean): void {
    // Re-create or remove lines to toggle visibility
    if (!this.series) return;
    if (!visible) {
      if (this.pocLine) { this.series.removePriceLine(this.pocLine); this.pocLine = null; }
      if (this.vahLine) { this.series.removePriceLine(this.vahLine); this.vahLine = null; }
      if (this.valLine) { this.series.removePriceLine(this.valLine); this.valLine = null; }
    } else {
      this._applyLines();
    }
  }

  // ── private helpers ───────────────────────────────────────────────────────

  private _applyLines(): void {
    if (!this.series || this.poc === 0) return;

    // POC — solid orange horizontal line
    if (this.pocLine) {
      this.pocLine.applyOptions({ price: this.poc, color: this.palette.pocColor });
    } else {
      this.pocLine = this.series.createPriceLine({
        price:            this.poc,
        color:            this.palette.pocColor,
        lineWidth:        2,
        lineStyle:        LineStyle.Solid,
        axisLabelVisible: true,
        title:            "POC",
      });
    }

    // VAH — dashed line
    if (this.vahLine) {
      this.vahLine.applyOptions({ price: this.vah, color: this.palette.vahColor });
    } else {
      this.vahLine = this.series.createPriceLine({
        price:            this.vah,
        color:            this.palette.vahColor,
        lineWidth:        1,
        lineStyle:        LineStyle.Dashed,
        axisLabelVisible: true,
        title:            "VAH",
      });
    }

    // VAL — dashed line
    if (this.valLine) {
      this.valLine.applyOptions({ price: this.val, color: this.palette.valColor });
    } else {
      this.valLine = this.series.createPriceLine({
        price:            this.val,
        color:            this.palette.valColor,
        lineWidth:        1,
        lineStyle:        LineStyle.Dashed,
        axisLabelVisible: true,
        title:            "VAL",
      });
    }
  }
}
