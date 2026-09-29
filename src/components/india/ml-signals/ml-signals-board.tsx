"use client";

import * as React from "react";
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  BrainCircuit,
  Clock,
  RefreshCw,
  TrendingDown,
  TrendingUp,
  AlertCircle,
  ChevronUp,
  ChevronDown,
  ChevronsUpDown,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { MLLatestSignalsResponse, MLSignalScore, MLConviction } from "@/lib/india/ml-client";

// ── Types ──────────────────────────────────────────────────────────────────────

type Filter = "all" | "long" | "short" | "tracked";
type SortKey = "conviction" | "symbol" | "pnl";

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
  const [data, setData] = React.useState<MLLatestSignalsResponse | null>(initialData);
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
      {/* ── Stats bar ─────────────────────────────────────────────────────── */}
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

// ── Loading skeleton ───────────────────────────────────────────────────────────

export function MLSignalsBoardSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-[88px] w-full rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-[520px] w-full rounded-xl" />
    </div>
  );
}
