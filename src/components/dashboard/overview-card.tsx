"use client";

import { motion } from "framer-motion";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TRACKED_SYMBOLS } from "@/lib/constants";
import { cn, formatCompact, formatPercent, formatPrice } from "@/lib/utils";
import { getClientBroker } from "@/services/brokers/client";
import { useMarketStore } from "@/store/marketStore";
import type { MarketOverviewEntry, SymbolId } from "@/types/market";

interface OverviewCardProps {
  entry: MarketOverviewEntry;
}

function useLivePrice(symbol: SymbolId, fallback: number) {
  const live = useMarketStore((s) => s.tickers[symbol]?.price);
  return live ?? fallback;
}

export function OverviewCard({ entry }: OverviewCardProps) {
  const meta = TRACKED_SYMBOLS.find((s) => s.id === entry.symbol)!;
  const broker = getClientBroker();
  const pairLabel = broker.pairs.spot[entry.symbol];
  const price = useLivePrice(entry.symbol, entry.price);
  const liveTicker = useMarketStore((s) => s.tickers[entry.symbol]);
  const changePct = liveTicker?.changePct24h ?? entry.changePct24h;
  const positive = changePct >= 0;

  const prevPriceRef = useRef(price);
  const [flash, setFlash] = useState<"up" | "down" | null>(null);

  useEffect(() => {
    if (price !== prevPriceRef.current) {
      setFlash(price > prevPriceRef.current ? "up" : "down");
      prevPriceRef.current = price;
      const t = setTimeout(() => setFlash(null), 450);
      return () => clearTimeout(t);
    }
  }, [price]);

  return (
    <Card
      className={cn(
        "relative overflow-hidden transition-colors",
        flash === "up" && "ring-1 ring-[color-mix(in_oklch,var(--color-bull)_45%,transparent)]",
        flash === "down" && "ring-1 ring-[color-mix(in_oklch,var(--color-bear)_45%,transparent)]",
      )}
    >
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-px"
        style={{ background: `linear-gradient(90deg, transparent, ${meta.color}, transparent)` }}
      />
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span
              aria-hidden
              className="grid h-7 w-7 place-items-center rounded-full text-[11px] font-semibold"
              style={{
                background: `color-mix(in oklch, ${meta.color} 18%, transparent)`,
                color: meta.color,
              }}
            >
              {entry.symbol}
            </span>
            <div className="flex flex-col">
              <CardTitle className="text-[var(--color-fg)]">{meta.name}</CardTitle>
              <span className="text-[10px] uppercase tracking-[0.16em] text-[var(--color-fg-subtle)]">
                {pairLabel}
              </span>
            </div>
          </div>

          <span
            className={cn(
              "inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset",
              positive
                ? "bg-[color-mix(in_oklch,var(--color-bull)_14%,transparent)] text-[var(--color-bull)] ring-[color-mix(in_oklch,var(--color-bull)_30%,transparent)]"
                : "bg-[color-mix(in_oklch,var(--color-bear)_14%,transparent)] text-[var(--color-bear)] ring-[color-mix(in_oklch,var(--color-bear)_30%,transparent)]",
            )}
          >
            {positive ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
            {formatPercent(changePct)}
          </span>
        </div>
      </CardHeader>

      <CardContent>
        <motion.div
          key={Math.round(price * 100)}
          initial={{ opacity: 0.6, y: 2 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.18, ease: "easeOut" }}
          className="num text-[28px] font-semibold leading-none tracking-tight"
        >
          ${formatPrice(price)}
        </motion.div>

        <dl className="mt-4 grid grid-cols-3 gap-3 text-[11px]">
          <Stat label="24h High" value={`$${formatPrice(entry.high24h)}`} />
          <Stat label="24h Low" value={`$${formatPrice(entry.low24h)}`} />
          <Stat label="Volume" value={`$${formatCompact(entry.quoteVolume24h)}`} />
          <Stat label="Mkt Cap" value={`$${formatCompact(entry.marketCap)}`} />
          <Stat label="Dominance" value={`${entry.dominance.toFixed(2)}%`} />
          <Stat
            label="Range"
            value={
              entry.high24h > 0 && entry.low24h > 0
                ? `${(((price - entry.low24h) / (entry.high24h - entry.low24h)) * 100).toFixed(0)}%`
                : "—"
            }
          />
        </dl>
      </CardContent>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-subtle)]">{label}</dt>
      <dd className="num text-[12px] font-medium text-[var(--color-fg)]">{value}</dd>
    </div>
  );
}
