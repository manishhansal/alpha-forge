"use client";

import * as React from "react";
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  Brain,
  Clock,
  Crosshair,
  Flame,
  Newspaper,
  Pause,
  ShieldAlert,
  Sparkles,
  Target,
  TrendingUp,
  Waves,
} from "lucide-react";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type {
  AiAction,
  AiFactorCategory,
  AiGrade,
  AiRiskLevel,
  AiSignal,
} from "@/types/ai-signals";

interface Props {
  signal: AiSignal;
  /** Render INR-style price labels (₹) instead of $ for the India surface. */
  currency?: "usd" | "inr";
}

const ACTION_META: Record<
  AiAction,
  {
    tone: "bull" | "bear" | "neutral";
    label: string;
    icon: typeof ArrowUpRight;
    accent: string;
    accentText: string;
    pillBg: string;
    ring: string;
  }
> = {
  LONG: {
    tone: "bull",
    label: "LONG",
    icon: ArrowUpRight,
    accent: "var(--color-bull)",
    accentText: "text-[var(--color-bull)]",
    pillBg: "bg-[color-mix(in_oklch,var(--color-bull)_18%,transparent)]",
    ring: "ring-[color-mix(in_oklch,var(--color-bull)_45%,transparent)]",
  },
  BUY: {
    tone: "bull",
    label: "BUY",
    icon: ArrowUpRight,
    accent: "var(--color-bull)",
    accentText: "text-[var(--color-bull)]",
    pillBg: "bg-[color-mix(in_oklch,var(--color-bull)_12%,transparent)]",
    ring: "ring-[color-mix(in_oklch,var(--color-bull)_35%,transparent)]",
  },
  SHORT: {
    tone: "bear",
    label: "SHORT",
    icon: ArrowDownRight,
    accent: "var(--color-bear)",
    accentText: "text-[var(--color-bear)]",
    pillBg: "bg-[color-mix(in_oklch,var(--color-bear)_18%,transparent)]",
    ring: "ring-[color-mix(in_oklch,var(--color-bear)_45%,transparent)]",
  },
  SELL: {
    tone: "bear",
    label: "SELL",
    icon: ArrowDownRight,
    accent: "var(--color-bear)",
    accentText: "text-[var(--color-bear)]",
    pillBg: "bg-[color-mix(in_oklch,var(--color-bear)_12%,transparent)]",
    ring: "ring-[color-mix(in_oklch,var(--color-bear)_35%,transparent)]",
  },
  WAIT: {
    tone: "neutral",
    label: "WAIT",
    icon: Pause,
    accent: "var(--color-fg-muted)",
    accentText: "text-[var(--color-fg-muted)]",
    pillBg: "bg-[var(--color-surface-hover)]",
    ring: "ring-[var(--color-border-strong)]",
  },
};

const GRADE_BG: Record<AiGrade, string> = {
  S: "bg-gradient-to-br from-[color-mix(in_oklch,var(--color-brand)_25%,transparent)] to-[color-mix(in_oklch,var(--color-info)_18%,transparent)] text-[var(--color-brand)]",
  A: "bg-[color-mix(in_oklch,var(--color-bull)_18%,transparent)] text-[var(--color-bull)]",
  B: "bg-[color-mix(in_oklch,var(--color-info)_18%,transparent)] text-[var(--color-info)]",
  C: "bg-[color-mix(in_oklch,var(--color-warning)_18%,transparent)] text-[var(--color-warning)]",
  D: "bg-[var(--color-surface-hover)] text-[var(--color-fg-muted)]",
};

const RISK_META: Record<AiRiskLevel, { label: string; tone: string }> = {
  low: { label: "Low risk", tone: "text-[var(--color-bull)]" },
  medium: { label: "Medium risk", tone: "text-[var(--color-warning)]" },
  high: { label: "High risk", tone: "text-[var(--color-bear)]" },
};

const CATEGORY_META: Record<
  AiFactorCategory,
  { label: string; icon: typeof Activity }
> = {
  technical: { label: "Tech", icon: TrendingUp },
  derivatives: { label: "Deriv", icon: BarChart3 },
  sentiment: { label: "Sent", icon: Brain },
  macro: { label: "Macro", icon: Clock },
  news: { label: "News", icon: Newspaper },
  chart: { label: "Chart", icon: Activity },
  flow: { label: "Flow", icon: Waves },
};

