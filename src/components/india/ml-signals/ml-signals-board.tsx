"use client";

import * as React from "react";
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  BrainCircuit,
  Calendar,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ChevronsUpDown,
  Clock,
  History,
  RefreshCw,
  TrendingDown,
  TrendingUp,
  AlertCircle,
  XCircle,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type {
  MLLatestSignalsResponse,
  MLSignalScore,
  MLConviction,
  MLForecastRecord,
  MLSignalHistoryResponse,
} from "@/lib/india/ml-client";

// ── Types ──────────────────────────────────────────────────────────────────────

type Filter  = "all" | "long" | "short" | "tracked";
type SortKey = "conviction" | "symbol" | "pnl";
type MainTab = "live" | "history";

interface Props {
  initialData: MLLatestSignalsResponse | null;
  endpoint?: string;
  intervalMs?: number;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Color palette for conviction grades. */
const CONVICTION_COLORS: Record<MLConviction, string> = {
  S: "text-[var(--color-bull)] bg-[color-mix(in_oklch,var(--color-bull)_15%,transparent)] ring-[color-mix(in_oklch,var(--color-bull)_30%,transparent)]",
  A: "text-emerald-400 bg-emerald-400/10 ring-emerald-400/25",
  B: "text-sky-400 bg-sky-400/10 ring-sky-400/25",
  C: "text-amber-400 bg-amber-400/10 ring-amber-400/25",
  D: "text-[var(--color-fg-muted)] bg-transparent ring-[var(--color-border)]",
};

/** The score bar shows strength toward LONG (right) or SHORT (left). */
function ScoreBar({ score }: { score: number }) {
  // distance from 0.5 mapped to fill width [0,100%]
  const strength = Math.round(Math.abs(score - 0.5) * 200); // 0–100
  const isShort = score < 0.5;
  return (
    <div className="relative flex h-1.5 w-24 items-center overflow-hidden rounded-full bg-[var(--color-border)]">
      {isShort ? (
        <div
          className="absolute right-1/2 h-full rounded-full bg-[var(--color-bear)]"
          style={{ width: `${strength / 2}%` }}
        />
      ) : (
        <div
          className="absolute left-1/2 h-full rounded-full bg-[var(--color-bull)]"
          style={{ width: `${strength / 2}%` }}
        />
      )}
      {/* Centre tick */}
      <div className="absolute left-1/2 h-full w-px -translate-x-1/2 bg-[var(--color-border-strong)]" />
    </div>
  );
}

function ConvictionPill({ conviction }: { conviction: MLConviction }) {
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wider ring-1 ring-inset",
        CONVICTION_COLORS[conviction],
      )}
    >
      {conviction}
    </span>
  );
}

function PnlCell({ pct }: { pct: number | null | undefined }) {
  if (pct == null) return <span className="text-xs text-[var(--color-fg-muted)]">—</span>;
  const pos = pct >= 0;
  return (
    <span className={cn("text-xs font-medium tabular-nums", pos ? "text-[var(--color-bull)]" : "text-[var(--color-bear)]")}>
      {pos ? "+" : ""}{pct.toFixed(2)}%
    </span>
  );
}

/** Format seconds-ago into a human label. */
function timeAgo(isoTs: string | null): string {
  if (!isoTs) return "—";
  try {
    const secs = Math.floor((Date.now() - new Date(isoTs).getTime()) / 1000);
    if (secs < 60) return `${secs}s ago`;
    if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
    return `${Math.floor(secs / 3600)}h ago`;
  } catch {
    return "—";
  }
}

// ── Main Board ─────────────────────────────────────────────────────────────────

