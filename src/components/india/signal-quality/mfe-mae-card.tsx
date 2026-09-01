"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { MfeMaeSummary } from "@/lib/signal-quality/types";

function fix2(n: number) {
  return Number.isFinite(n) && n !== 0 ? n.toFixed(2) : "—";
}

function pct(n: number) {
  return Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : "—";
}

export function MfeMaeTable({ summaries }: { summaries: MfeMaeSummary[] }) {
  const withData = summaries.filter((s) => s.tradeCount > 0);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold tracking-tight">
          MFE / MAE Analysis
        </CardTitle>
        <p className="text-[11px]" style={{ color: "var(--color-fg-subtle)" }}>
          Maximum Favorable Excursion and Maximum Adverse Excursion per strategy.
          Identifies stops that are too tight or targets that are too conservative.
        </p>
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        <table className="w-full text-[11px]">
          <thead>
            <tr
              className="border-b text-[10px] uppercase tracking-widest"
              style={{ borderColor: "var(--color-border)", color: "var(--color-fg-subtle)" }}
            >
              <th className="px-4 py-2 text-left">Strategy</th>
              <th className="px-4 py-2 text-right">n</th>
              <th className="px-4 py-2 text-right">Avg MFE%</th>
              <th className="px-4 py-2 text-right">Avg MAE%</th>
              <th className="px-4 py-2 text-right">MFE Capture</th>
              <th className="px-4 py-2 text-right">MFE P25–P75</th>
              <th className="px-4 py-2 text-right">MAE P25–P75</th>
              <th className="px-4 py-2 text-right">Stop Too Tight</th>
              <th className="px-4 py-2 text-right">Target Too Conservative</th>
            </tr>
          </thead>
          <tbody>
            {withData.map((s) => (
              <tr
                key={s.strategyId}
                className="border-b transition-colors hover:bg-[var(--color-surface-hover)]"
                style={{ borderColor: "var(--color-border)" }}
              >
                <td className="px-4 py-2 font-medium" style={{ color: "var(--color-fg)" }}>
                  {s.strategyId}
                </td>
                <td className="px-4 py-2 text-right font-mono" style={{ color: "var(--color-fg-muted)" }}>
                  {s.tradeCount}
                </td>
                <td className="px-4 py-2 text-right" style={{ color: "var(--color-bull)" }}>
                  {fix2(s.avgMfePct)}%
                </td>
                <td className="px-4 py-2 text-right" style={{ color: "var(--color-bear)" }}>
                  {fix2(s.avgMaePct)}%
                </td>
                <td className="px-4 py-2 text-right">
                  <span
                    style={{
                      color:
                        s.avgMfeCaptureRatio > 0.7
                          ? "var(--color-bull)"
                          : s.avgMfeCaptureRatio > 0.4
                          ? "var(--color-warning)"
                          : "var(--color-bear)",
                    }}
                  >
                    {pct(s.avgMfeCaptureRatio)}
                  </span>
                </td>
                <td className="px-4 py-2 text-right font-mono" style={{ color: "var(--color-fg-muted)" }}>
                  {fix2(s.mfePctP25)}–{fix2(s.mfePctP75)}%
                </td>
                <td className="px-4 py-2 text-right font-mono" style={{ color: "var(--color-fg-muted)" }}>
                  {fix2(s.maePctP25)}–{fix2(s.maePctP75)}%
                </td>
                <td className="px-4 py-2 text-right">
                  <span
                    style={{
                      color:
                        s.stopTooTightFraction > 0.3
                          ? "var(--color-bear)"
                          : s.stopTooTightFraction > 0.15
                          ? "var(--color-warning)"
                          : "var(--color-bull)",
                    }}
                  >
                    {pct(s.stopTooTightFraction)}
                  </span>
                </td>
                <td className="px-4 py-2 text-right">
                  <span
                    style={{
                      color:
                        s.targetTooConservativeFraction > 0.4
                          ? "var(--color-warning)"
                          : "var(--color-fg-muted)",
                    }}
                  >
                    {pct(s.targetTooConservativeFraction)}
                  </span>
                </td>
              </tr>
            ))}
            {withData.length === 0 && (
              <tr>
                <td
                  colSpan={9}
                  className="px-4 py-8 text-center text-[12px]"
                  style={{ color: "var(--color-fg-subtle)" }}
                >
                  No resolved trades yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
