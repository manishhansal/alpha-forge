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
import { AnchoredVwapPlugin, type VwapChartBar } from "./plugins/anchored-vwap";
import { VolumeProfilePlugin, type ProfileBarWithTime } from "./plugins/volume-profile";
import { SuperConfluencePlugin } from "./plugins/super-confluence-plugin";

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
    // VWAP palette for dark mode
    vwap: {
      sessionColor: "#fbbf24",  // amber-400
      dailyColor:   "#818cf8",  // indigo-400
      weeklyColor:  "#34d399",  // emerald-400
    },
    // Volume Profile palette for dark mode
    profile: {
      pocColor: "#fb923c",      // orange-400
      vahColor: "#94a3b8",      // slate-400
      valColor: "#94a3b8",
    },
  },
  light: {
    bg: "rgba(0,0,0,0)",
    text: "#475569",
    grid: "rgba(15,23,42,0.06)",
    border: "rgba(15,23,42,0.18)",
    vwap: {
      sessionColor: "#d97706",  // amber-600
      dailyColor:   "#4f46e5",  // indigo-600
      weeklyColor:  "#059669",  // emerald-600
    },
    profile: {
      pocColor: "#ea580c",      // orange-600
      vahColor: "#64748b",      // slate-500
      valColor: "#64748b",
    },
  },
} as const;

/** NSE tick-size calibration used for Volume Profile. */
function tickSizeForSymbol(symbol: string): number {
  if (symbol.startsWith("BANKNIFTY")) return 5;
  if (
    symbol.startsWith("NIFTY") ||
    symbol.startsWith("FINNIFTY") ||
    symbol.startsWith("MIDCPNIFTY")
  ) return 1;
  return 0.05;
}

