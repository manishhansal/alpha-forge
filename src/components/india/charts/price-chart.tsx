"use client";

import * as React from "react";
import {
  CandlestickSeries,
  HistogramSeries,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type Time,
} from "lightweight-charts";

import { useTheme } from "@/components/theme-provider";
import type { Candle, Interval } from "@/types/india";

type Props = {
  symbol: string;
  initialInterval?: Interval;
  initialRange?: string;
  height?: number;
};

const INTERVALS: { label: string; value: Interval; range: string }[] = [
  { label: "5m", value: "5m", range: "5d" },
  { label: "15m", value: "15m", range: "1mo" },
  { label: "1h", value: "1h", range: "3mo" },
  { label: "1D", value: "1d", range: "1y" },
  { label: "1W", value: "1w", range: "5y" },
];

// lightweight-charts is canvas-based so it can't pick up CSS variables on
// its own — we maintain a small theme map and `applyOptions()` on every
// theme flip to keep colors in lockstep with the rest of the UI.
const CHART_THEMES = {
  dark: {
    bg: "rgba(0,0,0,0)",
    text: "#cbd5e1",
    grid: "rgba(148,163,184,0.06)",
    border: "rgba(148,163,184,0.20)",
  },
  light: {
    bg: "rgba(0,0,0,0)",
    text: "#475569",
    grid: "rgba(15,23,42,0.06)",
    border: "rgba(15,23,42,0.18)",
  },
} as const;

export function PriceChart({
  symbol,
  initialInterval = "1d",
  initialRange = "1y",
  height = 460,
}: Props) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const chartRef = React.useRef<IChartApi | null>(null);
  const candleRef = React.useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeRef = React.useRef<ISeriesApi<"Histogram"> | null>(null);

  const [interval, setInterval] = React.useState<Interval>(initialInterval);
  const [range, setRange] = React.useState<string>(initialRange);
  const [candles, setCandles] = React.useState<Candle[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const { resolvedTheme } = useTheme();

  React.useEffect(() => {
    if (!containerRef.current || chartRef.current) return;
    const palette = CHART_THEMES[resolvedTheme];
    const chart = createChart(containerRef.current, {
      layout: {
        background: { color: palette.bg },
        textColor: palette.text,
        fontSize: 11,
      },
      grid: {
        vertLines: { color: palette.grid },
        horzLines: { color: palette.grid },
      },
      width: containerRef.current.clientWidth,
      height,
      timeScale: {
        borderColor: palette.border,
        timeVisible: true,
        secondsVisible: false,
      },
      rightPriceScale: { borderColor: palette.border },
      crosshair: { mode: 1 },
      autoSize: false,
    });
    chartRef.current = chart;

    candleRef.current = chart.addSeries(CandlestickSeries, {
      upColor: "#10b981",
      downColor: "#f43f5e",
      wickUpColor: "#10b981",
      wickDownColor: "#f43f5e",
      borderVisible: false,
    });

    volumeRef.current = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "vol",
      color: "rgba(99, 102, 241, 0.45)",
    });
    chart.priceScale("vol").applyOptions({
      scaleMargins: { top: 0.82, bottom: 0 },
    });

    const ro = new ResizeObserver((entries) => {
      if (!chartRef.current) return;
      const w = entries[0]?.contentRect.width ?? 600;
      chartRef.current.applyOptions({ width: w });
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      volumeRef.current = null;
    };
    // We intentionally don't depend on `resolvedTheme` here — that effect
    // re-creates the chart from scratch, which is wasteful. The dedicated
    // theme-sync effect below `applyOptions()`s instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [height]);

  // Re-paint the chart palette when the user toggles dark/light without
  // tearing down the chart instance or re-fetching data.
  React.useEffect(() => {
    if (!chartRef.current) return;
    const palette = CHART_THEMES[resolvedTheme];
    chartRef.current.applyOptions({
      layout: {
        background: { color: palette.bg },
        textColor: palette.text,
      },
      grid: {
        vertLines: { color: palette.grid },
        horzLines: { color: palette.grid },
      },
      timeScale: { borderColor: palette.border },
      rightPriceScale: { borderColor: palette.border },
    });
  }, [resolvedTheme]);

  React.useEffect(() => {
    const ctrl = new AbortController();
    const load = async () => {
      try {
        setError(null);
        const r = await fetch(
          `/api/in/historical?symbol=${encodeURIComponent(symbol)}&interval=${interval}&range=${range}`,
          { cache: "no-store", signal: ctrl.signal },
        );
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as { candles: Candle[] };
        if (ctrl.signal.aborted) return;
        setCandles(j.candles);
      } catch (e: unknown) {
        if ((e as { name?: string })?.name === "AbortError") return;
        setError((e as Error)?.message ?? "Failed");
      }
    };
    void load();
    return () => ctrl.abort();
  }, [symbol, interval, range]);

  React.useEffect(() => {
    if (!candleRef.current || !volumeRef.current || !candles) return;
    candleRef.current.setData(
      candles.map((c) => ({
        time: c.time as Time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
    );
    volumeRef.current.setData(
      candles.map((c) => ({
        time: c.time as Time,
        value: c.volume ?? 0,
        color:
          c.close >= c.open ? "rgba(16,185,129,0.4)" : "rgba(244,63,94,0.4)",
      })),
    );
    chartRef.current?.timeScale().fitContent();
  }, [candles]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1.5 flex-wrap">
        {INTERVALS.map((i) => {
          const active = i.value === interval;
          return (
            <button
              key={i.value}
              onClick={() => {
                setInterval(i.value);
                setRange(i.range);
              }}
              className={`text-xs px-2.5 py-1 rounded-md font-medium transition-colors ${
                active
                  ? "bg-foreground text-background"
                  : "bg-muted text-muted-foreground hover:bg-muted/70"
              }`}
            >
              {i.label}
            </button>
          );
        })}
        {error && (
          <span className="text-xs text-rose-500 ml-2">Error: {error}</span>
        )}
      </div>

      <div
        ref={containerRef}
        className="rounded-xl border border-border/60 bg-card/50 overflow-hidden"
        style={{ height }}
      />
    </div>
  );
}
