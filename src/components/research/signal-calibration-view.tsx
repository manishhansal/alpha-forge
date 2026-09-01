"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function SignalCalibrationView() {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Signal Calibration — Reliability Diagram</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm mb-4" style={{ color: "var(--color-fg-muted)" }}>
            Each point on the calibration curve represents a bin of predicted probabilities.
            A perfectly calibrated model lies on the diagonal.
          </p>
          <div className="text-center py-12" style={{ color: "var(--color-fg-muted)", border: "2px dashed var(--color-border)", borderRadius: "8px" }}>
            <p className="text-sm font-medium">Calibration curve placeholder</p>
            <p className="mt-2 text-xs">Requires signal outcome data from live/paper trading</p>
          </div>
          <div className="mt-4 grid grid-cols-3 gap-3 text-center text-xs">
            <div className="rounded p-2" style={{ background: "var(--color-surface-subtle)" }}>
              <p className="font-medium" style={{ color: "var(--color-fg)" }}>Brier Score</p>
              <p className="mt-1 font-mono text-lg" style={{ color: "var(--color-fg-muted)" }}>—</p>
              <p style={{ color: "var(--color-fg-muted)" }}>lower is better (0 = perfect)</p>
            </div>
            <div className="rounded p-2" style={{ background: "var(--color-surface-subtle)" }}>
              <p className="font-medium" style={{ color: "var(--color-fg)" }}>ECE</p>
              <p className="mt-1 font-mono text-lg" style={{ color: "var(--color-fg-muted)" }}>—</p>
              <p style={{ color: "var(--color-fg-muted)" }}>Expected Calibration Error (&lt;0.05 = good)</p>
            </div>
            <div className="rounded p-2" style={{ background: "var(--color-surface-subtle)" }}>
              <p className="font-medium" style={{ color: "var(--color-fg)" }}>Well Calibrated</p>
              <p className="mt-1 font-mono text-lg" style={{ color: "var(--color-fg-muted)" }}>—</p>
              <p style={{ color: "var(--color-fg-muted)" }}>ECE &lt; 0.05</p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
