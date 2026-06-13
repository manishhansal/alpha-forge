"use client";

import type {
  StrategyGrade,
  StrategyRecommendation,
  StrategyScoreBreakdown,
} from "@/features/scalping/strategy-score";
import { cn } from "@/lib/utils";

/**
 * Compact score chip rendered in the strategy picker and the backtest page.
 * Shows the 0-100 score plus the letter grade and uses recommendation-aware
 * colours so good strategies (green) stand out from "use cautiously" (amber)
 * and "not recommended" (red) at a glance.
 */

interface Props {
  /** When undefined, renders a neutral placeholder ("—"). */
  score?: StrategyScoreBreakdown | null;
  /** Stretch to fill the parent's width instead of hugging content. */
  fullWidth?: boolean;
  /** Compact variant — used inside the picker cards. */
  compact?: boolean;
  className?: string;
}

export function StrategyScoreBadge({ score, fullWidth, compact, className }: Props) {
  if (!score) {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-md border border-dashed border-[var(--color-border)] px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-wider text-[var(--color-fg-subtle)]",
          fullWidth && "w-full justify-center",
          className,
        )}
      >
        {compact ? "—" : "Backtest pending"}
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
      <span className="font-mono text-[10px] tabular-nums">{score.score}/100</span>
      <span
        className={cn(
          "rounded px-1 py-[1px] text-[10px] font-bold leading-none",
          palette.gradeBg,
          palette.gradeText,
        )}
      >
        {gradeLabel(score.grade)}
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

function paletteFor(rec: StrategyRecommendation): Palette {
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

function gradeLabel(grade: StrategyGrade): string {
  return grade;
}
