"use client";

/**
 * SignalTableRow + SignalDetailPanel
 * ...
 */

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  PlusCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { fmt, fmtPct } from "@/lib/india/format";
import { useIndiaWatchlistStore } from "@/store/india/watchlistStore";
import { PaperTradeButton } from "@/components/india/paper-trading/paper-trade-button";

// ─── Types ────────────────────────────────────────────────────────────────────

export type SignalRow = {
  symbol: string;
  price: number | null;
  changePct: number | null;
  volume?: number | null;
  metric: number;
  metricLabel: string;
  kind?: string;
  note?: string;
  /** Suggested entry price */
  entry?: number | null;
  /** Stop loss level */
  stopLoss?: number | null;
  /** Take-profit 1 */
  tp1?: number | null;
  /** Take-profit 2 */
  tp2?: number | null;
  /** Take-profit 3 / stretch */
  tp3?: number | null;
  /** ATR used for level computation */
  atr?: number | null;
  /**
   * Strategy ID to use when opening a paper trade from this row.
   * Defaults to "SCANNER_HIT" when not specified.
   */
  paperTradeStrategyId?: string;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function kindClass(kind?: string): string {
  switch (kind) {
    case "LONG_BUILDUP":
    case "BULLISH":
    case "GAINER":
    case "BULL_VOLUME":
    case "SHORT_COVERING":
    case "RANGE_EXPANSION":
      return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400";
    case "SHORT_BUILDUP":
    case "BEARISH":
    case "LOSER":
    case "BEAR_VOLUME":
    case "LONG_UNWINDING":
      return "bg-rose-500/15 text-rose-700 dark:text-rose-400";
    case "ELEVATED":
      return "bg-amber-500/15 text-amber-700 dark:text-amber-400";
    case "LOW":
      return "bg-blue-500/15 text-blue-700 dark:text-blue-400";
    default:
      return "bg-muted text-muted-foreground";
  }
}

function tvLink(symbol: string): string {
  const s = symbol.replace(".NS", "");
  return `https://in.tradingview.com/chart/CR5K0NSR/?symbol=NSE%3A${s}`;
}

// ─── Detail panel (shown as an extra row below the hit row) ───────────────────

function DetailPanel({
  hit,
  colSpan,
}: {
  hit: SignalRow;
  colSpan: number;
}) {
  const addToWatchlist = useIndiaWatchlistStore((s) => s.add);
  const sym = hit.symbol.replace(".NS", "");

  return (
    <motion.tr
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
    >
      <td
        colSpan={colSpan}
        className="border-b border-[var(--color-border)]/60 bg-[var(--color-bg-elevated)] px-4 pb-3 pt-2"
      >
        <div className="flex flex-wrap items-start gap-4">
          {/* ── Left: key metrics ─────────────────────────────────── */}
          <div className="flex flex-wrap gap-x-6 gap-y-1.5 text-[11px]">
            <div className="flex flex-col gap-0.5">
              <span className="text-[10px] uppercase tracking-wide text-[var(--color-fg-subtle)]">Price</span>
              <span className="font-semibold text-[var(--color-fg)] tabular">
                {hit.price != null ? fmt(hit.price) : "—"}
              </span>
            </div>

            <div className="flex flex-col gap-0.5">
              <span className="text-[10px] uppercase tracking-wide text-[var(--color-fg-subtle)]">Day %</span>
              <span
                className={cn(
                  "font-semibold tabular",
                  (hit.changePct ?? 0) >= 0
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-rose-600 dark:text-rose-400",
                )}
              >
                {hit.changePct != null ? fmtPct(hit.changePct) : "—"}
              </span>
            </div>

            <div className="flex flex-col gap-0.5">
              <span className="text-[10px] uppercase tracking-wide text-[var(--color-fg-subtle)]">Metric</span>
              <span className="font-semibold text-[var(--color-fg)] tabular">
                {hit.metricLabel}
              </span>
            </div>

            {hit.volume != null && hit.volume > 0 && (
              <div className="flex flex-col gap-0.5">
                <span className="text-[10px] uppercase tracking-wide text-[var(--color-fg-subtle)]">Volume</span>
                <span className="font-semibold text-[var(--color-fg)] tabular">
                  {(hit.volume / 1_00_000).toFixed(2)}L
                </span>
              </div>
            )}

            {hit.kind && (
              <div className="flex flex-col gap-0.5">
                <span className="text-[10px] uppercase tracking-wide text-[var(--color-fg-subtle)]">Signal</span>
                <span
                  className={cn(
                    "inline-block rounded-full px-2 py-0.5 text-[10px] font-bold",
                    kindClass(hit.kind),
                  )}
                >
                  {hit.kind.replace(/_/g, " ")}
                </span>
              </div>
            )}
          </div>

          {/* ── Right: note + actions ──────────────────────────────── */}
          <div className="flex flex-1 flex-col justify-between gap-2 min-w-0">
            {/* Trade levels — entry / SL / TP */}
            {(hit.entry != null || hit.stopLoss != null || hit.tp1 != null) && (
              <div className="flex flex-wrap gap-x-5 gap-y-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[11px]">
                {hit.entry != null && (
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[10px] uppercase tracking-wide text-[var(--color-fg-subtle)]">Entry</span>
                    <span className="font-semibold tabular text-[var(--color-fg)]">₹{fmt(hit.entry)}</span>
                  </div>
                )}
                {hit.stopLoss != null && (
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[10px] uppercase tracking-wide text-[var(--color-fg-subtle)]">Stop Loss</span>
                    <span className="font-semibold tabular text-rose-600 dark:text-rose-400">₹{fmt(hit.stopLoss)}</span>
                    {hit.entry != null && (
                      <span className="text-[10px] tabular text-rose-500">
                        {(((hit.stopLoss - hit.entry) / hit.entry) * 100).toFixed(2)}%
                      </span>
                    )}
                  </div>
                )}
                {hit.tp1 != null && (
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[10px] uppercase tracking-wide text-[var(--color-fg-subtle)]">TP1</span>
                    <span className="font-semibold tabular text-emerald-600 dark:text-emerald-400">₹{fmt(hit.tp1)}</span>
                    {hit.entry != null && (
                      <span className="text-[10px] tabular text-emerald-500">
                        +{(((hit.tp1 - hit.entry) / hit.entry) * 100).toFixed(2)}%
                      </span>
                    )}
                  </div>
                )}
                {hit.tp2 != null && (
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[10px] uppercase tracking-wide text-[var(--color-fg-subtle)]">TP2</span>
                    <span className="font-semibold tabular text-emerald-600 dark:text-emerald-400">₹{fmt(hit.tp2)}</span>
                    {hit.entry != null && (
                      <span className="text-[10px] tabular text-emerald-500">
                        +{(((hit.tp2 - hit.entry) / hit.entry) * 100).toFixed(2)}%
                      </span>
                    )}
                  </div>
                )}
                {hit.tp3 != null && (
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[10px] uppercase tracking-wide text-[var(--color-fg-subtle)]">TP3 (Stretch)</span>
                    <span className="font-semibold tabular text-emerald-600 dark:text-emerald-400">₹{fmt(hit.tp3)}</span>
                    {hit.entry != null && (
                      <span className="text-[10px] tabular text-emerald-500">
                        +{(((hit.tp3 - hit.entry) / hit.entry) * 100).toFixed(2)}%
                      </span>
                    )}
                  </div>
                )}
                {hit.atr != null && (
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[10px] uppercase tracking-wide text-[var(--color-fg-subtle)]">ATR(14)</span>
                    <span className="font-semibold tabular text-[var(--color-fg-muted)]">₹{fmt(hit.atr)}</span>
                  </div>
                )}
              </div>
            )}
            {hit.note && (
              <p className="text-[11px] text-[var(--color-fg-muted)] break-words">
                {hit.note}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2 mt-auto">
              <a
                href={tvLink(hit.symbol)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1 text-[11px] text-[var(--color-fg-muted)] transition-colors hover:text-[var(--color-fg)]"
              >
                <ExternalLink className="h-3 w-3" />
                TradingView
              </a>
              <a
                href={`/in/chart/${encodeURIComponent(hit.symbol)}`}
                className="inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1 text-[11px] text-[var(--color-fg-muted)] transition-colors hover:text-[var(--color-fg)]"
              >
                Chart
              </a>
              <button
                type="button"
                onClick={() => addToWatchlist(sym)}
                className="inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1 text-[11px] text-[var(--color-fg-muted)] transition-colors hover:text-[var(--color-fg)]"
              >
                <PlusCircle className="h-3 w-3" />
                Watchlist
              </button>
              {/* Paper trade button — only when entry/SL/target are available */}
              {hit.entry != null && hit.stopLoss != null && hit.tp1 != null && (
                <PaperTradeButton
                  size="xs"
                  payload={{
                    strategyId: (hit.paperTradeStrategyId ?? "SCANNER_HIT") as import("@/features/india/scalping/strategies/catalog").IndiaScalpStrategyId,
                    symbol:     sym,
                    direction:  (hit.kind === "BEARISH" || hit.kind === "SHORT_BUILDUP" || hit.kind === "LOSER" || hit.kind === "BEAR_VOLUME" || hit.kind === "LONG_UNWINDING")
                                  ? "SHORT" : "LONG",
                    entry:      hit.entry,
                    stopLoss:   hit.stopLoss,
                    target:     hit.tp1,
                    riskReward: hit.tp1 > 0 && hit.entry > 0 && hit.stopLoss > 0
                                  ? Math.abs(hit.tp1 - hit.entry) / Math.abs(hit.stopLoss - hit.entry)
                                  : 1,
                    atr:        hit.atr ?? null,
                    rationale:  hit.note ? [hit.note] : [],
                    extras:     { kind: hit.kind ?? null, metric: hit.metricLabel },
                  }}
                />
              )}
            </div>
          </div>
        </div>
      </td>
    </motion.tr>
  );
}

// ─── Main row ─────────────────────────────────────────────────────────────────

export type SignalTableRowProps = {
  hit: SignalRow;
  /** Total number of <td> columns in this table (for colSpan of detail panel). */
  colSpan: number;
  /** Sequential index within the visible page — drives the entrance delay. */
  index?: number;
  /** Extra cells rendered before Symbol (e.g. row number, source badge). */
  extraLeadCells?: React.ReactNode;
  /** Extra cells rendered after Chg% (e.g. Metric label, Tag). */
  extraTrailCells?: React.ReactNode;
  /** Whether this row is pre-expanded (controlled from outside). */
  expanded?: boolean;
  /** Called when the row is clicked to toggle. If omitted, row manages its own state. */
  onToggle?: () => void;
};

export function SignalTableRow({
  hit,
  colSpan,
  index = 0,
  extraLeadCells,
  extraTrailCells,
  expanded: controlledExpanded,
  onToggle,
}: SignalTableRowProps) {
  const [localExpanded, setLocalExpanded] = React.useState(false);

  const isExpanded = controlledExpanded ?? localExpanded;
  const toggle = onToggle ?? (() => setLocalExpanded((v) => !v));

  const up = (hit.changePct ?? 0) >= 0;
  const sym = hit.symbol.replace(".NS", "");

  return (
    <>
      <motion.tr
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2, delay: Math.min(index * 0.025, 0.35) }}
        onClick={toggle}
        className={cn(
          "cursor-pointer border-b border-[var(--color-border)]/40 transition-colors select-none",
          isExpanded
            ? "bg-[var(--color-bg-elevated)]"
            : "hover:bg-[var(--color-bg-elevated)]",
        )}
      >
        {/* Expand chevron */}
        <td className="w-6 pl-2 pr-0 text-[var(--color-fg-subtle)]">
          {isExpanded ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </td>

        {extraLeadCells}

        {/* Symbol */}
        <td className="p-2.5 font-medium text-sm">
          <span
            className="text-[var(--color-brand)]"
            title={`Click to ${isExpanded ? "collapse" : "expand"} details`}
          >
            {sym}
          </span>
        </td>

        {/* Price */}
        <td className="p-2.5 text-right tabular text-sm text-[var(--color-fg)]">
          {hit.price != null ? fmt(hit.price) : "—"}
        </td>

        {/* Chg% */}
        <td
          className={cn(
            "p-2.5 text-right tabular text-sm font-semibold",
            up
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-rose-600 dark:text-rose-400",
          )}
        >
          {hit.changePct != null ? fmtPct(hit.changePct) : "—"}
        </td>

        {extraTrailCells}
      </motion.tr>

      <AnimatePresence>
        {isExpanded && (
          <DetailPanel key={`${hit.symbol}-detail`} hit={hit} colSpan={colSpan} />
        )}
      </AnimatePresence>
    </>
  );
}

// ─── Standard table header cells (Symbol / Price / Chg%) ─────────────────────

export function SignalTableHead({
  extraLeadHeaders,
  extraTrailHeaders,
}: {
  extraLeadHeaders?: React.ReactNode;
  extraTrailHeaders?: React.ReactNode;
}) {
  return (
    <tr className="border-b border-[var(--color-border)]/60 bg-[var(--color-bg-elevated)] text-left text-[11px] uppercase tracking-wide text-[var(--color-fg-muted)]">
      {/* chevron spacer */}
      <th className="w-6 pl-2 pr-0" />
      {extraLeadHeaders}
      <th className="p-2.5 font-medium">Symbol</th>
      <th className="p-2.5 text-right font-medium">Price</th>
      <th className="p-2.5 text-right font-medium">Chg%</th>
      {extraTrailHeaders}
    </tr>
  );
}
