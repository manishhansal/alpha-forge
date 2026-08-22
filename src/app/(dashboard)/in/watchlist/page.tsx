"use client";

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Eye,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/india/ui/button";
import {
  PaginationStrip,
  usePaginationFilter,
} from "@/components/india/ui/pagination-filter";
import {
  SignalTableHead,
  SignalTableRow,
} from "@/components/india/ui/signal-table-row";
import { useIndiaWatchlistStore } from "@/store/india/watchlistStore";
import { useIndiaMarketStore } from "@/store/india/marketStore";
import { useFeedStream } from "@/hooks/india/useFeedStream";
import { useLiveQuotes } from "@/hooks/india/useLiveQuotes";
import { fmt } from "@/lib/india/format";
import { FNO_STOCKS } from "@/lib/india/fno-symbols";

// chevron + Symbol + Price + Chg% + High + Low + Remove = 7
const COL_SPAN = 7;

export default function WatchlistPage() {
  const items  = useIndiaWatchlistStore((s) => s.items);
  const remove = useIndiaWatchlistStore((s) => s.remove);
  const add    = useIndiaWatchlistStore((s) => s.add);
  const [expandedSymbol, setExpandedSymbol] = React.useState<string | null>(null);

  const symbols = React.useMemo(() => items.map((i) => i.symbol), [items]);

  useFeedStream(symbols, 4000);
  useLiveQuotes(symbols, 12_000);

  const ticks  = useIndiaMarketStore((s) => s.ticks);
  const quotes = useIndiaMarketStore((s) => s.quotes);

  const [search, setSearch] = React.useState("");
  const filtered = React.useMemo(() => {
    if (!search) return [] as string[];
    const q = search.toUpperCase();
    return FNO_STOCKS.filter((s) => s.includes(q)).slice(0, 8);
  }, [search]);

  const { pageItems, page, setPage, totalPages, filteredTotal, pageSize } =
    usePaginationFilter({ items, pageSize: 15 });

  // Build SignalRow shape from live tick + quote data for each watchlist item.
  const toSignalRow = React.useCallback(
    (symbol: string) => {
      const tick = ticks[symbol];
      const q    = quotes[symbol];
      const ltp  = tick?.ltp ?? q?.price ?? null;
      const changePct = tick?.changePct ?? q?.changePct ?? null;
      return {
        symbol,
        price: ltp,
        changePct,
        metric: Math.abs(changePct ?? 0),
        metricLabel: q?.open != null ? `Open ${fmt(q.open)}` : "",
        note:
          [
            q?.high != null ? `H ${fmt(q.high)}` : null,
            q?.low  != null ? `L ${fmt(q.low)}`  : null,
            q?.name ? q.name : null,
          ]
            .filter(Boolean)
            .join(" · ") || undefined,
      };
    },
    [ticks, quotes],
  );

  return (
    <div className="space-y-6">
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex items-end justify-between gap-3 flex-wrap"
      >
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-gradient-to-br from-amber-500/20 to-emerald-500/20 shrink-0">
            <Eye className="h-5 w-5 text-amber-500" />
          </div>
          <div>
            <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight">Watchlist</h1>
            <p className="text-xs sm:text-sm text-muted-foreground">
              Live diff updates via SSE feed — only your visible symbols are subscribed.
            </p>
          </div>
        </div>
        <span className="text-[10px] text-muted-foreground">
          {items.length} symbol{items.length === 1 ? "" : "s"}
        </span>
      </motion.div>

      {/* Symbol search / add */}
      <div className="relative">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Add F&O symbol (e.g. RELIANCE)…"
              className="w-full text-sm px-3 py-2 rounded-md bg-card/80 border border-border/60 outline-none focus:border-blue-400 transition-colors"
            />
            {search && (
              <button
                onClick={() => setSearch("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
        {filtered.length > 0 && (
          <div className="absolute left-0 right-0 mt-1 z-20 glass rounded-xl overflow-hidden shadow-lg">
            {filtered.map((s) => (
              <button
                key={s}
                onClick={() => { add(s); setSearch(""); }}
                className="w-full text-left px-3 py-2 text-sm hover:bg-muted/40 flex items-center justify-between"
              >
                <span className="font-medium">{s}</span>
                <Plus className="h-3.5 w-3.5 text-muted-foreground" />
              </button>
            ))}
          </div>
        )}
      </div>

      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="glass rounded-2xl overflow-hidden"
      >
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <SignalTableHead
                extraTrailHeaders={
                  <>
                    <th className="p-2.5 text-right font-medium">High</th>
                    <th className="p-2.5 text-right font-medium">Low</th>
                    <th className="p-2.5" />
                  </>
                }
              />
            </thead>
            <tbody>
              <AnimatePresence>
                {pageItems.map((item, i) => {
                  const q = quotes[item.symbol];
                  return (
                    <SignalTableRow
                      key={item.symbol}
                      hit={toSignalRow(item.symbol)}
                      colSpan={COL_SPAN}
                      index={i}
                      expanded={expandedSymbol === item.symbol}
                      onToggle={() =>
                        setExpandedSymbol((prev) =>
                          prev === item.symbol ? null : item.symbol,
                        )
                      }
                      extraTrailCells={
                        <>
                          <td className="p-2.5 text-right tabular text-[var(--color-fg-muted)] text-sm">
                            {fmt(q?.high ?? null)}
                          </td>
                          <td className="p-2.5 text-right tabular text-[var(--color-fg-muted)] text-sm">
                            {fmt(q?.low ?? null)}
                          </td>
                          <td className="p-2.5">
                            <Button
                              size="icon-xs"
                              variant="ghost"
                              onClick={(e) => {
                                e.stopPropagation();
                                remove(item.symbol);
                              }}
                              aria-label="Remove"
                            >
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          </td>
                        </>
                      }
                    />
                  );
                })}
              </AnimatePresence>

              {items.length === 0 && (
                <tr>
                  <td colSpan={COL_SPAN} className="p-8 text-center text-sm text-muted-foreground">
                    Watchlist empty — add a symbol above.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="px-4 pb-4">
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
    </div>
  );
}
