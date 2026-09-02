"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { PaperSignalFunnel } from "@/lib/signal-quality/types";

const STAGE_LABELS: Record<string, string> = {
  SIGNAL_GENERATED: "Signal Generated",
  RISK_APPROVED:    "Risk Approved",
  PAPER_EXECUTED:   "Paper Executed",
  PROFITABLE_OUTCOME: "Profitable Outcome",
};

function pct(n: number) {
  return `${(n * 100).toFixed(1)}%`;
}

export function PaperSignalFunnelCard({ funnel }: { funnel: PaperSignalFunnel }) {
  const stagesWithData = funnel.stages.filter((s) => s.count > 0);
  const maxCount = Math.max(...funnel.stages.map((s) => s.count), 1);

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between">
          <div>
            <CardTitle className="text-sm font-semibold tracking-tight">
              Paper vs Signal Funnel — {funnel.strategyId}
            </CardTitle>
            <p className="mt-0.5 text-[11px]" style={{ color: "var(--color-fg-subtle)" }}>
              Where is edge lost? From raw signal → risk approval → paper execution → profitable outcome.
            </p>
          </div>
          {funnel.bottleneck !== "NONE" && (
            <span
              className="rounded px-2 py-1 text-[10px] font-medium"
              style={{
                background: "color-mix(in oklch, var(--color-warning) 15%, transparent)",
                color: "var(--color-warning)",
              }}
            >
              Bottleneck: {funnel.bottleneck.replace(/_/g, " ")}
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {funnel.stages.map((stage, i) => {
          const widthPct = Math.round((stage.count / maxCount) * 100);
          const isBottleneck = stage.edgeLost > 0.2;
          return (
            <div key={stage.stage} className="space-y-1">
              <div className="flex items-center justify-between text-[11px]">
                <span style={{ color: "var(--color-fg-muted)" }}>
                  {STAGE_LABELS[stage.stage] ?? stage.stage}
                </span>
                <span className="font-mono" style={{ color: "var(--color-fg)" }}>
                  {stage.count.toLocaleString()}
                  {i > 0 && (
                    <span
                      className="ml-2"
                      style={{
                        color:
                          stage.passRate > 0.8
                            ? "var(--color-bull)"
                            : stage.passRate > 0.5
                            ? "var(--color-warning)"
                            : "var(--color-bear)",
                      }}
                    >
                      ({pct(stage.passRate)} pass)
                    </span>
                  )}
                </span>
              </div>
              <div
                className="relative h-6 rounded"
                style={{ background: "var(--color-surface)" }}
              >
                <div
                  className="h-full rounded transition-all"
                  style={{
                    width: `${widthPct}%`,
                    background: isBottleneck
                      ? "color-mix(in oklch, var(--color-bear) 30%, transparent)"
                      : i === funnel.stages.length - 1
                      ? "color-mix(in oklch, var(--color-bull) 30%, transparent)"
                      : "color-mix(in oklch, var(--color-brand) 20%, transparent)",
                    border: `1px solid ${
                      isBottleneck
                        ? "color-mix(in oklch, var(--color-bear) 50%, transparent)"
                        : "color-mix(in oklch, var(--color-border-strong) 50%, transparent)"
                    }`,
                  }}
                />
              </div>
            </div>
          );
        })}

        <p
          className="mt-2 text-[10px]"
          style={{
            color:
              funnel.bottleneck === "NONE"
                ? "var(--color-bull)"
                : "var(--color-warning)",
          }}
        >
          {funnel.bottleneckDescription}
        </p>
      </CardContent>
    </Card>
  );
}
