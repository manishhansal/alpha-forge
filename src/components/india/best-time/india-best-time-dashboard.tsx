"use client";

import { motion } from "framer-motion";
import {
  Activity,
  Building2,
  Calendar,
  Clock3,
  Gauge,
  Sparkles,
  Target,
  TrendingUp,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { QUALITY_TOKENS } from "@/features/best-time/engine";
import type {
  BestTimeStatus,
  Quality,
  TradingWindow,
  WindowSlug,
} from "@/features/best-time/types";
import {
  DAY_RECOMMENDATIONS,
  STYLE_RECOMMENDATIONS,
  TRADING_WINDOWS,
  formatDuration,
  formatWindowRange,
  getBestTimeStatus,
} from "@/features/india/best-time/engine";
import { cn } from "@/lib/utils";

interface IndiaBestTimeDashboardProps {
  initial?: BestTimeStatus;
}

const QUALITY_LABELS: Record<Quality, string> = {
  ideal: "Excellent",
  good: "Good",
  moderate: "Medium",
  poor: "Avoid",
  off: "Closed",
};

const STYLE_ICONS: Record<string, typeof Sparkles> = {
  "F&O scalping": Zap,
  "ORB / gap trading": TrendingUp,
  "Trend / swing entries": Target,
  "Mean reversion": Activity,
  "Index option carry": Gauge,
};

/**
 * NSE-aware twin of `BestTimeDashboard`. Uses the India engine + a fixed
 * 09:00 → 16:00 IST timeline (the only window that's relevant on NSE) so
 * the visual "now" cursor stays inside a tight, legible band.
 */
export function IndiaBestTimeDashboard({ initial }: IndiaBestTimeDashboardProps) {
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
    }, msUntilNextMinute + 50);

    return () => {
      if (timeoutId) clearTimeout(timeoutId);
      if (intervalId) clearInterval(intervalId);
    };
  }, []);

  const tokens = QUALITY_TOKENS[status.active.quality];
  const dayTokens = QUALITY_TOKENS[status.istDay.quality];

  return (
    <div className="flex flex-col gap-6">
      <HeroStatusCard status={status} />
      <NseTimeline status={status} />

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <SessionWindowsCard active={status.active} />
        <BestDaysCard activeDay={status.istDay.day} />
      </section>

      <StyleMatrixCard activeSlug={status.active.slug} />

      <ExpiryAndPowerHourCard
        activeSlug={status.active.slug}
        dayLabel={status.istDay.label}
      />

      <p className="text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)]">
        Active window quality:{" "}
        <span className={cn("font-semibold", tokens.text)}>
          {QUALITY_LABELS[status.active.quality]}
        </span>{" "}
        · Today&apos;s quality:{" "}
        <span className={cn("font-semibold", dayTokens.text)}>
          {QUALITY_LABELS[status.istDay.quality]}
        </span>
      </p>
    </div>
  );
}

function HeroStatusCard({ status }: { status: BestTimeStatus }) {
  const tokens = QUALITY_TOKENS[status.active.quality];
  const dayTokens = QUALITY_TOKENS[status.istDay.quality];
  const isOff = status.active.slug === "off";

  return (
    <Card className={cn("overflow-hidden ring-1", tokens.ring)}>
      <CardContent className="p-0">
        <div
          className={cn(
            "flex flex-col gap-5 p-5 sm:flex-row sm:items-center sm:justify-between",
            tokens.bg,
          )}
        >
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={tokens.badge}>
                <Building2 className="h-3 w-3" />
                {status.active.label}
              </Badge>
              <Badge variant={dayTokens.badge}>
                <Calendar className="h-3 w-3" />
                {status.istDay.label}
              </Badge>
              <Badge variant="outline">
                <Clock3 className="h-3 w-3" />
                <span suppressHydrationWarning>{status.istTime} IST</span>
              </Badge>
            </div>

            <h2 className="text-2xl font-semibold tracking-tight">
              {status.verdict}
            </h2>
            <p className="max-w-2xl text-sm text-[var(--color-fg-muted)]">
              {status.active.insight}
            </p>

            <div className="flex flex-wrap gap-3 pt-1">
              {status.activeEndsInMinutes != null && !isOff && (
                <span className="inline-flex items-center gap-1 text-[12px] text-[var(--color-fg-muted)]">
                  <Sparkles className="h-3.5 w-3.5" />
                  Ends in {formatDuration(status.activeEndsInMinutes)}
                </span>
              )}
              {status.nextWindow && (
                <span className="inline-flex items-center gap-1 text-[12px] text-[var(--color-fg-muted)]">
                  <TrendingUp className="h-3.5 w-3.5" />
                  Next: {status.nextWindow.label} in{" "}
                  {formatDuration(status.nextWindow.startsInMinutes)} (
                  {status.nextWindow.startsAt} IST)
                </span>
              )}
              {!status.nextWindow && !isOff && (
                <span className="inline-flex items-center gap-1 text-[12px] text-[var(--color-fg-muted)]">
                  <TrendingUp className="h-3.5 w-3.5" />
                  No upgrade left today — closing window approaches
                </span>
              )}
            </div>
          </div>

          <ScoreDial score={status.score} tone={tokens.text} />
        </div>
      </CardContent>
    </Card>
  );
}

