"use client";

import { useState } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { LiquidationHeatSeries } from "@/features/heatmap/aggregate";
import { cn, formatCompact, formatPrice } from "@/lib/utils";
import type { SymbolId } from "@/types/market";

interface Props {
  series: LiquidationHeatSeries[];
}

export function LiquidationHeatmap({ series }: Props) {
  const symbols = series.map((s) => s.symbol);
  const [active, setActive] = useState<SymbolId>(symbols[0] ?? "BTC");
  const current = series.find((s) => s.symbol === active);

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex flex-col gap-1">
            <CardTitle>Liquidation heatmap · {active}</CardTitle>
            <p className="text-[11px] text-[var(--color-fg-subtle)]">
              Rolling {current ? Math.round(current.windowMs / 60_000) : 5}-minute buffer from Binance
              <code className="ml-1 font-mono text-[10px] text-[var(--color-fg-muted)]">
                !forceOrder@arr
              </code>{" "}
              — long liqs in red (sells), short liqs in green (buys).
            </p>
          </div>
          <div className="inline-flex items-center gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-1">
            {symbols.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setActive(s)}
                className={cn(
                  "rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors",
                  active === s
                    ? "bg-[var(--color-surface)] text-[var(--color-fg)] shadow-sm"
                    : "text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]",
                )}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent>{current ? <Bars data={current} /> : null}</CardContent>
    </Card>
  );
}

function Bars({ data }: { data: LiquidationHeatSeries }) {
  if (data.empty || data.buckets.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-8 text-center">
        <p className="text-[12px] text-[var(--color-fg-muted)]">
          No liquidations in the last {Math.round(data.windowMs / 60_000)} minutes.
        </p>
        <p className="text-[11px] text-[var(--color-fg-subtle)]">
          Make sure the worker is running (<code className="font-mono">npm run worker:dev</code>) and
          subscribed to <code className="font-mono">{data.pair}</code>.
        </p>
      </div>
    );
  }

  const max = data.maxBucketUsd || 1;

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-3 gap-3 text-[11px]">
        <Summary label="Mark price" value={`$${formatPrice(data.referencePrice)}`} />
        <Summary
          label={`${Math.round(data.windowMs / 60_000)}m total`}
          value={`$${formatCompact(data.totalNotionalUsd)}`}
        />
        <Summary label="Events" value={String(data.eventCount)} />
      </div>

      {/* Vertical price-level histogram. Each row is a bucket; bars grow from
          the centerline outward (longs left, shorts right) for at-a-glance
          imbalance reading. Sorted descending so highest price is on top. */}
      <ul className="flex flex-col gap-0.5">
        {[...data.buckets].reverse().map((b, i) => {
          const longW = (b.longNotionalUsd / max) * 50;
          const shortW = (b.shortNotionalUsd / max) * 50;
          const isCenter = i === Math.floor(data.buckets.length / 2);
          return (
            <li
              key={`${b.price}-${i}`}
              className={cn(
                "grid grid-cols-[80px_1fr_80px] items-center gap-2 rounded-sm py-0.5 text-[11px]",
                isCenter && "bg-[var(--color-surface-hover)]",
              )}
            >
              <span className="num truncate pr-2 text-right tabular-nums text-[var(--color-fg-muted)]">
                ${formatPrice(b.price)}
              </span>
              <div className="relative h-3 w-full rounded-sm bg-[var(--color-surface)]">
                <span className="absolute inset-y-0 left-1/2 w-px bg-[var(--color-border)]" />
                <span
                  className="absolute inset-y-0 right-1/2 rounded-l-sm bg-[var(--color-bear)]/65"
                  style={{ width: `${longW}%` }}
                  aria-label="Long liquidations"
                />
                <span
                  className="absolute inset-y-0 left-1/2 rounded-r-sm bg-[var(--color-bull)]/65"
                  style={{ width: `${shortW}%` }}
                  aria-label="Short liquidations"
                />
              </div>
              <span className="num pl-2 text-left tabular-nums text-[var(--color-fg)]">
                {b.totalNotionalUsd > 0 ? `$${formatCompact(b.totalNotionalUsd)}` : ""}
              </span>
            </li>
          );
        })}
      </ul>

      <div className="flex items-center justify-end gap-4 text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-subtle)]">
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-3 rounded-sm bg-[var(--color-bear)]/65" />
          Long liq
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-3 rounded-sm bg-[var(--color-bull)]/65" />
          Short liq
        </span>
      </div>
    </div>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3 py-2">
      <span className="text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-subtle)]">
        {label}
      </span>
      <span className="num text-sm font-medium text-[var(--color-fg)]">{value}</span>
    </div>
  );
}
