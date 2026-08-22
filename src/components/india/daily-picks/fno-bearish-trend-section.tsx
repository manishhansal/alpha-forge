"use client";

import * as React from "react";
import {
  Activity,
  ExternalLink,
  RefreshCw,
  TrendingDown,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

import { cn } from "@/lib/utils";
import {
  PaginationStrip,
  usePaginationFilter,
} from "@/components/india/ui/pagination-filter";
import {
  SignalTableHead,
  SignalTableRow,
} from "@/components/india/ui/signal-table-row";
import type { ScannerResult } from "@/types/india/scanner";

const REFRESH_INTERVAL_MS = 5 * 60_000;

// ─── Bearish conditions legend ────────────────────────────────────────────────
const CONDITIONS: { label: string; detail: string }[] = [
  { label: "EMA(5) < SMA(20)",   detail: "Short-term EMA below medium-term SMA — bearish price momentum" },
  { label: "WMA(10) < SMA(20)",  detail: "Weighted MA below SMA — weighted price bias is bearish" },
  { label: "DI−(14) > 20",       detail: "Directional minus above 20 — strong downward pressure" },
  { label: "ADX(14) > 20",       detail: "Trend strength above 20 — confirmed trending market" },
  { label: "Volume > 1L",        detail: "Daily volume above 100 000 — adequate liquidity" },
  { label: "MACD Line < 0",      detail: "MACD below zero line — bearish momentum zone" },
  { label: "Close < Prev Close", detail: "Today's close below yesterday — down session" },
  { label: "Close < SMA(50)",    detail: "Price below 50-day MA — medium-term bearish" },
  { label: "Close > ₹150",       detail: "Minimum price filter for F&O liquidity" },
  { label: "DI− > DI+",          detail: "Negative directional indicator dominates — sellers in control" },
  { label: "RSI(14) < 50",       detail: "RSI below midline — bearish momentum" },
  { label: "MACD < Signal",      detail: "MACD line below signal — fresh bearish crossover territory" },
  { label: "Close < 2d Close",   detail: "Price below close two sessions ago — sustained downtrend" },
  { label: "SMA(20) < SMA(40)",  detail: "20-day MA below 40-day MA — bearish MA crossover stack" },
];

function ConditionBadge({ label, detail }: { label: string; detail: string }) {
  return (
    <li
      title={detail}
      className="flex items-center gap-1 rounded-md border border-rose-500/20 bg-rose-500/8 px-2 py-1 text-[10px] font-medium text-rose-700 dark:text-rose-400"
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-rose-500" />
      {label}
    </li>
  );
}

// chevron + Symbol + Price + Chg% + ADX·RSI = 5
const COL_SPAN = 5;

/**
 * FnoBearishTrendSection
 *
 * Displays NSE F&O stocks passing all 14 bearish trend conditions
 * (Moving Average + ADX + MACD) — the exact mirror of the bullish scanner.
 * Polls /api/in/fno-bearish-trend every 5 minutes.
 */
export function FnoBearishTrendSection() {
  const [result, setResult]         = React.useState<ScannerResult | null>(null);
  const [loading, setLoading]       = React.useState(true);
  const [error, setError]           = React.useState<string | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);
  const [showConditions, setShowConditions] = React.useState(false);
  const [expandedSymbol, setExpandedSymbol] = React.useState<string | null>(null);

  const load = React.useCallback(async (signal?: AbortSignal) => {
    setRefreshing(true);
    try {
      const res = await fetch("/api/in/fno-bearish-trend?limit=50", {
        cache: "no-store",
        signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setResult(await res.json() as ScannerResult);
      setError(null);
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setError((err as Error).message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  React.useEffect(() => {
    const ac = new AbortController();
    void load(ac.signal);
    const id = setInterval(() => void load(ac.signal), REFRESH_INTERVAL_MS);
    return () => { ac.abort(); clearInterval(id); };
  }, [load]);

  const hits = result?.hits ?? [];

  const { pageItems, page, setPage, totalPages, filteredTotal, pageSize } =
    usePaginationFilter({ items: hits, pageSize: 15 });

  return (
    <section className="flex flex-col gap-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 sm:p-5">
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-rose-500/10 text-rose-600 ring-1 ring-inset ring-rose-500/20 dark:text-rose-400">
            <TrendingDown className="h-4 w-4" />
          </span>
          <div>
            <h2 className="text-sm font-semibold text-[var(--color-fg)]">
              FnO Bearish Trend Scanner
            </h2>
            <p className="text-[11px] text-[var(--color-fg-subtle)]">
              Daily F&amp;O stocks · Moving Average + ADX + MACD · all 14 bearish conditions met
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Conditions toggle */}
          <button
            type="button"
            onClick={() => setShowConditions((v) => !v)}
            className="inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-2.5 py-1 text-[11px] text-[var(--color-fg-muted)] transition-colors hover:text-[var(--color-fg)]"
          >
            <Activity className="h-3 w-3" />
            {showConditions ? "Hide" : "Conditions"}
          </button>

          {/* Manual refresh */}
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

      {/* ── Conditions legend ────────────────────────────────────────────── */}
      <AnimatePresence>
        {showConditions && (
          <motion.div
            key="conditions"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-3">
              <p className="mb-2 text-[11px] font-medium text-[var(--color-fg-muted)]">
                Stock passes{" "}
                <span className="font-bold text-[var(--color-fg)]">all 14</span> of the
                below filters in the{" "}
                <span className="font-bold text-[var(--color-fg)]">futures segment</span>,
                daily timeframe:
              </p>
              <ul className="flex flex-wrap gap-1.5">
                {CONDITIONS.map((c) => (
                  <ConditionBadge key={c.label} label={c.label} detail={c.detail} />
                ))}
              </ul>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Status / meta row ────────────────────────────────────────────── */}
      <div className="flex items-center justify-between text-[11px] text-[var(--color-fg-subtle)]">
        <span>
          {loading
            ? "Scanning F&O universe…"
            : error
              ? `Error — ${error}`
              : `${hits.length} stock${hits.length !== 1 ? "s" : ""} matched · refreshes every 5 min`}
        </span>
        {result?.fetchedAt && (
          <span className="tabular">
            {new Date(result.fetchedAt).toLocaleTimeString("en-IN", {
              timeZone: "Asia/Kolkata",
              hour: "2-digit",
              minute: "2-digit",
            })}{" "}
            IST
          </span>
        )}
      </div>

      {/* ── Table ───────────────────────────────────────────────────────── */}
      {loading && hits.length === 0 ? (
        <div className="flex items-center justify-center py-10 text-[12px] text-[var(--color-fg-muted)]">
          <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
          Running screener across F&amp;O universe…
        </div>
      ) : error && hits.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[var(--color-border)] py-8 text-center text-[12px] text-[var(--color-fg-muted)]">
          Could not load results — check back shortly.
        </div>
      ) : hits.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[var(--color-border)] py-8 text-center text-[12px] text-[var(--color-fg-muted)]">
          No F&amp;O stocks currently pass all 14 bearish conditions — check back at next refresh.
        </div>
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border border-[var(--color-border)]">
            <table className="w-full text-left">
              <thead>
                <SignalTableHead
                  extraTrailHeaders={
                    <th className="p-2.5 text-right font-medium">ADX · RSI</th>
                  }
                />
              </thead>
              <tbody>
                <AnimatePresence>
                  {pageItems.map((hit, i) => (
                    <SignalTableRow
                      key={hit.symbol}
                      hit={hit}
                      colSpan={COL_SPAN}
                      index={i}
                      expanded={expandedSymbol === hit.symbol}
                      onToggle={() =>
                        setExpandedSymbol((prev) =>
                          prev === hit.symbol ? null : hit.symbol,
                        )
                      }
                      extraTrailCells={
                        <td className="p-2.5 text-right tabular text-[11px] text-[var(--color-fg-muted)]">
                          {hit.metricLabel}
                        </td>
                      }
                    />
                  ))}
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