function ScoreDial({ score, tone }: { score: number; tone: string }) {
  const radius = 52;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - score / 100);
  return (
    <div className="relative grid h-32 w-32 shrink-0 place-items-center">
      <svg viewBox="0 0 120 120" className="absolute inset-0">
        <circle
          cx={60}
          cy={60}
          r={radius}
          fill="none"
          stroke="var(--color-border)"
          strokeWidth={8}
        />
        <motion.circle
          cx={60}
          cy={60}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={8}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          transform="rotate(-90 60 60)"
          initial={false}
          animate={{ strokeDashoffset: offset }}
          transition={{ type: "spring", stiffness: 80, damping: 18 }}
          className={tone}
        />
      </svg>
      <div className="relative flex flex-col items-center">
        <span className={cn("text-3xl font-semibold tracking-tight", tone)}>
          {score}
        </span>
        <span className="text-[10px] uppercase tracking-[0.2em] text-[var(--color-fg-subtle)]">
          Score
        </span>
      </div>
    </div>
  );
}

const TIMELINE_START_MIN = 9 * 60; // 09:00 IST
const TIMELINE_END_MIN = 16 * 60; // 16:00 IST
const TIMELINE_RANGE_MIN = TIMELINE_END_MIN - TIMELINE_START_MIN;

function clampToTimeline(min: number): number {
  return Math.max(TIMELINE_START_MIN, Math.min(TIMELINE_END_MIN, min));
}

function pctOf(min: number): number {
  return ((clampToTimeline(min) - TIMELINE_START_MIN) / TIMELINE_RANGE_MIN) * 100;
}

function NseTimeline({ status }: { status: BestTimeStatus }) {
  // Only render windows that intersect 09:00 – 16:00.
  const windows = useMemo(
    () =>
      TRADING_WINDOWS.filter(
        (w) => w.endMin > TIMELINE_START_MIN && w.startMin < TIMELINE_END_MIN,
      ).map((w) => ({
        win: w,
        leftPct: pctOf(w.startMin),
        widthPct: pctOf(w.endMin) - pctOf(w.startMin),
      })),
    [],
  );

  // Convert "HH:mm" → minute-of-day for the cursor.
  const [hh, mm] = status.istTime.split(":").map((s) => Number.parseInt(s, 10));
  const nowMin = hh * 60 + mm;
  const cursorPct = pctOf(nowMin);
  const inSession = nowMin >= TIMELINE_START_MIN && nowMin <= TIMELINE_END_MIN;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-semibold normal-case tracking-tight text-[var(--color-fg)]">
            NSE session map · 09:00 – 16:00 IST
          </CardTitle>
          <span className="text-[11px] text-[var(--color-fg-subtle)]">
            {inSession
              ? `Now · ${status.istTime} IST`
              : "Outside trading hours"}
          </span>
        </div>
      </CardHeader>
      <CardContent>
        <div className="relative h-16 w-full overflow-hidden rounded-lg bg-[var(--color-surface-hover)] ring-1 ring-[var(--color-border)]">
          {windows.map(({ win, leftPct, widthPct }) => {
            const tokens = QUALITY_TOKENS[win.quality];
            return (
              <div
                key={`${win.slug}-${win.startMin}`}
                title={`${win.label} · ${formatWindowRange(win)}`}
                className={cn(
                  "absolute inset-y-0 flex items-center justify-center px-1",
                  tokens.bg,
                )}
                style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
              >
                <span
                  className={cn(
                    "truncate text-[10px] font-medium",
                    tokens.text,
                  )}
                >
                  {win.label}
                </span>
              </div>
            );
          })}
          {inSession && (
            <motion.div
              initial={false}
              animate={{ left: `${cursorPct}%` }}
              transition={{ type: "spring", stiffness: 60, damping: 18 }}
              className="absolute top-0 h-full w-[2px] bg-[var(--color-fg)]"
            >
              <div className="absolute -top-1 -left-1 h-2 w-2 rounded-full bg-[var(--color-fg)]" />
            </motion.div>
          )}
        </div>
        <div className="mt-2 flex justify-between text-[10px] text-[var(--color-fg-subtle)]">
          <span>09:00</span>
          <span>10:30</span>
          <span>12:00</span>
          <span>13:30</span>
          <span>15:00</span>
          <span>16:00</span>
        </div>
      </CardContent>
    </Card>
  );
}

