/**
 * Super Confluence chart overlay plugin.
 *
 * Draws on a lightweight-charts v5 price chart:
 *   1. AI Neural Line       — adaptive HMA trailing line, green (bull) / red (bear)
 *   2. UT Bot Trailing Stop — dotted ATR trailing stop, same colour scheme
 *   3. UT Buy / Sell markers — small triangle shapes via markers API
 *   4. SMC structure lines  — horizontal lines at last confirmed swing H/L
 *   5. Super Buy diamonds   — lime, size large (triple-confluence long)
 *   6. Super Sell diamonds  — fuchsia, size large (triple-confluence short)
 *
 * Usage:
 *   const plugin = new SuperConfluencePlugin();
 *   plugin.attach(chart, candleSeries, bars);   // bars: Candle[]
 *   plugin.detach();
 *   plugin.setTheme({ bull: '#00e676', bear: '#ff1744', ... });
 */

import {
  LineSeries,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
} from "lightweight-charts";

import type { Candle } from "@/types/india/market";
import {
  computeSuperConfluence,
  type SuperConfluenceBar,
} from "@/features/india/indicators/super-confluence";

// ─── Theme ────────────────────────────────────────────────────────────────────

export interface SuperConfluenceTheme {
  /** AI Neural Line + UT trail when bullish */
  bull:         string;
  /** AI Neural Line + UT trail when bearish */
  bear:         string;
  /** UT Buy marker colour */
  utBuy:        string;
  /** UT Sell marker colour */
  utSell:       string;
  /** Super Buy diamond colour */
  superBuy:     string;
  /** Super Sell diamond colour */
  superSell:    string;
  /** SMC swing-high line colour */
  swingHigh:    string;
  /** SMC swing-low line colour */
  swingLow:     string;
  /** EMA 9 line colour */
  ema9:         string;
  /** EMA 15 line colour */
  ema15:        string;
  /** EMA 21 line colour */
  ema21:        string;
}

const DEFAULT_THEME: SuperConfluenceTheme = {
  bull:      "#00e676",   // green
  bear:      "#ff1744",   // red
  utBuy:     "#00bcd4",   // cyan
  utSell:    "#ff9800",   // orange
  superBuy:  "#76ff03",   // lime
  superSell: "#e040fb",   // fuchsia
  swingHigh: "#ef5350",   // red-400
  swingLow:  "#42a5f5",   // blue-400
  ema9:      "#fbbf24",   // amber-400  — fastest, brightest
  ema15:     "#f59e0b",   // amber-500  — medium
  ema21:     "#d97706",   // amber-600  — slowest, darkest
};


// ─── Plugin ───────────────────────────────────────────────────────────────────

export class SuperConfluencePlugin {
  private chart:       IChartApi | null = null;
  private priceSeries: ISeriesApi<"Candlestick"> | null = null;
  private theme:       SuperConfluenceTheme = { ...DEFAULT_THEME };

  // Series rendered as lightweight-charts LineSeries
  private aiLineBullSeries:  ISeriesApi<"Line"> | null = null;
  private aiLineBearSeries:  ISeriesApi<"Line"> | null = null;
  private utTrailBullSeries: ISeriesApi<"Line"> | null = null;
  private utTrailBearSeries: ISeriesApi<"Line"> | null = null;
  private swingHighSeries:   ISeriesApi<"Line"> | null = null;
  private swingLowSeries:    ISeriesApi<"Line"> | null = null;
  private ema9Series:        ISeriesApi<"Line"> | null = null;
  private ema15Series:       ISeriesApi<"Line"> | null = null;
  private ema21Series:       ISeriesApi<"Line"> | null = null;

  // v5 markers plugin (replaces the removed series.setMarkers API)
  private markersPlugin: ISeriesMarkersPluginApi<Time> | null = null;

  // ── lifecycle ───────────────────────────────────────────────────────────────

