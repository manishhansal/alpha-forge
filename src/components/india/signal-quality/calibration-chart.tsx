"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ConfidenceCalibration, WinProbabilityCalibration } from "@/lib/signal-quality/types";

const ASSESSMENT_COLORS: Record<string, string> = {
  WELL_CALIBRATED: "var(--color-bull)",
  ACCEPTABLE: "var(--color-info)",
  POORLY_CALIBRATED: "var(--color-warning)",
  SEVERELY_DISTORTED: "var(--color-bear)",
  INSUFFICIENT_DATA: "var(--color-fg-subtle)",
};

/**
 * Renders a reliability diagram (predicted vs actual win rate) as a
 * lightweight SVG bar chart — no external chart library dependency.
 *
 * The diagonal represents perfect calibration. Bars above diagonal = under-
 * confident; bars below = over-confident.
 */
export function ConfidenceCalibrationChart({
  calibration,
}: {
  calibration: ConfidenceCalibration;
}) {
  const withData = calibration.buckets.filter((b) => b.signalCount > 0);
  const assessmentColor = ASSESSMENT_COLORS[calibration.overallAssessment] ?? "var(--color-fg-muted)";

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between">
          <div>
            <CardTitle className="text-sm font-semibold tracking-tight">
              Confidence Calibration
              {calibration.strategyId !== "ALL" && ` — ${calibration.strategyId}`}
            </CardTitle>
            <p className="mt-0.5 text-[11px]" style={{ color: "var(--color-fg-subtle)" }}>
              Predicted confidence bucket vs realised win rate
            </p>
          </div>
          <div className="text-right">
            <p className="text-[10px] uppercase tracking-wider" style={{ color: "var(--color-fg-subtle)" }}>
              ECE
            </p>
            <p className="text-base font-bold" style={{ color: assessmentColor }}>
              {calibration.ece.toFixed(3)}
            </p>
            <p className="text-[10px]" style={{ color: assessmentColor }}>
              {calibration.overallAssessment.replace(/_/g, " ")}
            </p>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {withData.length === 0 ? (
          <p className="py-4 text-center text-[12px]" style={{ color: "var(--color-fg-subtle)" }}>
            No confidence metadata in evaluation window.
          </p>
        ) : (
          <div className="space-y-3">
            {/* Reliability diagram */}
            <div
              className="relative h-[160px] w-full rounded-lg border p-2"
              style={{
                borderColor: "var(--color-border)",
                background: "var(--color-surface)",
              }}
            >
              {/* Perfect calibration diagonal */}
              <svg
                className="pointer-events-none absolute inset-2"
                style={{ opacity: 0.3 }}
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
              >
                <line
                  x1="0"
                  y1="100"
                  x2="100"
                  y2="0"
                  stroke="var(--color-fg-muted)"
                  strokeWidth="1"
                  strokeDasharray="4 3"
                />
              </svg>

              {/* Bars */}
              <div className="absolute inset-2 flex items-end gap-0.5">
                {withData.map((b) => {
                  const predicted = b.predictedWinRate;
                  const actual = b.actualWinRate;
                  const heightPct = Math.round(actual * 100);
                  const isOver = actual > predicted + 0.05;
                  const isUnder = actual < predicted - 0.05;
                  const barColor = isOver
                    ? "var(--color-bull)"
                    : isUnder
                    ? "var(--color-bear)"
                    : "var(--color-info)";

                  return (
                    <div
                      key={b.label}
                      className="group relative flex flex-1 flex-col items-center justify-end"
                      style={{ height: "100%" }}
                    >
                      <div
                        className="w-full rounded-t transition-opacity group-hover:opacity-80"
                        style={{
                          height: `${heightPct}%`,
                          background: barColor,
                          opacity: 0.7,
                        }}
                      />
                      {/* Tooltip */}
                      <div
                        className="pointer-events-none absolute bottom-full mb-1 hidden min-w-[100px] rounded border p-1.5 text-[10px] group-hover:block"
                        style={{
                          background: "var(--color-bg-elevated)",
                          borderColor: "var(--color-border-strong)",
                          zIndex: 10,
                        }}
                      >
                        <p className="font-semibold" style={{ color: "var(--color-fg)" }}>
                          {b.label}
                        </p>
                        <p style={{ color: "var(--color-fg-muted)" }}>n = {b.signalCount}</p>
                        <p style={{ color: "var(--color-info)" }}>
                          Predicted: {(predicted * 100).toFixed(0)}%
                        </p>
                        <p style={{ color: barColor }}>
                          Actual: {(actual * 100).toFixed(1)}%
                        </p>
                        <p style={{ color: "var(--color-fg-subtle)" }}>
                          Error: ±{(b.calibrationError * 100).toFixed(1)}%
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* X-axis labels */}
            <div className="flex gap-0.5">
              {withData.map((b) => (
                <div key={b.label} className="flex-1 text-center">
                  <p className="text-[9px]" style={{ color: "var(--color-fg-subtle)" }}>
                    {b.label}
                  </p>
                  <p className="text-[9px] font-medium" style={{ color: "var(--color-fg-muted)" }}>
                    n={b.signalCount}
                  </p>
                </div>
              ))}
            </div>

            {/* Brier score */}
            <div
              className="flex items-center justify-between rounded-lg border px-3 py-2"
              style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
            >
              <div>
                <p className="text-[10px] uppercase tracking-wider" style={{ color: "var(--color-fg-subtle)" }}>
                  Brier Score
                </p>
                <p className="text-sm font-bold" style={{ color: "var(--color-fg)" }}>
                  {calibration.brierScore.toFixed(4)}
                </p>
              </div>
              <div className="text-right">
                <p className="text-[10px] uppercase tracking-wider" style={{ color: "var(--color-fg-subtle)" }}>
                  Max Cal. Error
                </p>
                <p
                  className="text-sm font-bold"
                  style={{
                    color: calibration.mce > 0.15 ? "var(--color-bear)" : "var(--color-fg)",
                  }}
                >
                  {(calibration.mce * 100).toFixed(1)}%
                </p>
              </div>
              <div className="text-right">
                <p className="text-[10px] uppercase tracking-wider" style={{ color: "var(--color-fg-subtle)" }}>
                  Assessment
                </p>
                <p className="text-sm font-bold" style={{ color: assessmentColor }}>
                  {calibration.overallAssessment.replace(/_/g, " ")}
                </p>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** Win probability calibration grid */
export function WinProbabilityCalibrationCard({
  calibration,
}: {
  calibration: WinProbabilityCalibration;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold tracking-tight">
          Win Probability Calibration — {calibration.strategyId}
        </CardTitle>
        <p className="text-[11px]" style={{ color: "var(--color-fg-subtle)" }}>
          Predicted P(win) bucket vs realised win rate
        </p>
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        <table className="w-full text-[11px]">
          <thead>
            <tr
              className="border-b text-[10px] uppercase tracking-widest"
              style={{ borderColor: "var(--color-border)", color: "var(--color-fg-subtle)" }}
            >
              <th className="px-4 py-2 text-left">Bucket</th>
              <th className="px-4 py-2 text-right">n</th>
              <th className="px-4 py-2 text-right">Predicted</th>
              <th className="px-4 py-2 text-right">Realised</th>
              <th className="px-4 py-2 text-right">Error</th>
              <th className="px-4 py-2 text-left">Verdict</th>
            </tr>
          </thead>
          <tbody>
            {calibration.buckets.map((b) => (
              <tr
                key={b.label}
                className="border-b"
                style={{ borderColor: "var(--color-border)" }}
              >
                <td
                  className="px-4 py-1.5 font-mono"
                  style={{ color: "var(--color-fg)" }}
                >
                  {b.label}
                </td>
                <td className="px-4 py-1.5 text-right" style={{ color: "var(--color-fg-muted)" }}>
                  {b.sampleSize}
                </td>
                <td className="px-4 py-1.5 text-right" style={{ color: "var(--color-info)" }}>
                  {(b.predictedProbability * 100).toFixed(0)}%
                </td>
                <td
                  className="px-4 py-1.5 text-right font-semibold"
                  style={{
                    color:
                      b.realizedProbability > b.predictedProbability
                        ? "var(--color-bull)"
                        : "var(--color-bear)",
                  }}
                >
                  {b.sampleSize > 0 ? `${(b.realizedProbability * 100).toFixed(1)}%` : "—"}
                </td>
                <td
                  className="px-4 py-1.5 text-right"
                  style={{
                    color:
                      b.calibrationError > 0.1
                        ? "var(--color-bear)"
                        : "var(--color-fg-muted)",
                  }}
                >
                  {b.sampleSize > 0 ? `±${(b.calibrationError * 100).toFixed(1)}%` : "—"}
                </td>
                <td className="px-4 py-1.5">
                  <span
                    className="text-[10px]"
                    style={{
                      color:
                        b.verdict === "WELL_CALIBRATED"
                          ? "var(--color-bull)"
                          : b.verdict === "INSUFFICIENT_SAMPLE"
                          ? "var(--color-fg-subtle)"
                          : "var(--color-bear)",
                    }}
                  >
                    {b.verdict.replace(/_/g, " ")}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex items-center justify-between border-t px-4 py-2 text-[11px]" style={{ borderColor: "var(--color-border)" }}>
          <span style={{ color: "var(--color-fg-subtle)" }}>Brier Score:</span>
          <span className="font-mono" style={{ color: "var(--color-fg)" }}>
            {calibration.brierScore.toFixed(4)}
          </span>
          <span style={{ color: "var(--color-fg-subtle)" }}>ECE:</span>
          <span
            className="font-mono"
            style={{ color: calibration.ece > 0.1 ? "var(--color-bear)" : "var(--color-fg)" }}
          >
            {calibration.ece.toFixed(4)}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
