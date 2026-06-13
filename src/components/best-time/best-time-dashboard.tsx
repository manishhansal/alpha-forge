"use client";

import { motion } from "framer-motion";
import {
  Activity,
  Bitcoin,
  Calendar,
  Clock3,
  Gauge,
  Sparkles,
  Target,
  TrendingDown,
  TrendingUp,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DAY_RECOMMENDATIONS,
  formatDuration,
  formatWindowRange,
  getBestTimeStatus,
  QUALITY_TOKENS,
  STYLE_RECOMMENDATIONS,
  TRADING_WINDOWS,
} from "@/features/best-time/engine";
import type {
  BestTimeStatus,
  Quality,
  TradingWindow,
  WindowSlug,
} from "@/features/best-time/types";
import { cn } from "@/lib/utils";

interface BestTimeDashboardProps {
  initial?: BestTimeStatus;
}

const QUALITY_LABELS: Record<Quality, string> = {
  ideal: "Excellent",
  good: "Good",
  moderate: "Medium",
  poor: "Avoid",
  off: "Quiet",
};

const STYLE_ICONS: Record<string, typeof Sparkles> = {
  Scalping: Zap,
  "Futures trading": TrendingUp,
  "Swing entries": Target,
  "Range trading": Activity,
  Breakouts: Gauge,
};

export function BestTimeDashboard({ initial }: BestTimeDashboardProps) {
  const [status, setStatus] = useState<BestTimeStatus>(() => initial ?? getBestTimeStatus());

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

  return (
    <div className="flex flex-col gap-6">
      <HeroStatus status={status} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[2fr_1fr]">
        <TimelineCard activeSlug={status.active.slug} currentMinute={istMinuteFromStatus(status)} />
        <WeekdayCard activeDay={status.istDay.day} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <StyleMatrixCard activeSlug={status.active.slug} />
        <BtcSpotlightCard />
      </div>
    </div>
  );
}

function istMinuteFromStatus(status: BestTimeStatus): number {
  const [h, m] = status.istTime.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

// ---------------------------------------------------------------------------
// Hero card — verdict, score, countdowns
// ---------------------------------------------------------------------------

function HeroStatus({ status }: { status: BestTimeStatus }) {
  const tokens = QUALITY_TOKENS[status.active.quality];
  const dayTokens = QUALITY_TOKENS[status.istDay.quality];

  return (
    <Card className={cn("relative overflow-hidden p-0 ring-1 ring-inset", tokens.ring)}>
      <div
        aria-hidden
        className={cn("pointer-events-none absolute inset-0 opacity-60", tokens.bg)}
      />
      <div className="relative grid grid-cols-1 gap-6 px-6 py-6 md:grid-cols-[1fr_auto] md:items-center">
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] ring-1 ring-inset",
                tokens.bg,
                tokens.text,
                tokens.ring,
              )}
            >
              <span className={cn("h-1.5 w-1.5 animate-pulse rounded-full", tokens.dot)} />
              {status.active.label}
            </span>
            <Badge variant={dayTokens.badge}>{status.istDay.label} · {QUALITY_LABELS[status.istDay.quality]}</Badge>
            <span
              suppressHydrationWarning
              className="num inline-flex items-center gap-1 text-[11px] text-[var(--color-fg-muted)]"
            >
              <Clock3 className="h-3 w-3" />
              {status.istTime} IST
            </span>
          </div>
          <h2 className={cn("text-2xl font-semibold tracking-tight", tokens.text)}>
            {status.verdict}
          </h2>
          <p className="max-w-2xl text-sm leading-relaxed text-[var(--color-fg-muted)]">
            {status.active.insight}
          </p>

          <dl className="mt-2 grid grid-cols-2 gap-3 text-[11px] sm:grid-cols-4">
            <Stat
              label="Window"
              value={formatWindowRange(status.active)}
              tone="muted"
            />
            <Stat
              label="Ends in"
              value={
                status.activeEndsInMinutes !== null
                  ? formatDuration(status.activeEndsInMinutes)
                  : "—"
              }
              tone="fg"
              suppressHydration
            />
            <Stat
              label="Next window"
              value={status.nextWindow ? status.nextWindow.label : "Closed for today"}
              tone="fg"
            />
            <Stat
              label="Starts in"
              value={
                status.nextWindow ? formatDuration(status.nextWindow.startsInMinutes) : "—"
              }
              tone="fg"
              suppressHydration
            />
          </dl>
        </div>

        <ScoreRing score={status.score} tone={tokens} />
      </div>
    </Card>
  );
}

