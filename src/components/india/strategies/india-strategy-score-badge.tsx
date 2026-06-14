"use client";

import type {
  IndiaStrategyGrade,
  IndiaStrategyRecommendation,
  IndiaStrategyScore,
} from "@/features/india/scalping/strategy-score";
import { cn } from "@/lib/utils";

/**
 * Compact paper-trade score chip for the India strategy picker. Mirrors
 * the crypto `StrategyScoreBadge` 1:1 in look and recommendation-aware
 * colours, but typed to the India scoring engine so the NSE stack stays
 * self-contained. The score reflects the live paper-trade track record
 * (the F&O paper-trader worker fills the journal), not a 5y backtest.
 */

interface Props {
  /** When undefined, renders a neutral "pending" placeholder. */
  score?: IndiaStrategyScore | null;
  fullWidth?: boolean;
  compact?: boolean;
  className?: string;
}

export function IndiaStrategyScoreBadge({
  score,
  fullWidth,
  compact,
  className,
}: Props) {
  if (!score) {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-md border border-dashed border-[var(--color-border)] px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-wider text-[var(--color-fg-subtle)]",
          fullWidth && "w-full justify-center",
          className,
        )}
        title="No closed paper trades yet — the F&O paper-trader is still building this strategy's record."
      >
        {compact ? "—" : "No trades yet"}
      </span>
    );
  }

  const palette = paletteFor(score.recommendation);

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-[10px] font-medium",
        palette.bg,
        palette.border,
        palette.text,
        fullWidth && "w-full justify-center",
        className,
      )}
      title={score.rationale}
    >
      <span
        className="rounded-sm bg-[var(--color-bg-elevated)] px-1 text-[8px] font-bold uppercase leading-none tracking-wider opacity-80"
        title={
          score.source === "backtest"
            ? "Score from the 5-year OHLCV backtest"
            : "Score from the live paper-trade record"
        }
      >
        {score.source === "backtest" ? "5Y" : "PT"}
      </span>
      <span className="font-mono text-[10px] tabular-nums">{score.score}/100</span>
      <span
        className={cn(
          "rounded px-1 py-[1px] text-[10px] font-bold leading-none",
          palette.gradeBg,
          palette.gradeText,
        )}
      >
        {score.grade}
      </span>
      {!compact ? (
        <span className="hidden truncate text-[10px] font-normal opacity-90 sm:inline">
          {score.recommendationLabel}
        </span>
      ) : null}
    </span>
  );
}

interface Palette {
  bg: string;
  border: string;
  text: string;
  gradeBg: string;
  gradeText: string;
}

function paletteFor(rec: IndiaStrategyRecommendation): Palette {
  switch (rec) {
    case "highly-recommended":
      return {
        bg: "bg-[color-mix(in_oklch,var(--color-bull)_14%,transparent)]",
        border: "border-[color-mix(in_oklch,var(--color-bull)_35%,transparent)]",
        text: "text-[var(--color-bull)]",
        gradeBg: "bg-[color-mix(in_oklch,var(--color-bull)_25%,transparent)]",
        gradeText: "text-[var(--color-bull)]",
      };
    case "recommended":
      return {
        bg: "bg-[color-mix(in_oklch,var(--color-info)_12%,transparent)]",
        border: "border-[color-mix(in_oklch,var(--color-info)_35%,transparent)]",
        text: "text-[var(--color-info)]",
        gradeBg: "bg-[color-mix(in_oklch,var(--color-info)_22%,transparent)]",
        gradeText: "text-[var(--color-info)]",
      };
    case "use-cautiously":
      return {
        bg: "bg-[color-mix(in_oklch,var(--color-warning)_12%,transparent)]",
        border: "border-[color-mix(in_oklch,var(--color-warning)_35%,transparent)]",
        text: "text-[var(--color-warning)]",
        gradeBg: "bg-[color-mix(in_oklch,var(--color-warning)_22%,transparent)]",
        gradeText: "text-[var(--color-warning)]",
      };
    case "not-recommended":
      return {
        bg: "bg-[color-mix(in_oklch,var(--color-bear)_10%,transparent)]",
        border: "border-[color-mix(in_oklch,var(--color-bear)_30%,transparent)]",
        text: "text-[var(--color-bear)]",
        gradeBg: "bg-[color-mix(in_oklch,var(--color-bear)_22%,transparent)]",
        gradeText: "text-[var(--color-bear)]",
      };
  }
}

// Re-exported for callers that want to render the grade letter elsewhere.
export type { IndiaStrategyGrade };
