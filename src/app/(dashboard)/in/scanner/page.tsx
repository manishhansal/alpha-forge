"use client";

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Activity,
  Expand,
  Flame,
  Gauge,
  Radar,
  Rocket,
  TrendingUp,
} from "lucide-react";
import {
  FilterTabs,
  PaginationStrip,
  usePaginationFilter,
} from "@/components/india/ui/pagination-filter";
import {
  SignalTableHead,
  SignalTableRow,
  kindClass,
} from "@/components/india/ui/signal-table-row";
import { useIndiaScannerStore } from "@/store/india/scannerStore";
import { useScanner } from "@/hooks/india/useScanner";
import { fmtPct } from "@/lib/india/format";
import type { ScannerHit, ScannerType } from "@/types/india/scanner";

// Total columns: chevron + Symbol + Price + Chg% + Metric + Tag + Note = 7
const COL_SPAN = 7;

type Tab = {
  id: ScannerType;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  hint: string;
};

const TABS: Tab[] = [
  { id: "range-expansion", label: "Range Expansion", icon: Expand, hint: "WR8 + bullish trend" },
  { id: "momentum",        label: "Momentum",        icon: TrendingUp, hint: "Top % movers" },
  { id: "volume-breakout", label: "Volume",           icon: Rocket,     hint: "≥1.5× 20-day avg" },
  { id: "oi-buildup",      label: "OI Buildup",       icon: Activity,   hint: "Long/short build-up" },
  { id: "pcr",             label: "PCR",              icon: Gauge,      hint: "Put-Call Ratio" },
  { id: "iv-spike",        label: "IV",               icon: Flame,      hint: "ATM implied volatility" },
];

