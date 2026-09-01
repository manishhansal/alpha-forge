"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { TimeOfDayBucket } from "@/lib/signal-quality/types";

const REC_COLORS: Record<TimeOfDayBucket["recommendation"], string> = {
  TRADE:   "color-mix(in oklch, var(--color-bull) 25%, transparent)",
  CAUTION: "color-mix(in oklch, var(--color-warning) 20%, transparent)",
  AVOID:   "color-mix(in oklch, var(--color-bear) 20%, transparent)",
};

const REC_TEXT: Record<TimeOfDayBucket["recommendation"], string> = {
  TRADE:   "var(--color-bull)",
  CAUTION: "var(--color-warning)",
  AVOID:   "var(--color-bear)",
};

export function TimeOfDayHeatmap({ buckets }: { buckets: TimeOfDayBucket[] }) {
  const maxSignals = Math.max(...buckets.map((b) => b.signalCount), 1);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold tracking-tight">
          Time-of-Day Signal Quality
        </CardTitle>
        <p className="text-[11px]" style={{ color: "var(--color-fg-subtle)" }}>
          NSE market hours (IST). Bar height = signal count. Colour = TRADE / CAUTION / AVOID.
        </p>
      </CardHeader>
      <CardContent>
        {/* Bar chart */}
        <div className="flex h-[100px] items-end gap-1">
          {buckets.map((b) => {
            const heightPct = Math.max(4, Math.round((b.signalCount / maxSignals) * 100));
            return (
              <div
                key={b.label}
                className="group relative flex flex-1 flex-col items-center justify-end"
              >
                <div
                  className="w-full rounded-t transition-opacity group-hover:opacity-80"
                  style={{
                    height: `${heightPct}%`,
                    background: b.signalCount > 0 ? REC_COLORS[b.recommendation] : "var(--color-surface)",
                    border: `1px solid color-mix(in oklch, var(--color-border-strong) 50%, transparent)`,
                  }}
                />
                {/* Hover tooltip */}
                <div
                  className="pointer-events-none absolute bottom-full mb-1 hidden min-w-[140px] rounded border p-2 text-[10px] group-hover:block"
                  style={{
                    background: "var(--color-bg-elevated)",
                    borderColor: "var(--color-border-strong)",
                    zIndex: 20,
                    left: "50%",
                    transform: "translateX(-50%)",
                  }}
                >
                  <p className="font-semibold" style={{ color: "var(--color-fg)" }}>
                    {b.label}
                  </p>
                  <p style={{ color: "var(--color-fg-muted)" }}>Signals: {b.signalCount}</p>
                  <p style={{ color: "var(--color-fg-muted)" }}>
                    Precision: {b.signalCount > 0 ? `${(b.precision * 100).toFixed(1)}%` : "—"}
                  </p>
                  <p style={{ color: "var(--color-fg-muted)" }}>
                    Avg Return: {b.signalCount > 0 ? `${b.avgReturn.toFixed(2)}%` : "—"}
                  </p>
                  <p style={{ color: "var(--color-fg-muted)" }}>
                    False Signal: {b.signalCount > 0 ? `${(b.falseSignalRate * 100).toFixed(1)}%` : "—"}
                  </p>
                  <p
                    className="mt-0.5 font-semibold"
                    style={{ color: REC_TEXT[b.recommendation] }}
                  >
                    {b.recommendation}
                  </p>
                </div>
              </div>
            );
          })}
        </div>

        {/* X-axis labels */}
        <div className="mt-1 flex gap-1">
          {buckets.map((b) => (
            <div key={b.label} className="flex-1 text-center">
              <p className="text-[9px]" style={{ color: "var(--color-fg-subtle)" }}>
                {b.label.split("–")[0]}
              </p>
            </div>
          ))}
        </div>

        {/* Summary table */}
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr
                className="border-b text-[10px] uppercase tracking-widest"
                style={{ borderColor: "var(--color-border)", color: "var(--color-fg-subtle)" }}
              >
                <th className="px-2 py-1 text-left">Slot (IST)</th>
                <th className="px-2 py-1 text-right">Signals</th>
                <th className="px-2 py-1 text-right">Precision</th>
                <th className="px-2 py-1 text-right">Avg Return</th>
                <th className="px-2 py-1 text-right">False Rate</th>
                <th className="px-2 py-1 text-left">Exec Quality</th>
                <th className="px-2 py-1 text-left">Recommendation</th>
              </tr>
            </thead>
            <tbody>
              {buckets.map((b) => (
                <tr
                  key={b.label}
                  className="border-b"
                  style={{ borderColor: "var(--color-border)" }}
                >
                  <td className="px-2 py-1 font-mono" style={{ color: "var(--color-fg)" }}>
                    {b.label}
                  </td>
                  <td className="px-2 py-1 text-right" style={{ color: "var(--color-fg-muted)" }}>
                    {b.signalCount}
                  </td>
                  <td className="px-2 py-1 text-right">
                    <span
                      style={{
                        color:
                          b.signalCount === 0
                            ? "var(--color-fg-subtle)"
                            : b.precision > 0.55
                            ? "var(--color-bull)"
                            : b.precision > 0.45
                            ? "var(--color-warning)"
                            : "var(--color-bear)",
                      }}
                    >
                      {b.signalCount > 0 ? `${(b.precision * 100).toFixed(1)}%` : "—"}
                    </span>
                  </td>
                  <td className="px-2 py-1 text-right">
                    <span
                      style={{
                        color:
                          b.signalCount === 0
                            ? "var(--color-fg-subtle)"
                            : b.avgReturn > 0
                            ? "var(--color-bull)"
                            : "var(--color-bear)",
                      }}
                    >
                      {b.signalCount > 0
                        ? `${b.avgReturn >= 0 ? "+" : ""}${b.avgReturn.toFixed(2)}%`
                        : "—"}
                    </span>
                  </td>
                  <td
                    className="px-2 py-1 text-right"
                    style={{
                      color:
                        b.falseSignalRate > 0.6 ? "var(--color-bear)" : "var(--color-fg-muted)",
                    }}
                  >
                    {b.signalCount > 0 ? `${(b.falseSignalRate * 100).toFixed(1)}%` : "—"}
                  </td>
                  <td className="px-2 py-1">
                    <span
                      style={{
                        color:
                          b.executionQuality === "EXCELLENT"
                            ? "var(--color-bull)"
                            : b.executionQuality === "GOOD"
                            ? "var(--color-info)"
                            : b.executionQuality === "DEGRADED"
                            ? "var(--color-warning)"
                            : "var(--color-bear)",
                      }}
                    >
                      {b.executionQuality}
                    </span>
                  </td>
                  <td className="px-2 py-1">
                    <span
                      className="font-semibold"
                      style={{ color: REC_TEXT[b.recommendation] }}
                    >
                      {b.recommendation}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
