"use client";

import * as React from "react";
import {
  Flame,
  Gauge,
  LineChart,
  RefreshCw,
  Sparkles,
  Sunrise,
  Zap,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { fmtIstClock } from "@/lib/india/format";
import type { DailyPickBucket } from "@/features/india/daily-picks/engine";
import type { DailyPicksResponse } from "@/features/india/daily-picks/builder";
import { DailyPickCard } from "./daily-pick-card";
import { MarketContextPanel } from "./market-context-panel";

interface Props {
  initialData: DailyPicksResponse;
  endpoint?: string;
  intervalMs?: number;
}

const BUCKET_ICON: Record<DailyPickBucket, typeof Flame> = {
  INDICES_SCALP: LineChart,
  OPENING_BREAKOUT: Sunrise,
  MOMENTUM: Flame,
  SCALPING: Zap,
  POTENTIAL: Sparkles,
};

/**
 * Live Daily Picks board — paints the SSR payload immediately, then polls the
 * API so the P&L / progress-to-target on every pick ticks in real time. Picks
 * are frozen for the trading day server-side; this surface only re-reads.
 */
export function DailyPicksBoard({
  initialData,
  endpoint = "/api/in/daily-picks",
  // Matches the server-side `CACHE_TTL_MS` in the AI builder — the spec
  // calls for a fresh full-F&O scan every minute, and a tighter client
  // poll would just keep returning the same cached payload.
  intervalMs = 60_000,
}: Props) {
  const [data, setData] = React.useState<DailyPicksResponse>(initialData);
  const [refreshing, setRefreshing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const refresh = React.useCallback(
    async (signal?: AbortSignal) => {
      setRefreshing(true);
      try {
        const res = await fetch(endpoint, { cache: "no-store", signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as DailyPicksResponse;
        setData(json);
        setError(null);
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        setError((err as Error).message);
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

  // Pinned to IST (matches the rest of the board's stamping) so SSR + CSR
  // produce identical text — `toLocaleTimeString()` resolves differently on
  // Node (`20:40:21`) vs the browser (`8:40:21 PM`) and breaks hydration.
  const generatedLabel = fmtIstClock(data.generatedAt);

  return (
    <div className="flex flex-col gap-5">
      {/* Institutional Market Context Header — one panel, all the macro
          inputs (NIFTY / BANKNIFTY level + trend + S/R, India VIX + regime,
          PCR (NIFTY), Max Pain, bias). */}
      {data.marketContextHeader ? (
        <MarketContextPanel header={data.marketContextHeader} />
      ) : null}

      {/* Context banner */}
      <div className="flex flex-col gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Gauge className="h-4 w-4 text-[var(--color-brand)]" />
            <span className="text-sm font-semibold text-[var(--color-fg)]">
              {data.context.headline}
            </span>
          </div>
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ring-1 ring-inset",
              data.inActiveWindow
                ? "bg-[color-mix(in_oklch,var(--color-bull)_12%,transparent)] text-[var(--color-bull)] ring-[color-mix(in_oklch,var(--color-bull)_30%,transparent)]"
                : "bg-[color-mix(in_oklch,var(--color-warning)_12%,transparent)] text-[var(--color-warning)] ring-[color-mix(in_oklch,var(--color-warning)_30%,transparent)]",
            )}
          >
            {data.inActiveWindow ? "Market live" : "Market closed — plan"}
          </span>
        </div>
        {data.context.bullets.length > 0 ? (
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[var(--color-fg-muted)]">
            {data.context.bullets.map((b) => (
              <li key={b} className="flex items-center gap-1.5">
                <span className="h-1 w-1 rounded-full bg-[var(--color-fg-subtle)]" />
                {b}
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-[var(--color-fg-subtle)]">
        <span>
          Picks for{" "}
          <span className="font-semibold text-[var(--color-fg-muted)]">
            {data.tradeDate}
          </span>{" "}
          · {data.persisted ? "frozen & tracked live" : "live (not persisted)"} ·
          refreshed {generatedLabel}
          {error ? <span className="ml-2 text-[var(--color-bear)]">· {error}</span> : null}
        </span>
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

      {data.groups.map((group) => {
        const Icon = BUCKET_ICON[group.bucket];
        return (
          <section key={group.bucket} className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <span className="grid h-7 w-7 place-items-center rounded-lg bg-[var(--color-bg-elevated)] text-[var(--color-brand)] ring-1 ring-inset ring-[var(--color-border)]">
                <Icon className="h-4 w-4" />
              </span>
              <div className="flex flex-col">
                <h2 className="text-sm font-semibold text-[var(--color-fg)]">
                  {group.label}
                </h2>
                <p className="text-[11px] text-[var(--color-fg-subtle)]">
                  {group.description}
                </p>
              </div>
            </div>
            {group.picks.length === 0 ? (
              <div className="rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--color-bg-elevated)] py-8 text-center text-[12px] text-[var(--color-fg-muted)]">
                No qualifying setups right now — check back next refresh.
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                {group.picks.map((pick) => (
                  <DailyPickCard key={`${pick.bucket}-${pick.rank}`} pick={pick} />
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
