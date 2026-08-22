"use client";

import * as React from "react";
import Link from "next/link";
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  ChevronDown,
  ExternalLink,
  History,
  RefreshCw,
  ScanSearch,
  Target,
  TrendingDown,
  TrendingUp,
  Trophy,
  Zap,
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
} from "@/features/india/daily-picks/builder";
import { INDIA_SCALP_STRATEGY_CATALOG } from "@/features/india/scalping/strategies/catalog";
import type { IndiaPaperTradeRow } from "@/features/india/scalping/journal";
import type { FnoTrendScanRow, FnoTrendHistoryDay } from "@/features/india/fno-trend-history/service";

// ─── Types ────────────────────────────────────────────────────────────────────

type StatusFilter = "all" | "target" | "stop" | "closed";
type DirFilter    = "all" | "long" | "short";
type DaysFilter   = 7 | 14 | 30 | 60;
type SourceTab    = "picks" | "scalper" | "fno-trend";

// ─── Shared helpers ───────────────────────────────────────────────────────────

function OutcomeTag({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    TARGET_HIT: { label: "Target ✓",    cls: "text-emerald-600 dark:text-emerald-400" },
    STOP_HIT:   { label: "Stopped",     cls: "text-rose-600 dark:text-rose-400" },
    WIN:        { label: "Win ✓",       cls: "text-emerald-600 dark:text-emerald-400" },
    LOSS:       { label: "Loss",        cls: "text-rose-600 dark:text-rose-400" },
    OPEN:       { label: "Open",        cls: "text-amber-600 dark:text-amber-400" },
    CLOSED:     { label: "Squared off", cls: "text-[var(--color-fg-muted)]" },
    EXPIRED:    { label: "Expired",     cls: "text-[var(--color-warning)]" },
    CANCELLED:  { label: "Cancelled",   cls: "text-[var(--color-fg-subtle)]" },
  };
  const m = map[status] ?? { label: status, cls: "text-[var(--color-fg-muted)]" };
  return <span className={cn("font-medium text-[11px]", m.cls)}>{m.label}</span>;
}

// ─── ═══════════════════════════════════════════════════════════════════════ ─
//    DAILY PICKS SECTION
// ─ ═══════════════════════════════════════════════════════════════════════ ───

function AggregateBanner({ days }: { days: DailyPicksHistoryDay[] }) {
  const allPicks  = days.flatMap((d) => d.groups.flatMap((g) => g.picks));
  const total     = allPicks.length;
  const targetHit = allPicks.filter((p) => p.status === "TARGET_HIT").length;
  const stopHit   = allPicks.filter((p) => p.status === "STOP_HIT").length;
  const closed    = allPicks.filter((p) => p.status === "CLOSED" || p.status === "EXPIRED").length;
  const resolved  = targetHit + stopHit;
  const winRate   = resolved > 0 ? targetHit / resolved : null;
  const avgPnl    = (() => {
    const rp = allPicks.filter((p) => p.pnlPct != null && p.status !== "OPEN");
    return rp.length > 0 ? rp.reduce((s, p) => s + (p.pnlPct ?? 0), 0) / rp.length : null;
  })();
  const avgRR = (() => {
    const rp = allPicks.filter((p) => p.riskReward > 0);
    return rp.length > 0 ? rp.reduce((s, p) => s + p.riskReward, 0) / rp.length : null;
  })();

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {[
        { label: "Total picks",    value: String(total),                                     tone: "neutral" },
        { label: "Win rate",       value: winRate != null ? `${(winRate * 100).toFixed(0)}%` : "—",
          sub: resolved > 0 ? `${targetHit}W · ${stopHit}L of ${resolved}` : "No resolved",
          tone: winRate != null ? (winRate >= 0.5 ? "bull" : "bear") : "neutral" },
        { label: "Avg P&L",        value: avgPnl != null ? fmtPct(avgPnl) : "—",             tone: avgPnl != null ? (avgPnl >= 0 ? "bull" : "bear") : "neutral" },
        { label: "Avg R:R",        value: avgRR  != null ? `${avgRR.toFixed(2)}:1` : "—",    tone: "neutral" },
        { label: "Squared off",    value: String(closed),   sub: "intraday close",            tone: "neutral" },
        { label: "Trading days",   value: String(days.length),                               tone: "neutral" },
      ].map((s) => (
        <div key={s.label} className="flex flex-col gap-0.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
          <span className="text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)]">{s.label}</span>
          <span className={cn("text-xl font-semibold tabular-nums",
            s.tone === "bull" ? "text-emerald-600 dark:text-emerald-400"
            : s.tone === "bear" ? "text-rose-600 dark:text-rose-400"
            : "text-[var(--color-fg)]"
          )}>{s.value}</span>
          {(s as { sub?: string }).sub && <span className="text-[10px] text-[var(--color-fg-subtle)]">{(s as { sub?: string }).sub}</span>}
        </div>
      ))}
    </div>
  );
}

