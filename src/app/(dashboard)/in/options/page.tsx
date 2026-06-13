"use client";

import * as React from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { AlertTriangle, Layers, RefreshCw } from "lucide-react";
import { OptionChainTable } from "@/components/india/options/option-chain-table";
import { Button } from "@/components/india/ui/button";
import { useIndiaOptionChainStore } from "@/store/india/optionChainStore";
import { useOptionChain } from "@/hooks/india/useOptionChain";
import { FNO_INDICES } from "@/lib/india/fno-symbols";

const SUGGESTED_STOCKS = [
  "RELIANCE",
  "HDFCBANK",
  "ICICIBANK",
  "TCS",
  "INFY",
  "SBIN",
  "AXISBANK",
  "BAJFINANCE",
  "LT",
  "ITC",
];

function OptionsInner() {
  const search = useSearchParams();
  const router = useRouter();
  const initialSymbol = (search?.get("symbol") ?? "NIFTY").toUpperCase();

  const symbol = useIndiaOptionChainStore((s) => s.symbol);
  const setSymbol = useIndiaOptionChainStore((s) => s.setSymbol);
  const data = useIndiaOptionChainStore((s) => s.data);
  const loading = useIndiaOptionChainStore((s) => s.loading);
  const error = useIndiaOptionChainStore((s) => s.error);
  const refresh = useIndiaOptionChainStore((s) => s.refresh);

  React.useEffect(() => {
    if (initialSymbol !== symbol) setSymbol(initialSymbol);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSymbol]);

  useOptionChain(20_000);

  const [search2, setSearch2] = React.useState("");

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const v = search2.trim().toUpperCase();
    if (!v) return;
    router.replace(`/in/options?symbol=${encodeURIComponent(v)}`);
    setSymbol(v);
    setSearch2("");
  };

  return (
    <div className="space-y-6">
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex flex-wrap items-end justify-between gap-3"
      >
        <div className="flex items-center gap-3 min-w-0">
          <div className="p-2 rounded-lg bg-gradient-to-br from-blue-500/20 to-violet-500/20 shrink-0">
            <Layers className="h-5 w-5 text-blue-500" />
          </div>
          <div className="min-w-0">
            <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight">
              Option Chain — <span className="text-blue-500">{symbol}</span>
            </h1>
            <p className="text-xs sm:text-sm text-muted-foreground">
              Live PCR, OI build-up, IV skew & max-pain analytics
            </p>
          </div>
        </div>

        <form onSubmit={onSubmit} className="flex gap-2">
          <input
            value={search2}
            onChange={(e) => setSearch2(e.target.value)}
            placeholder="Symbol (e.g. RELIANCE)"
            className="text-sm px-3 py-1.5 rounded-md bg-card/80 border border-border/60 outline-none focus:border-blue-400 transition-colors"
          />
          <Button type="submit" size="sm">
            Load
          </Button>
        </form>
      </motion.div>

      <div className="flex flex-wrap gap-1.5 items-center">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground mr-1">
          Indices
        </span>
        {FNO_INDICES.map((i) => {
          const active = i.underlying === symbol;
          return (
            <button
              key={i.underlying}
              onClick={() => {
                setSymbol(i.underlying);
                router.replace(`/in/options?symbol=${i.underlying}`);
              }}
              className={`text-xs px-2.5 py-1 rounded-md font-medium transition-colors ${
                active
                  ? "bg-foreground text-background"
                  : "bg-muted text-muted-foreground hover:bg-muted/70"
              }`}
            >
              {i.underlying}
            </button>
          );
        })}
        <span className="mx-2 text-muted-foreground/40">·</span>
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground mr-1">
          Stocks
        </span>
        {SUGGESTED_STOCKS.map((s) => {
          const active = s === symbol;
          return (
            <button
              key={s}
              onClick={() => {
                setSymbol(s);
                router.replace(`/in/options?symbol=${s}`);
              }}
              className={`text-xs px-2.5 py-1 rounded-md font-medium transition-colors ${
                active
                  ? "bg-foreground text-background"
                  : "bg-muted text-muted-foreground hover:bg-muted/70"
              }`}
            >
              {s}
            </button>
          );
        })}
      </div>

      {error && (
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/5 p-3 flex items-start gap-3">
          <AlertTriangle className="h-4 w-4 text-rose-500 mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0 text-sm text-rose-500">
            <div className="font-medium">Couldn’t load the option chain</div>
            <div className="mt-0.5 text-xs text-rose-500/80 break-words">
              {error}
            </div>
            <div className="mt-1 text-[11px] text-muted-foreground">
              NSE shadow-throttles requests from non-Indian server IPs (and
              from any IP that&apos;s made too many hits). Usually clears in
              30–60s — wait, then Retry. If you&apos;re self-hosting, an Indian
              egress IP / VPN is the only reliable workaround until a paid
              broker option-chain adapter (Zerodha / Upstox) is wired up.
            </div>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={refresh}
            disabled={loading}
            className="shrink-0"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 mr-1.5 ${loading ? "animate-spin" : ""}`}
            />
            Retry
          </Button>
        </div>
      )}

      {data ? (
        <OptionChainTable data={data} loading={loading} spread={10} />
      ) : (
        <div className="glass rounded-2xl p-12 text-center text-sm text-muted-foreground">
          {loading
            ? "Loading option chain…"
            : error
              ? "No chain to display while the upstream source is rate-limiting."
              : "No data."}
        </div>
      )}
    </div>
  );
}

export default function OptionsPage() {
  return (
    <React.Suspense
      fallback={
        <div className="p-8 text-center text-sm text-muted-foreground">
          Loading…
        </div>
      }
    >
      <OptionsInner />
    </React.Suspense>
  );
}
