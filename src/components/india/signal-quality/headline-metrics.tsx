"use client";

import { Card, CardContent } from "@/components/ui/card";
import { BentoGrid, BentoCell } from "@/components/layout/BentoGrid";
import type { SignalQualityReport } from "@/lib/signal-quality/types";

interface MetricTileProps {
  label: string;
  value: string;
  sub?: string;
  color?: string;
}

function MetricTile({ label, value, sub, color }: MetricTileProps) {
  return (
    <Card className="h-full">
      <CardContent className="flex flex-col justify-between gap-1 p-4">
        <p
          className="text-[11px] uppercase tracking-widest"
          style={{ color: "var(--color-fg-subtle)" }}
        >
          {label}
        </p>
        <p
          className="text-2xl font-bold tabular-nums leading-none"
          style={{ color: color ?? "var(--color-fg)" }}
        >
          {value}
        </p>
        {sub && (
          <p className="text-[11px]" style={{ color: "var(--color-fg-subtle)" }}>
            {sub}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export function HeadlineMetrics({ report }: { report: SignalQualityReport }) {
  const best = report.leaderboard[0];
  const highQualityCount = report.finalVerdicts.filter((v) => v.verdict === "HIGH_QUALITY").length;
  const totalStrategies = report.finalVerdicts.length;
  const disableCount = report.finalVerdicts.filter(
    (v) => v.verdict === "DISABLE_CANDIDATE" || v.verdict === "DEGRADED",
  ).length;

  // Overall precision (trade-count weighted average)
  const weightedPrec =
    report.leaderboard.reduce((s, l) => s + l.precision * l.sampleSize, 0) /
    Math.max(1, report.leaderboard.reduce((s, l) => s + l.sampleSize, 0));

  // Overall calibration (from ALL bucket)
  const allCalib = report.confidenceCalibration.find((c) => c.strategyId === "ALL");
  const overallEce = allCalib?.ece ?? 0;

  return (
    <BentoGrid cols={12} gap="gap-4">
      <BentoCell colSpan={2}>
        <MetricTile
          label="Signals Evaluated"
          value={report.totalSignalsEvaluated.toLocaleString()}
          sub={`${report.totalTradesEvaluated} paper trades`}
          color="var(--color-fg)"
        />
      </BentoCell>
      <BentoCell colSpan={2}>
        <MetricTile
          label="Evaluation Window"
          value={`${report.evaluationWindowDays}d`}
          sub={`${totalStrategies} strategies analysed`}
        />
      </BentoCell>
      <BentoCell colSpan={2}>
        <MetricTile
          label="Weighted Precision"
          value={`${(weightedPrec * 100).toFixed(1)}%`}
          sub="WIN / (WIN + LOSS)"
          color={weightedPrec > 0.55 ? "var(--color-bull)" : weightedPrec > 0.45 ? "var(--color-warning)" : "var(--color-bear)"}
        />
      </BentoCell>
      <BentoCell colSpan={2}>
        <MetricTile
          label="Confidence ECE"
          value={overallEce > 0 ? overallEce.toFixed(3) : "—"}
          sub={allCalib?.overallAssessment?.replace(/_/g, " ") ?? "No data"}
          color={overallEce < 0.05 ? "var(--color-bull)" : overallEce < 0.10 ? "var(--color-warning)" : "var(--color-bear)"}
        />
      </BentoCell>
      <BentoCell colSpan={2}>
        <MetricTile
          label="High Quality"
          value={`${highQualityCount} / ${totalStrategies}`}
          sub="strategies passing threshold"
          color={highQualityCount > 0 ? "var(--color-bull)" : "var(--color-fg-muted)"}
        />
      </BentoCell>
      <BentoCell colSpan={2}>
        <MetricTile
          label="Disable Candidates"
          value={`${disableCount}`}
          sub="degraded or disable verdict"
          color={disableCount > 0 ? "var(--color-bear)" : "var(--color-bull)"}
        />
      </BentoCell>
    </BentoGrid>
  );
}
