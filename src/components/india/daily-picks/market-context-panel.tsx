/**
 * Daily Picks — Market Context Header panel.
 *
 * Mirrors the institutional Daily Picks spec's "Market Context Block": one
 * compact panel above the board with NIFTY / BANKNIFTY level + trend + S/R,
 * India VIX + regime, NIFTY PCR + interpretation, Max Pain (NIFTY +
 * BANKNIFTY), and the overall intraday bias headline.
 *
 * Fail-soft: every field renders `—` when its data source is unavailable.
 */

import * as React from "react";
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  CalendarDays,
  Gauge,
  Landmark,
  Layers,
  Scale,
  TrendingDown,
  TrendingUp,
  Waves,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { fmt } from "@/lib/india/format";
import type {
  IndexContextLine,
  IndexTrend,
  IndiaVixRegime,
  MarketContextHeader,
  PcrInterpretation,
} from "@/features/india/daily-picks/market-context";

type Tone = "bull" | "bear" | "neutral" | "warning" | "danger";

const TREND_TONE: Record<IndexTrend, Tone> = {
  bullish: "bull",
  bearish: "bear",
  sideways: "neutral",
};

const VIX_TONE: Record<IndiaVixRegime, Tone> = {
  low: "bull",
  moderate: "neutral",
  high: "warning",
  extreme: "danger",
};

const PCR_TONE: Record<PcrInterpretation, Tone> = {
  bullish: "bull",
  bearish: "bear",
  neutral: "neutral",
};

const TREND_ICON: Record<IndexTrend, React.ComponentType<{ className?: string }>> = {
  bullish: TrendingUp,
  bearish: TrendingDown,
  sideways: Activity,
};

const TREND_LABEL: Record<IndexTrend, string> = {
  bullish: "Bullish",
  bearish: "Bearish",
  sideways: "Sideways",
};

const VIX_LABEL: Record<IndiaVixRegime, string> = {
  low: "Low",
  moderate: "Moderate",
  high: "High",
  extreme: "Extreme",
};

const PCR_LABEL: Record<PcrInterpretation, string> = {
  bullish: "PE-heavy · Bullish",
  bearish: "CE-heavy · Bearish",
  neutral: "Neutral",
};

function toneClasses(tone: Tone): string {
  switch (tone) {
    case "bull":
      return "bg-[color-mix(in_oklch,var(--color-bull)_12%,transparent)] text-[var(--color-bull)] ring-[color-mix(in_oklch,var(--color-bull)_30%,transparent)]";
    case "bear":
      return "bg-[color-mix(in_oklch,var(--color-bear)_12%,transparent)] text-[var(--color-bear)] ring-[color-mix(in_oklch,var(--color-bear)_30%,transparent)]";
    case "warning":
      return "bg-[color-mix(in_oklch,var(--color-warning)_12%,transparent)] text-[var(--color-warning)] ring-[color-mix(in_oklch,var(--color-warning)_30%,transparent)]";
    case "danger":
      return "bg-[color-mix(in_oklch,var(--color-bear)_18%,transparent)] text-[var(--color-bear)] ring-[color-mix(in_oklch,var(--color-bear)_45%,transparent)]";
    default:
      return "bg-[var(--color-bg-elevated)] text-[var(--color-fg-muted)] ring-[var(--color-border)]";
  }
}

interface Props {
  header: MarketContextHeader;
}

export function MarketContextPanel({ header }: Props) {
  return (
    <section
      aria-label="Market Context Header"
      className="flex flex-col gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Layers className="h-4 w-4 text-[var(--color-brand)]" />
          <span className="text-sm font-semibold text-[var(--color-fg)]">
            Market Context
          </span>
        </div>
        <span className="flex items-center gap-1 text-[11px] text-[var(--color-fg-subtle)]">
          <CalendarDays className="h-3 w-3" />
          <span className="num">{header.date}</span>
        </span>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <IndexLine name="NIFTY 50" line={header.nifty} />
        <IndexLine name="BANKNIFTY" line={header.banknifty} />
        <ContextTile
          label="India VIX"
          value={
            header.indiaVix ? header.indiaVix.value.toFixed(2) : "—"
          }
          chip={
            header.indiaVix
              ? {
                  text: `${VIX_LABEL[header.indiaVix.regime]} regime`,
                  tone: VIX_TONE[header.indiaVix.regime],
                }
              : null
          }
          icon={<Gauge className="h-3 w-3" />}
        />
        <ContextTile
          label="PCR (NIFTY OI)"
          value={
            header.pcrNifty ? header.pcrNifty.value.toFixed(2) : "—"
          }
          chip={
            header.pcrNifty
              ? {
                  text: PCR_LABEL[header.pcrNifty.interpretation],
                  tone: PCR_TONE[header.pcrNifty.interpretation],
                }
              : null
          }
          icon={<Scale className="h-3 w-3" />}
        />
        <ContextTile
          label="Max Pain"
          value={
            header.maxPain.nifty != null
              ? `NIFTY ${fmt(header.maxPain.nifty)}`
              : "—"
          }
          sub={
            header.maxPain.banknifty != null
              ? `BANKNIFTY ${fmt(header.maxPain.banknifty)}`
              : "BANKNIFTY —"
          }
          icon={<Activity className="h-3 w-3" />}
        />
        <ContextTile
          label="F&O Flow Tilt"
          value={
            header.fiiFlow
              ? header.fiiFlow.note.replace(/^F&O OI tilt:\s*/i, "")
              : "—"
          }
          sub={
            header.fiiFlow
              ? "FII ₹Cr unavailable via SmartAPI — surfaced as OI-Buildup tilt"
              : undefined
          }
          icon={<Waves className="h-3 w-3" />}
          allowWrap
        />
        <SectorWatchTile watch={header.sectorWatch} />
        <ContextTile
          label="Bias"
          value={header.bias.headline}
          chip={{ text: header.bias.regime.toUpperCase(), tone: "neutral" }}
          // Bias headline can be a full sentence — let it wrap.
          allowWrap
        />
      </div>
    </section>
  );
}