export function MLSignalsBoard({
  initialData,
  endpoint = "/api/in/ml-signals",
  intervalMs = 30_000,
}: Props) {
  const [mainTab, setMainTab]  = React.useState<MainTab>("live");
  const [data, setData]        = React.useState<MLLatestSignalsResponse | null>(initialData);
  const [loading, setLoading] = React.useState(false);
  const [filter, setFilter] = React.useState<Filter>("all");
  const [sortKey, setSortKey] = React.useState<SortKey>("conviction");
  const [sortDir, setSortDir] = React.useState<"asc" | "desc">("asc");
  const [lastRefresh, setLastRefresh] = React.useState<number>(Date.now());

  // ── Polling ──────────────────────────────────────────────────────────────
  const refresh = React.useCallback(
    async (signal?: AbortSignal) => {
      try {
        setLoading(true);
        const res = await fetch(endpoint, { cache: "no-store", signal });
        if (!res.ok) return;
        const json = (await res.json()) as MLLatestSignalsResponse & { available?: boolean };
        setData(json);
        setLastRefresh(Date.now());
      } catch {
        /* ignore abort */
      } finally {
        setLoading(false);
      }
    },
    [endpoint],
  );

  React.useEffect(() => {
    const ac = new AbortController();
    const id = setInterval(() => void refresh(ac.signal), intervalMs);
    return () => {
      clearInterval(id);
      ac.abort();
    };
  }, [refresh, intervalMs]);

  // ── Derived data ──────────────────────────────────────────────────────────
  const signals = React.useMemo(() => {
    if (!data?.signals) return [];

    let list = [...data.signals];

    // Filter
    if (filter === "long")    list = list.filter(s => s.direction === 1);
    if (filter === "short")   list = list.filter(s => s.direction === -1);
    if (filter === "tracked") list = list.filter(s => s.live_pnl != null);

    // Sort
    list.sort((a, b) => {
      let cmp = 0;
      if (sortKey === "conviction") {
        // rank = 1 = strongest; sort ascending by rank = strongest first
        cmp = a.rank - b.rank;
      } else if (sortKey === "symbol") {
        cmp = a.symbol.localeCompare(b.symbol);
      } else if (sortKey === "pnl") {
        const pa = a.live_pnl?.net_pct ?? null;
        const pb = b.live_pnl?.net_pct ?? null;
        if (pa == null && pb == null) cmp = 0;
        else if (pa == null) cmp = 1;
        else if (pb == null) cmp = -1;
        else cmp = pa - pb;
      }
      return sortDir === "asc" ? cmp : -cmp;
    });

    return list;
  }, [data, filter, sortKey, sortDir]);

  const nLong    = data?.n_long ?? 0;
  const nShort   = data?.n_short ?? 0;
  const nTracked = data?.signals?.filter(s => s.live_pnl != null).length ?? 0;
  const niftyChg = data?.nifty_chg ?? null;
  const sessionPnl = data?.session_pnl;

  // ── Sort toggle helper ────────────────────────────────────────────────────
  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir(d => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  function SortIcon({ k }: { k: SortKey }) {
    if (sortKey !== k) return <ChevronsUpDown className="h-3 w-3 opacity-40" />;
    return sortDir === "asc"
      ? <ChevronUp className="h-3 w-3" />
      : <ChevronDown className="h-3 w-3" />;
  }

  // ── No session state ──────────────────────────────────────────────────────
  const hasData = (data?.n_scored ?? 0) > 0;

  if (!hasData) {
    return (
      <Card className="border-[var(--color-border)] bg-[var(--color-surface)]">
        <CardContent className="flex flex-col items-center gap-4 py-16 text-center">
          <BrainCircuit className="h-12 w-12 opacity-20" style={{ color: "var(--color-fg)" }} />
          <div className="space-y-1">
            <p className="text-base font-medium" style={{ color: "var(--color-fg)" }}>
              No live session
            </p>
            <p className="text-sm" style={{ color: "var(--color-fg-muted)" }}>
              {data?.message ?? "Start a session to see LightGBM signals for all 218 F&O symbols."}
            </p>
          </div>
          <code className="rounded bg-[var(--color-surface-raised)] px-3 py-1.5 text-xs font-mono" style={{ color: "var(--color-fg-muted)" }}>
            make session
          </code>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* ── Main tab switcher ─────────────────────────────────────────── */}
      <div className="flex items-center gap-1 self-start rounded-lg bg-[var(--color-surface-raised)] p-0.5">
        {(
          [
            { key: "live",    label: "Live Signals", icon: <Activity className="h-3 w-3" /> },
            { key: "history", label: "History",      icon: <History  className="h-3 w-3" /> },
          ] as const
        ).map(({ key, label, icon }) => (
          <button
            key={key}
            onClick={() => setMainTab(key)}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
              mainTab === key
                ? "bg-[var(--color-surface)] shadow-sm text-[var(--color-fg)]"
                : "text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]",
            )}
          >
            {icon}{label}
          </button>
        ))}
      </div>

      {/* ── History tab ───────────────────────────────────────────────── */}
      {mainTab === "history" && (
        <HistoryPanel endpoint={endpoint} />
      )}

      {/* ── Live tab ──────────────────────────────────────────────────── */}
      {mainTab === "live" && (<>
      {/* Market-closed notice */}
      {!data?.market_open && hasData && (
        <div className="flex items-start gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-2 text-xs text-[var(--color-fg-muted)]">
          <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-info)]" />
          <span>
            <span className="font-medium" style={{ color: "var(--color-fg)" }}>Market closed.</span>
            {" "}Showing model scores on latest EOD bars. For live intraday signals, run{" "}
            <code className="rounded bg-[var(--color-surface)] px-1 font-mono text-[11px]">make session</code>
            {" "}during market hours (9:15–15:30 IST).
          </span>
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-5">
        <StatCard
          label="Scored"
          value={String(data?.n_scored ?? 0)}
          icon={<Activity className="h-4 w-4" />}
        />
        <StatCard
          label="Long signals"
          value={String(nLong)}
          icon={<TrendingUp className="h-4 w-4 text-[var(--color-bull)]" />}
          valueClass="text-[var(--color-bull)]"
        />
        <StatCard
          label="Short signals"
          value={String(nShort)}
          icon={<TrendingDown className="h-4 w-4 text-[var(--color-bear)]" />}
          valueClass="text-[var(--color-bear)]"
        />
        <StatCard
          label="NIFTY"
          value={niftyChg != null ? `${niftyChg >= 0 ? "+" : ""}${niftyChg.toFixed(2)}%` : "—"}
          icon={niftyChg != null && niftyChg >= 0
            ? <ArrowUpRight className="h-4 w-4 text-[var(--color-bull)]" />
            : <ArrowDownRight className="h-4 w-4 text-[var(--color-bear)]" />}
          valueClass={niftyChg != null
            ? niftyChg >= 0 ? "text-[var(--color-bull)]" : "text-[var(--color-bear)]"
            : ""}
        />
        {sessionPnl && sessionPnl.n_positions > 0 && (
          <StatCard
            label={`Session P&L (${sessionPnl.n_positions})`}
            value={sessionPnl.mean_net != null
              ? `${sessionPnl.mean_net >= 0 ? "+" : ""}${sessionPnl.mean_net.toFixed(2)}%`
              : "—"}
            valueClass={sessionPnl.mean_net != null
              ? sessionPnl.mean_net >= 0 ? "text-[var(--color-bull)]" : "text-[var(--color-bear)]"
              : ""}
            subLabel={sessionPnl.win_rate != null ? `${sessionPnl.win_rate.toFixed(0)}% win rate` : undefined}
          />
        )}
      </div>

      {/* ── Toolbar ───────────────────────────────────────────────────────── */}
      <Card className="border-[var(--color-border)] bg-[var(--color-surface)]">
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 pb-0">
          {/* Filter tabs */}
          <div className="flex items-center gap-1 rounded-lg bg-[var(--color-surface-raised)] p-0.5">
            {(
              [
                { key: "all",     label: "All",      count: data?.n_scored ?? 0 },
                { key: "long",    label: "Long",     count: nLong, bullish: true },
                { key: "short",   label: "Short",    count: nShort, bearish: true },
                { key: "tracked", label: "Tracked",  count: nTracked },
              ] as const
            ).map(({ key, label, count, ...rest }) => {
              const bullish = "bullish" in rest;
              const bearish = "bearish" in rest;
              return (
              <button
                key={key}
                onClick={() => setFilter(key as Filter)}
                className={cn(
                  "rounded-md px-3 py-1 text-xs font-medium transition-colors",
                  filter === key
                    ? "bg-[var(--color-surface)] shadow-sm text-[var(--color-fg)]"
                    : "text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]",
                  bullish && filter === key && "text-[var(--color-bull)]",
                  bearish && filter === key && "text-[var(--color-bear)]",
                )}
              >
                {label}
                <span className="ml-1.5 rounded-full bg-[var(--color-border)] px-1.5 py-0.5 text-[10px] tabular-nums">
                  {count}
                </span>
              </button>
              );
            })}
          </div>

          {/* Meta info + refresh */}
          <div className="flex items-center gap-3">
            {data?.stale && (
              <span className="flex items-center gap-1 text-xs text-[var(--color-warning)]">
                <AlertCircle className="h-3 w-3" /> Stale
              </span>
            )}
            {data?.model_version && (
              <span className="text-xs font-mono text-[var(--color-fg-muted)]">
                {data.model_version}
              </span>
            )}
            <span className="flex items-center gap-1 text-xs text-[var(--color-fg-muted)]">
              <Clock className="h-3 w-3" />
              {data?.generated_at ? timeAgo(data.generated_at) : "—"}
            </span>
            <button
              onClick={() => void refresh()}
              disabled={loading}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-fg)] transition-colors disabled:opacity-50"
            >
              <RefreshCw className={cn("h-3 w-3", loading && "animate-spin")} />
              Refresh
            </button>
          </div>
        </CardHeader>

        {/* ── Signal table ──────────────────────────────────────────────────── */}
        <CardContent className="pt-3">
          {/* Table header */}
          <div className="mb-1 grid grid-cols-[2rem_1fr_5rem_7rem_3rem_5rem_5rem] items-center gap-2 border-b border-[var(--color-border)] pb-2 text-[11px] font-medium uppercase tracking-wider text-[var(--color-fg-muted)]">
            <span>#</span>
            <button className="flex items-center gap-1 text-left hover:text-[var(--color-fg)] transition-colors" onClick={() => toggleSort("symbol")}>
              Symbol <SortIcon k="symbol" />
            </button>
            <span>Direction</span>
            <button className="flex items-center gap-1 hover:text-[var(--color-fg)] transition-colors" onClick={() => toggleSort("conviction")}>
              Score <SortIcon k="conviction" />
            </button>
            <span>Grade</span>
            <span>Data</span>
            <button className="flex items-center gap-1 hover:text-[var(--color-fg)] transition-colors" onClick={() => toggleSort("pnl")}>
              P&L <SortIcon k="pnl" />
            </button>
          </div>

          {/* Rows */}
          <div className="max-h-[calc(100vh-22rem)] overflow-y-auto">
            <AnimatePresence initial={false}>
              {signals.length === 0 ? (
                <div className="py-12 text-center text-sm text-[var(--color-fg-muted)]">
                  No signals match the current filter.
                </div>
              ) : (
                signals.map((sig, i) => (
                  <SignalRow key={sig.symbol} sig={sig} index={i} />
                ))
              )}
            </AnimatePresence>
          </div>

          {signals.length > 0 && (
            <p className="mt-2 text-right text-[11px] text-[var(--color-fg-muted)]">
              Showing {signals.length} of {data?.n_scored ?? 0} signals
            </p>
          )}
        </CardContent>
      </Card>
      </>)}
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  icon,
  valueClass,
  subLabel,
}: {
  label: string;
  value: string;
  icon?: React.ReactNode;
  valueClass?: string;
  subLabel?: string;
}) {
  return (
    <Card className="border-[var(--color-border)] bg-[var(--color-surface)]">
      <CardContent className="flex flex-col gap-1 p-4">
        <div className="flex items-center gap-1.5 text-xs text-[var(--color-fg-muted)]">
          {icon}
          <span>{label}</span>
        </div>
        <span className={cn("text-xl font-semibold tabular-nums", valueClass)} style={{ color: valueClass ? undefined : "var(--color-fg)" }}>
          {value}
        </span>
        {subLabel && (
          <span className="text-[11px] text-[var(--color-fg-muted)]">{subLabel}</span>
        )}
      </CardContent>
    </Card>
  );
}