function SessionWindowsCard({ active }: { active: TradingWindow }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-semibold normal-case tracking-tight text-[var(--color-fg)]">
          NSE F&amp;O session windows
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col gap-3">
          {TRADING_WINDOWS.map((win) => {
            const tokens = QUALITY_TOKENS[win.quality];
            const isActive =
              win.slug === active.slug && win.startMin === active.startMin;
            return (
              <li
                key={`${win.slug}-${win.startMin}`}
                className={cn(
                  "flex flex-col gap-1 rounded-lg border p-3 transition-colors",
                  isActive
                    ? cn(
                        "border-[color-mix(in_oklch,var(--color-fg)_12%,transparent)]",
                        tokens.bg,
                      )
                    : "border-[var(--color-border)]",
                )}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className={cn("h-2 w-2 rounded-full", tokens.dot)} />
                    <span className="text-sm font-semibold">{win.label}</span>
                    {isActive && <Badge variant={tokens.badge}>Active</Badge>}
                  </div>
                  <span className="text-[11px] text-[var(--color-fg-muted)]">
                    {formatWindowRange(win)}
                  </span>
                </div>
                <p className="text-[12px] text-[var(--color-fg-muted)]">
                  {win.insight}
                </p>
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {win.styles.map((s) => (
                    <span
                      key={s}
                      className="rounded-full bg-[var(--color-surface-hover)] px-2 py-0.5 text-[10px] text-[var(--color-fg-muted)]"
                    >
                      {s}
                    </span>
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

function BestDaysCard({ activeDay }: { activeDay: number }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-semibold normal-case tracking-tight text-[var(--color-fg)]">
          Best days for NSE F&amp;O
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col">
          {DAY_RECOMMENDATIONS.map((d) => {
            const tokens = QUALITY_TOKENS[d.quality];
            const isToday = d.day === activeDay;
            return (
              <li
                key={d.day}
                className={cn(
                  "flex items-start justify-between gap-3 border-b border-[var(--color-border)] py-2 last:border-b-0",
                  isToday && "bg-[var(--color-surface-hover)] -mx-2 rounded-lg px-2",
                )}
              >
                <div className="flex flex-col">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{d.label}</span>
                    {isToday && <Badge variant="outline">Today</Badge>}
                  </div>
                  <span className="text-[11px] text-[var(--color-fg-muted)]">
                    {d.note}
                  </span>
                </div>
                <Badge variant={tokens.badge}>
                  {QUALITY_LABELS[d.quality]}
                </Badge>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

function StyleMatrixCard({ activeSlug }: { activeSlug: WindowSlug }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-semibold normal-case tracking-tight text-[var(--color-fg)]">
          Best window by trading style
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {STYLE_RECOMMENDATIONS.map((rec) => {
            const Icon = STYLE_ICONS[rec.style] ?? Sparkles;
            const isActive = rec.matches === activeSlug;
            return (
              <div
                key={rec.style}
                className={cn(
                  "flex items-start gap-3 rounded-lg border p-3 transition-colors",
                  isActive
                    ? "border-[var(--color-brand)] bg-[color-mix(in_oklch,var(--color-brand)_8%,transparent)]"
                    : "border-[var(--color-border)]",
                )}
              >
                <div className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-[var(--color-surface-hover)]">
                  <Icon className="h-4 w-4 text-[var(--color-fg-muted)]" />
                </div>
                <div className="flex flex-col">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold">{rec.style}</span>
                    {isActive && <Badge variant="bull">In window</Badge>}
                  </div>
                  <span className="text-[11px] text-[var(--color-fg-muted)]">
                    {rec.istWindow}
                  </span>
                  <span className="mt-1 text-[11px] text-[var(--color-fg-muted)]">
                    {rec.rationale}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function ExpiryAndPowerHourCard({
  activeSlug,
  dayLabel,
}: {
  activeSlug: WindowSlug;
  dayLabel: string;
}) {
  const isExpiry = dayLabel === "Thursday";
  const isPower = activeSlug === "golden";
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-semibold normal-case tracking-tight text-[var(--color-fg)]">
          NIFTY / BANKNIFTY focus
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div
            className={cn(
              "flex flex-col gap-1 rounded-lg border p-3",
              isExpiry
                ? "border-[var(--color-warning)] bg-[color-mix(in_oklch,var(--color-warning)_10%,transparent)]"
                : "border-[var(--color-border)]",
            )}
          >
            <span className="text-xs uppercase tracking-wider text-[var(--color-fg-subtle)]">
              Weekly expiry day
            </span>
            <span className="text-sm font-semibold">
              Thursday — NIFTY &amp; BANKNIFTY
            </span>
            <span className="text-[11px] text-[var(--color-fg-muted)]">
              IV crush + sharp option-premium decay; theta-positive trades
              dominate. Sized down directional bets only.
              {isExpiry && " · It's expiry today."}
            </span>
          </div>

          <div
            className={cn(
              "flex flex-col gap-1 rounded-lg border p-3",
              isPower
                ? "border-[var(--color-bull)] bg-[color-mix(in_oklch,var(--color-bull)_10%,transparent)]"
                : "border-[var(--color-border)]",
            )}
          >
            <span className="text-xs uppercase tracking-wider text-[var(--color-fg-subtle)]">
              Power Hour spotlight
            </span>
            <span className="text-sm font-semibold">15:00 – 15:30 IST</span>
            <span className="text-[11px] text-[var(--color-fg-muted)]">
              Tightest spreads of the day on weekly index options. Best window
              for 1m / 5m scalpers; aim to exit before the closing auction at
              15:30.
              {isPower && " · You're in it right now."}
            </span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
