"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import Link from "next/link";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { TRACKED_SYMBOLS } from "@/lib/constants";
import { cn, formatPrice } from "@/lib/utils";
import type { SignalType, SignalsResponse } from "@/types/market";

async function fetchSignals(): Promise<SignalsResponse> {
  const res = await fetch("/api/signals", { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load signals (${res.status})`);
  return res.json();
}

const TYPE_TONE: Record<SignalType, { tone: string; bg: string }> = {
  LONG: { tone: "text-[var(--color-bull)]", bg: "bg-[color-mix(in_oklch,var(--color-bull)_15%,transparent)]" },
  BUY: { tone: "text-[var(--color-bull)]", bg: "bg-[color-mix(in_oklch,var(--color-bull)_10%,transparent)]" },
  SHORT: { tone: "text-[var(--color-bear)]", bg: "bg-[color-mix(in_oklch,var(--color-bear)_15%,transparent)]" },
  SELL: { tone: "text-[var(--color-bear)]", bg: "bg-[color-mix(in_oklch,var(--color-bear)_10%,transparent)]" },
  HOLD: { tone: "text-[var(--color-fg-muted)]", bg: "bg-[var(--color-surface-hover)]" },
};

const TYPE_ICON = {
  LONG: ArrowUpRight,
  BUY: ArrowUpRight,
  SHORT: ArrowDownRight,
  SELL: ArrowDownRight,
  HOLD: Minus,
} as const;

interface QuickSignalsProps {
  initialData?: SignalsResponse;
}

export function QuickSignals({ initialData }: QuickSignalsProps = {}) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["signals"],
    queryFn: fetchSignals,
    refetchInterval: 30_000,
    staleTime: 15_000,
    initialData,
    initialDataUpdatedAt: initialData?.generatedAt,
  });

  if (isLoading && !data) {
    return <Skeleton className="h-[210px] w-full rounded-xl" />;
  }

  if (isError || !data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Quick Signals</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-[var(--color-fg-muted)]">Unable to load signals right now.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Quick Signals</CardTitle>
          <Link
            href="/signals"
            className="text-[11px] font-medium text-[var(--color-brand)] hover:underline"
          >
            View all →
          </Link>
        </div>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col divide-y divide-[var(--color-border)]">
          {data.signals.map((s) => {
            const meta = TRACKED_SYMBOLS.find((m) => m.id === s.symbol)!;
            const tone = TYPE_TONE[s.type];
            const Icon = TYPE_ICON[s.type];
            return (
              <li key={s.id} className="grid grid-cols-[auto_1fr_auto] items-center gap-3 py-2.5">
                <span
                  className="grid h-7 w-7 place-items-center rounded-full text-[11px] font-semibold"
                  style={{
                    background: `color-mix(in oklch, ${meta.color} 18%, transparent)`,
                    color: meta.color,
                  }}
                >
                  {s.symbol}
                </span>
                <div className="flex min-w-0 items-baseline gap-2">
                  <span className={cn("inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider", tone.bg, tone.tone)}>
                    <Icon className="h-3 w-3" />
                    {s.type}
                  </span>
                  <span className="text-[11px] text-[var(--color-fg-muted)]">
                    confidence {(s.confidence * 100).toFixed(0)}%
                  </span>
                </div>
                <span className="num text-xs font-medium">${formatPrice(s.entry)}</span>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
