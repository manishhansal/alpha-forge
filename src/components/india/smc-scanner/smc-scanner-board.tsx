"use client";

/**
 * SMCScannerBoard — live Smart Money Concepts scanner for NSE F&O.
 *
 * Polls /api/in/smc-scanner every 60 seconds during market hours.
 * Displays 5 scanner tabs (OB · FVG · S&D · Sweep · MS), timestamps,
 * proximity indicators, and a "Closed Today" view.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  RefreshCw,
  TrendingDown,
  TrendingUp,
  XCircle,
} from "lucide-react";

import type { SMCSignalRecord, SMCScannerRegistryResponse } from "@/lib/india/ml-client";
import { cn } from "@/lib/utils";

// ── Constants ─────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 60_000; // 1 minute

type Tab = "all" | "order_block" | "fvg" | "supply_demand" | "liquidity_sweep" | "market_structure" | "closed";

const TABS: { id: Tab; label: string; short: string }[] = [
  { id: "all",             label: "All Active",     short: "All"   },
  { id: "order_block",     label: "Order Block",    short: "OB"    },
  { id: "fvg",             label: "Fair Value Gap", short: "FVG"   },
  { id: "supply_demand",   label: "Supply & Demand",short: "S&D"   },
  { id: "liquidity_sweep", label: "Liq. Sweep",     short: "Sweep" },
  { id: "market_structure",label: "Mkt Structure",  short: "MS"    },
  { id: "closed",          label: "Closed Today",   short: "Closed"},
];

const SCANNER_LABELS: Record<string, string> = {
  order_block:      "OB",
  fvg:              "FVG",
  supply_demand:    "S&D",
  liquidity_sweep:  "Sweep",
  market_structure: "MS",
};

const SCANNER_COLORS: Record<string, string> = {
  order_block:      "bg-violet-500/20 text-violet-300 border-violet-500/30",
  fvg:              "bg-blue-500/20  text-blue-300  border-blue-500/30",
  supply_demand:    "bg-orange-500/20 text-orange-300 border-orange-500/30",
  liquidity_sweep:  "bg-cyan-500/20  text-cyan-300  border-cyan-500/30",
  market_structure: "bg-rose-500/20  text-rose-300  border-rose-500/30",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function isBearish(direction: string): boolean {
  const d = direction.toLowerCase();
  return d.includes("bear") || d.includes("supply") || d.includes("bos_bear") || d.includes("choch_bear");
}

/**
 * Format just time HH:MM IST — used only for intraday-fresh signals (same day).
 * For daily signals the date matters more, use formatSignalDate().
 */
