import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  CalendarRange,
  Clock,
  Gauge,
  Info,
  Rocket,
  ShieldAlert,
  Sparkles,
  Target,
  TrendingUp,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type {
  DailyPick,
  DailyPickStatus,
  DailyPickWarning,
  DailyPickWarningSeverity,
} from "@/features/india/daily-picks/engine";
import { fmt, fmtDuration, fmtIstTime, fmtPct } from "@/lib/india/format";
import { cn } from "@/lib/utils";

interface Props {
  pick: DailyPick;
}

const STATUS_META: Record<
  DailyPickStatus,
  { label: string; variant: "bull" | "bear" | "neutral" | "warning" }
> = {
  OPEN: { label: "Live", variant: "neutral" },
  TARGET_HIT: { label: "Target hit", variant: "bull" },
  STOP_HIT: { label: "Stopped out", variant: "bear" },
  CLOSED: { label: "Squared off", variant: "neutral" },
  EXPIRED: { label: "Expired", variant: "warning" },
};

/** Leading verb for the time-to-outcome line, by status. */
const OUTCOME_VERB: Record<DailyPickStatus, string> = {
  OPEN: "Live for",
  TARGET_HIT: "Target hit in",
  STOP_HIT: "Stopped in",
  CLOSED: "Squared off in",
  EXPIRED: "Expired after",
};

/** Map a warning severity to the Badge variant. */
const WARNING_VARIANT: Record<
  DailyPickWarningSeverity,
  "warning" | "bear" | "neutral"
> = {
  info: "neutral",
  warn: "warning",
  danger: "bear",
};

/**
 * One Daily Pick — frozen entry / stop / target / "can move upto" / "can
 * expect", the live P&L and progress-to-target, plus the logic explaining why
 * the signal sits in its bucket. Direction-aware (LONG vs SHORT) for every
 * derived percentage.
 */
