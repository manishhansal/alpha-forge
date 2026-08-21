/**
 * Anchored VWAP chart plugin — src/components/india/charts/plugins/anchored-vwap.ts
 *
 * Provides both the pure math function used by tests and a full
 * ISeriesPrimitive-based plugin that renders three Anchored VWAP
 * LineSeries overlays on a lightweight-charts v5 price chart.
 *
 * Formula: VWAP[i] = Σ(HLC3[j] × vol[j]) / Σ(vol[j])  for j from anchorIndex to i
 * Uses EXACT IEEE-754 double arithmetic — no rounding or approximation.
 *
 * Requirements: 2.1, 2.3
 */

import {
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type Time,
} from "lightweight-charts";

import { computeVolumeProfile } from "@/features/indicators";

// ─────────────────────────────────────────────────────────────────────────────
// Shared bar type for both the pure function and the plugin class
// ─────────────────────────────────────────────────────────────────────────────

export interface VwapBar {
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure math function (exported for tests)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute Anchored VWAP from anchorIndex to the end of the bars array.
 *
 * @param bars        Array of OHLCV-like bars (only high/low/close/volume needed).
 * @param anchorIndex Zero-based index of the anchor bar (session/daily/weekly open).
 * @returns           Array of the same length as `bars`.
 *                    Entries before anchorIndex are NaN.
 *                    Entries from anchorIndex onward are exact cumulative VWAP values.
 */
export function computeAnchoredVwap(
  bars: Array<{ high: number; low: number; close: number; volume: number }>,
  anchorIndex: number,
): number[] {
  const result: number[] = new Array(bars.length);

  let cumTypicalVol = 0;
  let cumVol = 0;

  for (let i = 0; i < bars.length; i++) {
    if (i < anchorIndex) {
      result[i] = NaN;
      continue;
    }
    const b = bars[i];
    // HLC3 = (high + low + close) / 3
    const hlc3 = (b.high + b.low + b.close) / 3;
    cumTypicalVol += hlc3 * b.volume;
    cumVol += b.volume;
    result[i] = cumTypicalVol / cumVol;
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Chart plugin types
// ─────────────────────────────────────────────────────────────────────────────

export type AnchorType = "session" | "daily" | "weekly";

export interface ChartPalette {
  sessionColor: string;
  dailyColor: string;
  weeklyColor: string;
}

/** Candle bar with a Time field for chart rendering. */
export interface VwapChartBar extends VwapBar {
  time: Time;
  open: number;
}

const DEFAULT_PALETTE: ChartPalette = {
  sessionColor: "#f59e0b",  // amber — session VWAP
  dailyColor:   "#6366f1",  // indigo — daily VWAP
  weeklyColor:  "#10b981",  // emerald — weekly VWAP
};

// IST offset from UTC: +5:30
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// Session start: 09:15 IST → 03:45 UTC
const SESSION_OPEN_MINUTES_UTC = 3 * 60 + 45;

/** Returns the number of minutes since UTC midnight for a Unix timestamp (seconds). */
function minutesSinceUtcMidnight(unixSec: number): number {
  return Math.floor((unixSec % 86400) / 60);
}

/** Returns the ISO day-of-week (0=Sun…6=Sat) for a Unix timestamp (seconds). */
function dayOfWeek(unixSec: number): number {
  return new Date(unixSec * 1000).getUTCDay();
}

/** Returns the UTC date string "YYYY-MM-DD" for a Unix timestamp (seconds). */
function dateString(unixSec: number): string {
  return new Date(unixSec * 1000).toISOString().slice(0, 10);
}

/**
 * Find the anchor index in a bar array for a given anchor type.
 * Falls back to index 0 when bars do not carry numeric timestamps.
 */
function findAnchorIndex(bars: VwapChartBar[], anchor: AnchorType): number {
  if (bars.length === 0) return 0;

  if (anchor === "session") {
    // Session open: first bar whose UTC-minutes ≥ SESSION_OPEN_MINUTES_UTC on the latest day
    const lastDay = dateString(bars[bars.length - 1].time as number);
    for (let i = 0; i < bars.length; i++) {
      const t = bars[i].time as number;
      if (dateString(t) === lastDay) {
        const mins = minutesSinceUtcMidnight(t);
        if (mins >= SESSION_OPEN_MINUTES_UTC) return i;
      }
    }
    return 0;
  }

  if (anchor === "daily") {
    // Daily open: first bar of the current calendar day (UTC)
    const lastDay = dateString(bars[bars.length - 1].time as number);
    for (let i = 0; i < bars.length; i++) {
      if (dateString(bars[i].time as number) === lastDay) return i;
    }
    return 0;
  }

  if (anchor === "weekly") {
    // Weekly open: first bar whose day-of-week is Monday (1) in the current week
    // Find the most recent Monday at or before the last bar
    const lastTs = bars[bars.length - 1].time as number;
    const lastDate = new Date(lastTs * 1000);
    const dow = lastDate.getUTCDay(); // 0=Sun, 1=Mon…
    const daysSinceMon = (dow + 6) % 7; // days since last Monday
    const monTs = lastTs - daysSinceMon * 86400;
    const monDay = dateString(monTs);
    for (let i = 0; i < bars.length; i++) {
      if (dateString(bars[i].time as number) >= monDay) return i;
    }
    return 0;
  }

  return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// AnchoredVwapPlugin — lightweight-charts v5 LineSeries overlay plugin
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Manages three Anchored VWAP LineSeries overlays on an existing price chart.
 * Call `attach(chart, bars)` to add the overlays and `detach()` to remove them.
 * Call `setTheme(palette)` whenever the app theme changes.
 */
export class AnchoredVwapPlugin {
  private chart: IChartApi | null = null;
  private palette: ChartPalette = { ...DEFAULT_PALETTE };

  private sessionSeries: ISeriesApi<"Line"> | null = null;
  private dailySeries:   ISeriesApi<"Line"> | null = null;
  private weeklySeries:  ISeriesApi<"Line"> | null = null;

  // ── lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Add all three VWAP line series to the chart and populate them with data.
   */
  attach(chart: IChartApi, bars: VwapChartBar[]): void {
    this.chart = chart;

    this.sessionSeries = chart.addSeries(LineSeries, {
      color: this.palette.sessionColor,
      lineWidth: 1,
      title: "VWAP (Session)",
      priceLineVisible: false,
      lastValueVisible: true,
    });

    this.dailySeries = chart.addSeries(LineSeries, {
      color: this.palette.dailyColor,
      lineWidth: 1,
      title: "VWAP (Daily)",
      priceLineVisible: false,
      lastValueVisible: true,
    });

    this.weeklySeries = chart.addSeries(LineSeries, {
      color: this.palette.weeklyColor,
      lineWidth: 1,
      title: "VWAP (Weekly)",
      priceLineVisible: false,
      lastValueVisible: true,
    });

    this.updateData(bars);
  }

  /**
   * Remove all VWAP series from the chart and release refs.
   */
  detach(): void {
    if (!this.chart) return;
    if (this.sessionSeries) {
      this.chart.removeSeries(this.sessionSeries);
      this.sessionSeries = null;
    }
    if (this.dailySeries) {
      this.chart.removeSeries(this.dailySeries);
      this.dailySeries = null;
    }
    if (this.weeklySeries) {
      this.chart.removeSeries(this.weeklySeries);
      this.weeklySeries = null;
    }
    this.chart = null;
  }

  // ── data ───────────────────────────────────────────────────────────────────

  /**
   * Recompute and push VWAP data for all three anchors.
   * Call whenever the bars array changes (e.g. timeframe switch).
   */
  updateData(bars: VwapChartBar[]): void {
    if (!this.sessionSeries || !this.dailySeries || !this.weeklySeries) return;
    if (bars.length === 0) return;

    const sessionIdx = findAnchorIndex(bars, "session");
    const dailyIdx   = findAnchorIndex(bars, "daily");
    const weeklyIdx  = findAnchorIndex(bars, "weekly");

    const sessionVwap = computeAnchoredVwap(bars, sessionIdx);
    const dailyVwap   = computeAnchoredVwap(bars, dailyIdx);
    const weeklyVwap  = computeAnchoredVwap(bars, weeklyIdx);

    const toLineData = (vwapArr: number[]) =>
      bars
        .map((b, i) => ({ time: b.time, value: vwapArr[i] }))
        .filter((d) => isFinite(d.value));

    this.sessionSeries.setData(toLineData(sessionVwap));
    this.dailySeries.setData(toLineData(dailyVwap));
    this.weeklySeries.setData(toLineData(weeklyVwap));
  }

  // ── theme ──────────────────────────────────────────────────────────────────

  /**
   * Re-apply colour palette to all three series — call on theme toggle.
   */
  setTheme(palette: Partial<ChartPalette>): void {
    this.palette = { ...this.palette, ...palette };
    this.sessionSeries?.applyOptions({ color: this.palette.sessionColor });
    this.dailySeries?.applyOptions({ color: this.palette.dailyColor });
    this.weeklySeries?.applyOptions({ color: this.palette.weeklyColor });
  }

  // ── visibility ────────────────────────────────────────────────────────────

  setVisible(visible: boolean): void {
    const opts = { visible };
    this.sessionSeries?.applyOptions(opts);
    this.dailySeries?.applyOptions(opts);
    this.weeklySeries?.applyOptions(opts);
  }
}

// Re-export computeVolumeProfile so consumers of this module can access it
export { computeVolumeProfile };