export default function ScannerPage() {
  const active  = useIndiaScannerStore((s) => s.active);
  const setActive = useIndiaScannerStore((s) => s.setActive);
  const result  = useIndiaScannerStore((s) => s.results[active]);
  const loading = useIndiaScannerStore((s) => s.loading[active]);
  const error   = useIndiaScannerStore((s) => s.errors[active]);

  // Track which row is expanded so clicking another collapses the current one.
  const [expandedSymbol, setExpandedSymbol] = React.useState<string | null>(null);

  const interval =
    active === "momentum" || active === "volume-breakout"
      ? 15_000
      : active === "range-expansion"
        ? 60_000
        : 30_000;
  useScanner(active, interval, 25);

  const hits = React.useMemo(() => result?.hits ?? [], [result]);

  const getConfidence = React.useCallback(
    (h: ScannerHit) => {
      if (!result || result.hits.length === 0) return h.metric;
      const max = Math.max(...result.hits.map((x) => Math.abs(x.metric)));
      return max > 0 ? Math.abs(h.metric) / max : 0;
    },
    [result],
  );

  const getWinrate = React.useCallback((h: ScannerHit) => {
    const pct = h.changePct ?? 0;
    return Math.min(Math.abs(pct) / 10, 1);
  }, []);

  const {
    pageItems, activeTab, setActiveTab,
    page, setPage, totalPages, filteredTotal, pageSize, tabs,
  } = usePaginationFilter({
    items: hits,
    pageSize: 15,
    getConfidence,
    getWinrate,
    confidenceThreshold: 0.7,
    winrateThreshold: 0.6,
  });

  // Collapse expanded row when scanner type or page changes.
  React.useEffect(() => { setExpandedSymbol(null); }, [active, page]);

  return (
    <div className="space-y-6">
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex items-end justify-between gap-3 flex-wrap"
      >
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-gradient-to-br from-amber-500/20 to-rose-500/20 shrink-0">
            <Radar className="h-5 w-5 text-amber-500" />
          </div>
          <div>
            <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight">F&amp;O Scanner</h1>
            <p className="text-xs sm:text-sm text-muted-foreground">
              Momentum · Volume · OI build-up · PCR · IV — auto-refreshing
            </p>
          </div>
        </div>
        {result?.fetchedAt && (
          <span className="text-[10px] text-muted-foreground">
            updated {new Date(result.fetchedAt).toLocaleTimeString()}
          </span>
        )}
      </motion.div>

      {/* Scanner type tabs */}
      <div className="flex flex-wrap gap-1.5">
        {TABS.map((t) => {
          const Icon = t.icon;
          const isActive = t.id === active;
          return (
            <button
              key={t.id}
              onClick={() => setActive(t.id)}
              className={`relative inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                isActive ? "text-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              {t.label}
              <span className="text-[10px] text-muted-foreground/70 hidden sm:inline">· {t.hint}</span>
              {isActive && (
                <motion.span
                  layoutId="india-scanner-tab-indicator"
                  className="absolute inset-0 -z-10 rounded-full bg-muted"
                  transition={{ type: "spring", stiffness: 380, damping: 30 }}
                />
              )}
            </button>
          );
        })}
      </div>

      {error && (
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/5 p-3 text-sm text-rose-500">
          {error}
        </div>
      )}

      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="glass rounded-2xl overflow-hidden"
      >
        <div className="p-4 sm:p-5 border-b border-border/60 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-base sm:text-lg font-semibold">
              {result?.title ?? TABS.find((t) => t.id === active)?.label}
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              {result?.description ?? "Loading…"}
              {result && filteredTotal !== hits.length && (
                <span className="ml-1">· showing {filteredTotal} of {hits.length}</span>
              )}
            </p>
          </div>
          <FilterTabs tabs={tabs} active={activeTab} onChange={setActiveTab} />
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <SignalTableHead
                extraTrailHeaders={
                  <>
                    <th className="p-2.5 text-right font-medium">Metric</th>
                    <th className="p-2.5 font-medium">Tag</th>
                  </>
                }
              />
            </thead>
            <tbody>
              <AnimatePresence>
                {pageItems.map((h, i) => (
                  <SignalTableRow
                    key={h.symbol}
                    hit={h}
                    colSpan={COL_SPAN}
                    index={i}
                    expanded={expandedSymbol === h.symbol}
                    onToggle={() =>
                      setExpandedSymbol((prev) =>
                        prev === h.symbol ? null : h.symbol,
                      )
                    }
                    extraTrailCells={
                      <>
                        <td className="p-2.5 text-right tabular text-[11px] font-semibold text-[var(--color-fg-muted)]">
                          {h.metricLabel}
                        </td>
                        <td className="p-2.5">
                          {h.kind && (
                            <span
                              className={`text-[10px] font-bold px-2 py-0.5 rounded-full whitespace-nowrap ${kindClass(h.kind)}`}
                            >
                              {String(h.kind).replace(/_/g, " ")}
                            </span>
                          )}
                        </td>
                      </>
                    }
                  />
                ))}
              </AnimatePresence>

              {!result && loading && (
                <tr>
                  <td colSpan={COL_SPAN} className="p-8 text-center text-muted-foreground text-sm">
                    Running scanner…
                  </td>
                </tr>
              )}
              {result && hits.length === 0 && !loading && (
                <tr>
                  <td colSpan={COL_SPAN} className="p-8 text-center text-muted-foreground text-sm">
                    No hits.
                  </td>
                </tr>
              )}
              {result && hits.length > 0 && pageItems.length === 0 && !loading && (
                <tr>
                  <td colSpan={COL_SPAN} className="p-8 text-center text-muted-foreground text-sm">
                    No hits match the current filter.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="px-4 pb-4 sm:px-5 sm:pb-5">
          <PaginationStrip
            page={page}
            totalPages={totalPages}
            filteredTotal={filteredTotal}
            pageSize={pageSize}
            disabled={loading}
            onPrev={() => setPage(page - 1)}
            onNext={() => setPage(page + 1)}
            onJump={setPage}
          />
        </div>
      </motion.div>
    </div>
  );
}