export function DailyPickCard({ pick }: Props) {
  const isBull = pick.direction !== "BEARISH";
  const DirIcon = isBull ? ArrowUpRight : ArrowDownRight;
  const status = STATUS_META[pick.status];
  // Option-mode: entry / stop / target / lastPrice are *premium* ₹, not the
  // underlying. Premiums always move DOWN on a stop and UP on a target,
  // regardless of CE/PE — so the level-tone logic differs from a spot trade.
  const isOption = pick.optionContract != null;
  const stopTone: "bull" | "bear" = isOption ? "bear" : isBull ? "bear" : "bull";
  const targetTone: "bull" | "bear" = isOption ? "bull" : isBull ? "bull" : "bear";

  const pnl = pick.pnlPct;
  const pnlTone = pnl == null ? "neutral" : pnl >= 0 ? "bull" : "bear";
  const achieved = pick.achievedPct;
  const progressWidth = Math.max(0, Math.min(100, achieved ?? 0));

  // Timing — when the signal appeared on the board, and how long it took to
  // resolve (target / stop / square-off). For a still-live pick we show how
  // long it's been running so far instead.
  const appearedAt = fmtIstTime(pick.generatedAt);
  const elapsedMs = (pick.resolvedAt ?? Date.now()) - pick.generatedAt;
  const elapsed = fmtDuration(elapsedMs);

  const subtitle = isOption && pick.optionContract
    ? `NSE OPT · ${pick.optionContract.side} ${pick.optionContract.strike} · Lot ${pick.optionContract.lotSize} · ${pick.optionContract.expiry}`
    : `NSE F&O · ${pick.horizon}`;

  const confluenceScore = pick.confluenceScore;
  const confluenceTone =
    confluenceScore >= 8 ? "bull" : confluenceScore <= 4 ? "bear" : "neutral";
  const timeWindow = pick.timeWindow;
  const keyIndicators = pick.keyIndicators ?? [];
  const warnings: DailyPickWarning[] = pick.warnings ?? [];
  const setupType = pick.setupType;
  const researchNote = pick.researchNote;

  return (
    <Card
      className={cn(
        "@container relative gap-3 overflow-hidden py-4 ring-1 ring-inset",
        isBull
          ? "ring-[color-mix(in_oklch,var(--color-bull)_35%,transparent)]"
          : "ring-[color-mix(in_oklch,var(--color-bear)_35%,transparent)]",
      )}
    >
      <CardHeader className="px-4">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-3">
            <span className="grid h-9 w-9 place-items-center rounded-full bg-[var(--color-bg-elevated)] text-[11px] font-semibold text-[var(--color-fg)] ring-1 ring-inset ring-[var(--color-border)]">
              #{pick.rank}
            </span>
            <div className="flex flex-col">
              <CardTitle className="text-sm text-[var(--color-fg)]">
                {pick.displayName}
              </CardTitle>
              <span className="text-[10px] uppercase tracking-[0.16em] text-[var(--color-fg-subtle)]">
                {subtitle}
              </span>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            <Badge variant={isBull ? "bull" : "bear"}>
              <DirIcon className="h-3 w-3" />
              {isBull ? "LONG" : "SHORT"}
            </Badge>
            <Badge variant="info" title={`Grade ${pick.grade}`}>
              {pick.grade}
            </Badge>
          </div>
        </div>
        {setupType ? (
          <p className="mt-1 text-[10px] uppercase tracking-[0.16em] text-[var(--color-fg-subtle)]">
            <span className="text-[var(--color-fg-muted)]">Setup · </span>
            <span className="font-medium text-[var(--color-fg)] normal-case tracking-normal">
              {setupType}
            </span>
          </p>
        ) : null}
      </CardHeader>

      <CardContent className="flex flex-col gap-3 px-4">
        {/* Live tracking strip */}
        <div className="flex items-center justify-between gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3 py-2">
          <div className="flex items-center gap-2">
            <Badge variant={status.variant}>{status.label}</Badge>
            <span className="text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-subtle)]">
              Conf {pick.confidenceScore}
            </span>
          </div>
          <div className="flex flex-col items-end">
            <span
              className={cn(
                "num text-sm font-semibold",
                pnlTone === "bull"
                  ? "text-bull"
                  : pnlTone === "bear"
                    ? "text-bear"
                    : "text-[var(--color-fg-muted)]",
              )}
              aria-label="Live P&L"
            >
              {pnl == null ? "—" : fmtPct(pnl)}
            </span>
            <span className="text-[10px] text-[var(--color-fg-subtle)]">
              {pick.lastPrice != null ? `LTP ₹${fmt(pick.lastPrice)}` : "awaiting tick"}
            </span>
          </div>
        </div>

        {/* Spec strip — Confluence X/10 + Time Window. The card already shows
            a Conf 0-100 in the live strip above; this one renders the
            ladder-aligned X/10 the desk reads off the spec. */}
        {(confluenceScore > 0 || timeWindow) ? (
          <div className="flex items-center justify-between gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3 py-2">
            <div className="flex flex-col">
              <span className="text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-subtle)]">
                Confluence
              </span>
              <span
                className={cn(
                  "num text-sm font-semibold",
                  confluenceTone === "bull"
                    ? "text-bull"
                    : confluenceTone === "bear"
                      ? "text-bear"
                      : "text-[var(--color-fg)]",
                )}
              >
                {confluenceScore}
                <span className="text-[var(--color-fg-subtle)]">/10</span>
              </span>
            </div>
            {timeWindow ? (
              <div className="flex flex-col items-end">
                <span className="flex items-center gap-1 text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-subtle)]">
                  <CalendarRange className="h-3 w-3" />
                  Time window
                </span>
                <span className="num text-[12px] font-medium text-[var(--color-fg-muted)]">
                  {timeWindow.start}–{timeWindow.end} IST
                </span>
                <span className="text-[10px] text-[var(--color-fg-subtle)]">
                  {timeWindow.label}
                </span>
              </div>
            ) : null}
          </div>
        ) : null}

        {/* Warning badges — HIGH VIX, EVENT RISK, LOW CONFIDENCE, … */}
        {warnings.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {warnings.map((w) => (
              <Badge
                key={w.kind}
                variant={WARNING_VARIANT[w.severity]}
                title={w.note}
              >
                <AlertTriangle className="h-3 w-3" />
                {w.label}
              </Badge>
            ))}
          </div>
        ) : null}

        {/* Timing — appeared on the board + time-to-outcome */}
        <div className="flex items-center justify-between gap-2 text-[10px] text-[var(--color-fg-subtle)]">
          <span className="flex items-center gap-1">
            <Clock className="h-3 w-3" />
            Appeared{" "}
            <span className="num text-[var(--color-fg-muted)]">{appearedAt}</span>{" "}
            IST
          </span>
          <span className="num text-[var(--color-fg-muted)]">
            {OUTCOME_VERB[pick.status]} {elapsed}
          </span>
        </div>

        {/* Progress toward target */}
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-subtle)]">
            <span>Achieved till now</span>
            <span className="num text-[var(--color-fg-muted)]">
              {achieved == null ? "—" : `${achieved.toFixed(0)}% of target`}
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-bg-elevated)]">
            <div
              className={cn(
                "h-full rounded-full transition-all",
                pick.status === "STOP_HIT"
                  ? "bg-[var(--color-bear)]"
                  : "bg-[var(--color-bull)]",
              )}
              style={{ width: `${progressWidth}%` }}
            />
          </div>
        </div>

        {/* Levels */}
        <div className="grid grid-cols-2 gap-2 text-xs @sm:grid-cols-3">
          <Field label="Entry" value={`₹${fmt(pick.entry)}`} icon={<Sparkles className="h-3 w-3" />} />
          <Field
            label="Stop loss"
            value={`₹${fmt(pick.stopLoss)}`}
            sub={fmtPct(((pick.stopLoss - pick.entry) / pick.entry) * 100)}
            tone={stopTone}
            icon={<ShieldAlert className="h-3 w-3" />}
          />
          <Field
            label="Target"
            value={`₹${fmt(pick.target)}`}
            sub={fmtPct(((pick.target - pick.entry) / pick.entry) * 100)}
            tone={targetTone}
            icon={<Target className="h-3 w-3" />}
          />
          <Field
            label="Can move upto"
            value={`₹${fmt(pick.canMoveUpto)}`}
            sub={fmtPct(((pick.canMoveUpto - pick.entry) / pick.entry) * 100)}
            tone={targetTone}
            icon={<Rocket className="h-3 w-3" />}
          />
          <Field
            label="Can expect"
            value={`${isOption ? "+" : isBull ? "+" : "-"}${fmt(pick.canExpectPct)}%`}
            sub={`RR ${pick.riskReward.toFixed(1)}:1`}
            tone={targetTone}
            icon={<TrendingUp className="h-3 w-3" />}
          />
          <Field
            label="Win prob"
            value={`${Math.round(pick.winProbability * 100)}%`}
            icon={<Gauge className="h-3 w-3" />}
          />
        </div>

        {/* Key Indicators — chip row of the technical/structural factors
            driving the pick (RSI / VWAP / OI / PCR / ATR / …). */}
        {keyIndicators.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-subtle)]">
              Key Indicators
            </span>
            {keyIndicators.map((k) => (
              <span
                key={k}
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-fg-muted)]"
              >
                {k}
              </span>
            ))}
          </div>
        ) : null}

        {/* Logic */}
        <p className="rounded-lg border border-dashed border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3 py-2 text-[11px] leading-relaxed text-[var(--color-fg-muted)]">
          <span className="font-semibold text-[var(--color-fg)]">Why here: </span>
          {pick.logic}
        </p>

        {/* Research Note — 3–5 sentence institutional thesis: why this stock
            today, what the chart shows, what the chain reveals, the risk
            and why the R:R justifies it. */}
        {researchNote ? (
          <div className="flex gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3 py-2">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-brand)]" />
            <div className="flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-subtle)]">
                Research Note
              </span>
              <p className="text-[11px] leading-relaxed text-[var(--color-fg-muted)]">
                {researchNote}
              </p>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Field({
  label,
  value,
  sub,
  tone,
  icon,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "bull" | "bear";
  icon?: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3 py-2">
      <span className="flex shrink-0 items-center gap-1 text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-subtle)]">
        {icon}
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
