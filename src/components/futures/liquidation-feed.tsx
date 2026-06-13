"use client";

import { motion } from "framer-motion";
import { ArrowDown, ArrowUp } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useLiquidationStream } from "@/hooks/useLiquidationStream";
import { SYMBOLS_BY_BINANCE } from "@/lib/constants";
import { cn, formatCompact } from "@/lib/utils";
import { useLiquidationStore } from "@/store/liquidationStore";

const STATUS_LABEL: Record<string, { label: string; tone: string }> = {
  open: { label: "Live", tone: "text-bull" },
  connecting: { label: "Connecting…", tone: "text-[var(--color-warning)]" },
  closed: { label: "Reconnecting…", tone: "text-[var(--color-warning)]" },
  error: { label: "Error", tone: "text-bear" },
  idle: { label: "Idle", tone: "text-[var(--color-fg-muted)]" },
};

export function LiquidationFeed() {
  useLiquidationStream({ filterToTracked: true });
  const events = useLiquidationStore((s) => s.events);
  const status = useLiquidationStore((s) => s.status);
  const buy = useLiquidationStore((s) => s.buyNotional5m);
  const sell = useLiquidationStore((s) => s.sellNotional5m);
  const total = useLiquidationStore((s) => s.totalNotional5m);

  const meta = STATUS_LABEL[status] ?? STATUS_LABEL.idle;
  const longPct = total > 0 ? (sell / total) * 100 : 50;
  const shortPct = total > 0 ? (buy / total) * 100 : 50;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Liquidations · BTC · ETH · SOL</CardTitle>
          <span className={cn("text-[11px] font-medium", meta.tone)}>{meta.label}</span>
        </div>
      </CardHeader>
      <CardContent>
        <div className="mb-3 grid grid-cols-3 gap-3 text-[11px]">
          <Stat label="5m total" value={`$${formatCompact(total)}`} />
          <Stat label="Longs liquidated" value={`$${formatCompact(sell)}`} tone="bear" />
          <Stat label="Shorts liquidated" value={`$${formatCompact(buy)}`} tone="bull" />
        </div>
        <div className="mb-4 flex h-2 w-full overflow-hidden rounded-full bg-[var(--color-surface-hover)]">
          <div className="h-full bg-[var(--color-bear)]" style={{ width: `${longPct}%` }} />
          <div className="h-full bg-[var(--color-bull)]" style={{ width: `${shortPct}%` }} />
        </div>

        <div className="-mx-1 max-h-[260px] overflow-y-auto pr-1">
          {events.length === 0 ? (
            <p className="px-1 py-6 text-center text-xs text-[var(--color-fg-muted)]">
              Waiting for liquidations…
            </p>
          ) : (
            <ul className="flex flex-col">
              {events.map((event) => {
                const symbolMeta = SYMBOLS_BY_BINANCE[event.symbol];
                const isShortLiq = event.side === "BUY";
                return (
                  <motion.li
                    key={`${event.ts}-${event.symbol}-${event.side}-${event.qty}`}
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: 0.18 }}
                    className="grid grid-cols-[auto_1fr_auto] items-center gap-3 border-b border-[var(--color-border)] px-1 py-2 text-xs last:border-b-0"
                  >
                    <span
                      className={cn(
                        "grid h-5 w-5 place-items-center rounded-full",
                        isShortLiq ? "bg-bull/10 text-bull" : "bg-bear/10 text-bear",
                      )}
                    >
                      {isShortLiq ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
                    </span>
                    <div className="flex min-w-0 items-baseline gap-2">
                      <span className="font-semibold">{symbolMeta?.id ?? event.symbol}</span>
                      <span className={cn(isShortLiq ? "text-bull" : "text-bear")}>
                        {isShortLiq ? "Short liq" : "Long liq"}
                      </span>
                      <span className="num text-[var(--color-fg-muted)]">@ ${event.price.toFixed(2)}</span>
                    </div>
                    <span className="num font-medium">${formatCompact(event.notionalUsd)}</span>
                  </motion.li>
                );
              })}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "bull" | "bear" }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3 py-2">
      <span className="text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-subtle)]">{label}</span>
      <span
        className={cn(
          "num text-sm font-medium",
          tone === "bull" ? "text-bull" : tone === "bear" ? "text-bear" : "text-[var(--color-fg)]",
        )}
      >
        {value}
      </span>
    </div>
  );
}
