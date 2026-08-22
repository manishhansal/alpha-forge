"use client";

import * as React from "react";
import {
  ArrowDownRight,
  ArrowUpRight,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  Clock,
  ExternalLink,
  Filter,
  Pause,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Target,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

import { cn } from "@/lib/utils";
import { AiMarketContextBanner } from "./ai-market-context-banner";
import type { AiSignal, AiSignalsResponse, AiGrade } from "@/types/ai-signals";

interface Props {
  initialData: AiSignalsResponse;
  endpoint?: string;
  intervalMs?: number;
  currency?: "usd" | "inr";
}

type DirectionFilter = "all" | "bullish" | "bearish" | "wait";

const DIRECTION_OPTIONS: Array<{
  id: DirectionFilter;
  label: string;
  icon: typeof ArrowUpRight;
}> = [
  { id: "all",     label: "All",     icon: Filter       },
  { id: "bullish", label: "Bullish", icon: ArrowUpRight  },
  { id: "bearish", label: "Bearish", icon: ArrowDownRight},
  { id: "wait",    label: "Wait",    icon: Pause         },
];

const STORAGE_KEY_DIR = "ai-signals:dir";

const VALID_DIRECTIONS: DirectionFilter[] = ["all", "bullish", "bearish", "wait"];

// ─── localStorage helpers ────────────────────────────────────────────────────

const lsSubs = new Set<() => void>();
function subscribeToLocalStorage(cb: () => void) {
  if (typeof window === "undefined") return () => {};
  const h = () => cb();
  window.addEventListener("storage", h);
  lsSubs.add(cb);
  return () => { window.removeEventListener("storage", h); lsSubs.delete(cb); };
}
function notifyLocalStorage() { for (const cb of lsSubs) cb(); }
function readPersisted<T extends string>(key: string, valid: readonly T[], fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw && (valid as readonly string[]).includes(raw)) return raw as T;
  } catch { /* ignore */ }
  return fallback;
}
function usePersistedFilter<T extends string>(key: string, valid: readonly T[], fallback: T): [T, (v: T) => void] {
  const value = React.useSyncExternalStore(
    subscribeToLocalStorage,
    () => readPersisted(key, valid, fallback),
    () => fallback,
  );
  const set = React.useCallback((next: T) => {
    if (typeof window === "undefined") return;
    try { window.localStorage.setItem(key, next); } catch { /* ignore */ }
    notifyLocalStorage();
  }, [key]);
  return [value, set];
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

function fmtPrice(v: number, currency: "usd" | "inr"): string {
  if (!Number.isFinite(v)) return "—";
  const sym = currency === "inr" ? "₹" : "$";
  const d   = currency === "inr" ? 2 : v >= 1000 ? 2 : 4;
  return `${sym}${v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`;
}
function fmtPct(v: number): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
}

const GRADE_CLASS: Record<AiGrade, string> = {
  S: "bg-[color-mix(in_oklch,var(--color-brand)_20%,transparent)] text-[var(--color-brand)]",
  A: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  B: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  C: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  D: "bg-muted text-muted-foreground",
};

const ACTION_COLOR: Record<string, string> = {
  LONG:  "text-emerald-600 dark:text-emerald-400",
  BUY:   "text-emerald-600 dark:text-emerald-400",
  SHORT: "text-rose-600 dark:text-rose-400",
  SELL:  "text-rose-600 dark:text-rose-400",
  WAIT:  "text-[var(--color-fg-muted)]",
};

const HORIZON_LABEL: Record<string, string> = {
  scalp:       "Scalp",
  intraday:    "Intraday",
  swing:       "Swing",
  positional:  "Positional",
};

// ─── Expanded detail panel ───────────────────────────────────────────────────

