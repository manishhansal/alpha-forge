"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { VerdictBadge } from "./verdict-badge";
import type { StrategyLeaderboardEntry } from "@/lib/signal-quality/types";

function pct(n: number) {
  return `${(n * 100).toFixed(1)}%`;
}
function fix2(n: number) {
  return Number.isFinite(n) ? n.toFixed(2) : "—";
}

const SIG_COLORS: Record<string, string> = {
  STATISTICALLY_MEANINGFUL: "var(--color-bull)",
  MARGINAL: "var(--color-warning)",
  INSUFFICIENT_EVIDENCE: "var(--color-bear)",
};

export function StrategyLeaderboard({ entries }: { entries: StrategyLeaderboardEntry[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-semibold tracking-tight">
          Strategy Leaderboard
        </CardTitle>
        <p className="text-[12px]" style={{ color: "var(--color-fg-subtle)" }}>
          Ranked by Signal Quality Score (0–100). Sample size confidence shown per strategy.
          Do not rank a strategy with 3 trades above one with 300.
        </p>
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        <table className="w-full text-[12px]">
          <thead>
            <tr
              className="border-b text-[10px] uppercase tracking-widest"
              style={{ borderColor: "var(--color-border)", color: "var(--color-fg-subtle)" }}
            >
              <th className="px-4 py-2 text-left">Strategy</th>
              <th className="px-4 py-2 text-right">Score</th>
              <th className="px-4 py-2 text-right">Precision</th>
              <th className="px-4 py-2 text-right">Recall</th>
              <th className="px-4 py-2 text-right">F1</th>
              <th className="px-4 py-2 text-right">Profit Factor</th>
              <th className="px-4 py-2 text-right">Expectancy</th>
              <th className="px-4 py-2 text-right">MFE%</th>
              <th className="px-4 py-2 text-right">MAE%</th>
              <th className="px-4 py-2 text-right">Paper P&L</th>
              <th className="px-4 py-2 text-right">n</th>
              <th className="px-4 py-2 text-left">Sample</th>
              <th className="px-4 py-2 text-left">Verdict</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e, i) => (
              <tr
                key={e.strategyId}
                className="border-b transition-colors hover:bg-[var(--color-surface-hover)]"
                style={{ borderColor: "var(--color-border)" }}
              >
                <td className="px-4 py-2">
                  <div className="flex items-center gap-2">
                    <span
                      className="h-5 w-5 rounded text-center text-[10px] font-bold leading-5"
                      style={{
                        background: "var(--color-surface)",
                        color: i === 0 ? "var(--color-brand)" : "var(--color-fg-muted)",
                      }}
                    >
                      {i + 1}
                    </span>
                    <div>
                      <p className="font-medium" style={{ color: "var(--color-fg)" }}>
                        {e.label}
                      </p>
                      <p style={{ color: "var(--color-fg-subtle)" }}>{e.strategyId}</p>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-2 text-right">
                  <span
                    className="font-bold"
                    style={{
                      color:
                        e.signalQualityScore >= 75
                          ? "var(--color-bull)"
                          : e.signalQualityScore >= 50
                          ? "var(--color-warning)"
                          : "var(--color-bear)",
                    }}
                  >
                    {e.signalQualityScore}
                  </span>
                </td>
                <td className="px-4 py-2 text-right">
                  <span
                    style={{
                      color:
                        e.precision > 0.55
                          ? "var(--color-bull)"
                          : e.precision > 0.45
                          ? "var(--color-warning)"
                          : "var(--color-bear)",
                    }}
                  >
                    {pct(e.precision)}
                  </span>
                </td>
                <td className="px-4 py-2 text-right" style={{ color: "var(--color-fg-muted)" }}>
                  {pct(e.recall)}
                </td>
                <td className="px-4 py-2 text-right" style={{ color: "var(--color-fg-muted)" }}>
                  {fix2(e.f1)}
                </td>
                <td className="px-4 py-2 text-right">
                  <span
                    style={{
                      color:
                        e.profitFactor > 1.5
                          ? "var(--color-bull)"
                          : e.profitFactor > 1
                          ? "var(--color-fg)"
                          : "var(--color-bear)",
                    }}
                  >
                    {Number.isFinite(e.profitFactor) ? fix2(e.profitFactor) : "∞"}
                  </span>
                </td>
                <td className="px-4 py-2 text-right">
                  <span
                    style={{
                      color: e.expectancy > 0 ? "var(--color-bull)" : "var(--color-bear)",
                    }}
                  >
                    {fix2(e.expectancy)}%
                  </span>
                </td>
                <td className="px-4 py-2 text-right" style={{ color: "var(--color-bull)" }}>
                  {fix2(e.avgMfePct)}%
                </td>
                <td className="px-4 py-2 text-right" style={{ color: "var(--color-bear)" }}>
                  {fix2(e.avgMaePct)}%
                </td>
                <td className="px-4 py-2 text-right">
                  <span
                    style={{
                      color: e.paperPnlPct > 0 ? "var(--color-bull)" : "var(--color-bear)",
                    }}
                  >
                    {e.paperPnlPct >= 0 ? "+" : ""}
                    {fix2(e.paperPnlPct)}%
                  </span>
                </td>
                <td
                  className="px-4 py-2 text-right font-mono"
                  style={{ color: "var(--color-fg-muted)" }}
                >
                  {e.sampleSize}
                </td>
                <td className="px-4 py-2">
                  <span
                    className="text-[10px]"
                    style={{ color: SIG_COLORS[e.sampleConfidence] ?? "var(--color-fg-muted)" }}
                  >
                    {e.sampleConfidence.replace(/_/g, " ")}
                  </span>
                </td>
                <td className="px-4 py-2">
                  <VerdictBadge verdict={e.verdict} />
                </td>
              </tr>
            ))}
            {entries.length === 0 && (
              <tr>
                <td
                  colSpan={13}
                  className="px-4 py-8 text-center text-[12px]"
                  style={{ color: "var(--color-fg-subtle)" }}
                >
                  No resolved trades in the evaluation window yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