  /**
   * Attach all overlay series to `chart` and paint them from `candles`.
   * `priceSeries` is the existing candlestick series — markers are pinned to it.
   */
  attach(
    chart:       IChartApi,
    priceSeries: ISeriesApi<"Candlestick">,
    candles:     Candle[],
  ): void {
    this.chart       = chart;
    this.priceSeries = priceSeries;

    // AI Neural Line — split into bull/bear segment series so we can colour
    // each segment independently without a gradient hack.
    this.aiLineBullSeries = chart.addSeries(LineSeries, {
      color:             this.theme.bull,
      lineWidth:         2,
      title:             "AI Neural (Bull)",
      priceLineVisible:  false,
      lastValueVisible:  false,
      lineStyle:         0,   // solid
    });
    this.aiLineBearSeries = chart.addSeries(LineSeries, {
      color:             this.theme.bear,
      lineWidth:         2,
      title:             "AI Neural (Bear)",
      priceLineVisible:  false,
      lastValueVisible:  false,
      lineStyle:         0,
    });

    // UT Bot trailing stop — dotted, thinner
    this.utTrailBullSeries = chart.addSeries(LineSeries, {
      color:             this.theme.bull,
      lineWidth:         1,
      title:             "UT Trail (Bull)",
      priceLineVisible:  false,
      lastValueVisible:  false,
      lineStyle:         1,   // dotted
    });
    this.utTrailBearSeries = chart.addSeries(LineSeries, {
      color:             this.theme.bear,
      lineWidth:         1,
      title:             "UT Trail (Bear)",
      priceLineVisible:  false,
      lastValueVisible:  false,
      lineStyle:         1,
    });

    // SMC swing H/L — dashed horizontal extensions
    this.swingHighSeries = chart.addSeries(LineSeries, {
      color:             this.theme.swingHigh,
      lineWidth:         1,
      title:             "SMC Swing High",
      priceLineVisible:  false,
      lastValueVisible:  true,
      lineStyle:         2,   // dashed
    });
    this.swingLowSeries = chart.addSeries(LineSeries, {
      color:             this.theme.swingLow,
      lineWidth:         1,
      title:             "SMC Swing Low",
      priceLineVisible:  false,
      lastValueVisible:  true,
      lineStyle:         2,
    });

    // Create the v5 markers plugin on the price series
    this.markersPlugin = createSeriesMarkers(priceSeries, []);

    // EMA 9 / 15 / 21 — entry & exit confirmation
    this.ema9Series = chart.addSeries(LineSeries, {
      color:             this.theme.ema9,
      lineWidth:         1,
      title:             "EMA 9",
      priceLineVisible:  false,
      lastValueVisible:  true,
      lineStyle:         0,
    });
    this.ema15Series = chart.addSeries(LineSeries, {
      color:             this.theme.ema15,
      lineWidth:         1,
      title:             "EMA 15",
      priceLineVisible:  false,
      lastValueVisible:  true,
      lineStyle:         0,
    });
    this.ema21Series = chart.addSeries(LineSeries, {
      color:             this.theme.ema21,
      lineWidth:         1,
      title:             "EMA 21",
      priceLineVisible:  false,
      lastValueVisible:  true,
      lineStyle:         0,
    });

    this.updateData(candles);
  }

  /**
   * Remove all series + markers and release references.
   */
  detach(): void {
    if (!this.chart) return;
    const remove = (s: ISeriesApi<"Line"> | null) => {
      if (s) this.chart!.removeSeries(s);
    };
    remove(this.aiLineBullSeries);
    remove(this.aiLineBearSeries);
    remove(this.utTrailBullSeries);
    remove(this.utTrailBearSeries);
    remove(this.swingHighSeries);
    remove(this.swingLowSeries);
    remove(this.ema9Series);
    remove(this.ema15Series);
    remove(this.ema21Series);

    // Dispose markers plugin
    this.markersPlugin?.detach();
    this.markersPlugin = null;

    this.priceSeries = null;

    this.aiLineBullSeries  = null;
    this.aiLineBearSeries  = null;
    this.utTrailBullSeries = null;
    this.utTrailBearSeries = null;
    this.swingHighSeries   = null;
    this.swingLowSeries    = null;
    this.ema9Series        = null;
    this.ema15Series       = null;
    this.ema21Series       = null;
    this.chart             = null;
  }

  // ── data ────────────────────────────────────────────────────────────────────

