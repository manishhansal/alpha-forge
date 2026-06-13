"use client";

import { useEffect, useState } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TRACKED_SYMBOLS } from "@/lib/constants";
import { cn, formatPercent } from "@/lib/utils";
import { getClientBroker } from "@/services/brokers/client";
import type { FuturesSymbolView } from "@/types/market";

interface Props {
  symbols: FuturesSymbolView[];
}

function useCountdown(targetTs: number): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const diff = Math.max(0, targetTs - now);
  if (!targetTs || diff === 0) return "—";
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  const s = Math.floor((diff % 60_000) / 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function FundingRow({ row }: { row: FuturesSymbolView }) {
  const meta = TRACKED_SYMBOLS.find((s) => s.id === row.symbol)!;
  const pairLabel = getClientBroker().pairs.futures[row.symbol];
  const countdown = useCountdown(row.nextFundingTime);
  const fundingPct = row.fundingRate * 100;
  const positive = fundingPct >= 0;
  return (
    <tr className="border-b border-[var(--color-border)] last:border-b-0">
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          <span
            className="grid h-6 w-6 place-items-center rounded-full text-[10px] font-semibold"
            style={{
              background: `color-mix(in oklch, ${meta.color} 18%, transparent)`,
              color: meta.color,
            }}
          >
            {row.symbol}
          </span>
          <span className="text-xs text-[var(--color-fg-muted)]">{pairLabel}</span>
        </div>
      </td>
      <td className={cn("px-4 py-3 text-right num text-sm font-medium", positive ? "text-bull" : "text-bear")}>
        {formatPercent(fundingPct, 4)}
      </td>
      <td className={cn("px-4 py-3 text-right num text-sm", positive ? "text-bull" : "text-bear")}>
        {(row.fundingRateAnnualized * 100).toFixed(2)}%
      </td>
      <td className="px-4 py-3 text-right num text-xs text-[var(--color-fg-muted)]">{countdown}</td>
    </tr>
  );
}

export function FundingTable({ symbols }: Props) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Funding Rates</CardTitle>
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        <table className="min-w-full text-left">
          <thead>
            <tr className="border-b border-[var(--color-border)] text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-subtle)]">
              <th className="px-4 py-2 font-medium">Symbol</th>
              <th className="px-4 py-2 text-right font-medium">8h Rate</th>
              <th className="px-4 py-2 text-right font-medium">Annualized</th>
              <th className="px-4 py-2 text-right font-medium">Next In</th>
            </tr>
          </thead>
          <tbody>
            {symbols.map((s) => (
              <FundingRow key={s.symbol} row={s} />
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
