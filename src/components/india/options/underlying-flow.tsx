"use client";

import * as React from "react";
import type { Quote } from "@/types/india";
import { fmt } from "@/lib/india/format";

/**
 * Compact micro-flow strip for the option-chain underlying. Surfaces the
 * FULL-mode broker enrichment (order-book imbalance, 52-week range, daily
 * circuit limits) that rides the `/api/in/quote` payload. Renders nothing
 * unless at least one enrichment field is present, so index underlyings (which
 * have no order book) and non-Angel deployments degrade to the prior layout.
 */
export function UnderlyingFlow({
  quote,
}: {
  quote: Quote | null | undefined;
}) {
  if (!quote) return null;

  const imb = quote.orderBookImbalance ?? null;
  const hi = quote.weekHigh52 ?? null;
  const lo = quote.weekLow52 ?? null;
  const uc = quote.upperCircuit ?? null;
  const lc = quote.lowerCircuit ?? null;

  if (imb == null && hi == null && lo == null && uc == null && lc == null) {
    return null;
  }

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
      {imb != null && <ImbalanceTile imb={imb} />}
      {(hi != null || lo != null) && (
        <FlowTile label="52W High" value={fmt(hi)} accent="text-rose-500" />
      )}
      {(hi != null || lo != null) && (
        <FlowTile label="52W Low" value={fmt(lo)} accent="text-emerald-500" />
      )}
      {(uc != null || lc != null) && (
        <FlowTile
          label="Circuit"
          value={`${fmt(lc)} – ${fmt(uc)}`}
          accent="text-foreground"
        />
      )}
    </div>
  );
}

function ImbalanceTile({ imb }: { imb: number }) {
  const pct = Math.round(imb * 100);
  const pctLabel = `${pct > 0 ? "+" : ""}${pct}%`;
  const sentiment =
    imb > 0.05 ? "Buy pressure" : imb < -0.05 ? "Sell pressure" : "Balanced";
  const accent =
    imb > 0.05
      ? "text-emerald-500"
      : imb < -0.05
        ? "text-rose-500"
        : "text-foreground";
  // Center-origin gauge: bar grows right for buy pressure, left for sell.
  const widthPct = Math.min(50, Math.abs(imb) * 50);

  return (
    <div className="glass rounded-xl p-3">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
        Order-book Δ
      </div>
      <div className={`mt-1 text-lg font-semibold tabular ${accent}`}>
        {pctLabel}
      </div>
      <div className="relative mt-1.5 h-1 rounded-full bg-muted/50">
        <span className="absolute inset-y-0 left-1/2 w-px bg-border" />
        <span
          className={`absolute inset-y-0 rounded-full ${
            imb >= 0 ? "bg-emerald-500 left-1/2" : "bg-rose-500 right-1/2"
          }`}
          style={{ width: `${widthPct}%` }}
        />
      </div>
      <div className="text-[10px] text-muted-foreground mt-0.5 truncate">
        {sentiment}
      </div>
    </div>
  );
}

function FlowTile({
  label,
  value,
  accent = "text-foreground",
}: {
  label: string;
  value: string;
  accent?: string;
}) {
  return (
    <div className="glass rounded-xl p-3">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className={`mt-1 text-lg font-semibold tabular ${accent}`}>
        {value}
      </div>
    </div>
  );
}