function formatIST(isoUtc: string | null | undefined): string {
  if (!isoUtc) return "—";
  try {
    return new Date(isoUtc).toLocaleTimeString("en-IN", {
      timeZone: "Asia/Kolkata",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    return "—";
  }
}

function formatDateIST(isoUtc: string | null | undefined): string {
  if (!isoUtc) return "—";
  try {
    return new Date(isoUtc).toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    return "—";
  }
}

/**
 * Format the actual signal formation date (signal_timestamp).
 *
 * For daily-timeframe data:
 *   - A candle from "Oct 9 IST" has UTC = 2026-10-08T18:30:00Z
 *   - The IST equivalent is 2026-10-09 00:00 → we display "Oct 9"
 *   - Same-day signals (today's intraday bar): show time e.g. "12:34"
 *
 * Logic: if the IST date matches today → show time only; otherwise show date.
 */
function formatSignalDate(isoUtc: string | null | undefined): string {
  if (!isoUtc) return "—";
  try {
    const dt = new Date(isoUtc);
    const nowIST = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    const sigIST = new Date(dt.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));

    const isSameDay =
      sigIST.getFullYear() === nowIST.getFullYear() &&
      sigIST.getMonth()    === nowIST.getMonth() &&
      sigIST.getDate()     === nowIST.getDate();

    if (isSameDay) {
      // Same day — show time
      return dt.toLocaleTimeString("en-IN", {
        timeZone: "Asia/Kolkata",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
    }

    // Daily candles: midnight IST = 00:00, just show the date
    return dt.toLocaleDateString("en-IN", {
      timeZone: "Asia/Kolkata",
      month: "short",
      day: "numeric",
    });
  } catch {
    return "—";
  }
}

/** Full date+time IST for tooltips and expanded rows. */
function formatFullIST(isoUtc: string | null | undefined): string {
  if (!isoUtc) return "—";
  try {
    return new Date(isoUtc).toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    return "—";
  }
}

// ── Focus score (mirrors backend registry.py _focus_score) ──────────────────
// Determines the default sort order — highest priority signals at the top.
const SCANNER_TYPE_WEIGHT: Record<string, number> = {
  market_structure: 150,
  liquidity_sweep:  130,
  order_block:      110,
  supply_demand:     90,
  fvg:               80,
};

function focusScore(sig: SMCSignalRecord): number {
  let score = 0;
  if (sig.is_actionable)          score += 1000;   // price AT entry NOW
  if (sig.is_choch)               score +=  400;   // trend reversal
  score += SCANNER_TYPE_WEIGHT[sig.scanner_type] ?? 0;
  score += (sig.rr ?? 0) * 30;                     // R:R quality
  // explicit null check — prox=0 is falsy, `?? 999` would give wrong result
  const prox = sig.proximity_pct !== null && sig.proximity_pct !== undefined
    ? sig.proximity_pct : 999;
  if (prox <= 2)  score += (2 - prox) * 100;       // 0% → +200, 2% → +0
  else if (prox <= 5) score += (5 - prox) * 10;
  return score;
}

/** Priority tier label for a signal — used for row heat indicator. */
function priorityTier(sig: SMCSignalRecord): "hot" | "warm" | "watch" | null {
  if (!sig.is_actionable) return null;
  if (sig.is_choch && (sig.rr ?? 0) >= 3.5) return "hot";    // ChoCh ≥ 3.5R ✅
  if ((sig.rr ?? 0) >= 2.5) return "warm";                   // BOS ≥ 2.5R ✅
  return "watch";                                             // zone ✅
}

function proxClass(prox: number | null): string {
  if (prox === null) return "text-[var(--color-fg-subtle)]";
  if (prox <= 2)  return "text-emerald-400 font-semibold";
  if (prox <= 5)  return "text-amber-400";
  return "text-[var(--color-fg-muted)]";
}

function rrClass(rr: number | null): string {
  if (rr === null) return "text-[var(--color-fg-subtle)]";
  if (rr >= 3)  return "text-emerald-400 font-bold";
  if (rr >= 2)  return "text-emerald-300 font-semibold";
  if (rr >= 1.5) return "text-amber-300";
  return "text-[var(--color-fg-muted)]";
}

function fmt(n: number | null, dp = 2): string {
  if (n === null || n === undefined) return "—";
  return n.toLocaleString("en-IN", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

// ── Signal Row ────────────────────────────────────────────────────────────────

function SignalRow({ sig, showClosed }: { sig: SMCSignalRecord; showClosed?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const bearish = isBearish(sig.direction);

  return (
    <>
      <tr
        onClick={() => setExpanded((v) => !v)}
        className="cursor-pointer border-b border-[var(--color-border)]/30 hover:bg-[var(--color-surface)]/60 transition-colors"
      >
        {/* Priority indicator */}
        <td className="py-2.5 pl-3 pr-1 w-7">
          {(() => {
            const tier = priorityTier(sig);
            if (tier === "hot")   return <span title="Top pick: actionable ChoCh ≥3.5R" className="text-base leading-none">🔥</span>;
            if (tier === "warm")  return <span title="High priority: actionable BOS ≥2.5R" className="text-base leading-none">⭐</span>;
            if (tier === "watch") return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />;
            return <span className="block h-3.5 w-3.5" />;
          })()}
        </td>

        {/* Symbol */}
        <td className="py-2.5 pr-3 font-semibold text-[var(--color-fg)] text-sm whitespace-nowrap">
          {sig.symbol}
          {sig.is_choch && (
            <span className="ml-1 text-[9px] font-bold text-amber-400 tracking-wide">★ChoCh</span>
          )}
        </td>

        {/* Scanner type badge */}
        <td className="py-2.5 pr-3">
          <span
            className={cn(
              "inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-bold tracking-wide",
              SCANNER_COLORS[sig.scanner_type] ?? "bg-gray-500/20 text-gray-300",
            )}
          >
            {SCANNER_LABELS[sig.scanner_type] ?? sig.scanner_type}
          </span>
        </td>

        {/* Direction */}
        <td className="py-2.5 pr-3">
          <span
            className={cn(
              "inline-flex items-center gap-1 text-xs font-medium",
              bearish ? "text-red-400" : "text-emerald-400",
            )}
          >
            {bearish ? <TrendingDown className="h-3 w-3" /> : <TrendingUp className="h-3 w-3" />}
            <span className="hidden sm:inline">{sig.direction}</span>
          </span>
        </td>

        {/* Entry */}
        <td className="py-2.5 pr-3 text-right text-sm font-mono text-[var(--color-fg)]">
          {fmt(sig.entry)}
        </td>

        {/* Target */}
        <td className="py-2.5 pr-3 text-right text-xs font-mono text-[var(--color-fg-muted)]">
          {fmt(sig.target)}
        </td>

        {/* Stop */}
        <td className="py-2.5 pr-3 text-right text-xs font-mono text-[var(--color-fg-muted)]">
          {fmt(sig.stop)}
        </td>

        {/* R:R */}
        <td className={cn("py-2.5 pr-3 text-right text-xs", rrClass(sig.rr))}>
          {sig.rr !== null ? `${sig.rr.toFixed(1)}x` : "—"}
        </td>

        {/* Proximity */}
        <td className={cn("py-2.5 pr-3 text-right text-xs tabular-nums", proxClass(sig.proximity_pct))}>
          {sig.proximity_pct !== null ? `${sig.proximity_pct.toFixed(1)}%` : "—"}
        </td>

        {/* Appeared / Closed at */}
        <td className="py-2.5 pr-3 text-xs text-[var(--color-fg-subtle)] whitespace-nowrap">
          {showClosed
            ? formatDateIST(sig.closed_at)
            : formatSignalDate(sig.signal_timestamp)}
        </td>

        {/* Status */}
        <td className="py-2.5 pr-3">
          {showClosed ? (
            <span className="inline-flex items-center gap-1 rounded-md bg-gray-500/15 px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-fg-subtle)]">
              <XCircle className="h-2.5 w-2.5" />
              {sig.close_reason ?? "closed"}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400">
              <Activity className="h-2.5 w-2.5" />
              active
            </span>
          )}
        </td>

        {/* Expand chevron */}
        <td className="py-2.5 pr-2 text-[var(--color-fg-subtle)]">
          {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </td>
      </tr>

      {/* Expanded detail row */}
      <AnimatePresence>
        {expanded && (
          <tr>
            <td colSpan={12} className="p-0">
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.18 }}
                className="overflow-hidden"
              >
                <div className="grid grid-cols-2 gap-x-8 gap-y-2 border-b border-[var(--color-border)]/30 bg-[var(--color-surface)]/40 px-4 py-3 text-xs sm:grid-cols-4">
                  <div>
                    <p className="text-[var(--color-fg-subtle)]">Pattern formed (IST)</p>
                    <p className="font-semibold text-[var(--color-fg)]">{formatFullIST(sig.signal_timestamp)}</p>
                  </div>
                  <div>
                    <p className="text-[var(--color-fg-subtle)]">First in registry (IST)</p>
                    <p className="font-medium text-[var(--color-fg)]">{formatDateIST(sig.first_seen_at)}</p>
                  </div>
                  <div>
                    <p className="text-[var(--color-fg-subtle)]">Last confirmed (IST)</p>
                    <p className="font-medium text-[var(--color-fg)]">{formatDateIST(sig.last_seen_at)}</p>
                  </div>
                  {sig.closed_at && (
                    <div>
                      <p className="text-[var(--color-fg-subtle)]">Closed (IST)</p>
                      <p className="font-medium text-[var(--color-fg)]">{formatFullIST(sig.closed_at)}</p>
                    </div>
                  )}
                  <div>
                    <p className="text-[var(--color-fg-subtle)]">Lifecycle state</p>
                    <p className="font-medium text-[var(--color-fg)]">{sig.lifecycle_state ?? "—"}</p>
                  </div>
                  {sig.conviction_score !== null && (
                    <div>
                      <p className="text-[var(--color-fg-subtle)]">Conviction</p>
                      <p className="font-medium text-[var(--color-fg)]">{sig.conviction_score?.toFixed(2)}</p>
                    </div>
                  )}
                  <div>
                    <p className="text-[var(--color-fg-subtle)]">Signal ID</p>
                    <p className="font-mono text-[var(--color-fg-subtle)]">{sig.id}</p>
                  </div>
                </div>
              </motion.div>
            </td>
          </tr>
        )}
      </AnimatePresence>
    </>
  );
}

// ── Stats bar ─────────────────────────────────────────────────────────────────

function StatsBar({ data }: { data: SMCScannerRegistryResponse }) {
  const active = data.active_signals;
  const actionable = active.filter((s) => s.is_actionable).length;
  const byType = Object.entries(SCANNER_LABELS).map(([type, label]) => ({
    label,
    count: active.filter((s) => s.scanner_type === type).length,
  }));

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 text-xs">
      <span className="font-semibold text-[var(--color-fg)]">
        {data.n_active} active
      </span>
      <span className="text-[var(--color-fg-subtle)]">·</span>
      <span className="flex items-center gap-1 text-emerald-400">
        <CheckCircle2 className="h-3 w-3" />
        {actionable} actionable
      </span>
      <span className="text-[var(--color-fg-subtle)]">·</span>
      <span className="text-[var(--color-fg-subtle)]">
        {data.n_closed_today} closed today
      </span>
      <div className="ml-auto flex items-center gap-2">
        {byType.map(({ label, count }) => count > 0 && (
          <span key={label} className="text-[var(--color-fg-subtle)]">
            {label}:{" "}
            <span className="font-medium text-[var(--color-fg)]">{count}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

// ── Main Board ────────────────────────────────────────────────────────────────

export function SMCScannerBoard() {
  const [data, setData]       = useState<SMCScannerRegistryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("all");
  const [countdown, setCountdown] = useState(POLL_INTERVAL_MS / 1000);
  const [sortMode, setSortMode] = useState<"focus" | "proximity" | "date">("focus");

  const timerRef    = useRef<ReturnType<typeof setInterval> | null>(null);
  const countRef    = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchData = useCallback(async (includeClosed = false) => {
    try {
      setLoading(true);
      const url = `/api/in/smc-scanner?limit=2000${includeClosed ? "&include_closed=true" : ""}`;
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: SMCScannerRegistryResponse = await res.json();
      setData(json);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
      setCountdown(POLL_INTERVAL_MS / 1000);
    }
  }, []);

  // Initial fetch + polling
  useEffect(() => {
    fetchData(activeTab === "closed");

    timerRef.current = setInterval(() => fetchData(activeTab === "closed"), POLL_INTERVAL_MS);
    countRef.current = setInterval(() => setCountdown((c) => Math.max(0, c - 1)), 1000);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (countRef.current) clearInterval(countRef.current);
    };
  }, [fetchData, activeTab]);

  // Filtered signals for current tab
  const signals: SMCSignalRecord[] = (() => {
    if (!data) return [];
    if (activeTab === "closed") return data.closed_signals;
    if (activeTab === "all")    return data.active_signals;
    return data.active_signals.filter((s) => s.scanner_type === activeTab);
  })();

  const sortedSignals = [...signals].sort((a, b) => {
    if (sortMode === "focus") {
      return focusScore(b) - focusScore(a);          // highest focus first
    }
    if (sortMode === "proximity") {
      return (a.proximity_pct ?? 999) - (b.proximity_pct ?? 999);  // closest first
    }
    // date — most recently formed first
    const ta = a.signal_timestamp ?? a.first_seen_at ?? "";
    const tb = b.signal_timestamp ?? b.first_seen_at ?? "";
    return tb.localeCompare(ta);
  });

  const tabCounts: Record<Tab, number> = {
    all:             data?.n_active ?? 0,
    order_block:     data?.active_signals.filter((s) => s.scanner_type === "order_block").length ?? 0,
    fvg:             data?.active_signals.filter((s) => s.scanner_type === "fvg").length ?? 0,
    supply_demand:   data?.active_signals.filter((s) => s.scanner_type === "supply_demand").length ?? 0,
    liquidity_sweep: data?.active_signals.filter((s) => s.scanner_type === "liquidity_sweep").length ?? 0,
    market_structure:data?.active_signals.filter((s) => s.scanner_type === "market_structure").length ?? 0,
    closed:          data?.n_closed_today ?? 0,
  };

  const lastScanIST = data?.scanned_at ? formatDateIST(data.scanned_at) : null;

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-[var(--color-fg)]">SMC Scanner</h1>
          <p className="text-xs text-[var(--color-fg-subtle)]">
            Smart Money Concepts · NSE F&O · Daily signals
          </p>
        </div>
        <div className="flex items-center gap-3">
          {lastScanIST && (
            <span className="flex items-center gap-1 text-xs text-[var(--color-fg-subtle)]">
              <Clock className="h-3 w-3" />
              Last scan: {lastScanIST} IST
            </span>
          )}
          {/* Sort mode buttons */}
          <div className="flex items-center rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-0.5 text-xs">
            {(["focus", "proximity", "date"] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => setSortMode(mode)}
                className={cn(
                  "px-2.5 py-1 rounded-md font-medium transition-colors capitalize",
                  sortMode === mode
                    ? "bg-[var(--color-brand)] text-white"
                    : "text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]",
                )}
              >
                {mode === "focus" ? "🎯 Focus" : mode === "proximity" ? "📍 Proximity" : "📅 Date"}
              </button>
            ))}
          </div>
          <button
            onClick={() => fetchData(activeTab === "closed")}
            disabled={loading}
            className="flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-xs font-medium text-[var(--color-fg-muted)] transition-colors hover:border-[var(--color-brand)] hover:text-[var(--color-fg)] disabled:opacity-50"
          >
            <RefreshCw className={cn("h-3 w-3", loading && "animate-spin")} />
            {loading ? "Scanning…" : `Refresh (${countdown}s)`}
          </button>
        </div>
      </div>

      {/* Stats */}
      {data && <StatsBar data={data} />}

      {/* Error */}
      {error && (
        <div className="flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-300">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error} — scanner may be starting up or market is closed.
        </div>
      )}

      {/* Empty state when no registry data yet */}
      {!loading && data && data.n_active === 0 && activeTab !== "closed" && (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] py-12 text-center">
          <Activity className="h-8 w-8 text-[var(--color-fg-subtle)]" />
          <p className="text-sm font-medium text-[var(--color-fg-muted)]">No active signals yet</p>
          <p className="text-xs text-[var(--color-fg-subtle)]">
            The background scanner runs every 5 minutes during market hours (9:00–15:45 IST).
            <br />
            Signals will appear here once the first scan completes.
          </p>
        </div>
      )}

      {/* Tabs + Table */}
      {(data || loading) && (
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] overflow-hidden">
          {/* Tabs */}
          <div className="flex items-center gap-0 overflow-x-auto border-b border-[var(--color-border)] bg-[var(--color-surface)]/50 px-3">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  "flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-3 text-xs font-medium transition-colors",
                  activeTab === tab.id
                    ? "border-[var(--color-brand)] text-[var(--color-fg)]"
                    : "border-transparent text-[var(--color-fg-subtle)] hover:text-[var(--color-fg-muted)]",
                )}
              >
                {tab.short}
                {tabCounts[tab.id] > 0 && (
                  <span
                    className={cn(
                      "rounded-full px-1.5 py-0.5 text-[9px] font-bold",
                      activeTab === tab.id
                        ? "bg-[var(--color-brand)]/20 text-[var(--color-brand)]"
                        : "bg-[var(--color-surface)] text-[var(--color-fg-muted)]",
                    )}
                  >
                    {tabCounts[tab.id]}
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* Table */}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)]/50 bg-[var(--color-surface)]/30 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-fg-subtle)]">
                  <th className="py-2.5 pl-3 pr-1 text-left w-7" />
                  <th className="py-2.5 pr-3 text-left">Symbol</th>
                  <th className="py-2.5 pr-3 text-left">Type</th>
                  <th className="py-2.5 pr-3 text-left">Direction</th>
                  <th className="py-2.5 pr-3 text-right">Entry</th>
                  <th className="py-2.5 pr-3 text-right">Target</th>
                  <th className="py-2.5 pr-3 text-right">Stop</th>
                  <th className="py-2.5 pr-3 text-right">R:R</th>
                  <th
                    className="py-2.5 pr-3 text-right cursor-pointer select-none hover:text-[var(--color-fg)]"
                    onClick={() => setSortMode((m) => m === "proximity" ? "focus" : "proximity")}
                    title="Click to sort by proximity"
                  >
                    Prox {sortMode === "proximity" ? "↑" : ""}
                  </th>
                  <th className="py-2.5 pr-3 text-left">
                    {activeTab === "closed" ? "Closed (IST)" : "Formed (IST)"}
                  </th>
                  <th className="py-2.5 pr-3 text-left">Status</th>
                  <th className="py-2.5 pr-2 w-6" />
                </tr>
              </thead>
              <tbody>
                <AnimatePresence mode="popLayout">
                  {sortedSignals.map((sig) => (
                    <SignalRow
                      key={sig.id}
                      sig={sig}
                      showClosed={activeTab === "closed"}
                    />
                  ))}
                </AnimatePresence>
                {!loading && sortedSignals.length === 0 && (
                  <tr>
                    <td colSpan={12} className="py-8 text-center text-sm text-[var(--color-fg-subtle)]">
                      {activeTab === "closed"
                        ? "No signals closed today yet."
                        : "No signals in this category."}
                    </td>
                  </tr>
                )}
                {loading && sortedSignals.length === 0 && (
                  <tr>
                    <td colSpan={12} className="py-8 text-center">
                      <div className="flex items-center justify-center gap-2 text-sm text-[var(--color-fg-subtle)]">
                        <RefreshCw className="h-4 w-4 animate-spin" />
                        Scanning 282 symbols…
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Footer */}
          {data?.last_scan_meta && (
            <div className="border-t border-[var(--color-border)]/30 bg-[var(--color-surface)]/20 px-4 py-2 text-[10px] text-[var(--color-fg-subtle)]">
              Last full scan: {formatDateIST(data.last_scan_meta.scanned_at)} IST
              &nbsp;·&nbsp; {data.last_scan_meta.n_symbols} symbols
              &nbsp;·&nbsp; {data.last_scan_meta.n_total_signals} raw signals
              &nbsp;·&nbsp; Auto-refreshes every 60s
              &nbsp;·&nbsp; 🔥 ChoCh ≥3.5R actionable &nbsp;⭐ BOS ≥2.5R actionable &nbsp;✅ zone actionable
              &nbsp;·&nbsp; ✅ = within 2% of entry
            </div>
          )}
        </div>
      )}
    </div>
  );
}
