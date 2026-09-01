"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { CostRobustness } from "@/lib/signal-quality/types";

function fix2(n: number) {
  return Number.isFinite(n) ? n.toFixed(2) : "—";
}

function pct(n: number) {
  return Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : "—";
}

const SCENARIO_LABELS: Record<string, string> = {
  BASE:  "Base Cost (5 bps)",
  "1_5X": "1.5× Cost (7.5 bps)",
  "2X":   "2× Cost (10 bps)",
  "3X":   "3× Cost (15 bps)",
};

export function CostRobustnessCard({ robustness }: { robustness: CostRobustness }) {
  const verdictVariant =
    robustness.verdict === "COST_ROBUST"
      ? "bull"
      : robustness.verdict === "COST_SENSITIVE"
      ? "warning"
      : "bear";

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-semibold tracking-tight">
            Cost Robustness — {robustness.strategyId}
          </CardTitle>
          <Badge variant={verdictVariant}>{robustness.verdict.replace(/_/g, " ")}</Badge>
        </div>
        <p className="mt-0.5 text-[11px]" style={{ color: "var(--color-fg-subtle)" }}>
          Base cost: 5 bps round-trip (NSE F&O: STT + brokerage + exchange). Does edge survive cost stress?
        </p>
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        <table className="w-full text-[11px]">
          <thead>
            <tr
              className="border-b text-[10px] uppercase tracking-widest"
              style={{ borderColor: "var(--color-border)", color: "var(--color-fg-subtle)" }}
            >
              <th className="px-4 py-2 text-left">Cost Scenario</th>
              <th className="px-4 py-2 text-right">Cost (bps)</th>
              <th className="px-4 py-2 text-right">Precision</th>
              <th className="px-4 py-2 text-right">Expectancy</th>
              <th className="px-4 py-2 text-right">Net P&L%</th>
              <th className="px-4 py-2 text-right">Profit Factor</th>
            </tr>
          </thead>
          <tbody>
            {robustness.rows.map((row, i) => {
              const isBase = i === 0;
              const basePrec = robustness.rows[0].precision;
              const precDelta = row.precision - basePrec;
              return (
                <tr
                  key={row.scenario}
                  className="border-b"
                  style={{
                    borderColor: "var(--color-border)",
                    background: isBase ? "var(--color-surface)" : undefined,
                  }}
                >
                  <td className="px-4 py-1.5" style={{ color: "var(--color-fg)" }}>
                    {isBase && (
                      <span
                        className="mr-1.5 rounded px-1 py-0.5 text-[9px] font-medium"
                        style={{
                          background: "color-mix(in oklch, var(--color-info) 15%, transparent)",
                          color: "var(--color-info)",
                        }}
                      >
                        BASE
                      </span>
                    )}
                    {SCENARIO_LABELS[row.scenario] ?? row.scenario}
                  </td>
                  <td className="px-4 py-1.5 text-right font-mono" style={{ color: "var(--color-fg-muted)" }}>
                    {row.costBps}
                  </td>
                  <td className="px-4 py-1.5 text-right">
                    <span
                      style={{
                        color:
                          row.precision > 0.55
                            ? "var(--color-bull)"
                            : row.precision > 0.45
                            ? "var(--color-warning)"
                            : "var(--color-bear)",
                      }}
                    >
                      {pct(row.precision)}
                    </span>
                    {!isBase && (
                      <span
                        className="ml-1 text-[10px]"
                        style={{ color: precDelta < 0 ? "var(--color-bear)" : "var(--color-bull)" }}
                      >
                        ({precDelta >= 0 ? "+" : ""}{(precDelta * 100).toFixed(1)}%)
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-1.5 text-right">
                    <span
                      style={{
                        color: row.expectancy > 0 ? "var(--color-bull)" : "var(--color-bear)",
                      }}
                    >
                      {fix2(row.expectancy)}%
                    </span>
                  </td>
                  <td className="px-4 py-1.5 text-right">
                    <span
                      style={{
                        color: row.netPnlPct > 0 ? "var(--color-bull)" : "var(--color-bear)",
                      }}
                    >
                      {row.netPnlPct >= 0 ? "+" : ""}
                      {fix2(row.netPnlPct)}%
                    </span>
                  </td>
                  <td className="px-4 py-1.5 text-right">
                    <span
                      style={{
                        color:
                          row.profitFactor > 1.5
                            ? "var(--color-bull)"
                            : row.profitFactor > 1
                            ? "var(--color-fg)"
                            : "var(--color-bear)",
                      }}
                    >
                      {Number.isFinite(row.profitFactor) ? fix2(row.profitFactor) : "∞"}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
