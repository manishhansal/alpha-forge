"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { RegimeQuality, MarketRegime } from "@/lib/signal-quality/types";

const REGIME_LABELS: Record<MarketRegime, string> = {
  BULL_TRENDING:  "Bull Trend",
  BEAR_TRENDING:  "Bear Trend",
  RANGE_BOUND:    "Range Bound",
  HIGH_VOLATILITY:"High Vol",
  LOW_VOLATILITY: "Low Vol",
  EXPIRY_DAY:     "Expiry Day",
  NORMAL_DAY:     "Normal Day",
};

function cellColor(precision: number, signalCount: number): string {
  if (signalCount < 3) return "var(--color-surface)";
  if (precision > 0.65) return "color-mix(in oklch, var(--color-bull) 30%, transparent)";
  if (precision > 0.55) return "color-mix(in oklch, var(--color-bull) 15%, transparent)";
  if (precision > 0.45) return "color-mix(in oklch, var(--color-neutral) 15%, transparent)";
  if (precision > 0.35) return "color-mix(in oklch, var(--color-bear) 15%, transparent)";
  return "color-mix(in oklch, var(--color-bear) 30%, transparent)";
}

function textColor(precision: number, signalCount: number): string {
  if (signalCount < 3) return "var(--color-fg-subtle)";
  if (precision > 0.55) return "var(--color-bull)";
  if (precision > 0.45) return "var(--color-fg)";
  return "var(--color-bear)";
}

const ALL_REGIMES: MarketRegime[] = [
  "BULL_TRENDING", "BEAR_TRENDING", "RANGE_BOUND",
  "HIGH_VOLATILITY", "LOW_VOLATILITY", "EXPIRY_DAY", "NORMAL_DAY",
];

/** Shows a strategy × regime precision heatmap */
export function RegimeHeatmap({ regimeQuality }: { regimeQuality: RegimeQuality[] }) {
  // Only show strategies that have at least some data
  const strategies = regimeQuality.filter((rq) =>
    rq.cells.some((c) => c.signalCount > 0),
  );

  if (strategies.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-semibold tracking-tight">
            Regime × Strategy Heatmap
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="py-4 text-center text-[12px]" style={{ color: "var(--color-fg-subtle)" }}>
            No trade data available yet.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold tracking-tight">
          Regime × Strategy Precision Heatmap
        </CardTitle>
        <p className="text-[11px]" style={{ color: "var(--color-fg-subtle)" }}>
          Precision per strategy × market regime. Green = strong, red = weak, grey = insufficient data (n &lt; 3).
        </p>
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        <table className="w-full text-[11px]">
          <thead>
            <tr
              className="border-b text-[10px] uppercase tracking-widest"
              style={{ borderColor: "var(--color-border)", color: "var(--color-fg-subtle)" }}
            >
              <th className="px-3 py-2 text-left">Strategy</th>
              {ALL_REGIMES.map((r) => (
                <th key={r} className="px-2 py-2 text-center">
                  {REGIME_LABELS[r]}
                </th>
              ))}
              <th className="px-3 py-2 text-left">Best Regime</th>
              <th className="px-3 py-2 text-left">Worst Regime</th>
            </tr>
          </thead>
          <tbody>
            {strategies.map((rq) => (
              <tr
                key={rq.strategyId}
                className="border-b"
                style={{ borderColor: "var(--color-border)" }}
              >
                <td className="px-3 py-2 font-medium" style={{ color: "var(--color-fg)" }}>
                  {rq.strategyId}
                </td>
                {ALL_REGIMES.map((regime) => {
                  const cell = rq.cells.find((c) => c.regime === regime);
                  const prec = cell?.precision ?? 0;
                  const n = cell?.signalCount ?? 0;
                  return (
                    <td
                      key={regime}
                      className="px-2 py-2 text-center"
                      style={{
                        background: cellColor(prec, n),
                      }}
                    >
                      <p className="font-semibold" style={{ color: textColor(prec, n) }}>
                        {n > 0 ? `${(prec * 100).toFixed(0)}%` : "—"}
                      </p>
                      <p className="text-[9px]" style={{ color: "var(--color-fg-subtle)" }}>
                        n={n}
                      </p>
                    </td>
                  );
                })}
                <td className="px-3 py-2">
                  {rq.bestRegime ? (
                    <span
                      className="text-[10px] font-medium"
                      style={{ color: "var(--color-bull)" }}
                    >
                      {REGIME_LABELS[rq.bestRegime]}
                    </span>
                  ) : (
                    <span style={{ color: "var(--color-fg-subtle)" }}>—</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  {rq.worstRegime ? (
                    <span
                      className="text-[10px] font-medium"
                      style={{ color: "var(--color-bear)" }}
                    >
                      {REGIME_LABELS[rq.worstRegime]}
                    </span>
                  ) : (
                    <span style={{ color: "var(--color-fg-subtle)" }}>—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
