"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { InstrumentQualityRow } from "@/lib/signal-quality/types";

function fix2(n: number) {
  return Number.isFinite(n) ? n.toFixed(2) : "—";
}

function pct(n: number) {
  return Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : "—";
}

export function InstrumentHeatmap({ rows }: { rows: InstrumentQualityRow[] }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold tracking-tight">
          Instrument Quality Heatmap
        </CardTitle>
        <p className="text-[11px]" style={{ color: "var(--color-fg-subtle)" }}>
          Signal precision, expectancy, and cost impact per instrument.
          PREFERRED = high precision + positive expectancy; AVOID = poor precision or negative expectancy.
        </p>
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        <table className="w-full text-[11px]">
          <thead>
            <tr
              className="border-b text-[10px] uppercase tracking-widest"
              style={{ borderColor: "var(--color-border)", color: "var(--color-fg-subtle)" }}
            >
              <th className="px-4 py-2 text-left">Instrument</th>
              <th className="px-4 py-2 text-right">Signals</th>
              <th className="px-4 py-2 text-right">Precision</th>
              <th className="px-4 py-2 text-right">Expectancy</th>
              <th className="px-4 py-2 text-right">Cost (bps)</th>
              <th className="px-4 py-2 text-right">Slippage</th>
              <th className="px-4 py-2 text-left">Verdict</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.instrument}
                className="border-b transition-colors hover:bg-[var(--color-surface-hover)]"
                style={{ borderColor: "var(--color-border)" }}
              >
                <td className="px-4 py-1.5 font-medium" style={{ color: "var(--color-fg)" }}>
                  {row.instrument}
                </td>
                <td className="px-4 py-1.5 text-right font-mono" style={{ color: "var(--color-fg-muted)" }}>
                  {row.signalCount}
                </td>
                <td className="px-4 py-1.5 text-right">
                  <span
                    style={{
                      color:
                        row.precision > 0.6
                          ? "var(--color-bull)"
                          : row.precision > 0.45
                          ? "var(--color-warning)"
                          : "var(--color-bear)",
                    }}
                  >
                    {pct(row.precision)}
                  </span>
                </td>
                <td className="px-4 py-1.5 text-right">
                  <span
                    style={{
                      color: row.expectancy > 0 ? "var(--color-bull)" : "var(--color-bear)",
                    }}
                  >
                    {row.expectancy >= 0 ? "+" : ""}
                    {fix2(row.expectancy)}%
                  </span>
                </td>
                <td className="px-4 py-1.5 text-right font-mono" style={{ color: "var(--color-fg-muted)" }}>
                  {row.costImpactBps}
                </td>
                <td className="px-4 py-1.5 text-right">
                  <span
                    style={{
                      color:
                        row.slippageSensitivity === "HIGH"
                          ? "var(--color-bear)"
                          : row.slippageSensitivity === "MEDIUM"
                          ? "var(--color-warning)"
                          : "var(--color-bull)",
                    }}
                  >
                    {row.slippageSensitivity}
                  </span>
                </td>
                <td className="px-4 py-1.5">
                  <span
                    className="rounded-full px-2 py-0.5 text-[10px] font-medium"
                    style={{
                      background:
                        row.verdict === "PREFERRED"
                          ? "color-mix(in oklch, var(--color-bull) 15%, transparent)"
                          : row.verdict === "AVOID"
                          ? "color-mix(in oklch, var(--color-bear) 15%, transparent)"
                          : "color-mix(in oklch, var(--color-neutral) 10%, transparent)",
                      color:
                        row.verdict === "PREFERRED"
                          ? "var(--color-bull)"
                          : row.verdict === "AVOID"
                          ? "var(--color-bear)"
                          : "var(--color-fg-muted)",
                    }}
                  >
                    {row.verdict}
                  </span>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td
                  colSpan={7}
                  className="px-4 py-8 text-center text-[12px]"
                  style={{ color: "var(--color-fg-subtle)" }}
                >
                  No instrument data yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
