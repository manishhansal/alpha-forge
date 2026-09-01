"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const ALL_REGIMES = [
  "BULL_TRENDING", "BEAR_TRENDING", "RANGE_BOUND", "HIGH_VOLATILITY",
  "LOW_VOLATILITY", "HIGH_LIQUIDITY", "LOW_LIQUIDITY", "EVENT_DRIVEN",
  "EXPIRY_DAY", "NORMAL_DAY",
] as const;

function sharpeColor(sharpe: number | null): string {
  if (sharpe === null) return "var(--color-surface-subtle)";
  if (sharpe > 1.5) return "#15803d";
  if (sharpe > 0.8) return "#22c55e";
  if (sharpe > 0.3) return "#86efac";
  if (sharpe > 0) return "#fef08a";
  if (sharpe > -0.5) return "#fca5a5";
  return "#dc2626";
}

export function RegimeMatrixView() {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Strategy × Regime Matrix</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-separate border-spacing-0.5" aria-label="Regime matrix">
              <thead>
                <tr>
                  <th className="sticky left-0 px-3 py-2 text-left font-medium z-10" style={{ background: "var(--color-surface)", color: "var(--color-fg-muted)" }}>
                    Strategy
                  </th>
                  {ALL_REGIMES.map((r) => (
                    <th key={r} scope="col" className="px-2 py-2 text-center font-medium whitespace-nowrap" style={{ color: "var(--color-fg-muted)" }}>
                      {r.replace(/_/g, " ")}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td colSpan={ALL_REGIMES.length + 1} className="px-4 py-8 text-center" style={{ color: "var(--color-fg-muted)" }}>
                    Regime attribution data will appear here after running the research pipeline.
                    <br />
                    <span className="mt-2 block text-xs">
                      Green = positive Sharpe · Yellow = marginal · Red = negative
                    </span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-4 text-xs" style={{ color: "var(--color-fg-muted)" }}>
            <span>Colour key:</span>
            {[
              { label: "> 1.5", color: "#15803d" },
              { label: "0.8–1.5", color: "#22c55e" },
              { label: "0.3–0.8", color: "#86efac" },
              { label: "0–0.3", color: "#fef08a" },
              { label: "< 0", color: "#fca5a5" },
            ].map((k) => (
              <span key={k.label} className="flex items-center gap-1">
                <span className="inline-block h-3 w-3 rounded" style={{ background: k.color }} />
                {k.label}
              </span>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