function SectorWatchTile({
  watch,
}: {
  watch: MarketContextHeader["sectorWatch"];
}) {
  if (!watch || (watch.strong.length === 0 && watch.weak.length === 0)) {
    return (
      <ContextTile
        label="Sector Watch"
        value="—"
        icon={<Landmark className="h-3 w-3" />}
      />
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3 py-2">
      <span className="flex items-center gap-1 text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-subtle)]">
        <Landmark className="h-3 w-3" />
        Sector Watch
      </span>
      <div className="flex flex-col gap-1">
        {watch.strong.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1">
            <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.14em] text-bull">
              <ArrowUpRight className="h-3 w-3" />
              Strong
            </span>
            {watch.strong.map((name) => (
              <span
                key={`strong-${name}`}
                className={cn(
                  "rounded-md px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset",
                  toneClasses("bull"),
                )}
              >
                {name}
              </span>
            ))}
          </div>
        ) : null}
        {watch.weak.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1">
            <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.14em] text-bear">
              <ArrowDownRight className="h-3 w-3" />
              Weak
            </span>
            {watch.weak.map((name) => (
              <span
                key={`weak-${name}`}
                className={cn(
                  "rounded-md px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset",
                  toneClasses("bear"),
                )}
              >
                {name}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function IndexLine({
  name,
  line,
}: {
  name: string;
  line: IndexContextLine | null;
}) {
  if (!line) {
    return (
      <div className="flex min-w-0 flex-col gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3 py-2">
        <span className="text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-subtle)]">
          {name}
        </span>
        <span className="text-sm text-[var(--color-fg-muted)]">—</span>
      </div>
    );
  }
  const TrendIcon = TREND_ICON[line.trend];
  const trendTone = TREND_TONE[line.trend];
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-subtle)]">
          {name}
        </span>
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset",
            toneClasses(trendTone),
          )}
        >
          <TrendIcon className="h-3 w-3" />
          {TREND_LABEL[line.trend]}
        </span>
      </div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="num text-sm font-semibold text-[var(--color-fg)]">
          {fmt(line.level)}
        </span>
        <span
          className={cn(
            "num text-[11px] font-medium",
            line.changePct > 0
              ? "text-bull"
              : line.changePct < 0
                ? "text-bear"
                : "text-[var(--color-fg-muted)]",
          )}
        >
          {line.changePct > 0 ? "+" : ""}
          {line.changePct.toFixed(2)}%
        </span>
      </div>
      <div className="flex items-center gap-2 text-[10px] text-[var(--color-fg-subtle)]">
        <span>
          S{" "}
          <span className="num text-[var(--color-fg-muted)]">
            {line.support != null ? fmt(line.support) : "—"}
          </span>
        </span>
        <span className="h-1 w-1 rounded-full bg-[var(--color-fg-subtle)]" />
        <span>
          R{" "}
          <span className="num text-[var(--color-fg-muted)]">
            {line.resistance != null ? fmt(line.resistance) : "—"}
          </span>
        </span>
      </div>
    </div>
  );
}

function ContextTile({
  label,
  value,
  sub,
  chip,
  icon,
  allowWrap,
}: {
  label: string;
  value: string;
  sub?: string;
  chip?: { text: string; tone: Tone } | null;
  icon?: React.ReactNode;
  allowWrap?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1 text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-subtle)]">
          {icon}
          {label}
        </span>
        {chip ? (
          <span
            className={cn(
              "rounded-full px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset",
              toneClasses(chip.tone),
            )}
          >
            {chip.text}
          </span>
        ) : null}
      </div>
      <span
        className={cn(
          "num text-sm font-semibold text-[var(--color-fg)]",
          allowWrap ? "whitespace-normal" : "truncate",
        )}
      >
        {value}
      </span>
      {sub ? (
        <span className="num text-[10px] text-[var(--color-fg-subtle)]">
          {sub}
        </span>
      ) : null}
    </div>
  );
}