export function PriceChart({
  symbol,
  initialInterval = "1d",
  initialRange = "1y",
  height = 460,
}: Props) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const chartRef     = React.useRef<IChartApi | null>(null);
  const candleRef    = React.useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeRef    = React.useRef<ISeriesApi<"Histogram"> | null>(null);

  // Plugin instances — stable across data reloads; recreated only when chart is destroyed
  const vwapPluginRef    = React.useRef<AnchoredVwapPlugin | null>(null);
  const profilePluginRef = React.useRef<VolumeProfilePlugin | null>(null);
  const scPluginRef      = React.useRef<SuperConfluencePlugin | null>(null);

  const [interval, setInterval] = React.useState<Interval>(initialInterval);
  const [range, setRange]       = React.useState<string>(initialRange);
  const [candles, setCandles]   = React.useState<Candle[] | null>(null);
  const [error, setError]       = React.useState<string | null>(null);

  // Toolbar plugin toggles
  const [vwapActive,    setVwapActive]    = React.useState(false);
  const [profileActive, setProfileActive] = React.useState(false);
  const [scActive,      setScActive]      = React.useState(false);

  const { resolvedTheme } = useTheme();

  // ── chart initialisation ─────────────────────────────────────────────────

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
      upColor:      "#10b981",
      downColor:    "#f43f5e",
      wickUpColor:  "#10b981",
      wickDownColor: "#f43f5e",
      borderVisible: false,
    });

    volumeRef.current = chart.addSeries(HistogramSeries, {
      priceFormat:  { type: "volume" },
      priceScaleId: "vol",
      color:        "rgba(99, 102, 241, 0.45)",
    });
    chart.priceScale("vol").applyOptions({
      scaleMargins: { top: 0.82, bottom: 0 },
    });

    // Initialise plugin instances (not yet attached — wait for toolbar toggle)
    vwapPluginRef.current    = new AnchoredVwapPlugin();
    profilePluginRef.current = new VolumeProfilePlugin();
    scPluginRef.current      = new SuperConfluencePlugin();

    const ro = new ResizeObserver((entries) => {
      if (!chartRef.current) return;
      const w = entries[0]?.contentRect.width ?? 600;
      chartRef.current.applyOptions({ width: w });
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      // Detach plugins before destroying chart
      vwapPluginRef.current?.detach();
      profilePluginRef.current?.detach();
      scPluginRef.current?.detach();
      vwapPluginRef.current    = null;
      profilePluginRef.current = null;
      scPluginRef.current      = null;
      chart.remove();
      chartRef.current  = null;
      candleRef.current = null;
      volumeRef.current = null;
    };
    // We intentionally don't depend on `resolvedTheme` here — that effect
    // re-creates the chart from scratch, which is wasteful. The dedicated
    // theme-sync effect below `applyOptions()`s instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [height]);

  // ── theme sync ───────────────────────────────────────────────────────────

  // Re-paint the chart palette when the user toggles dark/light without
  // tearing down the chart instance or re-fetching data.
  React.useEffect(() => {
    if (!chartRef.current) return;
    const palette = CHART_THEMES[resolvedTheme];
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

    // Propagate theme change to active plugins (Requirement 2.6)
    vwapPluginRef.current?.setTheme(palette.vwap);
    profilePluginRef.current?.setTheme(palette.profile);
  }, [resolvedTheme]);

  // ── data fetch ───────────────────────────────────────────────────────────

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

  // ── chart data update ────────────────────────────────────────────────────

  React.useEffect(() => {
    if (!candleRef.current || !volumeRef.current || !candles) return;

    const candleData = candles.map((c) => ({
      time:  c.time as Time,
      open:  c.open,
      high:  c.high,
      low:   c.low,
      close: c.close,
    }));

    candleRef.current.setData(candleData);
    volumeRef.current.setData(
      candles.map((c) => ({
        time:  c.time as Time,
        value: c.volume ?? 0,
        color: c.close >= c.open ? "rgba(16,185,129,0.4)" : "rgba(244,63,94,0.4)",
      })),
    );
    chartRef.current?.timeScale().fitContent();

    // Update VWAP plugin data if active (Requirement 2.5 — persist across timeframe change)
    if (vwapActive && vwapPluginRef.current && chartRef.current) {
      const vwapBars: VwapChartBar[] = candles.map((c) => ({
        time:   c.time as Time,
        open:   c.open,
        high:   c.high,
        low:    c.low,
        close:  c.close,
        volume: c.volume ?? 0,
      }));
      vwapPluginRef.current.updateData(vwapBars);
    }

    // Update Volume Profile plugin data if active (Requirement 2.5)
    if (profileActive && profilePluginRef.current && candleRef.current) {
      const profileBars: ProfileBarWithTime[] = candles.map((c) => ({
        time:   c.time as Time,
        open:   c.open,
        high:   c.high,
        low:    c.low,
        close:  c.close,
        volume: c.volume ?? 0,
      }));
      profilePluginRef.current.updateData(profileBars, { tickSize: tickSizeForSymbol(symbol) });
    }

    // Update Super Confluence plugin data if active
    if (scActive && scPluginRef.current) {
      scPluginRef.current.updateData(candles);
    }
  }, [candles, vwapActive, profileActive, scActive, symbol]);

  // ── VWAP toggle handler ──────────────────────────────────────────────────

  const handleVwapToggle = React.useCallback(() => {
    const nextActive = !vwapActive;
    setVwapActive(nextActive);

    if (!vwapPluginRef.current || !chartRef.current) return;

    if (nextActive) {
      const bars: VwapChartBar[] = (candles ?? []).map((c) => ({
        time:   c.time as Time,
        open:   c.open,
        high:   c.high,
        low:    c.low,
        close:  c.close,
        volume: c.volume ?? 0,
      }));
      vwapPluginRef.current.attach(chartRef.current, bars);
      // Apply current theme colours
      const palette = CHART_THEMES[resolvedTheme];
      vwapPluginRef.current.setTheme(palette.vwap);
    } else {
      vwapPluginRef.current.detach();
      // Re-create instance so it's ready for the next attach
      vwapPluginRef.current = new AnchoredVwapPlugin();
    }
  }, [vwapActive, candles, resolvedTheme]);

  // ── Volume Profile toggle handler ─────────────────────────────────────────

  const handleProfileToggle = React.useCallback(() => {
    const nextActive = !profileActive;
    setProfileActive(nextActive);

    if (!profilePluginRef.current || !candleRef.current) return;

    if (nextActive) {
      const bars: ProfileBarWithTime[] = (candles ?? []).map((c) => ({
        time:   c.time as Time,
        open:   c.open,
        high:   c.high,
        low:    c.low,
        close:  c.close,
        volume: c.volume ?? 0,
      }));
      profilePluginRef.current.attach(
        candleRef.current,
        bars,
        { tickSize: tickSizeForSymbol(symbol) },
      );
      const palette = CHART_THEMES[resolvedTheme];
      profilePluginRef.current.setTheme(palette.profile);
    } else {
      profilePluginRef.current.detach();
      profilePluginRef.current = new VolumeProfilePlugin();
    }
  }, [profileActive, candles, symbol, resolvedTheme]);

  // ── Super Confluence toggle handler ───────────────────────────────────────

  const handleScToggle = React.useCallback(() => {
    const nextActive = !scActive;
    setScActive(nextActive);

    if (!scPluginRef.current || !chartRef.current || !candleRef.current) return;

    if (nextActive) {
      scPluginRef.current.attach(
        chartRef.current,
        candleRef.current,
        candles ?? [],
      );
    } else {
      scPluginRef.current.detach();
      // Re-create so it is ready for the next attach
      scPluginRef.current = new SuperConfluencePlugin();
    }
  }, [scActive, candles]);

  // ── render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-3">
      {/* ── Toolbar ──────────────────────────────────────────────────── */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {/* Interval pills */}
        {INTERVALS.map((i) => {
          const active = i.value === interval;
          return (
            <button
              key={i.value}
              onClick={() => {
                setInterval(i.value);
                setRange(i.range);
              }}
              className={[
                "relative text-xs px-3 py-1 rounded-full font-semibold transition-all duration-200",
                active
                  ? "bg-[var(--color-fg)] text-[var(--color-bg)] shadow-sm"
                  : "bg-[var(--color-surface)] text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)]",
              ].join(" ")}
            >
              {active && (
                <span
                  className="absolute inset-0 rounded-full"
                  style={{
                    boxShadow: "0 0 10px 1px color-mix(in oklch, var(--brand) 18%, transparent)",
                  }}
                  aria-hidden
                />
              )}
              <span className="relative">{i.label}</span>
            </button>
          );
        })}

        {/* Divider */}
        <span className="h-4 w-px bg-[var(--color-border)] mx-0.5" aria-hidden />

        {/* VWAP toggle */}
        <button
          onClick={handleVwapToggle}
          aria-pressed={vwapActive}
          className={[
            "text-xs px-3 py-1 rounded-full font-semibold transition-all duration-200",
            vwapActive
              ? "bg-[color-mix(in_oklch,var(--warning)_18%,transparent)] text-[var(--warning)] ring-1 ring-[color-mix(in_oklch,var(--warning)_40%,transparent)] shadow-[0_0_10px_color-mix(in_oklch,var(--warning)_20%,transparent)]"
              : "bg-[var(--color-surface)] text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)]",
          ].join(" ")}
        >
          VWAP
        </button>

        {/* Volume Profile toggle */}
        <button
          onClick={handleProfileToggle}
          aria-pressed={profileActive}
          className={[
            "text-xs px-3 py-1 rounded-full font-semibold transition-all duration-200",
            profileActive
              ? "bg-[color-mix(in_oklch,var(--btc)_18%,transparent)] text-[var(--btc)] ring-1 ring-[color-mix(in_oklch,var(--btc)_40%,transparent)] shadow-[0_0_10px_color-mix(in_oklch,var(--btc)_20%,transparent)]"
              : "bg-[var(--color-surface)] text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)]",
          ].join(" ")}
        >
          Profile
        </button>

        {/* Super Confluence toggle */}
        <button
          onClick={handleScToggle}
          aria-pressed={scActive}
          title="Super Confluence Engine — UT Bot + AI Neural Trend + SMC Structure. Highlights high-confidence entries (entry, stop, targets) and eliminates fake signals by requiring all three systems to agree."
          className={[
            "text-xs px-3 py-1 rounded-full font-semibold transition-all duration-200",
            scActive
              ? "bg-[color-mix(in_oklch,var(--bull)_18%,transparent)] text-[var(--bull)] ring-1 ring-[color-mix(in_oklch,var(--bull)_40%,transparent)] shadow-[0_0_10px_color-mix(in_oklch,var(--bull)_20%,transparent)]"
              : "bg-[var(--color-surface)] text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)]",
          ].join(" ")}
        >
          🔥 SC
        </button>

        {error && (
          <span className="text-xs text-[var(--color-bear)] ml-2">Error: {error}</span>
        )}
      </div>

      {/* ── Chart canvas ──────────────────────────────────────────── */}
      <div
        ref={containerRef}
        className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)]/40 overflow-hidden"
        style={{ height }}
      />
    </div>
  );
}
