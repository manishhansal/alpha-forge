"use client";

/**
 * PnlLineChart — Per-strategy cumulative P&L line chart using lightweight-charts.
 *
 * Renders one LineSeries per strategy with cumulative ₹ P&L on the Y-axis and
 * date on the X-axis. Syncs with the app's dark/light theme via useTheme().
 *
 * Requirement 19.4: performance breakdown section SHALL render a per-strategy
 * chart using `lightweight-charts` line series (not Recharts).
 */

import * as React from "react";
import { RefreshCw, TrendingUp } from "lucide-react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type Time,
} from "lightweight-charts";

import { useTheme } from "@/components/theme-provider";
import type { IndiaStrategyPnlPoint } from "@/features/india/scalping/journal";

// ─── Theme palette ────────────────────────────────────────────────────────────
// Canvas-based rendering can't consume CSS variables directly. We maintain
// explicit resolved values that mirror the IIT token definitions in globals.css.

const CHART_THEMES = {
  dark: {
    bg:          "rgba(0,0,0,0)",
    text:        "rgba(148,163,184,0.85)",   // --fg-muted dark
    grid:        "rgba(148,163,184,0.06)",
    border:      "rgba(148,163,184,0.18)",
    positive:    "#10d079",                  // --color-data-positive dark
    negative:    "#f43f5e",                  // --color-data-negative dark
    muted:       "rgba(148,163,184,0.50)",
  },
  light: {
    bg:          "rgba(0,0,0,0)",
    text:        "rgba(71,85,105,0.85)",     // --fg-muted light
    grid:        "rgba(15,23,42,0.06)",
    border:      "rgba(15,23,42,0.18)",
    positive:    "#059669",                  // --color-data-positive light
    negative:    "#e11d48",                  // --color-data-negative light
    muted:       "rgba(71,85,105,0.50)",
  },
} as const;