interface StatProps {
  label: string;
  value: string;
  tone: "muted" | "fg";
  suppressHydration?: boolean;
}

function Stat({ label, value, tone, suppressHydration }: StatProps) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-subtle)]">
        {label}
      </dt>
      <dd
        className={cn(
          "num text-[13px] font-medium",
          tone === "fg" ? "text-[var(--color-fg)]" : "text-[var(--color-fg-muted)]",
        )}
        suppressHydrationWarning={suppressHydration}
      >
        {value}
      </dd>
    </div>
  );
}

function ScoreRing({
  score,
  tone,
}: {
  score: number;
  tone: (typeof QUALITY_TOKENS)[keyof typeof QUALITY_TOKENS];
}) {
  const clamped = Math.max(0, Math.min(100, score));
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.92 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.35, ease: "easeOut" }}
      className={cn("relative h-28 w-28 shrink-0", tone.text)}
    >
      <div
        className={cn("absolute inset-0 rounded-full ring-1 ring-inset", tone.ring)}
        style={{
          background: `conic-gradient(currentColor ${clamped}%, transparent 0)`,
        }}
      />
      <div className="absolute inset-[6px] rounded-full bg-[var(--color-surface)]" />
      <div className="absolute inset-0 grid place-items-center">
        <div className="flex flex-col items-center">
          <span className="num text-[26px] font-semibold leading-none">{clamped}</span>
          <span className="mt-1 text-[9px] uppercase tracking-[0.18em] text-[var(--color-fg-subtle)]">
            Quality
          </span>
        </div>
      </div>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Timeline card — 24h IST visualisation of every window
// ---------------------------------------------------------------------------