function AiSignalDetail({ signal, currency, colSpan }: { signal: AiSignal; currency: "usd" | "inr"; colSpan: number }) {
  const isBull = signal.direction === "BULLISH";
  const stopPct = signal.entry > 0
    ? ((signal.stopLoss - signal.entry) / signal.entry) * 100
    : 0;
  const tp1 = signal.takeProfits?.[0];
  const tp1Pct = tp1 && signal.entry > 0
    ? ((tp1.price - signal.entry) / signal.entry) * 100
    : null;

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
          {/* Summary */}
          {signal.summary && (
            <div className="flex items-start gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
              <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-brand)]" />
              <p className="text-[12px] leading-relaxed text-[var(--color-fg-muted)]">{signal.summary}</p>
            </div>
          )}

          {/* Level grid */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <DetailCell label="Entry" value={fmtPrice(signal.entry, currency)} />
            <DetailCell
              label="Stop Loss"
              value={fmtPrice(signal.stopLoss, currency)}
              sub={fmtPct(stopPct)}
              subTone={isBull ? "bear" : "bull"}
            />
            {tp1 && (
              <DetailCell
                label="TP1"
                value={fmtPrice(tp1.price, currency)}
                sub={tp1Pct != null ? fmtPct(tp1Pct) : undefined}
                subTone="bull"
              />
            )}
            <DetailCell label="Strike" value={signal.strike != null ? fmtPrice(signal.strike, currency) : "—"} />
          </div>

          {/* Metrics row */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <DetailCell label="Win Prob"      value={`${Math.round(signal.winProbability * 100)}%`} />
            <DetailCell label="R:R (TP1)"     value={`${signal.riskReward.toFixed(2)}:1`} />
            <DetailCell label="Expected Move" value={`${signal.expectedMovePct.toFixed(1)}%`} />
            <DetailCell label="Risk"          value={signal.riskLevel} />
          </div>

          {/* Quant / ML flags */}
          {(signal.quantGatePassed != null || signal.mlEnhanced) && (
            <div className="flex flex-wrap gap-1.5">
              {signal.quantGatePassed === true && (
                <span className="rounded-full bg-emerald-500/12 px-2 py-0.5 text-[10px] font-semibold text-emerald-600 ring-1 ring-inset ring-emerald-500/25 dark:text-emerald-400">✓ Quant Gate</span>
              )}
              {signal.quantGatePassed === false && (
                <span className="rounded-full bg-amber-500/12 px-2 py-0.5 text-[10px] font-semibold text-amber-600 ring-1 ring-inset ring-amber-500/25 dark:text-amber-400">⚠ Low Liq</span>
              )}
              {signal.mlEnhanced === true && (
                <span className="rounded-full bg-[color-mix(in_oklch,var(--color-brand)_12%,transparent)] px-2 py-0.5 text-[10px] font-semibold text-[var(--color-brand)] ring-1 ring-inset ring-[color-mix(in_oklch,var(--color-brand)_25%,transparent)]">ML Top</span>
              )}
            </div>
          )}

          {/* Reasons */}
          {signal.reasons && signal.reasons.length > 0 && (
            <ul className="flex flex-wrap gap-1.5">
              {signal.reasons.map((r, i) => (
                <li
                  key={i}
                  className={cn(
                    "rounded-md px-2 py-0.5 text-[10px] font-medium",
                    r.bullish
                      ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                      : "bg-rose-500/10 text-rose-700 dark:text-rose-400",
                  )}
                >
                  {r.text}
                </li>
              ))}
            </ul>
          )}

          {/* Invalidation */}
          {signal.invalidationCriteria && (
            <p className="flex items-start gap-1.5 text-[11px] text-[var(--color-fg-muted)]">
              <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-500" />
              <span><span className="font-semibold text-[var(--color-fg)]">Invalidation:</span> {signal.invalidationCriteria}</span>
            </p>
          )}

          {/* Actions */}
          <div className="flex flex-wrap gap-2 pt-1">
            <a
              href={`https://in.tradingview.com/chart/CR5K0NSR/?symbol=NSE%3A${signal.symbol.replace(".NS", "")}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1 text-[11px] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
            >
              <ExternalLink className="h-3 w-3" /> TradingView
            </a>
            <a
              href={`/in/chart/${encodeURIComponent(signal.symbol)}`}
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

function DetailCell({ label, value, sub, subTone }: {
  label: string;
  value: string;
  sub?: string;
  subTone?: "bull" | "bear";
}) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
      <span className="text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)]">{label}</span>
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

// ─── Single signal row ────────────────────────────────────────────────────────

function AiSignalRow({
  signal,
  currency,
  index,
  expanded,
  onToggle,
  colSpan,
}: {
  signal: AiSignal;
  currency: "usd" | "inr";
  index: number;
  expanded: boolean;
  onToggle: () => void;
  colSpan: number;
}) {
  const isBull = signal.direction === "BULLISH";
  const isBear = signal.direction === "BEARISH";

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

        {/* Symbol + display name */}
        <td className="p-2.5">
          <div className="flex flex-col">
            <span className="text-sm font-semibold text-[var(--color-brand)]">
              {signal.symbol.replace(".NS", "")}
            </span>
            <span className="text-[10px] text-[var(--color-fg-subtle)] truncate max-w-[140px]">
              {signal.displayName}
            </span>
          </div>
        </td>

        {/* Action badge */}
        <td className="p-2.5">
          <span className={cn("text-[11px] font-bold uppercase", ACTION_COLOR[signal.action] ?? "text-[var(--color-fg-muted)]")}>
            {signal.action}
          </span>
        </td>

        {/* Grade */}
        <td className="p-2.5">
          <span className={cn("inline-grid h-5 w-5 place-items-center rounded-full text-[10px] font-bold", GRADE_CLASS[signal.grade])}>
            {signal.grade}
          </span>
        </td>

        {/* Price (underlying) */}
        <td className="p-2.5 text-right tabular text-sm text-[var(--color-fg)]">
          {fmtPrice(signal.underlyingPrice, currency)}
        </td>

        {/* Confidence */}
        <td className="p-2.5 text-right tabular text-sm font-semibold text-[var(--color-fg)]">
          {signal.confidenceScore}%
        </td>

        {/* Win Prob */}
        <td className={cn("p-2.5 text-right tabular text-sm font-medium",
          isBull ? "text-emerald-600 dark:text-emerald-400"
          : isBear ? "text-rose-600 dark:text-rose-400"
          : "text-[var(--color-fg-muted)]"
        )}>
          {Math.round(signal.winProbability * 100)}%
        </td>

        {/* R:R */}
        <td className="p-2.5 text-right tabular text-[11px] text-[var(--color-fg-muted)]">
          {signal.riskReward.toFixed(1)}:1
        </td>

        {/* Horizon */}
        <td className="hidden p-2.5 text-[11px] text-[var(--color-fg-subtle)] sm:table-cell">
          <span className="inline-flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {HORIZON_LABEL[signal.horizon] ?? signal.horizon}
          </span>
        </td>
      </motion.tr>

      <AnimatePresence>
        {expanded && (
          <AiSignalDetail
            key={`${signal.id}-detail`}
            signal={signal}
            currency={currency}
            colSpan={colSpan}
          />
        )}
      </AnimatePresence>
    </>
  );
}

// total cols: chevron + symbol + action + grade + price + conf + winprob + rr + horizon = 9
const COL_SPAN = 9;

// ─── Board ────────────────────────────────────────────────────────────────────

export function AiSignalsBoard({
  initialData,
  endpoint = "/api/ai-signals",
  intervalMs = 30_000,
  currency = "usd",
}: Props) {
  const [data, setData] = React.useState<AiSignalsResponse>(initialData);
  const [refreshing, setRefreshing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [expandedId, setExpandedId] = React.useState<string | null>(null);

  const [directionFilter, setDirectionFilter] = usePersistedFilter(STORAGE_KEY_DIR, VALID_DIRECTIONS, "all");

  const refresh = React.useCallback(async (sig?: AbortSignal) => {
    setRefreshing(true);
    try {
      const res = await fetch(endpoint, { cache: "no-store", signal: sig });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json() as AiSignalsResponse);
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

  const filtered = React.useMemo(() => {
    return data.signals
      .filter((s) => {
        // Hard-lock to intraday only — scalp and intraday horizons only
        if (s.horizon !== "intraday" && s.horizon !== "scalp") return false;
        if (directionFilter === "bullish" && s.direction !== "BULLISH") return false;
        if (directionFilter === "bearish" && s.direction !== "BEARISH") return false;
        if (directionFilter === "wait"    && s.action    !== "WAIT")    return false;
        return true;
      })
      .slice()
      .sort((a, b) => {
        if (b.confidence    !== a.confidence)    return b.confidence    - a.confidence;
        if (b.winProbability !== a.winProbability) return b.winProbability - a.winProbability;
        return b.riskRewardBlended - a.riskRewardBlended;
      });
  }, [data.signals, directionFilter, horizonFilter]);

  const generatedLabel = new Date(data.generatedAt).toLocaleTimeString();
  const nextSessionLabel   = data.context.nextSessionLabel   ?? null;
  const nextSessionOpensAt = data.context.nextSessionOpensAt ?? null;

  return (
    <div className="flex flex-col gap-4">
      <AiMarketContextBanner context={data.context} stats={data.stats} />

      {nextSessionLabel && nextSessionOpensAt ? (
        <NextSessionBanner label={nextSessionLabel} opensAt={nextSessionOpensAt} />
      ) : null}

      {/* Filter bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
        <div className="flex flex-wrap gap-1.5">
          {DIRECTION_OPTIONS.map((opt) => {
            const OptIcon = opt.icon;
            const on = directionFilter === opt.id;
            return (
              <button
                key={opt.id}
                onClick={() => setDirectionFilter(opt.id)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ring-1 ring-inset",
                  on
                    ? "bg-[var(--color-surface-hover)] text-[var(--color-fg)] ring-[var(--color-border-strong)]"
                    : "bg-transparent text-[var(--color-fg-muted)] ring-[var(--color-border)] hover:text-[var(--color-fg)]",
                )}
                aria-pressed={on}
              >
                <OptIcon className="h-3 w-3" />
                {opt.label}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)]">
            {filtered.length} / {data.signals.length}
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
      </div>

      <p className="text-[11px] text-[var(--color-fg-subtle)]">
        Model {data.modelVersion} · regenerated {generatedLabel} · {data.context.dataFreshness}
        {error ? <span className="ml-2 text-[var(--color-bear)]">· {error}</span> : null}
      </p>

      {/* Table */}
      {filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--color-bg-elevated)] py-10 text-center text-sm text-[var(--color-fg-muted)]">
          No signals match the current filter. Try widening the filter or waiting for the next refresh.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-[var(--color-border)]">
          <table className="w-full text-sm">
            <thead className="bg-[var(--color-bg-elevated)] text-[11px] uppercase tracking-wide text-[var(--color-fg-muted)]">
              <tr className="border-b border-[var(--color-border)]/60">
                <th className="w-6 pl-2 pr-0" />
                <th className="p-2.5 text-left font-medium">Symbol</th>
                <th className="p-2.5 text-left font-medium">Action</th>
                <th className="p-2.5 text-left font-medium">Grade</th>
                <th className="p-2.5 text-right font-medium">Price</th>
                <th className="p-2.5 text-right font-medium">Conf</th>
                <th className="p-2.5 text-right font-medium">Win%</th>
                <th className="p-2.5 text-right font-medium">R:R</th>
                <th className="hidden p-2.5 text-left font-medium sm:table-cell">Horizon</th>
              </tr>
            </thead>
            <tbody>
              <AnimatePresence>
                {filtered.map((s, i) => (
                  <AiSignalRow
                    key={s.id}
                    signal={s}
                    currency={currency}
                    index={i}
                    expanded={expandedId === s.id}
                    onToggle={() => setExpandedId((prev) => prev === s.id ? null : s.id)}
                    colSpan={COL_SPAN}
                  />
                ))}
              </AnimatePresence>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Next session banner (unchanged) ─────────────────────────────────────────

function NextSessionBanner({ label, opensAt }: { label: string; opensAt: number }) {
  const [remainingLabel, setRemainingLabel] = React.useState<string>("…");

  React.useEffect(() => {
    const tick = () => setRemainingLabel(formatCountdown(opensAt - Date.now()));
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, [opensAt]);

  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[color-mix(in_oklch,var(--color-info)_30%,var(--color-border))] bg-[color-mix(in_oklch,var(--color-info)_8%,var(--color-bg-elevated))] px-4 py-2.5 text-[12px] text-[var(--color-fg-muted)]"
    >
      <div className="flex items-center gap-2">
        <span className="grid h-7 w-7 place-items-center rounded-full bg-[var(--color-bg-elevated)] text-[var(--color-info)] ring-1 ring-inset ring-[color-mix(in_oklch,var(--color-info)_30%,transparent)]">
          <CalendarClock className="h-3.5 w-3.5" />
        </span>
        <span>
          <span className="font-semibold text-[var(--color-fg)]">Market closed</span>{" "}
          — these signals are queued for{" "}
          <span className="font-semibold text-[var(--color-fg)]">{label}</span>. Plan now, execute at the open.
        </span>
      </div>
      <span className="num inline-flex items-center gap-1 rounded-full bg-[var(--color-bg-elevated)] px-2 py-0.5 text-[11px] font-medium tabular-nums text-[var(--color-fg-muted)] ring-1 ring-inset ring-[var(--color-border)]">
        Opens in {remainingLabel}
      </span>
    </div>
  );
}

function formatCountdown(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "moments";
  const totalMin = Math.floor(ms / 60_000);
  const days  = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor((totalMin % (60 * 24)) / 60);
  const mins  = totalMin % 60;
  if (days  > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}