function SignalRow({ sig, index }: { sig: MLSignalScore; index: number }) {
  const isLong  = sig.direction === 1;
  const pnl     = sig.live_pnl;
  const tracked = pnl != null;

  return (
    <motion.div
      layout
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      className={cn(
        "grid grid-cols-[2rem_1fr_5rem_7rem_3rem_5rem_5rem] items-center gap-2 rounded-lg px-1 py-2 text-sm transition-colors",
        "hover:bg-[var(--color-surface-raised)]",
        tracked && "bg-[color-mix(in_oklch,var(--color-info)_4%,transparent)]",
      )}
    >
      {/* Rank */}
      <span className="text-xs tabular-nums text-[var(--color-fg-muted)]">{sig.rank}</span>

      {/* Symbol */}
      <span className="font-medium truncate" style={{ color: "var(--color-fg)" }}>
        {sig.symbol}
        {tracked && (
          <span className="ml-1 text-[10px] text-[var(--color-info)] font-normal">●</span>
        )}
      </span>

      {/* Direction */}
      <span
        className={cn(
          "inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset w-fit",
          isLong
            ? "bg-[color-mix(in_oklch,var(--color-bull)_12%,transparent)] text-[var(--color-bull)] ring-[color-mix(in_oklch,var(--color-bull)_25%,transparent)]"
            : "bg-[color-mix(in_oklch,var(--color-bear)_12%,transparent)] text-[var(--color-bear)] ring-[color-mix(in_oklch,var(--color-bear)_25%,transparent)]",
        )}
      >
        {isLong ? <ArrowUpRight className="h-2.5 w-2.5" /> : <ArrowDownRight className="h-2.5 w-2.5" />}
        {isLong ? "LONG" : "SHORT"}
      </span>

      {/* Score bar + value */}
      <div className="flex items-center gap-2">
        <ScoreBar score={sig.score} />
        <span className="text-xs tabular-nums text-[var(--color-fg-muted)]">
          {sig.score.toFixed(3)}
        </span>
      </div>

      {/* Conviction grade */}
      <ConvictionPill conviction={sig.conviction} />

      {/* Data date — show just MM-DD to save space */}
      <span className="text-xs tabular-nums text-[var(--color-fg-muted)]">
        {sig.data_date ? sig.data_date.slice(5) : "—"}
      </span>

      {/* Live P&L */}
      <div className="flex flex-col gap-0.5">
        <PnlCell pct={pnl?.net_pct} />
        {pnl?.ltp != null && pnl.entry != null && (
          <span className="text-[10px] tabular-nums text-[var(--color-fg-muted)]">
            {pnl.entry.toFixed(1)} → {pnl.ltp.toFixed(1)}
          </span>
        )}
      </div>
    </motion.div>
  );
}