function TimelineCard({
  activeSlug,
  currentMinute,
}: {
  activeSlug: WindowSlug;
  currentMinute: number;
}) {
  const sortedWindows = useMemo(
    () =>
      [...TRADING_WINDOWS].sort((a, b) => a.startMin - b.startMin),
    [],
  );

  const tickMarks = useMemo(() => {
    return Array.from({ length: 9 }, (_, i) => ({
      atPct: (i / 8) * 100,
      label: `${(i * 3).toString().padStart(2, "0")}:00`,
    }));
  }, []);

  const nowPct = (currentMinute / 1440) * 100;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>24h IST trading map</CardTitle>
          <span className="text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-subtle)]">
            Now
            <span
              className="num ml-1 text-[var(--color-fg-muted)]"
              suppressHydrationWarning
            >
              {`${Math.floor(currentMinute / 60).toString().padStart(2, "0")}:${(currentMinute % 60).toString().padStart(2, "0")}`}
            </span>
          </span>
        </div>
      </CardHeader>
      <CardContent>
        <div className="relative">
          <div className="relative h-12 w-full overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-surface-hover)]">
            {sortedWindows.map((w) => {
              const tokens = QUALITY_TOKENS[w.quality];
              const left = (w.startMin / 1440) * 100;
              const width = ((w.endMin - w.startMin) / 1440) * 100;
              const isActive = activeSlug === w.slug;
              return (
                <div
                  key={w.slug}
                  title={`${w.label} · ${formatWindowRange(w)}`}
                  className={cn(
                    "group absolute inset-y-0 flex items-center justify-center overflow-hidden border-r border-[var(--color-border)] text-[9px] font-semibold uppercase tracking-wider ring-inset transition-all",
                    tokens.bg,
                    tokens.text,
                    isActive && "z-10 ring-2 ring-[var(--color-brand)]",
                  )}
                  style={{ left: `${left}%`, width: `${width}%` }}
                >
                  <span className="truncate px-1.5">{w.label}</span>
                </div>
              );
            })}
            <div
              className="absolute inset-y-0 z-20 w-px bg-[var(--color-fg)]"
              style={{ left: `${nowPct}%` }}
              suppressHydrationWarning
            >
              <span className="absolute -top-1.5 left-1/2 h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-[var(--color-fg)]" />
            </div>
          </div>
          <div className="mt-1.5 flex w-full justify-between text-[9px] text-[var(--color-fg-subtle)]">
            {tickMarks.map((t) => (
              <span key={t.label} className="num">
                {t.label}
              </span>
            ))}
          </div>
        </div>

        <ul className="mt-5 flex flex-col divide-y divide-[var(--color-border)]">
          {sortedWindows.map((w) => (
            <WindowRow key={w.slug} window={w} active={activeSlug === w.slug} />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function WindowRow({ window, active }: { window: TradingWindow; active: boolean }) {
  const tokens = QUALITY_TOKENS[window.quality];
  return (
    <li className="grid grid-cols-[auto_1fr_auto] items-start gap-3 py-3">
      <span
        className={cn(
          "mt-1 grid h-7 w-7 place-items-center rounded-md ring-1 ring-inset",
          tokens.bg,
          tokens.ring,
        )}
      >
        <span className={cn("h-1.5 w-1.5 rounded-full", tokens.dot)} />
      </span>
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn("text-[13px] font-semibold tracking-tight", tokens.text)}>
            {window.label}
          </span>
          {active ? <Badge variant="bull">Live now</Badge> : null}
          <Badge variant={tokens.badge}>{QUALITY_LABELS[window.quality]}</Badge>
        </div>
        <p className="text-[11px] leading-snug text-[var(--color-fg-muted)]">{window.insight}</p>
        <div className="flex flex-wrap gap-1.5">
          {window.styles.map((style) => (
            <span
              key={style}
              className="rounded-full border border-[var(--color-border)] bg-[var(--color-surface-hover)] px-2 py-0.5 text-[10px] text-[var(--color-fg-muted)]"
            >
              {style}
            </span>
          ))}
        </div>
      </div>
      <span className="num text-[11px] text-[var(--color-fg-muted)] whitespace-nowrap">
        {formatWindowRange(window)}
      </span>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Weekday card — quality per day of week
// ---------------------------------------------------------------------------

function WeekdayCard({ activeDay }: { activeDay: number }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Calendar className="h-4 w-4 text-[var(--color-fg-subtle)]" />
          Best days to trade
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col divide-y divide-[var(--color-border)]">
          {DAY_RECOMMENDATIONS.map((d) => {
            const tokens = QUALITY_TOKENS[d.quality];
            const isToday = d.day === activeDay;
            return (
              <li
                key={d.day}
                className={cn(
                  "grid grid-cols-[auto_1fr_auto] items-center gap-3 py-2.5",
                  isToday && "rounded-md bg-[var(--color-surface-hover)] px-2",
                )}
              >
                <span
                  className={cn(
                    "grid h-7 w-7 place-items-center rounded-md text-[10px] font-semibold uppercase tracking-wider ring-1 ring-inset",
                    tokens.bg,
                    tokens.text,
                    tokens.ring,
                  )}
                >
                  {d.label.slice(0, 3)}
                </span>
                <div className="flex min-w-0 flex-col">
                  <span className="text-[12px] font-medium text-[var(--color-fg)]">
                    {d.label}
                    {isToday ? (
                      <Badge variant="bull" className="ml-2">
                        Today
                      </Badge>
                    ) : null}
                  </span>
                  <span className="text-[11px] text-[var(--color-fg-muted)]">{d.note}</span>
                </div>
                <Badge variant={tokens.badge}>{QUALITY_LABELS[d.quality]}</Badge>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Style matrix card — per-style "best IST window" table
// ---------------------------------------------------------------------------

function StyleMatrixCard({ activeSlug }: { activeSlug: WindowSlug }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Best window by trading style</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col divide-y divide-[var(--color-border)]">
          {STYLE_RECOMMENDATIONS.map((r) => {
            const Icon = STYLE_ICONS[r.style] ?? Sparkles;
            const window = TRADING_WINDOWS.find((w) => w.slug === r.matches);
            const tokens = window ? QUALITY_TOKENS[window.quality] : QUALITY_TOKENS.off;
            const isLive = activeSlug === r.matches;
            return (
              <li key={r.style} className="grid grid-cols-[auto_1fr_auto] items-center gap-3 py-3">
                <span
                  className={cn(
                    "grid h-8 w-8 place-items-center rounded-md ring-1 ring-inset",
                    tokens.bg,
                    tokens.ring,
                  )}
                >
                  <Icon className={cn("h-4 w-4", tokens.text)} />
                </span>
                <div className="flex min-w-0 flex-col">
                  <span className="text-[13px] font-semibold tracking-tight text-[var(--color-fg)]">
                    {r.style}
                    {isLive ? (
                      <Badge variant="bull" className="ml-2">
                        Live
                      </Badge>
                    ) : null}
                  </span>
                  <span className="text-[11px] text-[var(--color-fg-muted)]">{r.rationale}</span>
                </div>
                <span className="num text-[11px] text-[var(--color-fg-muted)] whitespace-nowrap">
                  {r.istWindow}
                </span>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// BTC spotlight card — published guidance for BTC specifically
// ---------------------------------------------------------------------------

function BtcSpotlightCard() {
  return (
    <Card className="relative overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px"
        style={{
          background:
            "linear-gradient(90deg, transparent, var(--color-btc), transparent)",
        }}
      />
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bitcoin className="h-4 w-4 text-[var(--color-btc)]" />
          BTC spotlight · 7 PM – 11 PM IST
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-[12px] leading-relaxed text-[var(--color-fg-muted)]">
          BTC delivers its strongest volume, cleanest technical setups, and lowest slippage between{" "}
          <span className="font-medium text-[var(--color-fg)]">7:00 PM and 11:00 PM IST</span>{" "}
          — the same window when the majority of professional crypto desks are active globally.
          ETH and SOL ride the same wave with slightly thinner books.
        </p>
        <ul className="mt-4 flex flex-col gap-2.5 text-[12px]">
          <BtcRow
            icon={TrendingUp}
            label="Strongest volume"
            value="Binance / Bybit / Delta peak hours"
            tone="bull"
          />
          <BtcRow
            icon={Target}
            label="Cleanest setups"
            value="Liquidity sweeps + clear S/R"
            tone="info"
          />
          <BtcRow
            icon={TrendingDown}
            label="Lowest slippage"
            value="Tight spreads — even on $50k+ tickets"
            tone="bull"
          />
          <BtcRow
            icon={Zap}
            label="Best style fit"
            value="1m / 5m scalps + futures momentum"
            tone="warning"
          />
        </ul>
      </CardContent>
    </Card>
  );
}

type BtcTone = "bull" | "bear" | "info" | "warning";

const BTC_TONE_CLASS: Record<BtcTone, string> = {
  bull: "text-[var(--color-bull)]",
  bear: "text-[var(--color-bear)]",
  info: "text-[var(--color-info)]",
  warning: "text-[var(--color-warning)]",
};

function BtcRow({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: typeof Sparkles;
  label: string;
  value: string;
  tone: BtcTone;
}) {
  return (
    <li className="grid grid-cols-[auto_1fr_auto] items-center gap-3">
      <Icon className={cn("h-3.5 w-3.5", BTC_TONE_CLASS[tone])} />
      <span className="text-[var(--color-fg-muted)]">{label}</span>
      <span className="text-right text-[var(--color-fg)]">{value}</span>
    </li>
  );
}
