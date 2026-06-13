"use client";

import * as React from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import {
  ArrowDownRight,
  ArrowUpRight,
  Eye,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/india/ui/button";
import { useIndiaWatchlistStore } from "@/store/india/watchlistStore";
import { useIndiaMarketStore } from "@/store/india/marketStore";
import { useFeedStream } from "@/hooks/india/useFeedStream";
import { useLiveQuotes } from "@/hooks/india/useLiveQuotes";
import { fmt, fmtPct } from "@/lib/india/format";
import { FNO_STOCKS } from "@/lib/india/fno-symbols";

export default function WatchlistPage() {
  const items = useIndiaWatchlistStore((s) => s.items);
  const remove = useIndiaWatchlistStore((s) => s.remove);
  const add = useIndiaWatchlistStore((s) => s.add);

  const symbols = React.useMemo(() => items.map((i) => i.symbol), [items]);

  useFeedStream(symbols, 4000);
  useLiveQuotes(symbols, 12_000);

  const ticks = useIndiaMarketStore((s) => s.ticks);
  const quotes = useIndiaMarketStore((s) => s.quotes);

  const [search, setSearch] = React.useState("");
  const filtered = React.useMemo(() => {
    if (!search) return [] as string[];
    const q = search.toUpperCase();
    return FNO_STOCKS.filter((s) => s.includes(q)).slice(0, 8);
  }, [search]);

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
            <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight">
              Watchlist
            </h1>
            <p className="text-xs sm:text-sm text-muted-foreground">
              Live diff updates via SSE feed — only your visible symbols are
              subscribed.
            </p>
          </div>
        </div>

        <span className="text-[10px] text-muted-foreground">
          {items.length} symbol{items.length === 1 ? "" : "s"}
        </span>
      </motion.div>

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
                onClick={() => {
                  add(s);
                  setSearch("");
                }}
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
              <tr className="text-left border-b border-border/60 text-muted-foreground text-xs uppercase tracking-wide">
                <th className="p-3 font-medium">Symbol</th>
                <th className="p-3 font-medium text-right">LTP</th>
                <th className="p-3 font-medium text-right">Change %</th>
                <th className="p-3 font-medium text-right">Open</th>
                <th className="p-3 font-medium text-right">High</th>
                <th className="p-3 font-medium text-right">Low</th>
                <th className="p-3"></th>
              </tr>
            </thead>
            <tbody>
              <AnimatePresence>
                {items.map((item) => {
                  const tick = ticks[item.symbol];
                  const q = quotes[item.symbol];
                  const ltp = tick?.ltp ?? q?.price ?? null;
                  const changePct = tick?.changePct ?? q?.changePct ?? null;
                  const up = (changePct ?? 0) >= 0;
                  return (
                    <motion.tr
                      key={item.symbol}
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, x: -10 }}
                      className="border-b border-border/40 hover:bg-muted/30 transition-colors"
                    >
                      <td className="p-3 font-medium">
                        <Link
                          href={`/in/chart/${encodeURIComponent(item.symbol)}`}
                          className="text-blue-500 hover:text-blue-400 hover:underline"
                        >
                          {item.symbol}
                        </Link>
                        {q?.name && (
                          <div className="text-[10px] text-muted-foreground truncate max-w-[220px]">
                            {q.name}
                          </div>
                        )}
                      </td>
                      <td className="p-3 text-right tabular font-semibold">
                        {fmt(ltp)}
                      </td>
                      <td
                        className={`p-3 text-right tabular ${
                          up ? "text-emerald-500" : "text-rose-500"
                        }`}
                      >
                        <span className="inline-flex items-center justify-end gap-0.5">
                          {up ? (
                            <ArrowUpRight className="h-3 w-3" />
                          ) : (
                            <ArrowDownRight className="h-3 w-3" />
                          )}
                          {changePct == null ? "—" : fmtPct(changePct)}
                        </span>
                      </td>
                      <td className="p-3 text-right tabular text-muted-foreground">
                        {fmt(q?.open ?? null)}
                      </td>
                      <td className="p-3 text-right tabular text-muted-foreground">
                        {fmt(q?.high ?? null)}
                      </td>
                      <td className="p-3 text-right tabular text-muted-foreground">
                        {fmt(q?.low ?? null)}
                      </td>
                      <td className="p-3 text-right">
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          onClick={() => remove(item.symbol)}
                          aria-label="Remove"
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </td>
                    </motion.tr>
                  );
                })}
              </AnimatePresence>

              {items.length === 0 && (
                <tr>
                  <td
                    colSpan={7}
                    className="p-8 text-center text-sm text-muted-foreground"
                  >
                    Watchlist empty — add a symbol above.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </motion.div>
    </div>
  );
}