// ── History panel ──────────────────────────────────────────────────────────────

type HistoryFilter = "all" | "won" | "lost" | "open";

function StatusBadge({ status }: { status: string }) {
  const cfg: Record<string, { label: string; cls: string; icon: React.ReactNode }> = {
    won:  { label: "Won",  cls: "text-[var(--color-bull)] bg-[color-mix(in_oklch,var(--color-bull)_12%,transparent)] ring-[color-mix(in_oklch,var(--color-bull)_25%,transparent)]", icon: <CheckCircle2 className="h-2.5 w-2.5" /> },
    lost: { label: "Lost", cls: "text-[var(--color-bear)] bg-[color-mix(in_oklch,var(--color-bear)_12%,transparent)] ring-[color-mix(in_oklch,var(--color-bear)_25%,transparent)]", icon: <XCircle      className="h-2.5 w-2.5" /> },
    open: { label: "Open", cls: "text-sky-400 bg-sky-400/10 ring-sky-400/25", icon: <Clock className="h-2.5 w-2.5" /> },
  };
  const c = cfg[status] ?? { label: status, cls: "text-[var(--color-fg-muted)] bg-transparent ring-[var(--color-border)]", icon: null };
  return (
    <span className={cn("inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ring-inset w-fit", c.cls)}>
      {c.icon}{c.label}
    </span>
  );
}