  /**
   * (Re)compute the Super Confluence indicators from `candles` and push
   * new data to every series + the markers array.
   * Call on timeframe / symbol change.
   */
  updateData(candles: Candle[]): void {
    if (
      !this.chart ||
      !this.aiLineBullSeries ||
      !this.aiLineBearSeries ||
      !this.utTrailBullSeries ||
      !this.utTrailBearSeries ||
      !this.swingHighSeries ||
      !this.swingLowSeries
    ) return;

    const sc = computeSuperConfluence(candles);
    if (!sc || sc.bars.length === 0) {
      // Not enough history — clear everything
      this.aiLineBullSeries.setData([]);
      this.aiLineBearSeries.setData([]);
      this.utTrailBullSeries.setData([]);
      this.utTrailBearSeries.setData([]);
      this.swingHighSeries.setData([]);
      this.swingLowSeries.setData([]);
      this.ema9Series?.setData([]);
      this.ema15Series?.setData([]);
      this.ema21Series?.setData([]);
      this.markersPlugin?.setMarkers([]);
      return;
    }

    const bars: SuperConfluenceBar[] = sc.bars;

    // ── AI Neural Line — split by direction ──────────────────────────────────
    const aiBullData: { time: Time; value: number }[] = [];
    const aiBearData: { time: Time; value: number }[] = [];
    for (const b of bars) {
      if (!isFinite(b.aiLine)) continue;
      const pt = { time: b.time as Time, value: b.aiLine };
      if (b.aiDir >= 0) aiBullData.push(pt);
      else              aiBearData.push(pt);
    }
    this.aiLineBullSeries.setData(aiBullData);
    this.aiLineBearSeries.setData(aiBearData);

    // ── UT Bot trailing stop — split by direction ─────────────────────────────
    const utBullData: { time: Time; value: number }[] = [];
    const utBearData: { time: Time; value: number }[] = [];
    for (const b of bars) {
      if (!isFinite(b.utTrail)) continue;
      const pt = { time: b.time as Time, value: b.utTrail };
      if (b.aiDir >= 0) utBullData.push(pt);
      else              utBearData.push(pt);
    }
    this.utTrailBullSeries.setData(utBullData);
    this.utTrailBearSeries.setData(utBearData);

    // ── SMC swing H/L — forward-filled last confirmed levels ─────────────────
    const shData: { time: Time; value: number }[] = [];
    const slData: { time: Time; value: number }[] = [];
    for (const b of bars) {
      if (isFinite(b.swingHigh)) shData.push({ time: b.time as Time, value: b.swingHigh });
      if (isFinite(b.swingLow))  slData.push({ time: b.time as Time, value: b.swingLow });
    }
    this.swingHighSeries.setData(shData);
    this.swingLowSeries.setData(slData);

    // ── EMA 9 / 15 / 21 ──────────────────────────────────────────────────────
    const ema9Data:  { time: Time; value: number }[] = [];
    const ema15Data: { time: Time; value: number }[] = [];
    const ema21Data: { time: Time; value: number }[] = [];
    for (const b of bars) {
      const t = b.time as Time;
      if (isFinite(b.ema9))  ema9Data.push({ time: t, value: b.ema9 });
      if (isFinite(b.ema15)) ema15Data.push({ time: t, value: b.ema15 });
      if (isFinite(b.ema21)) ema21Data.push({ time: t, value: b.ema21 });
    }
    this.ema9Series?.setData(ema9Data);
    this.ema15Series?.setData(ema15Data);
    this.ema21Series?.setData(ema21Data);

    // ── Markers on the price series ───────────────────────────────────────────
    const markers: SeriesMarker<Time>[] = [];

    for (const b of bars) {
      const t = b.time as Time;

      // Super Buy — prominent lime diamond below bar
      if (b.superBuy) {
        markers.push({
          time:     t,
          position: "belowBar",
          color:    this.theme.superBuy,
          shape:    "arrowUp",
          text:     "SUPER BUY",
          size:     3,
        });
      }

      // Super Sell — fuchsia diamond above bar
      if (b.superSell) {
        markers.push({
          time:     t,
          position: "aboveBar",
          color:    this.theme.superSell,
          shape:    "arrowDown",
          text:     "SUPER SELL",
          size:     3,
        });
      }

      // UT Buy (without full super confluence) — small cyan triangle
      if (b.utBuy && !b.superBuy) {
        markers.push({
          time:     t,
          position: "belowBar",
          color:    this.theme.utBuy,
          shape:    "arrowUp",
          text:     "UT B",
          size:     1,
        });
      }

      // UT Sell (without full super confluence) — small orange triangle
      if (b.utSell && !b.superSell) {
        markers.push({
          time:     t,
          position: "aboveBar",
          color:    this.theme.utSell,
          shape:    "arrowDown",
          text:     "UT S",
          size:     1,
        });
      }

      // SMC BOS / CHoCH events — tiny label at the close price
      if (b.smcEvent) {
        const isBull = b.smcEvent.includes("BULL");
        markers.push({
          time:     t,
          position: isBull ? "belowBar" : "aboveBar",
          color:    isBull ? this.theme.swingLow : this.theme.swingHigh,
          shape:    "circle",
          text:     b.smcEvent.replace("_", " "),
          size:     0,
        });
      }
    }

    // lightweight-charts requires markers sorted by time ascending
    markers.sort((a, b) => (a.time as number) - (b.time as number));
    this.markersPlugin?.setMarkers(markers);
  }

  // ── theme ───────────────────────────────────────────────────────────────────

  setTheme(palette: Partial<SuperConfluenceTheme>): void {
    this.theme = { ...this.theme, ...palette };
    this.aiLineBullSeries?.applyOptions({ color: this.theme.bull });
    this.aiLineBearSeries?.applyOptions({ color: this.theme.bear });
    this.utTrailBullSeries?.applyOptions({ color: this.theme.bull });
    this.utTrailBearSeries?.applyOptions({ color: this.theme.bear });
    this.swingHighSeries?.applyOptions({ color: this.theme.swingHigh });
    this.swingLowSeries?.applyOptions({ color: this.theme.swingLow });
    this.ema9Series?.applyOptions({ color: this.theme.ema9 });
    this.ema15Series?.applyOptions({ color: this.theme.ema15 });
    this.ema21Series?.applyOptions({ color: this.theme.ema21 });
  }

  // ── visibility ──────────────────────────────────────────────────────────────

  setVisible(visible: boolean): void {
    const opts = { visible };
    this.aiLineBullSeries?.applyOptions(opts);
    this.aiLineBearSeries?.applyOptions(opts);
    this.utTrailBullSeries?.applyOptions(opts);
    this.utTrailBearSeries?.applyOptions(opts);
    this.swingHighSeries?.applyOptions(opts);
    this.swingLowSeries?.applyOptions(opts);
    this.ema9Series?.applyOptions(opts);
    this.ema15Series?.applyOptions(opts);
    this.ema21Series?.applyOptions(opts);
  }
}
