"use client";

import * as React from "react";
import {
  Activity,
  ExternalLink,
  RefreshCw,
  TrendingUp,
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

const CHARTINK_URL =
  "https://chartink.com/screener/daily-fno-stocks-bullish-trend-scanner-moving-average-adx-macd-3";

const REFRESH_INTERVAL_MS = 5 * 60_000; // 5 minutes — daily bars don't tick intraday

// ─── Condition labels shown in the criteria legend ───────────────────────────
const CONDITIONS: { label: string; detail: string }[] = [
  { label: "EMA(5) > SMA(20)", detail: "Short-term EMA above medium-term SMA — price momentum" },
  { label: "WMA(10) > SMA(20)", detail: "Weighted MA above SMA — weighted price bias is bullish" },
  { label: "DI+(14) > 20", detail: "Directional plus above 20 — strong upward pressure" },
  { label: "ADX(14) > 20", detail: "Trend strength above 20 — confirmed trending market" },
  { label: "Volume > 1L", detail: "Daily volume above 100 000 — adequate liquidity" },
  { label: "MACD Line > 0", detail: "MACD above zero line — bullish momentum zone" },
  { label: "Close > Prev Close", detail: "Today's close above yesterday — up session" },
  { label: "Close > SMA(50)", detail: "Price above 50-day MA — medium-term bullish" },
  { label: "Close > ₹150", detail: "Minimum price filter for F&O liquidity" },
  { label: "DI+ > DI−", detail: "Positive directional indicator dominates — buyers in control" },
  { label: "RSI(14) > 50", detail: "RSI above midline — bullish momentum" },
  { label: "MACD > Signal", detail: "MACD line above signal — fresh bullish crossover territory" },
  { label: "Close > 2d Close", detail: "Price above close two sessions ago — sustained uptrend" },
  { label: "SMA(20) > SMA(40)", detail: "20-day MA above 40-day MA — bullish MA crossover stack" },
];

function ConditionBadge({ label, detail }: { label: string; detail: string }) {
  return (
    <li
      title={detail}
      className="flex items-center gap-1 rounded-md border border-emerald-500/20 bg-emerald-500/8 px-2 py-1 text-[10px] font-medium text-emerald-700 dark:text-emerald-400"
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
      {label}
    </li>
  );
}

// chevron + Symbol + Price + Chg% + ADX·RSI = 5
const COL_SPAN = 5;

/**
 * FnoBullishTrendSection
 *
 * Displays NSE F&O stocks that pass the full 14-condition daily bullish trend
 * screener (Moving Average + ADX + MACD), mirroring the Chartink screener.
 * Polls /api/in/fno-bullish-trend every 5 minutes and re-renders in place.
 */
export function FnoBullishTrendSection() {
  const [result, setResult] = React.useState<ScannerResult | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);
  const [showConditions, setShowConditions] = React.useState(false);
  const [expandedSymbol, setExpandedSymbol] = React.useState<string | null>(null);

  const load = React.useCallback(async (signal?: AbortSignal) => {
    setRefreshing(true);
    try {
      const res = await fetch("/api/in/fno-bullish-trend?limit=50", {
        cache: "no-store",
        signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as ScannerResult;
      setResult(json);
      setError(null);
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setError((err as Error).message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Initial fetch + polling.
  React.useEffect(() => {
    const ac = new AbortController();
    void load(ac.signal);
    const id = setInterval(() => void load(ac.signal), REFRESH_INTERVAL_MS);
    return () => {
      ac.abort();
      clearInterval(id);
    };
  }, [load]);

  const hits = result?.hits ?? [];

  const { pageItems, page, setPage, totalPages, filteredTotal, pageSize } =
    usePaginationFilter({ items: hits, pageSize: 15 });

  return (
    <section className="flex flex-col gap-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 sm:p-5">
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-emerald-500/10 text-emerald-600 ring-1 ring-inset ring-emerald-500/20 dark:text-emerald-400">
            <TrendingUp className="h-4 w-4" />
          </span>
          <div>
            <h2 className="text-sm font-semibold text-[var(--color-fg)]">
              FnO Bullish Trend Scanner
            </h2>
            <p className="text-[11px] text-[var(--color-fg-subtle)]">
              Daily F&amp;O stocks · Moving Average + ADX + MACD · all 14 conditions met
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Chartink source link */}
          <a
            href={CHARTINK_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-2.5 py-1 text-[11px] text-[var(--color-fg-muted)] transition-colors hover:text-[var(--color-fg)]"
            title="View screener on Chartink"
          >
            <ExternalLink className="h-3 w-3" />
            Chartink
          </a>

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
                Stock passes <span className="font-bold text-[var(--color-fg)]">all 14</span> of the
                below filters in the <span className="font-bold text-[var(--color-fg)]">futures segment</span>,
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
          No F&amp;O stocks currently pass all 14 conditions — check back at next refresh.
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
