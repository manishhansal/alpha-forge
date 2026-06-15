"use client";

import * as React from "react";
import { AlertTriangle, Bomb, Dices, RefreshCw } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import type {
  ExpiryIndexBlock,
  ExpiryTrade,
} from "@/features/india/expiry-trades/engine";
import type { ExpiryTradesResponse } from "@/features/india/expiry-trades/builder";
import { fmt } from "@/lib/india/format";
import { cn } from "@/lib/utils";

interface Props {
  initialData: ExpiryTradesResponse;
  endpoint?: string;
  intervalMs?: number;
}

/**
 * Expiry-day-only section — Gamma Blast + Hero Zero index option plays. Renders
 * nothing on a non-expiry day; on an expiry day it paints the SSR payload and
 * polls so premiums / spot stay live through the session.
 */
export function ExpiryTradesSection({
  initialData,
  endpoint = "/api/in/expiry-trades",
  intervalMs = 30_000,
}: Props) {
  const [data, setData] = React.useState<ExpiryTradesResponse>(initialData);
  const [refreshing, setRefreshing] = React.useState(false);

  const refresh = React.useCallback(
    async (signal?: AbortSignal) => {
      setRefreshing(true);
      try {
        const res = await fetch(endpoint, { cache: "no-store", signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setData((await res.json()) as ExpiryTradesResponse);
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
      } finally {
        setRefreshing(false);
      }
    },
    [endpoint],
  );

  React.useEffect(() => {
    const ac = new AbortController();
    const id = setInterval(() => void refresh(ac.signal), intervalMs);
    return () => {
      ac.abort();
      clearInterval(id);
    };
  }, [intervalMs, refresh]);

  if (!data.isExpiryDay || data.indexes.length === 0) return null;

  return (
    <section className="flex flex-col gap-4 rounded-2xl border border-[color-mix(in_oklch,var(--color-warning)_40%,transparent)] bg-[color-mix(in_oklch,var(--color-warning)_6%,transparent)] p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-[color-mix(in_oklch,var(--color-warning)_18%,transparent)] text-[var(--color-warning)]">
            <Bomb className="h-4 w-4" />
          </span>
          <div className="flex flex-col">
            <h2 className="text-sm font-semibold text-[var(--color-fg)]">
              Expiry Day · Gamma Blast &amp; Hero Zero
            </h2>
            <p className="text-[11px] text-[var(--color-fg-subtle)]">
              Index option-buying plays — only shown on{" "}
              {data.indexes.map((b) => b.index).join(" & ")} expiry.
            </p>
          </div>
        </div>
        <button
          onClick={() => void refresh()}
          disabled={refreshing}
          className={cn(
            "inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-2 py-1 text-[11px] text-[var(--color-fg-muted)] transition-colors hover:text-[var(--color-fg)]",
            refreshing && "opacity-60",
          )}
        >
          <RefreshCw className={cn("h-3 w-3", refreshing && "animate-spin")} />
          Refresh
        </button>
      </div>

      <div className="flex items-start gap-2 rounded-lg border border-[color-mix(in_oklch,var(--color-warning)_30%,transparent)] bg-[var(--color-surface)] px-3 py-2 text-[11px] text-[var(--color-fg-muted)]">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-warning)]" />
        <span>
          Highest-risk trades on the board — expiry premium can decay to zero in
          minutes. Defined risk only, strict hard-stops, square off by 15:20. Not
          investment advice.
        </span>
      </div>

      {data.indexes.map((block) => (
        <IndexBlock key={block.index} block={block} />
      ))}
    </section>
  );
}

function IndexBlock({ block }: { block: ExpiryIndexBlock }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        <span className="font-semibold text-[var(--color-fg)]">{block.index}</span>
        <span className="num text-[var(--color-fg-muted)]">
          spot ₹{fmt(block.spot)}
        </span>
        <span className="text-[var(--color-fg-subtle)]">· exp {block.expiry}</span>
        <Badge variant={block.dataSource === "chain" ? "info" : "warning"}>
          {block.dataSource === "chain" ? "live chain" : "estimated"}
        </Badge>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {block.trades.map((t) => (
          <ExpiryTradeCard key={`${block.index}-${t.kind}`} trade={t} />
        ))}
      </div>
    </div>
  );
}

function ExpiryTradeCard({ trade }: { trade: ExpiryTrade }) {
  const isCall = trade.optionType === "CE";
  const Icon = trade.kind === "GAMMA_BLAST" ? Bomb : Dices;
  const gainPct = Math.round((trade.targetMultiple - 1) * 100);

  return (
    <Card className="gap-3 py-4 ring-1 ring-inset ring-[color-mix(in_oklch,var(--color-warning)_25%,transparent)]">
      <CardContent className="flex flex-col gap-3 px-4">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-[var(--color-bg-elevated)] text-[var(--color-warning)] ring-1 ring-inset ring-[var(--color-border)]">
              <Icon className="h-4 w-4" />
            </span>
            <div className="flex flex-col">
              <span className="text-sm font-semibold text-[var(--color-fg)]">
                {trade.label}
              </span>
              <span className="text-[10px] uppercase tracking-[0.16em] text-[var(--color-fg-subtle)]">
                {trade.strike} {trade.optionType}
              </span>
            </div>
          </div>
          <Badge variant={isCall ? "bull" : "bear"}>
            {isCall ? "CALL" : "PUT"}
          </Badge>
        </div>

        <div className="grid grid-cols-3 gap-2 text-xs">
          <Field label="Entry" value={`₹${fmt(trade.entryPremium)}`} />
          <Field
            label="Target"
            value={`₹${fmt(trade.target)}`}
            sub={`+${gainPct}%`}
            tone="bull"
          />
          <Field
            label="Stop"
            value={trade.stopLoss > 0 ? `₹${fmt(trade.stopLoss)}` : "₹0 (zero)"}
            sub={trade.stopLoss > 0 ? "-50%" : "total"}
            tone="bear"
          />
        </div>

        <p className="rounded-lg border border-dashed border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3 py-2 text-[11px] leading-relaxed text-[var(--color-fg-muted)]">
          <span className="font-semibold text-[var(--color-fg)]">Plan: </span>
          {trade.rationale}
        </p>
      </CardContent>
    </Card>
  );
}

function Field({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "bull" | "bear";
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3 py-2">
      <span className="text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-subtle)]">
        {label}
      </span>
      <span className="num truncate text-sm font-semibold text-[var(--color-fg)]">
        {value}
      </span>
      {sub ? (
        <span
          className={cn(
            "num text-[10px]",
            tone === "bull"
              ? "text-bull"
              : tone === "bear"
                ? "text-bear"
                : "text-[var(--color-fg-muted)]",
          )}
        >
          {sub}
        </span>
      ) : null}
    </div>
  );
}
