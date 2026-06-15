import {
  ArrowDownRight,
  ArrowUpRight,
  Gauge,
  Rocket,
  ShieldAlert,
  Sparkles,
  Target,
  TrendingUp,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { DailyPick, DailyPickStatus } from "@/features/india/daily-picks/engine";
import { fmt, fmtPct } from "@/lib/india/format";
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
  EXPIRED: { label: "Expired", variant: "warning" },
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

  const pnl = pick.pnlPct;
  const pnlTone = pnl == null ? "neutral" : pnl >= 0 ? "bull" : "bear";
  const achieved = pick.achievedPct;
  const progressWidth = Math.max(0, Math.min(100, achieved ?? 0));

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
                NSE F&amp;O · {pick.horizon}
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
            tone={isBull ? "bear" : "bull"}
            icon={<ShieldAlert className="h-3 w-3" />}
          />
          <Field
            label="Target"
            value={`₹${fmt(pick.target)}`}
            sub={fmtPct(((pick.target - pick.entry) / pick.entry) * 100)}
            tone={isBull ? "bull" : "bear"}
            icon={<Target className="h-3 w-3" />}
          />
          <Field
            label="Can move upto"
            value={`₹${fmt(pick.canMoveUpto)}`}
            sub={fmtPct(((pick.canMoveUpto - pick.entry) / pick.entry) * 100)}
            tone={isBull ? "bull" : "bear"}
            icon={<Rocket className="h-3 w-3" />}
          />
          <Field
            label="Can expect"
            value={`${isBull ? "+" : "-"}${fmt(pick.canExpectPct)}%`}
            sub={`RR ${pick.riskReward.toFixed(1)}:1`}
            tone={isBull ? "bull" : "bear"}
            icon={<TrendingUp className="h-3 w-3" />}
          />
          <Field
            label="Win prob"
            value={`${Math.round(pick.winProbability * 100)}%`}
            icon={<Gauge className="h-3 w-3" />}
          />
        </div>

        {/* Logic */}
        <p className="rounded-lg border border-dashed border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3 py-2 text-[11px] leading-relaxed text-[var(--color-fg-muted)]">
          <span className="font-semibold text-[var(--color-fg)]">Why here: </span>
          {pick.logic}
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
