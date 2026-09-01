"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ResearchExperiment } from "@/lib/research/types";

const STATUS_COLORS: Record<string, string> = {
  RUNNING: "#3b82f6",
  COMPLETED: "#22c55e",
  FAILED: "#ef4444",
  INCONCLUSIVE: "#f59e0b",
  PROMOTED: "#a78bfa",
  DEMOTED: "#f97316",
};

export function ExperimentHistoryView({ experiments }: { experiments: ResearchExperiment[] }) {
  if (experiments.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-sm" style={{ color: "var(--color-fg-muted)" }}>
          No experiments recorded yet. Create experiments via POST /api/research/experiments.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Experiment History ({experiments.length})</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm" aria-label="Experiment history">
            <thead>
              <tr style={{ borderBottom: "1px solid var(--color-border)" }}>
                {["Experiment ID", "Strategy", "Version", "Dataset", "Method", "Status", "Timestamp"].map((col) => (
                  <th key={col} scope="col" className="px-4 py-3 text-left text-xs font-medium" style={{ color: "var(--color-fg-muted)" }}>
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {experiments.map((exp) => (
                <tr key={exp.experimentId} style={{ borderBottom: "1px solid var(--color-border)" }}>
                  <td className="px-4 py-2.5 font-mono text-xs" style={{ color: "var(--color-fg-muted)" }}>
                    {exp.experimentId.slice(0, 24)}…
                  </td>
                  <td className="px-4 py-2.5 font-medium text-xs" style={{ color: "var(--color-fg)" }}>
                    {exp.strategyId}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs" style={{ color: "var(--color-fg-muted)" }}>
                    {exp.strategyVersion}
                  </td>
                  <td className="px-4 py-2.5 text-xs font-mono" style={{ color: "var(--color-fg-muted)" }}>
                    {exp.datasetVersion.slice(0, 20)}
                  </td>
                  <td className="px-4 py-2.5 text-xs" style={{ color: "var(--color-fg-muted)" }}>
                    {exp.validationMethod}
                  </td>
                  <td className="px-4 py-2.5">
                    <span
                      className="rounded px-2 py-0.5 text-xs font-medium"
                      style={{ color: STATUS_COLORS[exp.resultStatus] ?? "#6b7280", background: `${STATUS_COLORS[exp.resultStatus] ?? "#6b7280"}18` }}
                    >
                      {exp.resultStatus}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs" style={{ color: "var(--color-fg-muted)" }}>
                    {new Date(exp.timestamp).toLocaleDateString("en-IN")}
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
