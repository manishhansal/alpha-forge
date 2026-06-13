"use client";

import * as React from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import {
  Activity,
  Expand,
  Flame,
  Gauge,
  PlusCircle,
  Radar,
  Rocket,
  TrendingUp,
} from "lucide-react";
import { Button } from "@/components/india/ui/button";
import { useIndiaScannerStore } from "@/store/india/scannerStore";
import { useIndiaWatchlistStore } from "@/store/india/watchlistStore";
import { useScanner } from "@/hooks/india/useScanner";
import { fmt, fmtPct } from "@/lib/india/format";
import type { ScannerType } from "@/types/india/scanner";

type Tab = {
  id: ScannerType;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  hint: string;
};

const TABS: Tab[] = [
  {
    id: "range-expansion",
    label: "Range Expansion",
    icon: Expand,
    hint: "WR8 + bullish trend",
  },
  { id: "momentum", label: "Momentum", icon: TrendingUp, hint: "Top % movers" },
  {
    id: "volume-breakout",
    label: "Volume",
    icon: Rocket,
    hint: "≥1.5× 20-day avg",
  },
  {
    id: "oi-buildup",
    label: "OI Buildup",
    icon: Activity,
    hint: "Long/short build-up",
  },
  { id: "pcr", label: "PCR", icon: Gauge, hint: "Put-Call Ratio" },
  { id: "iv-spike", label: "IV", icon: Flame, hint: "ATM implied volatility" },
];

function kindClass(kind?: string): string {
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

export default function ScannerPage() {
  const active = useIndiaScannerStore((s) => s.active);
  const setActive = useIndiaScannerStore((s) => s.setActive);
  const result = useIndiaScannerStore((s) => s.results[active]);
  const loading = useIndiaScannerStore((s) => s.loading[active]);
  const error = useIndiaScannerStore((s) => s.errors[active]);

  const interval =
    active === "momentum" || active === "volume-breakout"
      ? 15_000
      : active === "range-expansion"
        ? 60_000
        : 30_000;
  useScanner(active, interval, 25);

  const addToWatchlist = useIndiaWatchlistStore((s) => s.add);

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
            <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight">
              F&amp;O Scanner
            </h1>
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

      <div className="flex flex-wrap gap-1.5">
        {TABS.map((t) => {
          const Icon = t.icon;
          const isActive = t.id === active;
          return (
            <button
              key={t.id}
              onClick={() => setActive(t.id)}
              className={`relative inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                isActive
                  ? "text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              {t.label}
              <span className="text-[10px] text-muted-foreground/70 hidden sm:inline">
                · {t.hint}
              </span>
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
        <div className="p-4 sm:p-5 border-b border-border/60">
          <h2 className="text-base sm:text-lg font-semibold">
            {result?.title ?? TABS.find((t) => t.id === active)?.label}
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            {result?.description ?? "Loading…"}
          </p>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left border-b border-border/60 text-muted-foreground text-xs uppercase tracking-wide">
                <th className="p-3 font-medium">#</th>
                <th className="p-3 font-medium">Symbol</th>
                <th className="p-3 font-medium text-right">Price</th>
                <th className="p-3 font-medium text-right">Day %</th>
                <th className="p-3 font-medium text-right">Metric</th>
                <th className="p-3 font-medium">Tag</th>
                <th className="p-3 font-medium">Note</th>
                <th className="p-3"></th>
              </tr>
            </thead>
            <tbody>
              <AnimatePresence>
                {result?.hits.map((h, i) => (
                  <motion.tr
                    key={h.symbol}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    transition={{ delay: Math.min(i * 0.015, 0.4) }}
                    className="border-b border-border/40 hover:bg-muted/30 transition-colors"
                  >
                    <td className="p-3 text-muted-foreground">{i + 1}</td>
                    <td className="p-3 font-medium">
                      <Link
                        href={`/in/chart/${encodeURIComponent(h.symbol)}`}
                        className="text-blue-500 hover:text-blue-400 hover:underline"
                      >
                        {h.symbol}
                      </Link>
                    </td>
                    <td className="p-3 text-right tabular">{fmt(h.price)}</td>
                    <td
                      className={`p-3 text-right tabular font-medium ${
                        (h.changePct ?? 0) >= 0
                          ? "text-emerald-500"
                          : "text-rose-500"
                      }`}
                    >
                      {h.changePct == null ? "—" : fmtPct(h.changePct)}
                    </td>
                    <td className="p-3 text-right tabular font-semibold">
                      {h.metricLabel}
                    </td>
                    <td className="p-3">
                      {h.kind && (
                        <span
                          className={`text-[10px] font-bold px-2 py-0.5 rounded-full whitespace-nowrap ${kindClass(h.kind)}`}
                        >
                          {String(h.kind).replace("_", " ")}
                        </span>
                      )}
                    </td>
                    <td className="p-3 text-xs text-muted-foreground max-w-[260px] truncate">
                      {h.note ?? ""}
                    </td>
                    <td className="p-3">
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => addToWatchlist(h.symbol)}
                        title="Add to watchlist"
                      >
                        <PlusCircle className="h-3 w-3 mr-1" />
                        Watch
                      </Button>
                    </td>
                  </motion.tr>
                ))}
              </AnimatePresence>

              {!result && loading && (
                <tr>
                  <td
                    colSpan={8}
                    className="p-8 text-center text-muted-foreground text-sm"
                  >
                    Running scanner…
                  </td>
                </tr>
              )}
              {result && result.hits.length === 0 && !loading && (
                <tr>
                  <td
                    colSpan={8}
                    className="p-8 text-center text-muted-foreground text-sm"
                  >
                    No hits.
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
