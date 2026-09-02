"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { GradeValidation } from "@/lib/signal-quality/types";

const GRADE_COLORS: Record<string, string> = {
  S: "var(--color-brand)",
  A: "var(--color-bull)",
  B: "var(--color-info)",
  C: "var(--color-warning)",
  D: "var(--color-bear)",
};

function fix2(n: number) {
  return Number.isFinite(n) ? n.toFixed(2) : "—";
}

export function GradeValidationCard({ validation }: { validation: GradeValidation }) {
  const verdictVariant =
    validation.verdict === "GRADE_SYSTEM_USEFUL"
      ? "bull"
      : validation.verdict === "GRADE_SYSTEM_WEAKLY_USEFUL"
      ? "warning"
      : "bear";

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-semibold tracking-tight">
            Grade Validation — {validation.strategyId}
          </CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant={verdictVariant}>
              {validation.verdict.replace(/_/g, " ")}
            </Badge>
            {validation.orderingValid ? (
              <span className="text-[10px]" style={{ color: "var(--color-bull)" }}>
                ✓ Ordering valid (S ≥ A ≥ B ≥ C ≥ D)
              </span>
            ) : (
              <span className="text-[10px]" style={{ color: "var(--color-bear)" }}>
                ✗ {validation.orderingBreaches.length} ordering breach
                {validation.orderingBreaches.length !== 1 ? "es" : ""}
              </span>
            )}
          </div>
        </div>
        <p className="mt-1 text-[11px]" style={{ color: "var(--color-fg-subtle)" }}>
          A useful grade system must show S ≥ A ≥ B ≥ C ≥ D for expectancy, win rate, and profit factor.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Grade metrics table */}
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr
                className="border-b text-[10px] uppercase tracking-widest"
                style={{ borderColor: "var(--color-border)", color: "var(--color-fg-subtle)" }}
              >
                <th className="px-3 py-1.5 text-left">Grade</th>
                <th className="px-3 py-1.5 text-right">n</th>
                <th className="px-3 py-1.5 text-right">Win Rate</th>
                <th className="px-3 py-1.5 text-right">Expectancy</th>
                <th className="px-3 py-1.5 text-right">Profit Factor</th>
                <th className="px-3 py-1.5 text-right">Avg Return</th>
                <th className="px-3 py-1.5 text-right">Avg Confidence</th>
                <th className="px-3 py-1.5 text-right">Avg R</th>
              </tr>
            </thead>
            <tbody>
              {(["S", "A", "B", "C", "D"] as const).map((g) => {
                const gm = validation.grades.find((gv) => gv.grade === g);
                if (!gm) {
                  return (
                    <tr
                      key={g}
                      className="border-b"
                      style={{ borderColor: "var(--color-border)" }}
                    >
                      <td className="px-3 py-1.5">
                        <span
                          className="inline-flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-bold"
                          style={{
                            background: "var(--color-surface)",
                            color: "var(--color-fg-subtle)",
                          }}
                        >
                          {g}
                        </span>
                      </td>
                      <td
                        colSpan={7}
                        className="px-3 py-1.5 text-[11px]"
                        style={{ color: "var(--color-fg-subtle)" }}
                      >
                        No data
                      </td>
                    </tr>
                  );
                }
                return (
                  <tr
                    key={g}
                    className="border-b hover:bg-[var(--color-surface-hover)]"
                    style={{ borderColor: "var(--color-border)" }}
                  >
                    <td className="px-3 py-1.5">
                      <span
                        className="inline-flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-bold"
                        style={{
                          background: "color-mix(in oklch, " + GRADE_COLORS[g] + " 15%, transparent)",
                          color: GRADE_COLORS[g],
                        }}
                      >
                        {g}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono" style={{ color: "var(--color-fg-muted)" }}>
                      {gm.signalCount}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      <span
                        style={{
                          color:
                            gm.winRate > 0.6
                              ? "var(--color-bull)"
                              : gm.winRate > 0.45
                              ? "var(--color-fg)"
                              : "var(--color-bear)",
                        }}
                      >
                        {(gm.winRate * 100).toFixed(1)}%
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      <span
                        style={{
                          color: gm.avgExpectancy > 0 ? "var(--color-bull)" : "var(--color-bear)",
                        }}
                      >
                        {fix2(gm.avgExpectancy)}%
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      <span
                        style={{
                          color:
                            gm.profitFactor > 1.5
                              ? "var(--color-bull)"
                              : gm.profitFactor > 1
                              ? "var(--color-fg)"
                              : "var(--color-bear)",
                        }}
                      >
                        {Number.isFinite(gm.profitFactor) ? fix2(gm.profitFactor) : "∞"}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      <span
                        style={{
                          color: gm.avgForwardReturn > 0 ? "var(--color-bull)" : "var(--color-bear)",
                        }}
                      >
                        {gm.avgForwardReturn >= 0 ? "+" : ""}
                        {fix2(gm.avgForwardReturn)}%
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-right" style={{ color: "var(--color-fg-muted)" }}>
                      {(gm.avgConfidence).toFixed(1)}
                    </td>
                    <td className="px-3 py-1.5 text-right" style={{ color: "var(--color-fg-muted)" }}>
                      {fix2(gm.avgRMultiple)}R
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Ordering breaches */}
        {validation.orderingBreaches.length > 0 && (
          <div
            className="rounded-lg border p-3 text-[11px]"
            style={{
              borderColor: "color-mix(in oklch, var(--color-bear) 30%, transparent)",
              background: "color-mix(in oklch, var(--color-bear) 8%, transparent)",
            }}
          >
            <p className="mb-1 font-semibold" style={{ color: "var(--color-bear)" }}>
              Ordering Breaches — grade system may not be useful
            </p>
            {validation.orderingBreaches.map((breach, i) => (
              <p key={i} className="mt-0.5" style={{ color: "var(--color-fg-muted)" }}>
                • {breach}
              </p>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