// A fixed palette for per-strategy line colors — distinct enough to read at
// a glance. We rotate through these when there are more strategies than slots.
const STRATEGY_COLORS = [
  "#6366f1", // indigo-500
  "#f59e0b", // amber-500
  "#06b6d4", // cyan-500
  "#a78bfa", // violet-400
  "#34d399", // emerald-400
  "#fb923c", // orange-400
  "#f472b6", // pink-400
  "#38bdf8", // sky-400
];

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PnlLineChartProps {
  /** Initial data: keys are strategy IDs, values are time-ordered points. */
  initialData?: Record<string, IndiaStrategyPnlPoint[]>;
  height?: number;
  /** Whether to auto-refresh from the API on mount (default: true). */
  autoFetch?: boolean;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function PnlLineChart({
  initialData,
  height = 200,
  autoFetch = true,
}: PnlLineChartProps) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const chartRef     = React.useRef<IChartApi | null>(null);
  // Map from strategyId → series instance so we can update data without
  // recreating the chart.
  const seriesMapRef = React.useRef<Map<string, ISeriesApi<"Line">>>(new Map());

  const { resolvedTheme } = useTheme();

  const [data, setData]       = React.useState<Record<string, IndiaStrategyPnlPoint[]>>(
    initialData ?? {},
  );
  const [loading, setLoading] = React.useState(!initialData && autoFetch);
  const [error, setError]     = React.useState<string | null>(null);

  // ── Fetch ────────────────────────────────────────────────────────────────

  const load = React.useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/in/paper-trade/strategy-pnl", {
        cache: "no-store",
        signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as Record<string, IndiaStrategyPnlPoint[]>;
      setData(json);
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    if (!autoFetch) return;
    const ac = new AbortController();
    void load(ac.signal);
    return () => ac.abort();
  }, [autoFetch, load]);

  // ── Chart init ───────────────────────────────────────────────────────────

  React.useEffect(() => {
    if (!containerRef.current || chartRef.current) return;

    const palette = CHART_THEMES[resolvedTheme as keyof typeof CHART_THEMES] ?? CHART_THEMES.dark;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { color: palette.bg },
        textColor:  palette.text,
        fontSize:   11,
      },
      grid: {
        vertLines: { color: palette.grid },
        horzLines: { color: palette.grid },
      },
      width:  containerRef.current.clientWidth,
      height,
      timeScale: {
        borderColor:    palette.border,
        timeVisible:    false,
        secondsVisible: false,
      },
      rightPriceScale: {
        borderColor: palette.border,
        // Show ₹ prefix in the price scale label via formatter below
      },
      crosshair: { mode: 1 },
      autoSize:  false,
      localization: {
        priceFormatter: (p: number) =>
          `₹${p >= 0 ? "+" : ""}${Math.round(p).toLocaleString("en-IN")}`,
      },
    });

    chartRef.current = chart;

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
      seriesMapRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [height]);

  // ── Theme sync ────────────────────────────────────────────────────────────

  React.useEffect(() => {
    if (!chartRef.current) return;
    const palette = CHART_THEMES[resolvedTheme as keyof typeof CHART_THEMES] ?? CHART_THEMES.dark;
    chartRef.current.applyOptions({
      layout: {
        background: { color: palette.bg },
        textColor:  palette.text,
      },
      grid: {
        vertLines: { color: palette.grid },
        horzLines: { color: palette.grid },
      },
      timeScale:       { borderColor: palette.border },
      rightPriceScale: { borderColor: palette.border },
    });
  }, [resolvedTheme]);

  // ── Data sync ─────────────────────────────────────────────────────────────

  React.useEffect(() => {
    if (!chartRef.current) return;
    const chart = chartRef.current;
    const palette = CHART_THEMES[resolvedTheme as keyof typeof CHART_THEMES] ?? CHART_THEMES.dark;

    const strategyIds = Object.keys(data).filter(
      (id) => data[id].length > 0,
    );

    // Remove series for strategies no longer in data
    for (const [id, series] of seriesMapRef.current.entries()) {
      if (!strategyIds.includes(id)) {
        chart.removeSeries(series);
        seriesMapRef.current.delete(id);
      }
    }

    // Add or update series for each strategy
    strategyIds.forEach((id, idx) => {
      const points = data[id];
      const color = STRATEGY_COLORS[idx % STRATEGY_COLORS.length];

      // Determine color based on final P&L value
      const lastPnl = points[points.length - 1]?.cumulativePnl ?? 0;
      const lineColor = lastPnl > 0 ? palette.positive : lastPnl < 0 ? palette.negative : color;

      let series = seriesMapRef.current.get(id);
      if (!series) {
        series = chart.addSeries(LineSeries, {
          color:             color,
          lineWidth:         2,
          priceLineVisible:  false,
          lastValueVisible:  true,
          crosshairMarkerVisible: true,
          title:             id.replace(/_/g, " "),
        });
        seriesMapRef.current.set(id, series);
      }

      // Update line color to reflect final P&L direction
      series.applyOptions({ color: lineColor });

      // Set time-series data — lightweight-charts needs ascending Time values
      const chartData = points
        .filter((p) => p.date && p.date.length === 10)
        .map((p) => ({
          time:  p.date as Time,
          value: p.cumulativePnl,
        }));

      // Deduplicate by date (keep last point per date for same-day trades)
      const deduped = new Map<string, number>();
      for (const pt of chartData) {
        deduped.set(pt.time as string, pt.value);
      }
      const sorted = Array.from(deduped.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([time, value]) => ({ time: time as Time, value }));

      if (sorted.length > 0) {
        series.setData(sorted);
      }
    });

    if (strategyIds.length > 0) {
      chart.timeScale().fitContent();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, resolvedTheme]);

  // ── Derived legend entries ─────────────────────────────────────────────────

  const legendEntries = React.useMemo(() => {
    return Object.entries(data)
      .filter(([, pts]) => pts.length > 0)
      .map(([id, pts], idx) => {
        const lastPnl = pts[pts.length - 1]?.cumulativePnl ?? 0;
        return {
          id,
          label:   id.replace(/_/g, " "),
          color:   STRATEGY_COLORS[idx % STRATEGY_COLORS.length],
          lastPnl,
        };
      })
      .sort((a, b) => b.lastPnl - a.lastPnl);
  }, [data]);

  const hasData = legendEntries.length > 0;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-2">
      {/* Section header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <TrendingUp className="h-3.5 w-3.5 text-[var(--color-fg-muted)]" aria-hidden />
          <p className="text-[11px] uppercase tracking-wider text-[var(--color-fg-muted)]">
            Cumulative P&amp;L by Strategy
          </p>
        </div>
        {autoFetch && (
          <button
            onClick={() => void load()}
            disabled={loading}
            aria-label="Refresh strategy P&L chart"
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10px] text-[var(--color-fg-subtle)] hover:text-[var(--color-fg)] transition-colors disabled:opacity-50"
          >
            <RefreshCw
              className={`h-3 w-3 ${loading ? "animate-spin" : ""}`}
              aria-hidden
            />
          </button>
        )}
      </div>

      {/* Error state */}
      {error && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-[11px] text-rose-500">
          {error}
        </div>
      )}

      {/* Loading skeleton */}
      {loading && !hasData && (
        <div
          className="animate-pulse rounded-lg bg-[var(--color-bg-elevated)]"
          style={{ height }}
          aria-label="Loading P&L chart"
        />
      )}

      {/* Empty state */}
      {!loading && !error && !hasData && (
        <div
          className="flex items-center justify-center rounded-lg border border-dashed border-[var(--color-border)] bg-[var(--color-bg-elevated)] text-[11px] text-[var(--color-fg-subtle)]"
          style={{ height }}
        >
          No closed trades yet — chart will appear here once strategies fire.
        </div>
      )}

      {/* Chart canvas */}
      <div
        ref={containerRef}
        className="overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]/40"
        style={{ height, display: hasData || loading ? "block" : "none" }}
        aria-label="Cumulative P&L per strategy line chart"
      />

      {/* Legend */}
      {legendEntries.length > 0 && (
        <div className="flex flex-wrap gap-x-4 gap-y-1.5 px-1">
          {legendEntries.map(({ id, label, color, lastPnl }) => (
            <div key={id} className="flex items-center gap-1.5">
              <span
                className="inline-block h-2 w-4 rounded-full"
                style={{ backgroundColor: color }}
                aria-hidden
              />
              <span className="text-[10px] uppercase tracking-wide text-[var(--color-fg-muted)]">
                {label}
              </span>
              <span
                className={`text-[10px] font-semibold tabular-nums ${
                  lastPnl > 0
                    ? "text-[var(--color-data-positive,#10d079)]"
                    : lastPnl < 0
                      ? "text-[var(--color-data-negative,#f43f5e)]"
                      : "text-[var(--color-fg-muted)]"
                }`}
              >
                {lastPnl >= 0 ? "+" : ""}₹{Math.round(lastPnl).toLocaleString("en-IN")}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
