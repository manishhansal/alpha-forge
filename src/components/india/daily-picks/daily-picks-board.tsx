"use client";

import * as React from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Clock,
  ExternalLink,
  Flame,
  Gauge,
  LineChart,
  RefreshCw,
  Rocket,
  ShieldAlert,
  Sparkles,
  Sunrise,
  Target,
  TrendingDown,
  Zap,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

import { cn } from "@/lib/utils";
import { fmt, fmtIstClock, fmtIstTime, fmtDuration, fmtPct } from "@/lib/india/format";
import {
  PaginationStrip,
  usePaginationFilter,
} from "@/components/india/ui/pagination-filter";
import type {
  DailyPick,
  DailyPickBucket,
  DailyPickGroup,
  DailyPickStatus,
} from "@/features/india/daily-picks/engine";
import type { DailyPicksResponse } from "@/features/india/daily-picks/builder";
import { MarketContextPanel } from "./market-context-panel";

interface Props {
  initialData: DailyPicksResponse;
  endpoint?: string;
  intervalMs?: number;
}

const BUCKET_ICON: Record<DailyPickBucket, typeof Flame> = {
  INDICES_SCALP:    LineChart,
  OPENING_BREAKOUT: Sunrise,
  MOMENTUM:         Flame,
  SHORT_MOMENTUM:   TrendingDown,
  SCALPING:         Zap,
  POTENTIAL:        Sparkles,
};

const STATUS_CLASS: Record<DailyPickStatus, string> = {
  OPEN:       "bg-[var(--color-surface-hover)] text-[var(--color-fg-muted)]",
  TARGET_HIT: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  STOP_HIT:   "bg-rose-500/15 text-rose-600 dark:text-rose-400",
  CLOSED:     "bg-[var(--color-surface-hover)] text-[var(--color-fg-muted)]",
  EXPIRED:    "bg-amber-500/15 text-amber-600 dark:text-amber-400",
};

const STATUS_LABEL: Record<DailyPickStatus, string> = {
  OPEN:       "Live",
  TARGET_HIT: "Target",
  STOP_HIT:   "Stopped",
  CLOSED:     "Closed",
  EXPIRED:    "Expired",
};

// ─── Expanded detail panel ────────────────────────────────────────────────────