function BucketHeatStrip({ days }: { days: DailyPicksHistoryDay[] }) {
  const allPicks = days.flatMap((d) => d.groups.flatMap((g) => g.picks));
  const buckets  = [...new Set(allPicks.map((p) => p.bucket))];
  if (buckets.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {buckets.map((bucket) => {
        const bp  = allPicks.filter((p) => p.bucket === bucket);
        const res = bp.filter((p) => p.status === "TARGET_HIT" || p.status === "STOP_HIT");
        const wr  = res.length > 0 ? res.filter((p) => p.status === "TARGET_HIT").length / res.length : null;
        return (
          <div key={bucket} className="flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3 py-1.5 text-[11px]">
            <span className="font-medium text-[var(--color-fg)]">{DAILY_PICK_BUCKET_META[bucket]?.label?.replace("Highly ", "") ?? bucket}</span>
            <span className="text-[var(--color-fg-subtle)]">{bp.length} picks</span>
            {wr != null && (
              <span className={cn("font-semibold", wr >= 0.5 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400")}>
                {(wr * 100).toFixed(0)}% win
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function DaySummaryBadge({ summary }: { summary: DailyPicksDaySummary }) {
  return (
    <span className="flex items-center gap-3 text-[11px] text-[var(--color-fg-muted)]">
      <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400"><Target className="h-3 w-3" />{summary.targetHit} hit</span>
      <span className="flex items-center gap-1 text-rose-600 dark:text-rose-400"><TrendingDown className="h-3 w-3" />{summary.stopHit} stop</span>
      {summary.closed > 0 && <span>{summary.closed} squared</span>}
      {summary.open   > 0 && <span className="text-amber-600 dark:text-amber-400">{summary.open} open</span>}
      <span className={cn("font-semibold",
        summary.winRate >= 0.5 ? "text-emerald-600 dark:text-emerald-400"
        : summary.winRate > 0  ? "text-rose-600 dark:text-rose-400"
        : "text-[var(--color-fg-muted)]"
      )}>{(summary.winRate * 100).toFixed(0)}% win</span>
    </span>
  );
}

function PickRow({ pick, index }: { pick: DailyPick; index: number }) {
  const [open, setOpen] = React.useState(false);
  const isBull = pick.direction !== "BEARISH";
  const tvSym  = pick.symbol.replace(".NS", "");
  return (
    <>
      <motion.tr
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18, delay: Math.min(index * 0.02, 0.3) }}
        onClick={() => setOpen((v) => !v)}
        className={cn("cursor-pointer border-b border-[var(--color-border)]/40 select-none transition-colors",
          open ? "bg-[var(--color-bg-elevated)]" : "hover:bg-[var(--color-bg-elevated)]"
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
            <span className="text-[10px] text-[var(--color-fg-subtle)] truncate max-w-[120px]">{pick.displayName}</span>
          </div>
        </td>
        <td className="p-2.5">
          <span className={cn("flex items-center gap-1 text-[11px] font-bold",
            isBull ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"
          )}>
            {isBull ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
            {isBull ? "LONG" : "SHORT"}
          </span>
        </td>
        <td className="p-2.5 text-right tabular text-sm">₹{fmt(pick.entry)}</td>
        <td className="p-2.5 text-right tabular text-sm text-rose-600 dark:text-rose-400">₹{fmt(pick.stopLoss)}</td>
        <td className="p-2.5 text-right tabular text-sm text-emerald-600 dark:text-emerald-400">₹{fmt(pick.target)}</td>
        <td className={cn("p-2.5 text-right tabular text-sm font-semibold",
          pick.pnlPct == null ? "text-[var(--color-fg-muted)]" : pick.pnlPct >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"
        )}>{pick.pnlPct == null ? "—" : fmtPct(pick.pnlPct)}</td>
        <td className="p-2.5 text-right tabular text-[11px] text-[var(--color-fg-muted)]">{fmtIstTime(pick.generatedAt)}</td>
        <td className="p-2.5 text-right tabular text-[11px] text-[var(--color-fg-muted)]">
          {pick.resolvedAt != null ? fmtDuration(pick.resolvedAt - pick.generatedAt) : "—"}
        </td>
        <td className="p-2.5"><OutcomeTag status={pick.status} /></td>
      </motion.tr>
      <AnimatePresence>
        {open && (
          <motion.tr initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
            <td colSpan={11} className="border-b border-[var(--color-border)]/50 bg-[var(--color-bg-elevated)] px-4 pb-3 pt-2">
              <div className="flex flex-wrap gap-4 text-[11px]">
                <div className="flex flex-wrap gap-x-5 gap-y-1">
                  {[
                    { l: "Entry",      v: `₹${fmt(pick.entry)}`,                           c: "text-[var(--color-fg)]" },
                    { l: "Stop Loss",  v: `₹${fmt(pick.stopLoss)}`,                        c: "text-rose-600 dark:text-rose-400" },
                    { l: "Target",     v: `₹${fmt(pick.target)}`,                          c: "text-emerald-600 dark:text-emerald-400" },
                    { l: "Stretch",    v: `₹${fmt(pick.canMoveUpto)}`,                     c: "text-emerald-500" },
                    { l: "Can Expect", v: `${pick.canExpectPct.toFixed(1)}%`,              c: "text-[var(--color-fg-muted)]" },
                    { l: "R:R",        v: `${pick.riskReward.toFixed(1)}:1`,               c: "text-[var(--color-fg-muted)]" },
                    { l: "Win Prob",   v: `${Math.round(pick.winProbability * 100)}%`,     c: "text-[var(--color-fg-muted)]" },
                    { l: "Confluence", v: `${pick.confluenceScore}/10`,                    c: "text-[var(--color-fg-muted)]" },
                  ].map((f) => (
                    <div key={f.l} className="flex flex-col gap-0.5">
                      <span className="text-[10px] uppercase tracking-wide text-[var(--color-fg-subtle)]">{f.l}</span>
                      <span className={cn("font-semibold tabular-nums", f.c)}>{f.v}</span>
                    </div>
                  ))}
                </div>
                {pick.logic && (
                  <p className="w-full rounded-lg border border-dashed border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[11px] leading-relaxed text-[var(--color-fg-muted)]">
                    <span className="font-semibold text-[var(--color-fg)]">Why here: </span>{pick.logic}
                  </p>
                )}
                <div className="flex gap-2">
                  <a href={`https://in.tradingview.com/chart/CR5K0NSR/?symbol=NSE%3A${tvSym}`} target="_blank" rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1 text-[11px] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]">
                    <ExternalLink className="h-3 w-3" /> TradingView
                  </a>
                  <Link href={`/in/chart/${encodeURIComponent(pick.symbol)}`} onClick={(e) => e.stopPropagation()}
                    className="inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1 text-[11px] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]">
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

function DayAccordion({ day, statusFilter, dirFilter }: {
  day: DailyPicksHistoryDay; statusFilter: StatusFilter; dirFilter: DirFilter;
}) {
  const [open, setOpen] = React.useState(false);
  const allPicks = day.groups.flatMap((g) => g.picks).filter((p) => {
    if (statusFilter === "target" && p.status !== "TARGET_HIT") return false;
    if (statusFilter === "stop"   && p.status !== "STOP_HIT")   return false;
    if (statusFilter === "closed" && p.status !== "CLOSED" && p.status !== "EXPIRED") return false;
    if (dirFilter === "long"  && p.direction === "BEARISH") return false;
    if (dirFilter === "short" && p.direction !== "BEARISH") return false;
    return true;
  });
  const { pageItems, page, setPage, totalPages, filteredTotal, pageSize } =
    usePaginationFilter({ items: allPicks, pageSize: 10 });
  return (
    <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
      <button type="button" onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left" aria-expanded={open}>
        <span className="flex items-center gap-2">
          <History className="h-4 w-4 text-[var(--color-fg-subtle)]" />
          <span className="text-sm font-semibold text-[var(--color-fg)]">{day.tradeDate}</span>
          <span className="text-[11px] text-[var(--color-fg-muted)]">· {allPicks.length} pick{allPicks.length !== 1 ? "s" : ""}</span>
        </span>
        <span className="flex items-center gap-3">
          <DaySummaryBadge summary={day.summary} />
          <ChevronDown className={cn("h-4 w-4 text-[var(--color-fg-subtle)] transition-transform", open && "rotate-180")} />
        </span>
      </button>
      <AnimatePresence>
        {open && allPicks.length > 0 && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }}
            className="overflow-hidden border-t border-[var(--color-border)]">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-[var(--color-bg-elevated)] text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)]">
                  <tr className="border-b border-[var(--color-border)]/60">
                    <th className="w-5 pl-2 pr-0" />
                    <th className="p-2.5 text-left">Bucket</th>
                    <th className="p-2.5 text-left">Symbol</th>
                    <th className="p-2.5 text-left">Dir</th>
                    <th className="p-2.5 text-right">Entry</th>
                    <th className="p-2.5 text-right">SL</th>
                    <th className="p-2.5 text-right">Target</th>
                    <th className="p-2.5 text-right">P&amp;L</th>
                    <th className="p-2.5 text-right">Appeared</th>
                    <th className="p-2.5 text-right">Held</th>
                    <th className="p-2.5">Outcome</th>
                  </tr>
                </thead>
                <tbody>
                  <AnimatePresence>
                    {pageItems.map((pick, i) => <PickRow key={`${pick.bucket}-${pick.rank}`} pick={pick} index={i} />)}
                  </AnimatePresence>
                </tbody>
              </table>
            </div>
            <div className="px-4 pb-3 pt-1">
              <PaginationStrip page={page} totalPages={totalPages} filteredTotal={filteredTotal} pageSize={pageSize}
                onPrev={() => setPage(page - 1)} onNext={() => setPage(page + 1)} onJump={setPage} />
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

// ─── ═══════════════════════════════════════════════════════════════════════ ─
//    SCALPER TRADES SECTION
// ─ ═══════════════════════════════════════════════════════════════════════ ───

// PaperTrade rows come from the API as serialised strings for dates
type ScalperTradeRow = Omit<IndiaPaperTradeRow, "openedAt" | "closedAt"> & {
  openedAt: string;
  closedAt: string | null;
};

function ScalperAggregateBanner({ trades }: { trades: ScalperTradeRow[] }) {
  const resolved = trades.filter((t) => t.status === "WIN" || t.status === "LOSS");
  const wins     = resolved.filter((t) => t.status === "WIN").length;
  const wr       = resolved.length > 0 ? wins / resolved.length : null;
  const avgPnl   = (() => {
    const rp = trades.filter((t) => t.pnlPct != null);
    return rp.length > 0 ? rp.reduce((s, t) => s + (t.pnlPct ?? 0), 0) / rp.length : null;
  })();
  const avgRR = (() => {
    const rp = trades.filter((t) => t.riskReward > 0);
    return rp.length > 0 ? rp.reduce((s, t) => s + t.riskReward, 0) / rp.length : null;
  })();
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {[
        { label: "Total trades", value: String(trades.length),                                  tone: "neutral" },
        { label: "Win rate",     value: wr != null ? `${(wr * 100).toFixed(0)}%` : "—",
          sub: resolved.length > 0 ? `${wins}W · ${resolved.length - wins}L` : "No resolved", tone: wr != null ? (wr >= 0.5 ? "bull" : "bear") : "neutral" },
        { label: "Avg P&L",      value: avgPnl != null ? fmtPct(avgPnl) : "—",                 tone: avgPnl != null ? (avgPnl >= 0 ? "bull" : "bear") : "neutral" },
        { label: "Avg R:R",      value: avgRR  != null ? `${avgRR.toFixed(2)}:1` : "—",        tone: "neutral" },
        { label: "Open",         value: String(trades.filter((t) => t.status === "OPEN").length), tone: "neutral" },
      ].map((s) => (
        <div key={s.label} className="flex flex-col gap-0.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
          <span className="text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)]">{s.label}</span>
          <span className={cn("text-xl font-semibold tabular-nums",
            s.tone === "bull" ? "text-emerald-600 dark:text-emerald-400"
            : s.tone === "bear" ? "text-rose-600 dark:text-rose-400"
            : "text-[var(--color-fg)]"
          )}>{s.value}</span>
          {(s as {sub?: string}).sub && <span className="text-[10px] text-[var(--color-fg-subtle)]">{(s as {sub?: string}).sub}</span>}
        </div>
      ))}
    </div>
  );
}

function StrategyHeatStrip({ trades }: { trades: ScalperTradeRow[] }) {
  const ids = [...new Set(trades.map((t) => t.strategyId))];
  if (ids.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {ids.map((id) => {
        const meta    = INDIA_SCALP_STRATEGY_CATALOG.find((s) => s.id === id);
        const st      = trades.filter((t) => t.strategyId === id);
        const res     = st.filter((t) => t.status === "WIN" || t.status === "LOSS");
        const wr      = res.length > 0 ? res.filter((t) => t.status === "WIN").length / res.length : null;
        return (
          <div key={id} className="flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3 py-1.5 text-[11px]">
            <span className="font-medium text-[var(--color-fg)]">{meta?.label ?? id}</span>
            <span className="text-[var(--color-fg-subtle)]">{st.length} trades</span>
            {wr != null && (
              <span className={cn("font-semibold", wr >= 0.5 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400")}>
                {(wr * 100).toFixed(0)}% win
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ScalperTradeRow({ trade, index }: { trade: ScalperTradeRow; index: number }) {
  const [open, setOpen] = React.useState(false);
  const isBull = trade.direction === "LONG";
  const tvSym  = trade.symbol.replace(".NS", "");
  const meta   = INDIA_SCALP_STRATEGY_CATALOG.find((s) => s.id === trade.strategyId);
  const opened = new Date(trade.openedAt);
  const closed = trade.closedAt ? new Date(trade.closedAt) : null;
  return (
    <>
      <motion.tr
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18, delay: Math.min(index * 0.02, 0.3) }}
        onClick={() => setOpen((v) => !v)}
        className={cn("cursor-pointer border-b border-[var(--color-border)]/40 select-none transition-colors",
          open ? "bg-[var(--color-bg-elevated)]" : "hover:bg-[var(--color-bg-elevated)]"
        )}
      >
        <td className="p-2.5 w-5 text-[var(--color-fg-subtle)]">
          <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} />
        </td>
        <td className="p-2.5 text-[11px] text-[var(--color-fg-muted)]">{meta?.label ?? trade.strategyId}</td>
        <td className="p-2.5">
          <span className="text-sm font-semibold text-[var(--color-brand)]">{tvSym}</span>
        </td>
        <td className="p-2.5">
          <span className={cn("flex items-center gap-1 text-[11px] font-bold",
            isBull ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"
          )}>
            {isBull ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
            {trade.direction}
          </span>
        </td>
        <td className="p-2.5 text-right tabular text-sm">₹{fmt(trade.entry)}</td>
        <td className="p-2.5 text-right tabular text-sm text-rose-600 dark:text-rose-400">₹{fmt(trade.stopLoss)}</td>
        <td className="p-2.5 text-right tabular text-sm text-emerald-600 dark:text-emerald-400">₹{fmt(trade.target)}</td>
        <td className="p-2.5 text-right tabular text-sm">{trade.exitPrice != null ? `₹${fmt(trade.exitPrice)}` : "—"}</td>
        <td className={cn("p-2.5 text-right tabular text-sm font-semibold",
          trade.pnlPct == null ? "text-[var(--color-fg-muted)]" : trade.pnlPct >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"
        )}>{trade.pnlPct == null ? "—" : fmtPct(trade.pnlPct)}</td>
        <td className="p-2.5 text-right tabular text-[11px] text-[var(--color-fg-muted)]">
          {opened.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" })}
        </td>
        <td className="p-2.5 text-right tabular text-[11px] text-[var(--color-fg-muted)]">
          {closed ? fmtDuration(closed.getTime() - opened.getTime()) : "—"}
        </td>
        <td className="p-2.5"><OutcomeTag status={trade.status} /></td>
      </motion.tr>
      <AnimatePresence>
        {open && (
          <motion.tr initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
            <td colSpan={12} className="border-b border-[var(--color-border)]/50 bg-[var(--color-bg-elevated)] px-4 pb-3 pt-2">
              <div className="flex flex-wrap gap-4 text-[11px]">
                <div className="flex flex-wrap gap-x-5 gap-y-1">
                  {[
                    { l: "Entry",     v: `₹${fmt(trade.entry)}`,                             c: "text-[var(--color-fg)]" },
                    { l: "Stop Loss", v: `₹${fmt(trade.stopLoss)}`,                          c: "text-rose-600 dark:text-rose-400" },
                    { l: "Target",    v: `₹${fmt(trade.target)}`,                            c: "text-emerald-600 dark:text-emerald-400" },
                    { l: "Exit",      v: trade.exitPrice != null ? `₹${fmt(trade.exitPrice)}` : "—", c: "text-[var(--color-fg-muted)]" },
                    { l: "R:R",       v: `${trade.riskReward.toFixed(1)}:1`,                 c: "text-[var(--color-fg-muted)]" },
                    { l: "ATR",       v: `₹${fmt(trade.atr)}`,                               c: "text-[var(--color-fg-muted)]" },
                    { l: "Strategy",  v: meta?.label ?? trade.strategyId,                    c: "text-[var(--color-fg)]" },
                    { l: "Timeframe", v: trade.strategyTimeframe,                            c: "text-[var(--color-fg-muted)]" },
                  ].map((f) => (
                    <div key={f.l} className="flex flex-col gap-0.5">
                      <span className="text-[10px] uppercase tracking-wide text-[var(--color-fg-subtle)]">{f.l}</span>
                      <span className={cn("font-semibold tabular-nums", f.c)}>{f.v}</span>
                    </div>
                  ))}
                </div>
                {trade.rationale.length > 0 && (
                  <p className="w-full rounded-lg border border-dashed border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[11px] leading-relaxed text-[var(--color-fg-muted)]">
                    {trade.rationale.join(" · ")}
                  </p>
                )}
                <div className="flex gap-2">
                  <a href={`https://in.tradingview.com/chart/CR5K0NSR/?symbol=NSE%3A${tvSym}`} target="_blank" rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1 text-[11px] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]">
                    <ExternalLink className="h-3 w-3" /> TradingView
                  </a>
                  <Link href={`/in/chart/${encodeURIComponent(trade.symbol)}`} onClick={(e) => e.stopPropagation()}
                    className="inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1 text-[11px] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]">
                    Chart
                  </Link>
                  <Link href="/in/paper-trading" onClick={(e) => e.stopPropagation()}
                    className="inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1 text-[11px] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]">
                    <BarChart3 className="h-3 w-3" /> Full Journal
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

function ScalperSection({ daysFilter, dirFilter }: { daysFilter: DaysFilter; dirFilter: DirFilter }) {
  const [trades,    setTrades]    = React.useState<ScalperTradeRow[] | null>(null);
  const [total,     setTotal]     = React.useState(0);
  const [loading,   setLoading]   = React.useState(true);
  const [error,     setError]     = React.useState<string | null>(null);
  const [page,      setPage]      = React.useState(1);
  const PAGE_SIZE = 20;

  const load = React.useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const cutoff = new Date(Date.now() - daysFilter * 86_400_000).toISOString();
      const dirParam = dirFilter === "long" ? "&status=WIN,LOSS,EXPIRED,OPEN" : "";
      const res = await fetch(
        `/api/in/scalper/journal?limit=${PAGE_SIZE}&offset=${(page - 1) * PAGE_SIZE}${dirParam}`,
        { cache: "no-store", signal },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as { items: ScalperTradeRow[]; total: number };
      // Filter by date client-side (API doesn't have a date filter)
      const filtered = json.items.filter((t) => {
        if (t.openedAt < cutoff) return false;
        if (dirFilter === "long"  && t.direction !== "LONG")  return false;
        if (dirFilter === "short" && t.direction !== "SHORT") return false;
        return true;
      });
      setTrades(filtered);
      setTotal(json.total);
      setError(null);
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setError((err as Error).message);
    } finally { setLoading(false); }
  }, [daysFilter, dirFilter, page]);

  React.useEffect(() => {
    const ac = new AbortController();
    void load(ac.signal);
    return () => ac.abort();
  }, [load]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="flex flex-col gap-4">
      {trades != null && trades.length > 0 && <ScalperAggregateBanner trades={trades} />}
      {trades != null && trades.length > 0 && <StrategyHeatStrip trades={trades} />}

      {loading && trades == null ? (
        <div className="flex items-center justify-center py-12 text-[12px] text-[var(--color-fg-muted)]">
          <RefreshCw className="mr-2 h-4 w-4 animate-spin" />Loading scalper trades…
        </div>
      ) : error ? (
        <div className="rounded-xl border border-dashed border-[var(--color-border)] py-10 text-center text-[12px] text-[var(--color-fg-muted)]">
          Couldn&apos;t load trades: {error}
        </div>
      ) : trades != null && trades.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--color-border)] py-10 text-center text-[12px] text-[var(--color-fg-muted)]">
          No scalper trades in the last {daysFilter} days.{" "}
          <Link href="/in/strategies" className="text-[var(--color-brand)] hover:underline">Enable strategies</Link>{" "}
          and run the worker to start paper trading.
        </div>
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl border border-[var(--color-border)]">
            <table className="w-full text-sm">
              <thead className="bg-[var(--color-bg-elevated)] text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)]">
                <tr className="border-b border-[var(--color-border)]/60">
                  <th className="w-5 pl-2 pr-0" />
                  <th className="p-2.5 text-left">Strategy</th>
                  <th className="p-2.5 text-left">Symbol</th>
                  <th className="p-2.5 text-left">Dir</th>
                  <th className="p-2.5 text-right">Entry</th>
                  <th className="p-2.5 text-right">SL</th>
                  <th className="p-2.5 text-right">Target</th>
                  <th className="p-2.5 text-right">Exit</th>
                  <th className="p-2.5 text-right">P&amp;L</th>
                  <th className="p-2.5 text-right">Opened</th>
                  <th className="p-2.5 text-right">Held</th>
                  <th className="p-2.5">Outcome</th>
                </tr>
              </thead>
              <tbody>
                <AnimatePresence>
                  {(trades ?? []).map((t, i) => <ScalperTradeRow key={t.id} trade={t} index={i} />)}
                </AnimatePresence>
              </tbody>
            </table>
          </div>
          <PaginationStrip page={page} totalPages={totalPages} filteredTotal={trades?.length ?? 0} pageSize={PAGE_SIZE}
            onPrev={() => setPage((p) => p - 1)} onNext={() => setPage((p) => p + 1)} onJump={setPage} />
        </>
      )}
    </div>
  );
}

// ─── ═══════════════════════════════════════════════════════════════════════ ─
//    FNO TREND SCANNER HISTORY SECTION
// ─ ═══════════════════════════════════════════════════════════════════════ ───

// FnoTrendScanRow dates come serialised from the API
type FnoTrendScanSerial = Omit<FnoTrendScanRow, "resolvedAt" | "scannedAt" | "updatedAt"> & {
  resolvedAt: string | null;
  scannedAt:  string;
  updatedAt:  string;
};
type FnoTrendHistoryDaySerial = Omit<FnoTrendHistoryDay, "scans"> & {
  scans: FnoTrendScanSerial[];
};

function FnoTrendAggregateBanner({ days }: { days: FnoTrendHistoryDaySerial[] }) {
  const all       = days.flatMap((d) => d.scans);
  const bullish   = all.filter((s) => s.scanType === "BULLISH").length;
  const bearish   = all.filter((s) => s.scanType === "BEARISH").length;
  const resolved  = all.filter((s) => s.status === "TARGET_HIT" || s.status === "STOP_HIT");
  const wins      = resolved.filter((s) => s.status === "TARGET_HIT").length;
  const wr        = resolved.length > 0 ? wins / resolved.length : null;
  const avgPnl    = (() => {
    const rp = all.filter((s) => s.pnlPct != null);
    return rp.length > 0 ? rp.reduce((s, r) => s + (r.pnlPct ?? 0), 0) / rp.length : null;
  })();
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {[
        { label: "Total signals",  value: String(all.length),       tone: "neutral" },
        { label: "Bullish",        value: String(bullish),           tone: "bull" },
        { label: "Bearish",        value: String(bearish),           tone: "bear" },
        { label: "Win rate",       value: wr != null ? `${(wr * 100).toFixed(0)}%` : "—",
          sub: resolved.length > 0 ? `${wins}W · ${resolved.length - wins}L of ${resolved.length}` : "No resolved",
          tone: wr != null ? (wr >= 0.5 ? "bull" : "bear") : "neutral" },
        { label: "Avg P&L",        value: avgPnl != null ? fmtPct(avgPnl) : "—",
          tone: avgPnl != null ? (avgPnl >= 0 ? "bull" : "bear") : "neutral" },
      ].map((s) => (
        <div key={s.label} className="flex flex-col gap-0.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
          <span className="text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)]">{s.label}</span>
          <span className={cn("text-xl font-semibold tabular-nums",
            s.tone === "bull" ? "text-emerald-600 dark:text-emerald-400"
            : s.tone === "bear" ? "text-rose-600 dark:text-rose-400"
            : "text-[var(--color-fg)]"
          )}>{s.value}</span>
          {(s as {sub?: string}).sub && <span className="text-[10px] text-[var(--color-fg-subtle)]">{(s as {sub?: string}).sub}</span>}
        </div>
      ))}
    </div>
  );
}

function FnoTrendScanRowComp({ scan, index }: { scan: FnoTrendScanSerial; index: number }) {
  const [open, setOpen] = React.useState(false);
  const isBull = scan.scanType === "BULLISH";
  const tvSym  = scan.symbol.replace(".NS", "");
  const scannedAt = new Date(scan.scannedAt);
  const resolvedAt = scan.resolvedAt ? new Date(scan.resolvedAt) : null;
  return (
    <>
      <motion.tr
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18, delay: Math.min(index * 0.02, 0.3) }}
        onClick={() => setOpen((v) => !v)}
        className={cn("cursor-pointer border-b border-[var(--color-border)]/40 select-none transition-colors",
          open ? "bg-[var(--color-bg-elevated)]" : "hover:bg-[var(--color-bg-elevated)]"
        )}
      >
        <td className="p-2.5 w-5 text-[var(--color-fg-subtle)]">
          <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} />
        </td>
        <td className="p-2.5">
          <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold",
            isBull ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                   : "bg-rose-500/15 text-rose-700 dark:text-rose-400"
          )}>
            {isBull ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
            {scan.scanType}
          </span>
        </td>
        <td className="p-2.5">
          <span className="text-sm font-semibold text-[var(--color-brand)]">{tvSym}</span>
        </td>
        <td className={cn("p-2.5 text-right tabular text-sm font-semibold",
          scan.changePct >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"
        )}>{fmtPct(scan.changePct)}</td>
        <td className="p-2.5 text-right tabular text-sm">₹{fmt(scan.entry)}</td>
        <td className={cn("p-2.5 text-right tabular text-sm",
          isBull ? "text-rose-600 dark:text-rose-400" : "text-emerald-600 dark:text-emerald-400"
        )}>₹{fmt(scan.stopLoss)}</td>
        <td className={cn("p-2.5 text-right tabular text-sm",
          isBull ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"
        )}>₹{fmt(scan.tp1)}</td>
        <td className={cn("p-2.5 text-right tabular text-sm font-semibold",
          scan.pnlPct == null ? "text-[var(--color-fg-muted)]"
          : scan.pnlPct >= 0  ? "text-emerald-600 dark:text-emerald-400"
          :                      "text-rose-600 dark:text-rose-400"
        )}>{scan.pnlPct == null ? "—" : fmtPct(scan.pnlPct)}</td>
        <td className="p-2.5 text-right tabular text-[11px] text-[var(--color-fg-muted)]">
          {scannedAt.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" })}
        </td>
        <td className="p-2.5 text-right tabular text-[11px] text-[var(--color-fg-muted)]">
          {resolvedAt ? fmtDuration(resolvedAt.getTime() - scannedAt.getTime()) : "—"}
        </td>
        <td className="p-2.5"><OutcomeTag status={scan.status} /></td>
      </motion.tr>
      <AnimatePresence>
        {open && (
          <motion.tr initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
            <td colSpan={11} className="border-b border-[var(--color-border)]/50 bg-[var(--color-bg-elevated)] px-4 pb-3 pt-2">
              <div className="flex flex-wrap gap-4 text-[11px]">
                <div className="flex flex-wrap gap-x-5 gap-y-1">
                  {[
                    { l: "Entry",    v: `₹${fmt(scan.entry)}`,    c: "text-[var(--color-fg)]" },
                    { l: "SL",       v: `₹${fmt(scan.stopLoss)}`, c: isBull ? "text-rose-600 dark:text-rose-400" : "text-emerald-600 dark:text-emerald-400" },
                    { l: "TP1",      v: `₹${fmt(scan.tp1)}`,      c: isBull ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400" },
                    { l: "TP2",      v: `₹${fmt(scan.tp2)}`,      c: isBull ? "text-emerald-500" : "text-rose-500" },
                    { l: "TP3",      v: `₹${fmt(scan.tp3)}`,      c: isBull ? "text-emerald-400" : "text-rose-400" },
                    { l: "ATR(14)", v: `₹${fmt(scan.atr)}`,      c: "text-[var(--color-fg-muted)]" },
                    { l: "ADX",      v: scan.adxVal.toFixed(1),   c: "text-[var(--color-fg-muted)]" },
                    { l: "RSI",      v: scan.rsiVal.toFixed(0),   c: "text-[var(--color-fg-muted)]" },
                  ].map((f) => (
                    <div key={f.l} className="flex flex-col gap-0.5">
                      <span className="text-[10px] uppercase tracking-wide text-[var(--color-fg-subtle)]">{f.l}</span>
                      <span className={cn("font-semibold tabular-nums", f.c)}>{f.v}</span>
                    </div>
                  ))}
                </div>
                <div className="flex gap-2">
                  <a href={`https://in.tradingview.com/chart/CR5K0NSR/?symbol=NSE%3A${tvSym}`} target="_blank" rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1 text-[11px] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]">
                    <ExternalLink className="h-3 w-3" /> TradingView
                  </a>
                  <Link href={`/in/chart/${encodeURIComponent(scan.symbol)}`} onClick={(e) => e.stopPropagation()}
                    className="inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1 text-[11px] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]">
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

function FnoTrendDayAccordion({ day, scanTypeFilter, dirFilter }: {
  day: FnoTrendHistoryDaySerial;
  scanTypeFilter: "ALL" | "BULLISH" | "BEARISH";
  dirFilter: DirFilter;
}) {
  const [open, setOpen] = React.useState(false);
  const scans = day.scans.filter((s) => {
    if (scanTypeFilter !== "ALL" && s.scanType !== scanTypeFilter) return false;
    if (dirFilter === "long"  && s.scanType !== "BULLISH") return false;
    if (dirFilter === "short" && s.scanType !== "BEARISH") return false;
    return true;
  });
  const { pageItems, page, setPage, totalPages, filteredTotal, pageSize } =
    usePaginationFilter({ items: scans, pageSize: 15 });
  return (
    <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
      <button type="button" onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left" aria-expanded={open}>
        <span className="flex items-center gap-2">
          <History className="h-4 w-4 text-[var(--color-fg-subtle)]" />
          <span className="text-sm font-semibold text-[var(--color-fg)]">{day.tradeDate}</span>
          <span className="text-[11px] text-[var(--color-fg-muted)]">· {scans.length} signal{scans.length !== 1 ? "s" : ""}</span>
        </span>
        <span className="flex items-center gap-3 text-[11px] text-[var(--color-fg-muted)]">
          <span className="text-emerald-600 dark:text-emerald-400">{day.summary.targetHit} hit</span>
          <span className="text-rose-600 dark:text-rose-400">{day.summary.stopHit} stop</span>
          {day.summary.closed > 0 && <span>{day.summary.closed} squared</span>}
          {day.summary.open > 0 && <span className="text-amber-600 dark:text-amber-400">{day.summary.open} open</span>}
          <span className={cn("font-semibold",
            day.summary.winRate >= 0.5 ? "text-emerald-600 dark:text-emerald-400"
            : day.summary.winRate > 0  ? "text-rose-600 dark:text-rose-400"
            : "text-[var(--color-fg-muted)]"
          )}>{(day.summary.winRate * 100).toFixed(0)}% win</span>
          <ChevronDown className={cn("h-4 w-4 text-[var(--color-fg-subtle)] transition-transform", open && "rotate-180")} />
        </span>
      </button>
      <AnimatePresence>
        {open && scans.length > 0 && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }}
            className="overflow-hidden border-t border-[var(--color-border)]">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-[var(--color-bg-elevated)] text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)]">
                  <tr className="border-b border-[var(--color-border)]/60">
                    <th className="w-5 pl-2 pr-0" />
                    <th className="p-2.5 text-left">Type</th>
                    <th className="p-2.5 text-left">Symbol</th>
                    <th className="p-2.5 text-right">Chg%</th>
                    <th className="p-2.5 text-right">Entry</th>
                    <th className="p-2.5 text-right">SL</th>
                    <th className="p-2.5 text-right">TP1</th>
                    <th className="p-2.5 text-right">P&amp;L</th>
                    <th className="p-2.5 text-right">Scanned</th>
                    <th className="p-2.5 text-right">Held</th>
                    <th className="p-2.5">Outcome</th>
                  </tr>
                </thead>
                <tbody>
                  <AnimatePresence>
                    {pageItems.map((scan, i) => <FnoTrendScanRowComp key={scan.id} scan={scan} index={i} />)}
                  </AnimatePresence>
                </tbody>
              </table>
            </div>
            <div className="px-4 pb-3 pt-1">
              <PaginationStrip page={page} totalPages={totalPages} filteredTotal={filteredTotal} pageSize={pageSize}
                onPrev={() => setPage(page - 1)} onNext={() => setPage(page + 1)} onJump={setPage} />
            </div>
          </motion.div>
        )}
        {open && scans.length === 0 && (
          <div className="border-t border-[var(--color-border)] px-4 py-6 text-center text-[12px] text-[var(--color-fg-muted)]">
            No signals match the current filters for this day.
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}

function FnoTrendSection({ daysFilter, dirFilter }: { daysFilter: DaysFilter; dirFilter: DirFilter }) {
  const [data,       setData]       = React.useState<{ days: FnoTrendHistoryDaySerial[] } | null>(null);
  const [loading,    setLoading]    = React.useState(true);
  const [error,      setError]      = React.useState<string | null>(null);
  const [scanFilter, setScanFilter] = React.useState<"ALL" | "BULLISH" | "BEARISH">("ALL");

  const load = React.useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/in/fno-trend-history?days=${daysFilter}`, { cache: "no-store", signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json() as { days: FnoTrendHistoryDaySerial[] });
      setError(null);
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setError((err as Error).message);
    } finally { setLoading(false); }
  }, [daysFilter]);

  React.useEffect(() => {
    const ac = new AbortController();
    void load(ac.signal);
    return () => ac.abort();
  }, [load]);

  const days = data?.days ?? [];
  const { pageItems: dayPage, page, setPage, totalPages, filteredTotal, pageSize } =
    usePaginationFilter({ items: days, pageSize: 7 });

  return (
    <div className="flex flex-col gap-4">
      {/* Scan type sub-filter */}
      <div className="flex items-center gap-1">
        {(["ALL", "BULLISH", "BEARISH"] as const).map((f) => (
          <button key={f} onClick={() => setScanFilter(f)}
            className={cn("inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors",
              scanFilter === f
                ? "bg-[var(--color-surface-hover)] text-[var(--color-fg)] ring-1 ring-inset ring-[var(--color-border-strong)]"
                : "text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
            )}>
            {f === "BULLISH" ? <TrendingUp className="h-3 w-3 text-emerald-500" /> : null}
            {f === "BEARISH" ? <TrendingDown className="h-3 w-3 text-rose-500" /> : null}
            {f === "ALL" ? "All" : f.charAt(0) + f.slice(1).toLowerCase()}
          </button>
        ))}
        <button onClick={() => void load()} disabled={loading}
          className={cn("ml-auto inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-2.5 py-1 text-[11px] text-[var(--color-fg-muted)] transition-colors hover:text-[var(--color-fg)]", loading && "opacity-60")}>
          <RefreshCw className={cn("h-3 w-3", loading && "animate-spin")} />Refresh
        </button>
      </div>

      {days.length > 0 && <FnoTrendAggregateBanner days={days} />}

      {loading && days.length === 0 ? (
        <div className="flex items-center justify-center py-12 text-[12px] text-[var(--color-fg-muted)]">
          <RefreshCw className="mr-2 h-4 w-4 animate-spin" />Loading FnO Trend history…
        </div>
      ) : error ? (
        <div className="rounded-xl border border-dashed border-[var(--color-border)] py-10 text-center text-[12px] text-[var(--color-fg-muted)]">
          Couldn&apos;t load history: {error}
        </div>
      ) : days.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--color-border)] py-10 text-center text-[12px] text-[var(--color-fg-muted)]">
          <p>No FnO Trend Scanner history yet.</p>
          <p className="mt-1">History starts accruing automatically when the{" "}
            <Link href="/in/daily-picks" className="text-[var(--color-brand)] hover:underline">Daily Picks</Link>{" "}
            page is visited during market hours (09:15–15:30 IST).
          </p>
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-2">
            {dayPage.map((day) => (
              <FnoTrendDayAccordion key={day.tradeDate} day={day} scanTypeFilter={scanFilter} dirFilter={dirFilter} />
            ))}
          </div>
          <PaginationStrip page={page} totalPages={totalPages} filteredTotal={filteredTotal} pageSize={pageSize}
            onPrev={() => setPage(page - 1)} onNext={() => setPage(page + 1)} onJump={setPage} />
        </>
      )}
    </div>
  );
}

// ─── ═══════════════════════════════════════════════════════════════════════ ─
//    MAIN PAGE
// ─ ═══════════════════════════════════════════════════════════════════════ ───

export default function TradeHistoryPage() {
  const [days,          setDays]          = React.useState<DailyPicksHistoryDay[] | null>(null);
  const [loadingPicks,  setLoadingPicks]  = React.useState(true);
  const [errorPicks,    setErrorPicks]    = React.useState<string | null>(null);
  const [refreshing,    setRefreshing]    = React.useState(false);

  const [activeTab,     setActiveTab]     = React.useState<SourceTab>("picks");
  const [daysFilter,    setDaysFilter]    = React.useState<DaysFilter>(30);
  const [statusFilter,  setStatusFilter]  = React.useState<StatusFilter>("all");
  const [dirFilter,     setDirFilter]     = React.useState<DirFilter>("all");

  const loadPicks = React.useCallback(async (signal?: AbortSignal) => {
    setRefreshing(true);
    try {
      const res = await fetch(`/api/in/daily-picks/history?days=${daysFilter}`, { cache: "no-store", signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as { days: DailyPicksHistoryDay[] };
      setDays(json.days);
      setErrorPicks(null);
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setErrorPicks((err as Error).message);
    } finally { setLoadingPicks(false); setRefreshing(false); }
  }, [daysFilter]);

  React.useEffect(() => {
    const ac = new AbortController();
    void loadPicks(ac.signal);
    return () => ac.abort();
  }, [loadPicks]);

  const filteredDays = days ?? [];
  const { pageItems: dayPage, page, setPage, totalPages, filteredTotal, pageSize } =
    usePaginationFilter({ items: filteredDays, pageSize: 7 });

  const TABS: { id: SourceTab; label: string; icon: typeof Trophy }[] = [
    { id: "picks",     label: "Daily Picks",        icon: Trophy      },
    { id: "scalper",   label: "Scalper Trades",      icon: Zap         },
    { id: "fno-trend", label: "FnO Trend Scanner",   icon: ScanSearch  },
  ];

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6">
      {/* Header */}
      <header className="flex items-center gap-3">
        <div className="grid h-9 w-9 place-items-center rounded-lg bg-gradient-to-br from-[var(--color-brand)]/20 to-[var(--color-info)]/15">
          <History className="h-5 w-5 text-[var(--color-brand)]" />
        </div>
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Trade History</h1>
          <p className="text-sm text-[var(--color-fg-muted)]">
            Frozen picks &amp; paper trades with final outcomes across all tracked sources.
          </p>
        </div>
      </header>

      {/* Source tabs */}
      <div className="flex items-center gap-1 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-1">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button key={id} onClick={() => setActiveTab(id)}
            className={cn("flex flex-1 items-center justify-center gap-2 rounded-lg py-2 text-[12px] font-medium transition-colors",
              activeTab === id
                ? "bg-[var(--color-bg-elevated)] text-[var(--color-fg)] shadow-sm"
                : "text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
            )}>
            <Icon className="h-3.5 w-3.5" /> {label}
          </button>
        ))}
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          {/* Days range */}
          <div className="flex items-center gap-1">
            {([7, 14, 30, 60] as DaysFilter[]).map((d) => (
              <button key={d} onClick={() => setDaysFilter(d)}
                className={cn("rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors",
                  daysFilter === d
                    ? "bg-[var(--color-surface-hover)] text-[var(--color-fg)] ring-1 ring-inset ring-[var(--color-border-strong)]"
                    : "text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
                )}>{d}d</button>
            ))}
          </div>
          <span className="h-4 w-px bg-[var(--color-border)]" />
          {/* Outcome filter — only for picks tab */}
          {activeTab === "picks" && (["all", "target", "stop", "closed"] as StatusFilter[]).map((f) => (
            <button key={f} onClick={() => setStatusFilter(f)}
              className={cn("rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors",
                statusFilter === f
                  ? "bg-[var(--color-surface-hover)] text-[var(--color-fg)] ring-1 ring-inset ring-[var(--color-border-strong)]"
                  : "text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
              )}>
              {f === "all" ? "All outcomes" : f === "target" ? "🎯 Target hit" : f === "stop" ? "🛑 Stopped" : "🔒 Squared off"}
            </button>
          ))}
          <span className="h-4 w-px bg-[var(--color-border)]" />
          {/* Direction */}
          {(["all", "long", "short"] as DirFilter[]).map((f) => (
            <button key={f} onClick={() => setDirFilter(f)}
              className={cn("inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors",
                dirFilter === f
                  ? "bg-[var(--color-surface-hover)] text-[var(--color-fg)] ring-1 ring-inset ring-[var(--color-border-strong)]"
                  : "text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
              )}>
              {f === "long"  ? <TrendingUp   className="h-3 w-3" /> : null}
              {f === "short" ? <TrendingDown className="h-3 w-3" /> : null}
              {f === "all" ? "All" : f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 text-[11px] text-[var(--color-fg-subtle)]">
          {activeTab === "picks" && days != null && <span>{filteredDays.length} day{filteredDays.length !== 1 ? "s" : ""}</span>}
          {activeTab === "picks" && (
            <button type="button" onClick={() => void loadPicks()} disabled={refreshing}
              className={cn("inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-2.5 py-1 text-[11px] text-[var(--color-fg-muted)] transition-colors hover:text-[var(--color-fg)]", refreshing && "opacity-60")}>
              <RefreshCw className={cn("h-3 w-3", refreshing && "animate-spin")} />Refresh
            </button>
          )}
          <Link href="/in/paper-trading" className="inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-2.5 py-1 text-[11px] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]">
            <Activity className="h-3 w-3" /> Paper Trading
          </Link>
        </div>
      </div>

      {/* ── Tab: Daily Picks ── */}
      {activeTab === "picks" && (
        <>
          {days != null && days.length > 0 && <AggregateBanner days={days} />}
          {days != null && days.length > 0 && <BucketHeatStrip days={days} />}
          {loadingPicks && days == null ? (
            <div className="flex items-center justify-center py-16 text-[12px] text-[var(--color-fg-muted)]">
              <RefreshCw className="mr-2 h-4 w-4 animate-spin" />Loading history…
            </div>
          ) : errorPicks ? (
            <div className="rounded-xl border border-dashed border-[var(--color-border)] py-12 text-center text-[12px] text-[var(--color-fg-muted)]">
              Couldn&apos;t load history: {errorPicks}
            </div>
          ) : days != null && days.length === 0 ? (
            <div className="rounded-xl border border-dashed border-[var(--color-border)] py-12 text-center text-[12px] text-[var(--color-fg-muted)]">
              No past picks yet — history starts accruing from the first frozen trading day.
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-2">
                {dayPage.map((day) => (
                  <DayAccordion key={day.tradeDate} day={day} statusFilter={statusFilter} dirFilter={dirFilter} />
                ))}
              </div>
              <PaginationStrip page={page} totalPages={totalPages} filteredTotal={filteredTotal} pageSize={pageSize}
                onPrev={() => setPage(page - 1)} onNext={() => setPage(page + 1)} onJump={setPage} />
            </>
          )}
        </>
      )}

      {/* ── Tab: Scalper Trades ── */}
      {activeTab === "scalper" && (
        <ScalperSection daysFilter={daysFilter} dirFilter={dirFilter} />
      )}

      {/* ── Tab: FnO Trend Scanner ── */}
      {activeTab === "fno-trend" && (
        <FnoTrendSection daysFilter={daysFilter} dirFilter={dirFilter} />
      )}
    </div>
  );
}
