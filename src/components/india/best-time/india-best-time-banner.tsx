"use client";

import { Clock3, Sparkles, TrendingUp } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { QUALITY_TOKENS } from "@/features/best-time/engine";
import {
  formatDuration,
  formatWindowRange,
  getBestTimeStatus,
} from "@/features/india/best-time/engine";
import type { BestTimeStatus } from "@/features/best-time/types";
import { cn } from "@/lib/utils";

interface IndiaBestTimeBannerProps {
  initial?: BestTimeStatus;
}

/**
 * NSE-aware twin of `BestTimeBanner`. Same layout and tokens, but the
 * status snapshot comes from the India engine (sessions in 09:15 – 15:30
 * IST, expiry-aware day quality). Routes to `/in/best-time` for the full
 * breakdown.
 */
export function IndiaBestTimeBanner({ initial }: IndiaBestTimeBannerProps) {
  const [status, setStatus] = useState<BestTimeStatus>(
    () => initial ?? getBestTimeStatus(),
  );

  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let intervalId: ReturnType<typeof setInterval> | null = null;

    const tick = () => setStatus(getBestTimeStatus());
    tick();

    const msUntilNextMinute = 60_000 - (Date.now() % 60_000);
    timeoutId = setTimeout(() => {
      tick();
      intervalId = setInterval(tick, 60_000);
    }, msUntilNextMinute);

    return () => {
      if (timeoutId) clearTimeout(timeoutId);
      if (intervalId) clearInterval(intervalId);
    };
  }, []);

  const tokens = QUALITY_TOKENS[status.active.quality];
  const dayTokens = QUALITY_TOKENS[status.istDay.quality];

  return (
    <Card
      className={cn(
        "relative overflow-hidden border-0 p-0 ring-1 ring-inset",
        tokens.ring,
      )}
    >
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-0 opacity-[0.55]",
          tokens.bg,
        )}
      />
      <div className="relative grid grid-cols-1 gap-4 px-5 py-4 md:grid-cols-[1fr_auto] md:items-center">
        <div className="flex items-start gap-4">
          <div
            className={cn(
              "grid h-12 w-12 shrink-0 place-items-center rounded-xl ring-1 ring-inset",
              tokens.bg,
              tokens.ring,
            )}
          >
            <Sparkles className={cn("h-5 w-5", tokens.text)} />
          </div>
          <div className="flex min-w-0 flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] ring-1 ring-inset",
                  tokens.bg,
                  tokens.text,
                  tokens.ring,
                )}
              >
                <span
                  className={cn(
                    "h-1.5 w-1.5 animate-pulse rounded-full",
                    tokens.dot,
                  )}
                />
                {status.active.label}
              </span>
              <Badge variant={dayTokens.badge}>{status.istDay.label}</Badge>
              <span
                suppressHydrationWarning
                className="num inline-flex items-center gap-1 text-[11px] text-[var(--color-fg-muted)]"
              >
                <Clock3 className="h-3 w-3" />
                {status.istTime} IST
              </span>
            </div>
            <p
              className={cn(
                "text-sm font-semibold tracking-tight",
                tokens.text,
              )}
            >
              {status.verdict}
            </p>
            <p className="text-[12px] leading-snug text-[var(--color-fg-muted)]">
              {status.active.insight}
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-[var(--color-fg-subtle)]">
              <span className="inline-flex items-center gap-1">
                <span className={cn("h-1.5 w-1.5 rounded-full", tokens.dot)} />
                <span className="text-[var(--color-fg-muted)]">
                  Window {formatWindowRange(status.active)}
                </span>
              </span>
              {status.activeEndsInMinutes !== null ? (
                <span suppressHydrationWarning>
                  Ends in{" "}
                  <span className="num text-[var(--color-fg)]">
                    {formatDuration(status.activeEndsInMinutes)}
                  </span>
                </span>
              ) : null}
              {status.nextWindow ? (
                <span suppressHydrationWarning>
                  Next:{" "}
                  <span className="text-[var(--color-fg)]">
                    {status.nextWindow.label}
                  </span>{" "}
                  in{" "}
                  <span className="num text-[var(--color-fg)]">
                    {formatDuration(status.nextWindow.startsInMinutes)}
                  </span>{" "}
                  (<span className="num">{status.nextWindow.startsAt}</span>)
                </span>
              ) : null}
            </div>
          </div>
        </div>

        <div className="flex flex-row items-center gap-4 md:flex-col md:items-end md:gap-2">
          <ScoreDial score={status.score} tone={tokens} />
          <Link
            href="/in/best-time"
            className="inline-flex items-center gap-1 text-[11px] font-medium text-[var(--color-brand)] hover:underline"
          >
            <TrendingUp className="h-3 w-3" />
            Full breakdown →
          </Link>
        </div>
      </div>
    </Card>
  );
}

interface ScoreDialProps {
  score: number;
  tone: (typeof QUALITY_TOKENS)[keyof typeof QUALITY_TOKENS];
}

function ScoreDial({ score, tone }: ScoreDialProps) {
  const clamped = Math.max(0, Math.min(100, score));
  return (
    <div className={cn("relative h-16 w-16 shrink-0", tone.text)}>
      <div
        className={cn(
          "absolute inset-0 rounded-full ring-1 ring-inset",
          tone.ring,
        )}
        style={{
          background: `conic-gradient(currentColor ${clamped}%, transparent 0)`,
        }}
      />
      <div className="absolute inset-[3px] rounded-full bg-[var(--color-surface)]" />
      <div
        className="absolute inset-0 grid place-items-center text-[14px] font-semibold tracking-tight"
        suppressHydrationWarning
      >
        <span className="num">{clamped}</span>
      </div>
    </div>
  );
}
