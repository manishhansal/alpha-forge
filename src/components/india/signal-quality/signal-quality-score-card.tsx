"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { VerdictBadge } from "./verdict-badge";
import type { SignalQualityScore } from "@/lib/signal-quality/types";

/** Weighted component definitions — must match engine weights exactly */
const SCORE_COMPONENTS: Array<{
  key: keyof SignalQualityScore["breakdown"];
  label: string;
  weight: number;
  higherIsBetter: boolean;
}> = [
  { key: "precisionScore",         label: "Precision",           weight: 20, higherIsBetter: true  },
  { key: "expectancyScore",        label: "Expectancy",          weight: 20, higherIsBetter: true  },
  { key: "drawdownScore",          label: "Drawdown (inverse)",  weight: 10, higherIsBetter: true  },
  { key: "recallScore",            label: "Recall",              weight: 10, higherIsBetter: true  },
  { key: "costRobustnessScore",    label: "Cost Robustness",     weight: 10, higherIsBetter: true  },
  { key: "calibrationScore",       label: "Calibration",         weight: 10, higherIsBetter: true  },
  { key: "regimeConsistencyScore", label: "Regime Consistency",  weight: 10, higherIsBetter: true  },
  { key: "sampleSizeScore",        label: "Sample Size",         weight: 5,  higherIsBetter: true  },
  { key: "paperExecutionScore",    label: "Paper Execution",     weight: 5,  higherIsBetter: true  },
];

function ScoreRing({ score }: { score: number }) {
  const size = 80;
  const stroke = 8;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - score / 100);
  const color =
    score >= 75
      ? "var(--color-bull)"
      : score >= 50
      ? "var(--color-warning)"
      : "var(--color-bear)";

  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--color-border)"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeDasharray={circ}
          strokeDashoffset={offset}
          strokeLinecap="round"
          style={{ transition: "stroke-dashoffset 0.6s ease" }}
        />
      </svg>
      <div
        className="absolute inset-0 flex flex-col items-center justify-center"
      >
        <p className="text-lg font-bold leading-none" style={{ color }}>
          {score}
        </p>
        <p className="text-[9px]" style={{ color: "var(--color-fg-subtle)" }}>
          / 100
        </p>
      </div>
    </div>
  );
}

export function SignalQualityScoreCard({ scoreData }: { scoreData: SignalQualityScore }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-semibold tracking-tight">
            {scoreData.label}
          </CardTitle>
          <VerdictBadge verdict={scoreData.verdict} />
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex items-start gap-4">
          {/* Score ring */}
          <ScoreRing score={scoreData.score} />

          {/* Component breakdown bars */}
          <div className="flex-1 space-y-1.5">
            {SCORE_COMPONENTS.map((comp) => {
              const rawVal = scoreData.breakdown[comp.key] as number;
              const contribution = rawVal * comp.weight;
              const barPct = Math.min(100, Math.round(rawVal * 100));
              const barColor =
                barPct > 70
                  ? "var(--color-bull)"
                  : barPct > 40
                  ? "var(--color-warning)"
                  : "var(--color-bear)";

              return (
                <div key={comp.key} className="flex items-center gap-2">
                  <p
                    className="w-[130px] text-[10px] shrink-0"
                    style={{ color: "var(--color-fg-subtle)" }}
                  >
                    {comp.label}
                  </p>
                  <div
                    className="h-2 flex-1 overflow-hidden rounded-full"
                    style={{ background: "var(--color-surface)" }}
                  >
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${barPct}%`, background: barColor }}
                    />
                  </div>
                  <p
                    className="w-[34px] text-right text-[10px] font-mono"
                    style={{ color: "var(--color-fg-muted)" }}
                  >
                    {contribution.toFixed(1)}
                  </p>
                  <p
                    className="w-[24px] text-right text-[9px]"
                    style={{ color: "var(--color-fg-subtle)" }}
                  >
                    ×{comp.weight}
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
