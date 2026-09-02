"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ConfusionMatrix } from "@/lib/signal-quality/types";

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <p className="text-[10px] uppercase tracking-wider" style={{ color: "var(--color-fg-subtle)" }}>
        {label}
      </p>
      <p className="text-lg font-bold tabular-nums" style={{ color: color ?? "var(--color-fg)" }}>
        {value}
      </p>
    </div>
  );
}

function pct(n: number) {
  return `${(n * 100).toFixed(1)}%`;
}

export function ConfusionMatrixCard({ matrix }: { matrix: ConfusionMatrix }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-semibold tracking-tight">
            {matrix.strategyId}
          </CardTitle>
          <span
            className="rounded px-1.5 py-0.5 text-[10px] font-medium"
            style={{
              background:
                matrix.significanceLevel === "STATISTICALLY_MEANINGFUL"
                  ? "color-mix(in oklch, var(--color-bull) 15%, transparent)"
                  : matrix.significanceLevel === "MARGINAL"
                  ? "color-mix(in oklch, var(--color-warning) 15%, transparent)"
                  : "color-mix(in oklch, var(--color-bear) 15%, transparent)",
              color:
                matrix.significanceLevel === "STATISTICALLY_MEANINGFUL"
                  ? "var(--color-bull)"
                  : matrix.significanceLevel === "MARGINAL"
                  ? "var(--color-warning)"
                  : "var(--color-bear)",
            }}
          >
            n={matrix.sampleSize}
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Confusion quadrants */}
        <div className="grid grid-cols-2 gap-1.5">
          <div
            className="rounded-lg p-2.5 text-center"
            style={{ background: "color-mix(in oklch, var(--color-bull) 12%, transparent)" }}
          >
            <p className="text-[10px] uppercase tracking-wider" style={{ color: "var(--color-bull)" }}>
              True Positives
            </p>
            <p className="text-2xl font-bold" style={{ color: "var(--color-bull)" }}>
              {matrix.truePositives}
            </p>
          </div>
          <div
            className="rounded-lg p-2.5 text-center"
            style={{ background: "color-mix(in oklch, var(--color-bear) 12%, transparent)" }}
          >
            <p className="text-[10px] uppercase tracking-wider" style={{ color: "var(--color-bear)" }}>
              False Positives
            </p>
            <p className="text-2xl font-bold" style={{ color: "var(--color-bear)" }}>
              {matrix.falsePositives}
            </p>
          </div>
          <div
            className="rounded-lg p-2.5 text-center"
            style={{ background: "color-mix(in oklch, var(--color-warning) 12%, transparent)" }}
          >
            <p className="text-[10px] uppercase tracking-wider" style={{ color: "var(--color-warning)" }}>
              False Negatives
            </p>
            <p className="text-2xl font-bold" style={{ color: "var(--color-warning)" }}>
              {matrix.falseNegatives}
            </p>
          </div>
          <div
            className="rounded-lg p-2.5 text-center"
            style={{ background: "color-mix(in oklch, var(--color-info) 10%, transparent)" }}
          >
            <p className="text-[10px] uppercase tracking-wider" style={{ color: "var(--color-info)" }}>
              True Negatives
            </p>
            <p className="text-2xl font-bold" style={{ color: "var(--color-info)" }}>
              {matrix.trueNegatives}
            </p>
          </div>
        </div>

        {/* Derived metrics */}
        <div className="grid grid-cols-3 gap-2 border-t pt-3" style={{ borderColor: "var(--color-border)" }}>
          <Stat
            label="Precision"
            value={pct(matrix.precision)}
            color={matrix.precision > 0.55 ? "var(--color-bull)" : matrix.precision > 0.45 ? "var(--color-warning)" : "var(--color-bear)"}
          />
          <Stat
            label="Recall"
            value={pct(matrix.recall)}
            color="var(--color-fg)"
          />
          <Stat
            label="F1 Score"
            value={matrix.f1.toFixed(3)}
            color={matrix.f1 > 0.6 ? "var(--color-bull)" : "var(--color-fg-muted)"}
          />
          <Stat label="Specificity" value={pct(matrix.specificity)} />
          <Stat label="FP Rate" value={pct(matrix.falsePositiveRate)} color="var(--color-bear)" />
          <Stat label="FN Rate" value={pct(matrix.falseNegativeRate)} color="var(--color-warning)" />
        </div>
      </CardContent>
    </Card>
  );
}