function HistoryRow({ rec, index }: { rec: MLForecastRecord; index: number }) {
  const isLong = rec.direction === 1;
  const resolved = rec.net_pct != null;
  return (
    <motion.div
      layout initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      transition={{ duration: 0.12 }}
      className="grid grid-cols-[2rem_1fr_4.5rem_7rem_4.5rem_5rem_5.5rem] items-center gap-2 rounded-lg px-1 py-2 text-sm transition-colors hover:bg-[var(--color-surface-raised)]"
    >
      <span className="text-xs tabular-nums text-[var(--color-fg-muted)]">{index + 1}</span>

      <span className="font-medium truncate" style={{ color: "var(--color-fg)" }}>{rec.symbol}</span>

      <span className={cn(
        "inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ring-inset w-fit",
        isLong
          ? "bg-[color-mix(in_oklch,var(--color-bull)_12%,transparent)] text-[var(--color-bull)] ring-[color-mix(in_oklch,var(--color-bull)_25%,transparent)]"
          : "bg-[color-mix(in_oklch,var(--color-bear)_12%,transparent)] text-[var(--color-bear)] ring-[color-mix(in_oklch,var(--color-bear)_25%,transparent)]",
      )}>
        {isLong ? <ArrowUpRight className="h-2.5 w-2.5" /> : <ArrowDownRight className="h-2.5 w-2.5" />}
        {isLong ? "LONG" : "SHORT"}
      </span>

      <div className="flex items-center gap-2">
        <ScoreBar score={rec.score} />
        <span className="text-xs tabular-nums text-[var(--color-fg-muted)]">{rec.score.toFixed(3)}</span>
      </div>

      <StatusBadge status={rec.status} />

      {/* Net P&L */}
      {resolved ? (
        <span className={cn("text-xs font-medium tabular-nums",
          rec.net_pct! >= 0 ? "text-[var(--color-bull)]" : "text-[var(--color-bear)]"
        )}>
          {rec.net_pct! >= 0 ? "+" : ""}{rec.net_pct!.toFixed(2)}%
        </span>
      ) : (
        <span className="text-xs text-[var(--color-fg-muted)]">—</span>
      )}

      {/* Brier delta — negative = model beats market prior */}
      {rec.brier_delta != null ? (
        <span className={cn("text-[11px] tabular-nums font-mono",
          rec.brier_delta < 0 ? "text-[var(--color-bull)]" : "text-[var(--color-bear)]"
        )}>
          {rec.brier_delta >= 0 ? "+" : ""}{rec.brier_delta.toFixed(4)}
        </span>
      ) : (
        <span className="text-[11px] text-[var(--color-fg-muted)]">—</span>
      )}
    </motion.div>
  );
}