function PickDetail({ pick, colSpan }: { pick: DailyPick; colSpan: number }) {
  const isBull     = pick.direction !== "BEARISH";
  const isOption   = pick.optionContract != null;
  const stopTone   = isOption ? "bear" : isBull ? "bear" : "bull";
  const targetTone = isOption ? "bull" : isBull ? "bull" : "bear";

  const appearedAt = fmtIstTime(pick.generatedAt);
  const elapsedMs  = (pick.resolvedAt ?? Date.now()) - pick.generatedAt;
  const elapsed    = fmtDuration(elapsedMs);

  const progressWidth = Math.max(0, Math.min(100, pick.achievedPct ?? 0));
  const pnl           = pick.pnlPct;
  const achieved      = pick.achievedPct;

  const OUTCOME_VERB: Record<DailyPickStatus, string> = {
    OPEN:       "Live for",
    TARGET_HIT: "Target hit in",
    STOP_HIT:   "Stopped in",
    CLOSED:     "Squared off in",
    EXPIRED:    "Expired after",
  };

  return (
    <motion.tr
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
    >
      <td
        colSpan={colSpan}
        className="border-b border-[var(--color-border)]/50 bg-[var(--color-bg-elevated)] px-4 pb-4 pt-2"
      >
        <div className="flex flex-col gap-3">
          {/* Setup type + subtitle */}
          {pick.setupType && (
            <p className="text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)]">
              <span className="text-[var(--color-fg-muted)]">Setup · </span>
              <span className="font-medium normal-case tracking-normal text-[var(--color-fg)]">{pick.setupType}</span>
            </p>
          )}

          {/* Confluence + time window */}
          {(pick.confluenceScore > 0 || pick.timeWindow) && (
            <div className="flex flex-wrap items-center gap-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[12px]">
              <div className="flex flex-col gap-0.5">
                <span className="text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)]">Confluence</span>
                <span className={cn("text-sm font-semibold",
                  pick.confluenceScore >= 8 ? "text-emerald-600 dark:text-emerald-400"
                  : pick.confluenceScore <= 4 ? "text-rose-600 dark:text-rose-400"
                  : "text-[var(--color-fg)]"
                )}>
                  {pick.confluenceScore}<span className="text-[var(--color-fg-subtle)]">/10</span>
                </span>
              </div>
              {pick.timeWindow && (
                <div className="flex flex-col gap-0.5">
                  <span className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)]">
                    <Clock className="h-3 w-3" /> Time window
                  </span>
                  <span className="font-medium text-[var(--color-fg-muted)]">
                    {pick.timeWindow.start}–{pick.timeWindow.end} IST
                  </span>
                  <span className="text-[10px] text-[var(--color-fg-subtle)]">{pick.timeWindow.label}</span>
                </div>
              )}
              <div className="flex flex-col gap-0.5">
                <span className="text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)]">Appeared</span>
                <span className="font-medium text-[var(--color-fg-muted)]">{appearedAt} IST</span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)]">{OUTCOME_VERB[pick.status]}</span>
                <span className="font-medium text-[var(--color-fg-muted)]">{elapsed}</span>
              </div>
            </div>
          )}

          {/* Warnings */}
          {pick.warnings && pick.warnings.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {pick.warnings.map((w) => (
                <span
                  key={w.kind}
                  title={w.note}
                  className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold",
                    w.severity === "danger"  ? "bg-rose-500/15 text-rose-600 dark:text-rose-400"
                    : w.severity === "warn"  ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                    : "bg-[var(--color-surface-hover)] text-[var(--color-fg-muted)]"
                  )}
                >
                  <AlertTriangle className="h-3 w-3" />
                  {w.label}
                </span>
              ))}
            </div>
          )}

          {/* Progress */}
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)]">
              <span>Achieved till now</span>
              <span className="text-[var(--color-fg-muted)] tabular-nums">
                {achieved == null ? "—" : `${achieved.toFixed(0)}% of target`}
              </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-surface)]">
              <div
                className={cn("h-full rounded-full transition-all",
                  pick.status === "STOP_HIT" ? "bg-rose-500" : "bg-emerald-500"
                )}
                style={{ width: `${progressWidth}%` }}
              />
            </div>
          </div>

          {/* Levels grid */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <DetailCell label="Entry"         value={`₹${fmt(pick.entry)}`}          icon={<Sparkles className="h-3 w-3" />} />
            <DetailCell label="Stop Loss"     value={`₹${fmt(pick.stopLoss)}`}       icon={<ShieldAlert className="h-3 w-3" />}
              sub={fmtPct(((pick.stopLoss - pick.entry) / pick.entry) * 100)} subTone={stopTone} />
            <DetailCell label="Target"        value={`₹${fmt(pick.target)}`}         icon={<Target className="h-3 w-3" />}
              sub={fmtPct(((pick.target - pick.entry) / pick.entry) * 100)}   subTone={targetTone} />
            <DetailCell label="Can Move Upto" value={`₹${fmt(pick.canMoveUpto)}`}    icon={<Rocket className="h-3 w-3" />}
              sub={fmtPct(((pick.canMoveUpto - pick.entry) / pick.entry) * 100)} subTone={targetTone} />
            <DetailCell label="Can Expect"    value={`${isBull ? "+" : "-"}${fmt(pick.canExpectPct)}%`}
              sub={`RR ${pick.riskReward.toFixed(1)}:1`} />
            <DetailCell label="Win Prob"      value={`${Math.round(pick.winProbability * 100)}%`} />
          </div>

          {/* Option contract */}
          {pick.optionContract && (
            <p className="text-[11px] text-[var(--color-fg-muted)]">
              <span className="font-semibold text-[var(--color-fg)]">Option: </span>
              {pick.optionContract.side} {pick.optionContract.strike} · Lot {pick.optionContract.lotSize} · {pick.optionContract.expiry}
            </p>
          )}

          {/* Key indicators */}
          {pick.keyIndicators && pick.keyIndicators.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              <span className="text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)]">Key Indicators</span>
              {pick.keyIndicators.map((k) => (
                <span key={k} className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-fg-muted)]">
                  {k}
                </span>
              ))}
            </div>
          )}

          {/* Logic */}
          {pick.logic && (
            <p className="rounded-lg border border-dashed border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[11px] leading-relaxed text-[var(--color-fg-muted)]">
              <span className="font-semibold text-[var(--color-fg)]">Why here: </span>{pick.logic}
            </p>
          )}

          {/* Research note */}
          {pick.researchNote && (
            <div className="flex gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
              <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-brand)]" />
              <div className="flex flex-col gap-0.5">
                <span className="text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)]">Research Note</span>
                <p className="text-[11px] leading-relaxed text-[var(--color-fg-muted)]">{pick.researchNote}</p>
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="flex flex-wrap gap-2 pt-1">
            <a
              href={`https://in.tradingview.com/chart/CR5K0NSR/?symbol=NSE%3A${pick.symbol.replace(".NS", "")}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1 text-[11px] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
            >
              <ExternalLink className="h-3 w-3" /> TradingView
            </a>
            <a
              href={`/in/chart/${encodeURIComponent(pick.symbol)}`}
              className="inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1 text-[11px] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
            >
              Chart
            </a>
          </div>
        </div>
      </td>
    </motion.tr>
  );
}

function DetailCell({ label, value, sub, subTone, icon }: {
  label: string; value: string; sub?: string;
  subTone?: "bull" | "bear"; icon?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
      <span className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)]">
        {icon}{label}
      </span>
      <span className="text-sm font-semibold tabular-nums text-[var(--color-fg)]">{value}</span>
      {sub && (
        <span className={cn("text-[10px] tabular-nums",
          subTone === "bull" ? "text-emerald-600 dark:text-emerald-400"
          : subTone === "bear" ? "text-rose-600 dark:text-rose-400"
          : "text-[var(--color-fg-muted)]"
        )}>{sub}</span>
      )}
    </div>
  );
}

// ─── Single pick row ──────────────────────────────────────────────────────────

// chevron + symbol + direction + grade + status + P&L + conf + winprob + rr = 9
const COL_SPAN = 9;

function PickRow({
  pick,
  index,
  expanded,
  onToggle,
}: {
  pick: DailyPick;
  index: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const isBull = pick.direction !== "BEARISH";
  const pnl    = pick.pnlPct;

  return (
    <>
      <motion.tr
        initial={{ opacity: 0, y: 5 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.18, delay: Math.min(index * 0.03, 0.35) }}
        onClick={onToggle}
        className={cn(
          "cursor-pointer border-b border-[var(--color-border)]/40 select-none transition-colors",
          expanded ? "bg-[var(--color-bg-elevated)]" : "hover:bg-[var(--color-bg-elevated)]",
        )}
      >
        {/* Expand chevron */}
        <td className="w-6 pl-2 pr-0 text-[var(--color-fg-subtle)]">
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </td>

        {/* Rank + symbol */}
        <td className="p-2.5">
          <div className="flex items-center gap-2">
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[var(--color-bg-elevated)] text-[10px] font-bold text-[var(--color-fg)] ring-1 ring-inset ring-[var(--color-border)]">
              {pick.rank}
            </span>
            <div className="flex flex-col min-w-0">
              <span className="text-sm font-semibold text-[var(--color-brand)]">
                {pick.symbol.replace(".NS", "")}
              </span>
              <span className="text-[10px] text-[var(--color-fg-subtle)] truncate max-w-[130px]">
                {pick.displayName}
              </span>
            </div>
          </div>
        </td>

        {/* Direction */}
        <td className="p-2.5">
          <span className={cn("text-[11px] font-bold uppercase",
            isBull ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"
          )}>
            {isBull ? "LONG" : "SHORT"}
          </span>
        </td>

        {/* Grade */}
        <td className="p-2.5">
          <span className={cn("inline-grid h-5 w-5 place-items-center rounded-full text-[10px] font-bold",
            pick.grade === "S" ? "bg-[color-mix(in_oklch,var(--color-brand)_20%,transparent)] text-[var(--color-brand)]"
            : pick.grade === "A" ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
            : pick.grade === "B" ? "bg-blue-500/15 text-blue-600 dark:text-blue-400"
            : pick.grade === "C" ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
            : "bg-muted text-muted-foreground"
          )}>
            {pick.grade}
          </span>
        </td>

        {/* Status */}
        <td className="p-2.5">
          <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-semibold", STATUS_CLASS[pick.status])}>
            {STATUS_LABEL[pick.status]}
          </span>
        </td>

        {/* P&L */}
        <td className={cn("p-2.5 text-right tabular text-sm font-semibold",
          pnl == null ? "text-[var(--color-fg-muted)]"
          : pnl >= 0  ? "text-emerald-600 dark:text-emerald-400"
          :              "text-rose-600 dark:text-rose-400"
        )}>
          {pnl == null ? "—" : fmtPct(pnl)}
        </td>

        {/* Conf */}
        <td className="p-2.5 text-right tabular text-sm text-[var(--color-fg)]">
          {pick.confidenceScore}
        </td>

        {/* Win Prob */}
        <td className={cn("p-2.5 text-right tabular text-sm font-medium",
          isBull ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"
        )}>
          {Math.round(pick.winProbability * 100)}%
        </td>

        {/* R:R */}
        <td className="p-2.5 text-right tabular text-[11px] text-[var(--color-fg-muted)]">
          {pick.riskReward.toFixed(1)}:1
        </td>
      </motion.tr>

      <AnimatePresence>
        {expanded && (
          <PickDetail key={`${pick.bucket}-${pick.rank}-detail`} pick={pick} colSpan={COL_SPAN} />
        )}
      </AnimatePresence>
    </>
  );
}

// ─── Bucket section ───────────────────────────────────────────────────────────

function DailyPicksBucketSection({ group }: { group: DailyPickGroup }) {
  const Icon = BUCKET_ICON[group.bucket];
  const [expandedKey, setExpandedKey] = React.useState<string | null>(null);

  const { pageItems, page, setPage, totalPages, filteredTotal, pageSize } =
    usePaginationFilter({ items: group.picks, pageSize: 10 });

  // Collapse expanded row when page changes.
  React.useEffect(() => { setExpandedKey(null); }, [page]);

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="grid h-7 w-7 place-items-center rounded-lg bg-[var(--color-bg-elevated)] text-[var(--color-brand)] ring-1 ring-inset ring-[var(--color-border)]">
          <Icon className="h-4 w-4" />
        </span>
        <div className="flex flex-col">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-[var(--color-fg)]">{group.label}</h2>
            <span className="rounded-full bg-[color-mix(in_oklch,var(--color-bull)_12%,transparent)] px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-[var(--color-bull)] ring-1 ring-inset ring-[color-mix(in_oklch,var(--color-bull)_25%,transparent)]">
              Intraday
            </span>
          </div>
          <p className="text-[11px] text-[var(--color-fg-subtle)]">{group.description}</p>
        </div>
      </div>

      {group.picks.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--color-bg-elevated)] py-8 text-center text-[12px] text-[var(--color-fg-muted)]">
          No qualifying setups right now — check back next refresh.
        </div>
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl border border-[var(--color-border)]">
            <table className="w-full text-sm">
              <thead className="bg-[var(--color-bg-elevated)] text-[11px] uppercase tracking-wide text-[var(--color-fg-muted)]">
                <tr className="border-b border-[var(--color-border)]/60">
                  <th className="w-6 pl-2 pr-0" />
                  <th className="p-2.5 text-left font-medium">Symbol</th>
                  <th className="p-2.5 text-left font-medium">Dir</th>
                  <th className="p-2.5 text-left font-medium">Grade</th>
                  <th className="p-2.5 text-left font-medium">Status</th>
                  <th className="p-2.5 text-right font-medium">P&amp;L</th>
                  <th className="p-2.5 text-right font-medium">Conf</th>
                  <th className="p-2.5 text-right font-medium">Win%</th>
                  <th className="p-2.5 text-right font-medium">R:R</th>
                </tr>
              </thead>
              <tbody>
                <AnimatePresence>
                  {pageItems.map((pick, i) => {
                    const rowKey = `${pick.bucket}-${pick.rank}`;
                    return (
                      <PickRow
                        key={rowKey}
                        pick={pick}
                        index={i}
                        expanded={expandedKey === rowKey}
                        onToggle={() =>
                          setExpandedKey((prev) => prev === rowKey ? null : rowKey)
                        }
                      />
                    );
                  })}
                </AnimatePresence>
              </tbody>
            </table>
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
    </section>
  );
}

// ─── Board ────────────────────────────────────────────────────────────────────

export function DailyPicksBoard({
  initialData,
  endpoint  = "/api/in/daily-picks",
  intervalMs = 60_000,
}: Props) {
  const [data, setData]         = React.useState<DailyPicksResponse>(initialData);
  const [refreshing, setRefreshing] = React.useState(false);
  const [error, setError]       = React.useState<string | null>(null);

  const refresh = React.useCallback(async (sig?: AbortSignal) => {
    setRefreshing(true);
    try {
      const res = await fetch(endpoint, { cache: "no-store", signal: sig });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json() as DailyPicksResponse);
      setError(null);
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setError((err as Error).message);
    } finally { setRefreshing(false); }
  }, [endpoint]);

  React.useEffect(() => {
    const ac = new AbortController();
    const id = setInterval(() => void refresh(ac.signal), intervalMs);
    return () => { ac.abort(); clearInterval(id); };
  }, [intervalMs, refresh]);

  const generatedLabel = fmtIstClock(data.generatedAt);

  return (
    <div className="flex flex-col gap-5">
      {data.marketContextHeader ? (
        <MarketContextPanel header={data.marketContextHeader} />
      ) : null}

      {/* Context banner */}
      <div className="flex flex-col gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Gauge className="h-4 w-4 text-[var(--color-brand)]" />
            <span className="text-sm font-semibold text-[var(--color-fg)]">
              {data.context.headline}
            </span>
          </div>
          <span className={cn(
            "rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ring-1 ring-inset",
            data.inActiveWindow
              ? "bg-[color-mix(in_oklch,var(--color-bull)_12%,transparent)] text-[var(--color-bull)] ring-[color-mix(in_oklch,var(--color-bull)_30%,transparent)]"
              : "bg-[color-mix(in_oklch,var(--color-warning)_12%,transparent)] text-[var(--color-warning)] ring-[color-mix(in_oklch,var(--color-warning)_30%,transparent)]",
          )}>
            {data.inActiveWindow ? "Market live" : "Market closed — plan"}
          </span>
        </div>
        {data.context.bullets.length > 0 && (
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[var(--color-fg-muted)]">
            {data.context.bullets.map((b) => (
              <li key={b} className="flex items-center gap-1.5">
                <span className="h-1 w-1 rounded-full bg-[var(--color-fg-subtle)]" />
                {b}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-[var(--color-fg-subtle)]">
        <span>
          Picks for{" "}
          <span className="font-semibold text-[var(--color-fg-muted)]">{data.tradeDate}</span>{" "}
          · {data.persisted ? "frozen & tracked live" : "live (not persisted)"} ·
          refreshed {generatedLabel}
          {error ? <span className="ml-2 text-[var(--color-bear)]">· {error}</span> : null}
        </span>
        <button
          onClick={() => void refresh()}
          disabled={refreshing}
          className={cn(
            "inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-2 py-1 text-[11px] text-[var(--color-fg-muted)] transition-colors hover:text-[var(--color-fg)]",
            refreshing && "opacity-60",
          )}
        >
          <RefreshCw className={cn("h-3 w-3", refreshing && "animate-spin")} />
          Refresh
        </button>
      </div>

      {data.groups.map((group) => (
        <DailyPicksBucketSection key={group.bucket} group={group} />
      ))}
    </div>
  );
}
