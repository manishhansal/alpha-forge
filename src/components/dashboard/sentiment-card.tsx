"use client";

import { useQuery } from "@tanstack/react-query";
import { Activity } from "lucide-react";
import { useSyncExternalStore } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { SentimentResult } from "@/types/market";

// `useSyncExternalStore`-backed "is mounted" flag — the subscribe callback
// is a no-op (the value never changes after hydration), the client snapshot
// is true, the server snapshot is false. Lets us derive locale-sensitive
// strings during render without tripping a hydration mismatch.
const NOOP_SUBSCRIBE = () => () => {};
const getClientMounted = () => true;
const getServerMounted = () => false;

async function fetchSentiment(): Promise<SentimentResult> {
  const res = await fetch("/api/sentiment", { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load sentiment (${res.status})`);
  return res.json();
}

const LABEL_TONE: Record<SentimentResult["label"], string> = {
  Bullish: "text-[var(--color-bull)]",
  Bearish: "text-[var(--color-bear)]",
  Neutral: "text-[var(--color-fg-muted)]",
};

const LABEL_BG: Record<SentimentResult["label"], string> = {
  Bullish: "bg-[color-mix(in_oklch,var(--color-bull)_18%,transparent)] ring-[color-mix(in_oklch,var(--color-bull)_36%,transparent)]",
  Bearish: "bg-[color-mix(in_oklch,var(--color-bear)_18%,transparent)] ring-[color-mix(in_oklch,var(--color-bear)_36%,transparent)]",
  Neutral: "bg-[var(--color-surface-hover)] ring-[var(--color-border)]",
};

function ScoreBar({ score }: { score: number }) {
  const widthPct = Math.min(100, Math.abs(score) * 100);
  const positive = score >= 0;
  return (
    <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-surface-hover)]">
      <div className="absolute inset-y-0 left-1/2 w-px bg-[var(--color-border-strong)]" />
      <div
        className={cn(
          "absolute inset-y-0 rounded-full",
          positive ? "left-1/2 bg-[var(--color-bull)]" : "right-1/2 bg-[var(--color-bear)]",
        )}
        style={{ width: `${widthPct / 2}%` }}
      />
    </div>
  );
}

interface SentimentCardProps {
  initialData?: SentimentResult;
}

export function SentimentCard({ initialData }: SentimentCardProps = {}) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["sentiment"],
    queryFn: fetchSentiment,
    refetchInterval: 30_000,
    staleTime: 15_000,
    initialData,
    // Treat the server-prefetched payload as fresh so we don't immediately
    // refire the same fetch on mount; React Query will refetch normally on
    // `refetchInterval` after `staleTime` elapses.
    initialDataUpdatedAt: initialData?.generatedAt,
  });

  // `toLocaleTimeString()` depends on the runtime's locale/timezone, so the
  // server (UTC, en-US 24h) and the browser disagree and React throws a
  // hydration mismatch. Render the timestamp only after mount so the SSR
  // markup is empty and the client always wins — derived during render via
  // an `isMounted` external-store flag rather than an effect (which the
  // lint rule `react-hooks/set-state-in-effect` flags).
  const isMounted = useSyncExternalStore(
    NOOP_SUBSCRIBE,
    getClientMounted,
    getServerMounted,
  );
  const generatedAtLabel =
    isMounted && data?.generatedAt
      ? new Date(data.generatedAt).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        })
      : "";

  if (isLoading && !data) {
    return <Skeleton className="h-[260px] w-full rounded-xl" />;
  }

  if (isError || !data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Market Sentiment</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-[var(--color-fg-muted)]">
            Unable to load sentiment right now. Check Binance/Alternative.me availability.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Market Sentiment</CardTitle>
          <span
            suppressHydrationWarning
            className="text-[10px] uppercase tracking-[0.16em] text-[var(--color-fg-subtle)]"
          >
            {generatedAtLabel}
          </span>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-4">
          <div
            className={cn(
              "grid h-16 w-16 place-items-center rounded-xl ring-1 ring-inset",
              LABEL_BG[data.label],
            )}
          >
            <Activity className={cn("h-6 w-6", LABEL_TONE[data.label])} />
          </div>
          <div className="flex flex-col">
            <span className={cn("text-xl font-semibold tracking-tight", LABEL_TONE[data.label])}>
              {data.label}
            </span>
            <span className="text-xs text-[var(--color-fg-muted)]">
              Score {data.score.toFixed(2)} · Confidence {(data.confidence * 100).toFixed(0)}%
            </span>
          </div>
        </div>

        <ul className="mt-4 grid gap-2.5">
          {data.breakdown.map((entry) => (
            <li key={entry.label} className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-[11px] font-medium text-[var(--color-fg)]">{entry.label}</span>
                <span className="text-[11px] text-[var(--color-fg-muted)]">{entry.description}</span>
              </div>
              <ScoreBar score={entry.score} />
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
