"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { use } from "react";
import { motion } from "framer-motion";
import { ArrowLeft, ArrowDownRight, ArrowUpRight, Star } from "lucide-react";
import { Button } from "@/components/india/ui/button";
import { useLiveQuotes } from "@/hooks/india/useLiveQuotes";
import { useFeedStream } from "@/hooks/india/useFeedStream";
import { useIndiaMarketStore } from "@/store/india/marketStore";
import { useIndiaWatchlistStore } from "@/store/india/watchlistStore";
import { fmt, fmtPct } from "@/lib/india/format";

const PriceChart = dynamic(
  () =>
    import("@/components/india/charts/price-chart").then((m) => m.PriceChart),
  {
    ssr: false,
    loading: () => (
      <div className="h-[460px] rounded-xl border border-border/60 bg-card/50 flex items-center justify-center text-sm text-muted-foreground">
        Loading chart…
      </div>
    ),
  },
);

type Params = { symbol: string };

export default function ChartPage({ params }: { params: Promise<Params> }) {
  const { symbol: rawSymbol } = use(params);
  const symbol = decodeURIComponent(rawSymbol).toUpperCase();

  const symbols = React.useMemo(() => [symbol], [symbol]);
  useLiveQuotes(symbols, 8000);
  useFeedStream(symbols, 4000);

  const quote = useIndiaMarketStore((s) => s.quotes[symbol]);
  const tick = useIndiaMarketStore((s) => s.ticks[symbol]);
  const ltp = tick?.ltp ?? quote?.price ?? null;
  const changePct = tick?.changePct ?? quote?.changePct ?? null;
  const change = quote?.change ?? null;

  const isWatched = useIndiaWatchlistStore((s) => s.has(symbol));
  const toggle = useIndiaWatchlistStore((s) => s.toggle);

  const up = (changePct ?? 0) >= 0;

  return (
    <div className="space-y-6">
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex items-end justify-between gap-3 flex-wrap"
      >
        <div className="flex items-start gap-3">
          <Link href="/in/dashboard">
            <Button size="icon-sm" variant="ghost" className="rounded-full">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight">
                {symbol}
              </h1>
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={() => toggle(symbol)}
                aria-label="Toggle watchlist"
                className="rounded-full"
              >
                <Star
                  className={`h-4 w-4 ${isWatched ? "fill-amber-400 text-amber-400" : "text-muted-foreground"}`}
                />
              </Button>
            </div>
            <div className="flex items-baseline gap-3 mt-1">
              <span className="text-3xl font-semibold tabular tracking-tight">
                {fmt(ltp)}
              </span>
              <span
                className={`inline-flex items-center gap-1 text-sm font-medium ${
                  up ? "text-emerald-500" : "text-rose-500"
                }`}
              >
                {up ? (
                  <ArrowUpRight className="h-4 w-4" />
                ) : (
                  <ArrowDownRight className="h-4 w-4" />
                )}
                <span className="tabular">
                  {change != null ? fmt(change) : "—"} ({fmtPct(changePct)})
                </span>
              </span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Link href={`/in/options?symbol=${encodeURIComponent(symbol)}`}>
            <Button size="sm" variant="outline" className="rounded-full">
              Option chain
            </Button>
          </Link>
          <a
            href={`https://in.tradingview.com/chart/?symbol=NSE%3A${symbol}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            <Button size="sm" variant="outline" className="rounded-full">
              TradingView
            </Button>
          </a>
        </div>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.05 }}
        className="glass rounded-2xl p-3 sm:p-4 shadow-sm"
      >
        <PriceChart symbol={symbol} />
      </motion.div>

      <div className="grid sm:grid-cols-4 gap-3">
        <Stat label="Open" value={fmt(quote?.open ?? null)} />
        <Stat label="Day High" value={fmt(quote?.high ?? null)} />
        <Stat label="Day Low" value={fmt(quote?.low ?? null)} />
        <Stat label="Prev Close" value={fmt(quote?.prevClose ?? null)} />
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="glass rounded-xl p-3">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 text-lg font-semibold tabular">{value}</div>
    </div>
  );
}