function formatPriceLabel(value: number, currency: "usd" | "inr"): string {
  if (!Number.isFinite(value)) return "—";
  const sym = currency === "inr" ? "₹" : "$";
  const decimals = currency === "inr" ? (value >= 1000 ? 2 : 2) : value >= 1000 ? 2 : 4;
  return `${sym}${value.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

function ConfidenceRing({
  value,
  grade,
  accent,
}: {
  value: number;
  grade: AiGrade;
  accent: string;
}) {
  const pct = Math.round(value);
  const r = 22;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - value / 100);
  return (
    <div className="relative grid h-14 w-14 place-items-center">
      <svg width="56" height="56" viewBox="0 0 56 56" className="-rotate-90">
        <circle
          cx="28"
          cy="28"
          r={r}
          stroke="var(--color-border)"
          strokeWidth="4"
          fill="none"
        />
        <circle
          cx="28"
          cy="28"
          r={r}
          stroke={accent}
          strokeWidth="4"
          fill="none"
          strokeDasharray={c}
          strokeDashoffset={offset}
          strokeLinecap="round"
        />
      </svg>
      <span className="num absolute text-[12px] font-semibold leading-none">
        {pct}
        <span className="text-[8px] text-[var(--color-fg-subtle)]">%</span>
      </span>
      <span
        className={cn(
          "absolute -bottom-1 -right-1 grid h-5 w-5 place-items-center rounded-full text-[10px] font-bold ring-1 ring-[var(--color-border)]",
          GRADE_BG[grade],
        )}
      >
        {grade}
      </span>
    </div>
  );
}

function HorizonBadge({ horizon }: { horizon: AiSignal["horizon"] }) {
  const label =
    horizon === "scalp"
      ? "Scalp · 30m"
      : horizon === "intraday"
        ? "Intraday · 1-4h"
        : horizon === "swing"
          ? "Swing · 1-3d"
          : "Positional · 1-2w";
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-bg-elevated)] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-[var(--color-fg-muted)] ring-1 ring-inset ring-[var(--color-border)]">
      <Clock className="h-2.5 w-2.5" />
      {label}
    </span>
  );
}

function StatRow({
  label,
  value,
  sub,
  icon,
  tone,
  className,
}: {
  label: string;
  value: string;
  sub?: string;
  icon?: React.ReactNode;
  tone?: "bull" | "bear" | "neutral";
  className?: string;
}) {
  // Vertical layout: label on top, value below, sub on a third line. At the
  // card's natural width (cards live in `xl:grid-cols-2`, so each cell ends
  // up ~280px wide and three of these sit side-by-side) the previous
  // horizontal layout couldn't fit `₹27,637.00 + ₹27,637.00 – ₹27,712.34`
  // without truncating the entry-zone sub. Stacking gives every value its
  // full column width and the layout no longer breaks at any card width.
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-0.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3 py-2",
        className,
      )}
    >
      <span className="flex items-center gap-1 text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-subtle)]">
        {icon}
        {label}
      </span>
      <span className="num truncate text-sm font-semibold tabular-nums text-[var(--color-fg)]">
        {value}
      </span>
      {sub ? (
        <span
          className={cn(
            "num truncate text-[10px] tabular-nums",
            tone === "bull"
              ? "text-[var(--color-bull)]"
              : tone === "bear"
                ? "text-[var(--color-bear)]"
                : "text-[var(--color-fg-muted)]",
          )}
          title={sub}
        >
          {sub}
        </span>
      ) : null}
    </div>
  );
}

// A tiny external-store wrapper around the wall clock. `useSyncExternalStore`
// is the React-19 blessed way to subscribe to external state — it lets us
// keep render pure (no `Date.now()` in the render body) while still ticking
// the countdown on a 1-second cadence.
//
// IMPORTANT: the cached snapshot must remain stable between ticks. If
// `getSnapshot()` returned a fresh `Date.now()` on every call, React would
// detect a change on every render and trigger an infinite update loop.
let cachedNow = 0;
const clockSubscribers = new Set<() => void>();
let clockIntervalId: ReturnType<typeof setInterval> | null = null;

function subscribeToClock(callback: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  if (cachedNow === 0) cachedNow = Date.now();
  clockSubscribers.add(callback);
  if (clockIntervalId === null) {
    clockIntervalId = setInterval(() => {
      cachedNow = Date.now();
      for (const cb of clockSubscribers) cb();
    }, 1000);
  }
  return () => {
    clockSubscribers.delete(callback);
    if (clockSubscribers.size === 0 && clockIntervalId !== null) {
      clearInterval(clockIntervalId);
      clockIntervalId = null;
    }
  };
}

function getClockSnapshot(): number {
  return cachedNow;
}

function getServerClockSnapshot(): number {
  // SSR-safe sentinel — the chip will show the full validForMs window on
  // the initial server-rendered HTML, then re-render to live values on hydrate.
  return 0;
}

function useNow(): number {
  return React.useSyncExternalStore(
    subscribeToClock,
    getClockSnapshot,
    getServerClockSnapshot,
  );
}

function CountdownChip({ exitBy }: { exitBy: number }) {
  const now = useNow();
  const remaining = now === 0 ? exitBy : Math.max(0, exitBy - now);
  const totalSec = Math.floor(remaining / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const label =
    h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s.toString().padStart(2, "0")}s` : `${s}s`;
  const stale = now !== 0 && remaining <= 0;
  return (
    <span
      className={cn(
        "num inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium tabular-nums",
        stale
          ? "bg-[color-mix(in_oklch,var(--color-bear)_15%,transparent)] text-[var(--color-bear)]"
          : "bg-[var(--color-bg-elevated)] text-[var(--color-fg-muted)] ring-1 ring-inset ring-[var(--color-border)]",
      )}
    >
      <Clock className="h-2.5 w-2.5" />
      {stale ? "Stale" : `Valid ${label}`}
    </span>
  );
}

