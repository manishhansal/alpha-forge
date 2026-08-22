"use client";

import * as React from "react";
import Link from "next/link";
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  ChevronDown,
  ExternalLink,
  History,
  RefreshCw,
  Target,
  TrendingDown,
  TrendingUp,
  Trophy,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

import { cn } from "@/lib/utils";
import { fmt, fmtDuration, fmtIstTime, fmtPct } from "@/lib/india/format";
import {
  PaginationStrip,
  usePaginationFilter,
} from "@/components/india/ui/pagination-filter";
import { DAILY_PICK_BUCKET_META, type DailyPick } from "@/features/india/daily-picks/engine";
import type {
  DailyPicksDaySummary,
  DailyPicksHistoryDay,
  DailyPicksHistoryResponse,
} from "@/features/india/daily-picks/builder";

// ─── Types ────────────────────────────────────────────────────────────────────

type StatusFilter = "all" | "target" | "stop" | "closed";
type DirFilter    = "all" | "long" | "short";
type DaysFilter   = 7 | 14 | 30 | 60;

// ─── Summary Stats Banner ─────────────────────────────────────────────────────

function AggregateBanner({ days }: { days: DailyPicksHistoryDay[] }) {
  const allPicks   = days.flatMap((d) => d.groups.flatMap((g) => g.picks));
  const total      = allPicks.length;
  const targetHit  = allPicks.filter((p) => p.status === "TARGET_HIT").length;
  const stopHit    = allPicks.filter((p) => p.status === "STOP_HIT").length;
  const closed     = allPicks.filter((p) => p.status === "CLOSED" || p.status === "EXPIRED").length;
  const resolved   = targetHit + stopHit;
  const winRate    = resolved > 0 ? targetHit / resolved : null;

  const avgPnl = (() => {
    const resolved_picks = allPicks.filter((p) => p.pnlPct != null && p.status !== "OPEN");
    if (resolved_picks.length === 0) return null;
    return resolved_picks.reduce((s, p) => s + (p.pnlPct ?? 0), 0) / resolved_picks.length;
  })();

  const avgRR = (() => {
    const with_rr = allPicks.filter((p) => p.riskReward > 0);
    if (with_rr.length === 0) return null;
    return with_rr.reduce((s, p) => s + p.riskReward, 0) / with_rr.length;
  })();

  const stats: { label: string; value: string; sub?: string; tone?: "bull" | "bear" | "neutral" }[] = [
    { label: "Total picks", value: String(total), tone: "neutral" },
    {
      label: "Win rate",
      value: winRate != null ? `${(winRate * 100).toFixed(0)}%` : "—",
      sub:   resolved > 0 ? `${targetHit}W · ${stopHit}L of ${resolved} resolved` : "No resolved picks",
      tone:  winRate != null ? (winRate >= 0.5 ? "bull" : "bear") : "neutral",
    },
    {
      label: "Avg P&L",
      value: avgPnl != null ? fmtPct(avgPnl) : "—",
      tone:  avgPnl != null ? (avgPnl >= 0 ? "bull" : "bear") : "neutral",
    },
    {
      label: "Avg R:R",
      value: avgRR != null ? `${avgRR.toFixed(2)}:1` : "—",
      tone:  "neutral",
    },
    {
      label: "Squared off",
      value: String(closed),
      sub:   "intraday close",
      tone:  "neutral",
    },
    {
      label: "Trading days",
      value: String(days.length),
      tone:  "neutral",
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {stats.map((s) => (
        <div
          key={s.label}
          className="flex flex-col gap-0.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3"
        >
          <span className="text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)]">
            {s.label}
          </span>
          <span
            className={cn(
              "text-xl font-semibold tabular-nums",
              s.tone === "bull" ? "text-emerald-600 dark:text-emerald-400"
              : s.tone === "bear" ? "text-rose-600 dark:text-rose-400"
              : "text-[var(--color-fg)]",
            )}
          >
            {s.value}
          </span>
          {s.sub && (
            <span className="text-[10px] text-[var(--color-fg-subtle)]">{s.sub}</span>
          )}
        </div>
      ))}
    </div>
  );
}

// ─── Bucket heat strip ────────────────────────────────────────────────────────

function BucketHeatStrip({ days }: { days: DailyPicksHistoryDay[] }) {
  const allPicks = days.flatMap((d) => d.groups.flatMap((g) => g.picks));
  const buckets  = [...new Set(allPicks.map((p) => p.bucket))];

  if (buckets.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2">
      {buckets.map((bucket) => {
        const bPicks    = allPicks.filter((p) => p.bucket === bucket);
        const resolved  = bPicks.filter((p) => p.status === "TARGET_HIT" || p.status === "STOP_HIT");
        const hits      = resolved.filter((p) => p.status === "TARGET_HIT").length;
        const wr        = resolved.length > 0 ? hits / resolved.length : null;
        const label     = DAILY_PICK_BUCKET_META[bucket]?.label?.replace("Highly ", "") ?? bucket;
        return (
          <div
            key={bucket}
            className="flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3 py-1.5 text-[11px]"
          >
            <span className="font-medium text-[var(--color-fg)]">{label}</span>
            <span className="text-[var(--color-fg-subtle)]">{bPicks.length} picks</span>
            {wr != null && (
              <span
                className={cn(
                  "font-semibold",
                  wr >= 0.5 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400",
                )}
              >
                {(wr * 100).toFixed(0)}% win
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Day summary row ──────────────────────────────────────────────────────────

function DaySummaryBadge({ summary }: { summary: DailyPicksDaySummary }) {
  return (
    <span className="flex items-center gap-3 text-[11px] text-[var(--color-fg-muted)]">
      <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
        <Target className="h-3 w-3" />
        {summary.targetHit} hit
      </span>
      <span className="flex items-center gap-1 text-rose-600 dark:text-rose-400">
        <TrendingDown className="h-3 w-3" />
        {summary.stopHit} stop
      </span>
      {summary.closed > 0 && <span>{summary.closed} squared</span>}
      {summary.open > 0 && <span className="text-amber-600 dark:text-amber-400">{summary.open} open</span>}
      <span
        className={cn(
          "font-semibold",
          summary.winRate >= 0.5
            ? "text-emerald-600 dark:text-emerald-400"
            : summary.winRate > 0
              ? "text-rose-600 dark:text-rose-400"
              : "text-[var(--color-fg-muted)]",
        )}
      >
        {(summary.winRate * 100).toFixed(0)}% win
      </span>
    </span>
  );
}

// ─── Pick outcome tag ─────────────────────────────────────────────────────────

function OutcomeTag({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    TARGET_HIT: { label: "Target ✓",    cls: "text-emerald-600 dark:text-emerald-400" },
    STOP_HIT:   { label: "Stopped",     cls: "text-rose-600 dark:text-rose-400" },
    OPEN:       { label: "Open",        cls: "text-amber-600 dark:text-amber-400" },
    CLOSED:     { label: "Squared off", cls: "text-[var(--color-fg-muted)]" },
    EXPIRED:    { label: "Expired",     cls: "text-[var(--color-warning)]" },
  };
  const m = map[status] ?? map.OPEN;
  return <span className={cn("font-medium text-[11px]", m.cls)}>{m.label}</span>;
}

// ─── Single pick row ──────────────────────────────────────────────────────────

function PickRow({ pick, index }: { pick: DailyPick; index: number }) {
  const [open, setOpen] = React.useState(false);
  const isBull  = pick.direction !== "BEARISH";
  const tvSym   = pick.symbol.replace(".NS", "");

  return (
    <>
      <motion.tr
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18, delay: Math.min(index * 0.02, 0.3) }}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "cursor-pointer border-b border-[var(--color-border)]/40 select-none transition-colors",
          open ? "bg-[var(--color-bg-elevated)]" : "hover:bg-[var(--color-bg-elevated)]",
        )}
      >
        <td className="p-2.5 text-[var(--color-fg-subtle)] w-5">
          <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} />
        </td>
        <td className="p-2.5 text-[11px] text-[var(--color-fg-muted)]">
          {DAILY_PICK_BUCKET_META[pick.bucket]?.label?.replace("Highly ", "") ?? pick.bucket}
        </td>
        <td className="p-2.5">
          <div className="flex flex-col">
            <span className="text-sm font-semibold text-[var(--color-brand)]">{tvSym}</span>
            <span className="text-[10px] text-[var(--color-fg-subtle)] truncate max-w-[120px]">
              {pick.displayName}
            </span>
          </div>
        </td>
        <td className="p-2.5">
          <span className={cn("flex items-center gap-1 text-[11px] font-bold",
            isBull ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400",
          )}>
            {isBull ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
            {isBull ? "LONG" : "SHORT"}
          </span>
        </td>
        <td className="p-2.5 text-right tabular text-sm">₹{fmt(pick.entry)}</td>
        <td className="p-2.5 text-right tabular text-sm text-rose-600 dark:text-rose-400">
          ₹{fmt(pick.stopLoss)}
        </td>
        <td className="p-2.5 text-right tabular text-sm text-emerald-600 dark:text-emerald-400">
          ₹{fmt(pick.target)}
        </td>
        <td className={cn("p-2.5 text-right tabular text-sm font-semibold",
          pick.pnlPct == null ? "text-[var(--color-fg-muted)]"
          : pick.pnlPct >= 0  ? "text-emerald-600 dark:text-emerald-400"
          :                      "text-rose-600 dark:text-rose-400",
        )}>
          {pick.pnlPct == null ? "—" : fmtPct(pick.pnlPct)}
        </td>
        <td className="p-2.5 text-right tabular text-[11px] text-[var(--color-fg-muted)]">
          {fmtIstTime(pick.generatedAt)}
        </td>
        <td className="p-2.5 text-right tabular text-[11px] text-[var(--color-fg-muted)]">
          {pick.resolvedAt != null ? fmtDuration(pick.resolvedAt - pick.generatedAt) : "—"}
        </td>
        <td className="p-2.5">
          <OutcomeTag status={pick.status} />
        </td>
      </motion.tr>

      <AnimatePresence>
        {open && (
          <motion.tr
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
          >
            <td
              colSpan={11}
              className="border-b border-[var(--color-border)]/50 bg-[var(--color-bg-elevated)] px-4 pb-3 pt-2"
            >
              <div className="flex flex-wrap gap-4 text-[11px]">
                {/* Levels */}
                <div className="flex flex-wrap gap-x-5 gap-y-1">
                  {[
                    { label: "Entry",        val: `₹${fmt(pick.entry)}`,        cls: "text-[var(--color-fg)]" },
                    { label: "Stop Loss",    val: `₹${fmt(pick.stopLoss)}`,     cls: "text-rose-600 dark:text-rose-400" },
                    { label: "Target",       val: `₹${fmt(pick.target)}`,       cls: "text-emerald-600 dark:text-emerald-400" },
                    { label: "Stretch",      val: `₹${fmt(pick.canMoveUpto)}`,  cls: "text-emerald-500 dark:text-emerald-500" },
                    { label: "Can Expect",   val: `${pick.canExpectPct.toFixed(1)}%`, cls: "text-[var(--color-fg-muted)]" },
                    { label: "R:R",          val: `${pick.riskReward.toFixed(1)}:1`, cls: "text-[var(--color-fg-muted)]" },
                    { label: "Win Prob",     val: `${Math.round(pick.winProbability * 100)}%`, cls: "text-[var(--color-fg-muted)]" },
                    { label: "Confluence",   val: `${pick.confluenceScore}/10`, cls: "text-[var(--color-fg-muted)]" },
                  ].map((f) => (
                    <div key={f.label} className="flex flex-col gap-0.5">
                      <span className="text-[10px] uppercase tracking-wide text-[var(--color-fg-subtle)]">{f.label}</span>
                      <span className={cn("font-semibold tabular-nums", f.cls)}>{f.val}</span>
                    </div>
                  ))}
                </div>
                {/* Logic */}
                {pick.logic && (
                  <p className="w-full rounded-lg border border-dashed border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[11px] leading-relaxed text-[var(--color-fg-muted)]">
                    <span className="font-semibold text-[var(--color-fg)]">Why here: </span>
                    {pick.logic}
                  </p>
                )}
                {/* Actions */}
                <div className="flex gap-2">
                  <a
                    href={`https://in.tradingview.com/chart/CR5K0NSR/?symbol=NSE%3A${tvSym}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1 text-[11px] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
                  >
                    <ExternalLink className="h-3 w-3" /> TradingView
                  </a>
                  <Link
                    href={`/in/chart/${encodeURIComponent(pick.symbol)}`}
                    onClick={(e) => e.stopPropagation()}
                    className="inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1 text-[11px] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
                  >
                    Chart
                  </Link>
                </div>
              </div>
            </td>
          </motion.tr>
        )}
      </AnimatePresence>
    </>
  );
}

// ─── Day accordion ────────────────────────────────────────────────────────────

function DayAccordion({
  day,
  statusFilter,
  dirFilter,
}: {
  day: DailyPicksHistoryDay;
  statusFilter: StatusFilter;
  dirFilter: DirFilter;
}) {
  const [open, setOpen] = React.useState(false);

  const allPicks = day.groups.flatMap((g) => g.picks).filter((p) => {
    if (statusFilter === "target" && p.status !== "TARGET_HIT") return false;
    if (statusFilter === "stop"   && p.status !== "STOP_HIT")   return false;
    if (statusFilter === "closed" && p.status !== "CLOSED" && p.status !== "EXPIRED") return false;
    if (dirFilter === "long"  && p.direction === "BEARISH")  return false;
    if (dirFilter === "short" && p.direction !== "BEARISH")  return false;
    return true;
  });

  const { pageItems, page, setPage, totalPages, filteredTotal, pageSize } =
    usePaginationFilter({ items: allPicks, pageSize: 10 });

  return (
    <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
        aria-expanded={open}
      >
        <span className="flex items-center gap-2">
          <History className="h-4 w-4 text-[var(--color-fg-subtle)]" />
          <span className="text-sm font-semibold text-[var(--color-fg)]">{day.tradeDate}</span>
          <span className="text-[11px] text-[var(--color-fg-muted)]">
            · {allPicks.length} pick{allPicks.length !== 1 ? "s" : ""}
          </span>
        </span>
        <span className="flex items-center gap-3">
          <DaySummaryBadge summary={day.summary} />
          <ChevronDown
            className={cn("h-4 w-4 text-[var(--color-fg-subtle)] transition-transform", open && "rotate-180")}
          />
        </span>
      </button>

      <AnimatePresence>
        {open && allPicks.length > 0 && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden border-t border-[var(--color-border)]"
          >
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-[var(--color-bg-elevated)] text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)]">
                  <tr className="border-b border-[var(--color-border)]/60">
                    <th className="w-5 pl-2 pr-0" />
                    <th className="p-2.5 text-left font-medium">Bucket</th>
                    <th className="p-2.5 text-left font-medium">Symbol</th>
                    <th className="p-2.5 text-left font-medium">Dir</th>
                    <th className="p-2.5 text-right font-medium">Entry</th>
                    <th className="p-2.5 text-right font-medium">SL</th>
                    <th className="p-2.5 text-right font-medium">Target</th>
                    <th className="p-2.5 text-right font-medium">P&amp;L</th>
                    <th className="p-2.5 text-right font-medium">Appeared</th>
                    <th className="p-2.5 text-right font-medium">Held</th>
                    <th className="p-2.5 font-medium">Outcome</th>
                  </tr>
                </thead>
                <tbody>
                  <AnimatePresence>
                    {pageItems.map((pick, i) => (
                      <PickRow
                        key={`${pick.bucket}-${pick.rank}`}
                        pick={pick}
                        index={i}
                      />
                    ))}
                  </AnimatePresence>
                </tbody>
              </table>
            </div>
            <div className="px-4 pb-3 pt-1">
              <PaginationStrip
                page={page}
                totalPages={totalPages}
                filteredTotal={filteredTotal}
                pageSize={pageSize}
                onPrev={() => setPage(page - 1)}
                onNext={() => setPage(page + 1)}
                onJump={setPage}
              />
            </div>
          </motion.div>
        )}
        {open && allPicks.length === 0 && (
          <div className="border-t border-[var(--color-border)] px-4 py-6 text-center text-[12px] text-[var(--color-fg-muted)]">
            No picks match the current filters for this day.
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Other sources notice ─────────────────────────────────────────────────────

function OtherSourcesNotice() {
  const sources = [
    { label: "AI Signals",  href: "/in/ai-signals",  note: "Live intraday signals — no DB persistence" },
    { label: "Signals",     href: "/in/signals",      note: "Live scanner feed — no DB persistence" },
    { label: "Scanner",     href: "/in/scanner",      note: "Real-time screener — no DB persistence" },
    { label: "Strategies",  href: "/in/strategies",   note: "Paper trading history on the Paper Trading page" },
  ];
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="flex items-center gap-2 mb-3">
        <Activity className="h-4 w-4 text-[var(--color-brand)]" />
        <span className="text-sm font-semibold text-[var(--color-fg)]">Other signal sources</span>
      </div>
      <p className="mb-3 text-[12px] text-[var(--color-fg-muted)]">
        AI Signals, Live Signals, and Scanner hits are real-time screener results — they are not
        persisted to a database, so historical outcome tracking is not available. Only Daily Picks
        are frozen at session start and tracked to TARGET_HIT / STOP_HIT / CLOSED resolution.
        Strategy paper-trade history lives on the{" "}
        <Link href="/in/paper-trading" className="text-[var(--color-brand)] hover:underline">
          Paper Trading
        </Link>{" "}
        page.
      </p>
      <div className="flex flex-wrap gap-2">
        {sources.map((s) => (
          <Link
            key={s.href}
            href={s.href}
            className="flex flex-col rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3 py-2 text-[11px] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-fg)]"
          >
            <span className="font-semibold text-[var(--color-fg)]">{s.label}</span>
            <span className="text-[var(--color-fg-subtle)]">{s.note}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function TradeHistoryPage() {
  const [days, setDays]               = React.useState<DailyPicksHistoryDay[] | null>(null);
  const [loading, setLoading]         = React.useState(true);
  const [error, setError]             = React.useState<string | null>(null);
  const [refreshing, setRefreshing]   = React.useState(false);
  const [daysFilter, setDaysFilter]   = React.useState<DaysFilter>(30);
  const [statusFilter, setStatusFilter] = React.useState<StatusFilter>("all");
  const [dirFilter, setDirFilter]     = React.useState<DirFilter>("all");

  const load = React.useCallback(async (signal?: AbortSignal) => {
    setRefreshing(true);
    try {
      const res = await fetch(
        `/api/in/daily-picks/history?days=${daysFilter}`,
        { cache: "no-store", signal },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { days: DailyPicksHistoryDay[] };
      setDays(json.days);
      setError(null);
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setError((err as Error).message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [daysFilter]);

  React.useEffect(() => {
    const ac = new AbortController();
    void load(ac.signal);
    return () => ac.abort();
  }, [load]);

  // Paginate the days list
  const filteredDays = days ?? [];
  const { pageItems: dayPage, page, setPage, totalPages, filteredTotal, pageSize } =
    usePaginationFilter({ items: filteredDays, pageSize: 7 });

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6">
      {/* Header */}
      <header className="flex flex-col gap-1">
        <div className="flex items-center gap-3">
          <div className="grid h-9 w-9 place-items-center rounded-lg bg-gradient-to-br from-[var(--color-brand)]/20 to-[var(--color-info)]/15">
            <Trophy className="h-5 w-5 text-[var(--color-brand)]" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Trade History</h1>
            <p className="text-sm text-[var(--color-fg-muted)]">
              Frozen Daily Picks with final outcomes — every trade on the record.
            </p>
          </div>
        </div>
      </header>

      {/* Filter + refresh bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          {/* Days range */}
          <div className="flex items-center gap-1">
            {([7, 14, 30, 60] as DaysFilter[]).map((d) => (
              <button
                key={d}
                onClick={() => setDaysFilter(d)}
                className={cn(
                  "rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors",
                  daysFilter === d
                    ? "bg-[var(--color-surface-hover)] text-[var(--color-fg)] ring-1 ring-inset ring-[var(--color-border-strong)]"
                    : "text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]",
                )}
              >
                {d}d
              </button>
            ))}
          </div>

          <span className="h-4 w-px bg-[var(--color-border)]" />

          {/* Outcome filter */}
          {(["all", "target", "stop", "closed"] as StatusFilter[]).map((f) => (
            <button
              key={f}
              onClick={() => setStatusFilter(f)}
              className={cn(
                "rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors",
                statusFilter === f
                  ? "bg-[var(--color-surface-hover)] text-[var(--color-fg)] ring-1 ring-inset ring-[var(--color-border-strong)]"
                  : "text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]",
              )}
            >
              {f === "all" ? "All outcomes" : f === "target" ? "🎯 Target hit" : f === "stop" ? "🛑 Stopped" : "🔒 Squared off"}
            </button>
          ))}

          <span className="h-4 w-px bg-[var(--color-border)]" />

          {/* Direction filter */}
          {(["all", "long", "short"] as DirFilter[]).map((f) => (
            <button
              key={f}
              onClick={() => setDirFilter(f)}
              className={cn(
                "inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors",
                dirFilter === f
                  ? "bg-[var(--color-surface-hover)] text-[var(--color-fg)] ring-1 ring-inset ring-[var(--color-border-strong)]"
                  : "text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]",
              )}
            >
              {f === "long"  ? <TrendingUp   className="h-3 w-3" /> : null}
              {f === "short" ? <TrendingDown className="h-3 w-3" /> : null}
              {f === "all" ? "All" : f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 text-[11px] text-[var(--color-fg-subtle)]">
          {days != null && <span>{filteredDays.length} day{filteredDays.length !== 1 ? "s" : ""}</span>}
          <button
            type="button"
            onClick={() => void load()}
            disabled={refreshing}
            className={cn(
              "inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-2.5 py-1 text-[11px] text-[var(--color-fg-muted)] transition-colors hover:text-[var(--color-fg)]",
              refreshing && "opacity-60",
            )}
          >
            <RefreshCw className={cn("h-3 w-3", refreshing && "animate-spin")} />
            Refresh
          </button>
        </div>
      </div>

      {/* Aggregate stats */}
      {days != null && days.length > 0 && <AggregateBanner days={days} />}
      {days != null && days.length > 0 && <BucketHeatStrip days={days} />}

      {/* Day list */}
      {loading && days == null ? (
        <div className="flex items-center justify-center py-16 text-[12px] text-[var(--color-fg-muted)]">
          <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
          Loading history…
        </div>
      ) : error ? (
        <div className="rounded-xl border border-dashed border-[var(--color-border)] py-12 text-center text-[12px] text-[var(--color-fg-muted)]">
          Couldn&apos;t load history: {error}
        </div>
      ) : days != null && days.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--color-border)] py-12 text-center text-[12px] text-[var(--color-fg-muted)]">
          No past picks yet — history starts accruing from the first frozen trading day.
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-2">
            {dayPage.map((day) => (
              <DayAccordion
                key={day.tradeDate}
                day={day}
                statusFilter={statusFilter}
                dirFilter={dirFilter}
              />
            ))}
          </div>
          <PaginationStrip
            page={page}
            totalPages={totalPages}
            filteredTotal={filteredTotal}
            pageSize={pageSize}
            onPrev={() => setPage(page - 1)}
            onNext={() => setPage(page + 1)}
            onJump={setPage}
          />
        </>
      )}

      {/* Other sources section */}
      <OtherSourcesNotice />
    </div>
  );
}
