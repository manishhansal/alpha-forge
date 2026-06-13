"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { useIndiaMarketStore } from "@/store/india/marketStore";
import { useFeedStream } from "@/hooks/india/useFeedStream";
import { fmt, fmtPct } from "@/lib/india/format";

type Props = {
  symbols: string[];
  /** Display labels for each symbol (defaults to the symbol itself). */
  labels?: Record<string, string>;
};

export function LiveTicker({ symbols, labels }: Props) {
  useFeedStream(symbols, 5000);
  const ticks = useIndiaMarketStore((s) => s.ticks);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="overflow-hidden rounded-xl border border-border/60 bg-card/40 backdrop-blur"
    >
      <div className="flex gap-6 px-4 py-2 overflow-x-auto whitespace-nowrap text-xs">
        {symbols.map((s) => {
          const t = ticks[s];
          const pct = t?.changePct ?? null;
          const up = (pct ?? 0) >= 0;
          return (
            <span key={s} className="inline-flex items-center gap-2 shrink-0">
              <span className="font-medium text-muted-foreground">
                {labels?.[s] ?? s}
              </span>
              <span className="tabular font-semibold">
                {fmt(t?.ltp ?? null)}
              </span>
              <span
                className={`tabular ${up ? "text-emerald-500" : "text-rose-500"}`}
              >
                {pct == null ? "—" : fmtPct(pct)}
              </span>
            </span>
          );
        })}
      </div>
    </motion.div>
  );
}