/**
 * Full-featured AI Signal card. Renders identically for both markets — the
 * only delta is the currency prefix on price values (`$` vs `₹`).
 */
export function AiSignalCard({ signal, currency = "usd" }: Props) {
  const action = ACTION_META[signal.action];
  const Icon = action.icon;
  const risk = RISK_META[signal.riskLevel];
  const isWait = signal.action === "WAIT";

  const stopPct =
    signal.underlyingPrice > 0
      ? ((signal.stopLoss - signal.entry) / signal.entry) * 100
      : 0;

  return (
    <Card
      className={cn(
        "relative overflow-hidden ring-1 ring-inset transition-shadow hover:shadow-lg",
        action.ring,
      )}
      data-action={signal.action}
    >
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-[2px]"
        style={{
          background: `linear-gradient(90deg, transparent, ${action.accent}, transparent)`,
        }}
      />
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <span
              className="grid h-10 w-10 place-items-center rounded-full text-[12px] font-semibold ring-1 ring-inset ring-[var(--color-border)]"
              style={{
                background: `color-mix(in oklch, ${action.accent} 12%, transparent)`,
                color: action.accent,
              }}
            >
              {signal.symbol.slice(0, 4)}
            </span>
            <div className="flex flex-col leading-tight">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-[var(--color-fg)]">
                  {signal.displayName}
                </span>
                <HorizonBadge horizon={signal.horizon} />
              </div>
              <span className="text-[10px] uppercase tracking-[0.16em] text-[var(--color-fg-subtle)]">
                {signal.pair} · {signal.market === "crypto" ? "Crypto" : "NSE F&O"}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider ring-1 ring-inset",
                action.pillBg,
                action.accentText,
                action.ring,
              )}
            >
              <Icon className="h-3 w-3" />
              {action.label}
            </span>
            <ConfidenceRing
              value={signal.confidenceScore}
              grade={signal.grade}
              accent={action.accent}
            />
          </div>
        </div>
      </CardHeader>

      <CardContent className="pt-3">
        {/* AI summary */}
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3 py-2">
          <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-brand)]" />
          <p className="text-[12px] leading-relaxed text-[var(--color-fg-muted)]">
            {signal.summary}
          </p>
        </div>

        {/* Top metric strip */}
        <div className="mb-3 grid grid-cols-3 gap-2 text-center">
          <Metric
            label="Win Prob"
            value={`${Math.round(signal.winProbability * 100)}%`}
            tone="bull"
          />
          <Metric
            label="R:R (TP1)"
            value={`${signal.riskReward.toFixed(2)}:1`}
            tone="neutral"
          />
          <Metric
            label="Risk"
            value={risk.label.replace(" risk", "")}
            toneClass={risk.tone}
          />
        </div>

        {/* Entry / Stop / Strike */}
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-3">
          <StatRow
            label="Entry"
            value={formatPriceLabel(signal.entry, currency)}
            sub={
              isWait
                ? "—"
                : `${formatPriceLabel(signal.entryZone.min, currency)} – ${formatPriceLabel(signal.entryZone.max, currency)}`
            }
            icon={<Crosshair className="h-3 w-3" />}
          />
          <StatRow
            label="Stop"
            value={formatPriceLabel(signal.stopLoss, currency)}
            sub={`${stopPct >= 0 ? "+" : ""}${stopPct.toFixed(2)}%`}
            tone={signal.direction === "BULLISH" ? "bear" : "bull"}
            icon={<ShieldAlert className="h-3 w-3" />}
          />
          <StatRow
            label={signal.strike ? "Strike (ATM)" : "Mark"}
            value={formatPriceLabel(
              signal.strike ?? signal.underlyingPrice,
              currency,
            )}
            sub={`Size ${signal.positionSizingPct.toFixed(1)}%`}
            icon={<Target className="h-3 w-3" />}
          />
        </div>

        {/* Take-profit ladder */}
        <div className="mt-3">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-subtle)]">
              <Flame className="h-3 w-3" />
              Take-Profit Ladder
            </span>
            <span className="text-[10px] text-[var(--color-fg-subtle)]">
              Move: {signal.expectedMovePct.toFixed(2)}%
            </span>
          </div>
          <div className="grid grid-cols-3 gap-1.5">
            {signal.takeProfits.map((tp) => (
              <div
                key={tp.level}
                className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-2.5 py-1.5"
              >
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-fg-subtle)]">
                    TP{tp.level}
                  </span>
                  <span className="text-[10px] text-[var(--color-fg-muted)]">
                    {Math.round(tp.allocation * 100)}%
                  </span>
                </div>
                <div className="mt-0.5 num text-sm font-semibold tabular-nums text-[var(--color-fg)]">
                  {formatPriceLabel(tp.price, currency)}
                </div>
                <div
                  className={cn(
                    "num text-[10px] tabular-nums",
                    tp.percent >= 0
                      ? "text-[var(--color-bull)]"
                      : "text-[var(--color-bear)]",
                  )}
                >
                  {tp.percent >= 0 ? "+" : ""}
                  {tp.percent.toFixed(2)}%
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Timing block */}
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-[var(--color-border)] px-3 py-2">
          <Clock className="h-3 w-3 shrink-0 text-[var(--color-fg-subtle)]" />
          <span className="text-[11px] text-[var(--color-fg-muted)]">
            {signal.timing.bestEntryNote}
          </span>
          <CountdownChip exitBy={signal.timing.exitBy} />
        </div>

        {/* AI rationale */}
        {signal.reasons.length > 0 && (
          <div className="mt-3">
            <div className="mb-1.5 inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-subtle)]">
              <Brain className="h-3 w-3" />
              Why the AI is {signal.direction.toLowerCase()}
              <span className="ml-1 rounded-full bg-[var(--color-surface-hover)] px-1.5 py-0.5 text-[9px] text-[var(--color-fg-muted)]">
                {signal.bullishCount} bull · {signal.bearishCount} bear
              </span>
            </div>
            <ul className="flex flex-col gap-1">
              {signal.reasons.map((r, idx) => {
                const meta = CATEGORY_META[r.category];
                const CatIcon = meta.icon;
                return (
                  <li
                    key={idx}
                    className="flex items-start gap-2 text-[11px] leading-snug text-[var(--color-fg-muted)]"
                  >
                    <span
                      className={cn(
                        "mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider",
                        r.bullish
                          ? "bg-[color-mix(in_oklch,var(--color-bull)_14%,transparent)] text-[var(--color-bull)]"
                          : "bg-[color-mix(in_oklch,var(--color-bear)_14%,transparent)] text-[var(--color-bear)]",
                      )}
                    >
                      <CatIcon className="h-2.5 w-2.5" />
                      {meta.label}
                    </span>
                    <span>{r.text}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {/* Invalidation footer */}
        <div className="mt-3 rounded-lg bg-[color-mix(in_oklch,var(--color-warning)_8%,transparent)] px-3 py-2 text-[11px] leading-snug text-[var(--color-fg-muted)] ring-1 ring-inset ring-[color-mix(in_oklch,var(--color-warning)_25%,transparent)]">
          <span className="font-semibold text-[var(--color-warning)]">
            Invalidation:
          </span>{" "}
          {signal.invalidationCriteria}
        </div>
      </CardContent>
    </Card>
  );
}

function Metric({
  label,
  value,
  tone,
  toneClass,
}: {
  label: string;
  value: string;
  tone?: "bull" | "bear" | "neutral";
  toneClass?: string;
}) {
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-2 py-1.5">
      <div className="text-[9px] uppercase tracking-[0.14em] text-[var(--color-fg-subtle)]">
        {label}
      </div>
      <div
        className={cn(
          "num mt-0.5 text-sm font-semibold tabular-nums",
          toneClass
            ? toneClass
            : tone === "bull"
              ? "text-[var(--color-bull)]"
              : tone === "bear"
                ? "text-[var(--color-bear)]"
                : "text-[var(--color-fg)]",
        )}
      >
        {value}
      </div>
    </div>
  );
}