function HistoryPanel({ endpoint }: { endpoint: string }) {
  // Initialize to today IST; the backend will auto-fall-back to the most
  // recent date with records if today has none (e.g. before first session).
  const todayIST = React.useMemo(() => {
    const d = new Date(Date.now() + 5.5 * 3600 * 1000);
    return d.toISOString().slice(0, 10);
  }, []);

  const [date, setDate]       = React.useState(todayIST);
  const [hFilter, setHFilter] = React.useState<HistoryFilter>("all");
  const [data, setData]       = React.useState<MLSignalHistoryResponse | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError]     = React.useState<string | null>(null);

  const load = React.useCallback(async (d: string) => {
    setLoading(true); setError(null);
    try {
      const res = await fetch(`${endpoint}?view=history&date=${d}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as MLSignalHistoryResponse & { is_fallback?: boolean };
      setData(json);
      // If backend fell back to a different date, update the picker to reflect it
      if (json.is_fallback && json.date && json.date !== d) {
        setDate(json.date);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [endpoint]);

  React.useEffect(() => { void load(date); }, [date, load]);

  const records = React.useMemo(() => {
    if (!data?.records) return [];
    if (hFilter === "all") return data.records;
    return data.records.filter(r => r.status === hFilter);
  }, [data, hFilter]);

  const stats = data?.stats;

  return (
    <div className="flex flex-col gap-4">
      {/* Stats bar */}
      {stats && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <StatCard label="Resolved" value={String(stats.n_resolved)} icon={<Activity className="h-4 w-4" />} />
          <StatCard label="Won" value={String(stats.n_won)}
            icon={<CheckCircle2 className="h-4 w-4 text-[var(--color-bull)]" />}
            valueClass="text-[var(--color-bull)]" />
          <StatCard label="Lost" value={String(stats.n_lost)}
            icon={<XCircle className="h-4 w-4 text-[var(--color-bear)]" />}
            valueClass="text-[var(--color-bear)]" />
          {stats.win_rate != null && (
            <StatCard label="Win rate" value={`${stats.win_rate.toFixed(0)}%`}
              valueClass={stats.win_rate >= 50 ? "text-[var(--color-bull)]" : "text-[var(--color-bear)]"} />
          )}
          {stats.mean_net != null && (
            <StatCard label="Mean net P&L"
              value={`${stats.mean_net >= 0 ? "+" : ""}${stats.mean_net.toFixed(2)}%`}
              valueClass={stats.mean_net >= 0 ? "text-[var(--color-bull)]" : "text-[var(--color-bear)]"}
              subLabel={stats.brier_delta_mean != null
                ? `Brier Δ ${stats.brier_delta_mean >= 0 ? "+" : ""}${stats.brier_delta_mean.toFixed(4)}`
                : undefined} />
          )}
        </div>
      )}

      <Card className="border-[var(--color-border)] bg-[var(--color-surface)]">
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 pb-0">
          {/* Date picker */}
          <div className="flex items-center gap-2">
            <Calendar className="h-4 w-4 text-[var(--color-fg-muted)]" />
            <input
              type="date"
              value={date}
              max={todayIST}
              onChange={e => setDate(e.target.value)}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-2 py-1 text-xs text-[var(--color-fg)] focus:outline-none"
            />
            <span className="text-xs text-[var(--color-fg-muted)]">
              {data ? `${data.n} symbols` : "—"}
            </span>
          </div>

          {/* Status filter tabs */}
          <div className="flex items-center gap-1 rounded-lg bg-[var(--color-surface-raised)] p-0.5">
            {(["all", "won", "lost", "open"] as HistoryFilter[]).map(f => (
              <button key={f} onClick={() => setHFilter(f)}
                className={cn(
                  "rounded-md px-3 py-1 text-xs font-medium capitalize transition-colors",
                  hFilter === f
                    ? "bg-[var(--color-surface)] shadow-sm text-[var(--color-fg)]"
                    : "text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]",
                  f === "won"  && hFilter === f && "text-[var(--color-bull)]",
                  f === "lost" && hFilter === f && "text-[var(--color-bear)]",
                )}>
                {f}
                {stats && (
                  <span className="ml-1.5 rounded-full bg-[var(--color-border)] px-1.5 py-0.5 text-[10px] tabular-nums">
                    {f === "all" ? stats.n_total : f === "won" ? stats.n_won : f === "lost" ? stats.n_lost : stats.n_open}
                  </span>
                )}
              </button>
            ))}
          </div>
        </CardHeader>

        <CardContent className="pt-3">
          {/* Table header */}
          <div className="mb-1 grid grid-cols-[2rem_1fr_4.5rem_7rem_4.5rem_5rem_5.5rem] items-center gap-2 border-b border-[var(--color-border)] pb-2 text-[11px] font-medium uppercase tracking-wider text-[var(--color-fg-muted)]">
            <span>#</span>
            <span>Symbol</span>
            <span>Direction</span>
            <span>Score</span>
            <span>Status</span>
            <span>Net P&L</span>
            <span title="Brier delta: negative = model beats 50/50 baseline">Brier Δ</span>
          </div>

          {loading ? (
            <div className="space-y-2 pt-2">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-9 w-full rounded-lg" />
              ))}
            </div>
          ) : error ? (
            <div className="py-12 text-center text-sm text-[var(--color-bear)]">{error}</div>
          ) : (
            <div className="max-h-[calc(100vh-24rem)] overflow-y-auto">
              <AnimatePresence initial={false}>
                {records.length === 0 ? (
                  <div className="py-12 text-center text-sm text-[var(--color-fg-muted)]">
                    No records for this date / filter.
                  </div>
                ) : (
                  records.map((rec, i) => <HistoryRow key={rec.id ?? rec.symbol} rec={rec} index={i} />)
                )}
              </AnimatePresence>
            </div>
          )}

          {records.length > 0 && (
            <p className="mt-2 text-right text-[11px] text-[var(--color-fg-muted)]">
              {records.length} records
              {stats?.brier_delta_mean != null && (
                <span className="ml-2">
                  · Brier Δ mean: {stats.brier_delta_mean >= 0 ? "+" : ""}{stats.brier_delta_mean.toFixed(4)}
                  {stats.brier_delta_mean < 0 ? " (model beats market ✓)" : ""}
                </span>
              )}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ── Loading skeleton ───────────────────────────────────────────────────────────

export function MLSignalsBoardSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-9 w-48 rounded-lg" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-[88px] w-full rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-[520px] w-full rounded-xl" />
    </div>
  );
}
