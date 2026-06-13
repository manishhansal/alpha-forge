"use client";

import { Activity, Brain, Sparkles, TrendingDown, TrendingUp, Waves } from "lucide-react";

import { cn } from "@/lib/utils";
import type { AiMarketContext, AiSignalsResponse } from "@/types/ai-signals";

interface Props {
  context: AiMarketContext;
  stats: AiSignalsResponse["stats"];
}

const REGIME_META = {
  "risk-on": {
    label: "Risk-On",
    icon: TrendingUp,
    bg: "bg-[color-mix(in_oklch,var(--color-bull)_12%,transparent)]",
    accent: "text-[var(--color-bull)]",
    ring: "ring-[color-mix(in_oklch,var(--color-bull)_35%,transparent)]",
  },
  "risk-off": {
    label: "Risk-Off",
    icon: TrendingDown,
    bg: "bg-[color-mix(in_oklch,var(--color-bear)_12%,transparent)]",
    accent: "text-[var(--color-bear)]",
    ring: "ring-[color-mix(in_oklch,var(--color-bear)_35%,transparent)]",
  },
  mixed: {
    label: "Mixed",
    icon: Waves,
    bg: "bg-[color-mix(in_oklch,var(--color-info)_10%,transparent)]",
    accent: "text-[var(--color-info)]",
    ring: "ring-[color-mix(in_oklch,var(--color-info)_30%,transparent)]",
  },
  compressed: {
    label: "Compressed",
    icon: Activity,
    bg: "bg-[color-mix(in_oklch,var(--color-warning)_10%,transparent)]",
    accent: "text-[var(--color-warning)]",
    ring: "ring-[color-mix(in_oklch,var(--color-warning)_30%,transparent)]",
  },
} as const;

/**
 * Hero banner the AI Signals page renders above the signal grid. Shows the
 * detected market regime, a one-line headline, and a counter strip
 * (bullish / bearish / wait / top-grade).
 */
export function AiMarketContextBanner({ context, stats }: Props) {
  const meta = REGIME_META[context.regime];
  const Icon = meta.icon;
  const avgPct = Math.round(stats.avgConfidence * 100);
  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-xl border border-[var(--color-border)] p-4 ring-1 ring-inset md:flex-row md:items-center md:justify-between",
        meta.bg,
        meta.ring,
      )}
    >
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "grid h-11 w-11 shrink-0 place-items-center rounded-full bg-[var(--color-bg-elevated)] ring-1 ring-inset ring-[var(--color-border)]",
            meta.accent,
          )}
        >
          <Icon className="h-5 w-5" />
        </span>
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ring-1 ring-inset",
                meta.accent,
                meta.ring,
                "bg-[var(--color-bg-elevated)]",
              )}
            >
              <Sparkles className="h-3 w-3" />
              {meta.label}
            </span>
            <span className="text-sm font-semibold text-[var(--color-fg)]">
              {context.headline}
            </span>
          </div>
          <ul className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[var(--color-fg-muted)]">
            {context.bullets.map((b) => (
              <li key={b} className="flex items-center gap-1">
                <span className="h-1 w-1 rounded-full bg-[var(--color-fg-subtle)]" />
                {b}
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-1.5 md:gap-2">
        <Stat label="Bullish" value={stats.bullish} tone="bull" />
        <Stat label="Bearish" value={stats.bearish} tone="bear" />
        <Stat label="Wait" value={stats.wait} tone="neutral" />
        <Stat
          label="Avg Conf."
          value={`${avgPct}%`}
          tone={avgPct >= 60 ? "bull" : avgPct >= 40 ? "neutral" : "bear"}
          icon={<Brain className="h-3 w-3" />}
        />
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
  icon,
}: {
  label: string;
  value: string | number;
  tone: "bull" | "bear" | "neutral";
  icon?: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-2 py-1.5 text-center">
      <div className="flex items-center justify-center gap-1 text-[9px] uppercase tracking-[0.14em] text-[var(--color-fg-subtle)]">
        {icon}
        {label}
      </div>
      <div
        className={cn(
          "num mt-0.5 text-sm font-semibold tabular-nums",
          tone === "bull"
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
