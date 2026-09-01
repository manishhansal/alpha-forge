"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "./status-badge";
import type { StrategyMeta, StrategyHypothesis } from "@/lib/research/types";

type EnrichedStrategy = StrategyMeta & { hypothesis: StrategyHypothesis };

const PIPELINE_ORDER = [
  "EXPERIMENTAL",
  "RESEARCH",
  "BACKTEST_VALIDATED",
  "WALK_FORWARD_VALIDATED",
  "SHADOW",
  "PAPER",
  "LIVE_CANDIDATE",
  "MANUAL_APPROVAL",
  "LIVE",
] as const;

function stageIndex(status: string): number {
  return PIPELINE_ORDER.indexOf(status as typeof PIPELINE_ORDER[number]);
}

export function PromotionPipelineView({ strategies }: { strategies: EnrichedStrategy[] }) {
  // Sort by pipeline stage descending (most advanced first)
  const sorted = [...strategies].sort((a, b) => stageIndex(b.status) - stageIndex(a.status));

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">
            Promotion Pipeline — {strategies.length} strategies tracked
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto mb-4">
            <div className="flex items-center gap-0 min-w-max">
              {PIPELINE_ORDER.map((stage, i) => (
                <div key={stage} className="flex items-center">
                  <div
                    className="flex flex-col items-center px-3 py-2 rounded text-xs text-center"
                    style={{ background: "var(--color-surface-subtle)", minWidth: "80px" }}
                  >
                    <span className="font-bold text-sm" style={{ color: "var(--color-accent)" }}>
                      {strategies.filter((s) => s.status === stage).length}
                    </span>
                    <span style={{ color: "var(--color-fg-muted)" }}>{stage.replace(/_/g, " ")}</span>
                  </div>
                  {i < PIPELINE_ORDER.length - 1 && (
                    <span className="px-1 text-xs" style={{ color: "var(--color-fg-muted)" }}>→</span>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            {sorted.map((s) => {
              const blocked = s.status === "EXPERIMENTAL" && s.hypothesis.status !== "DEFINED";
              return (
                <div
                  key={s.strategyId}
                  className="flex items-start gap-3 rounded p-3 text-sm"
                  style={{ background: "var(--color-surface-subtle)", border: "1px solid var(--color-border)" }}
                >
                  <div className="flex-1">
                    <div className="flex flex-wrap items-center gap-2 mb-1">
                      <span className="font-medium" style={{ color: "var(--color-fg)" }}>{s.strategyName}</span>
                      <StatusBadge status={s.status} />
                      {blocked && (
                        <span className="text-xs text-amber-500 font-medium">⚠ Blocked: no hypothesis</span>
                      )}
                    </div>
                    <p className="text-xs" style={{ color: "var(--color-fg-muted)" }}>
                      {s.strategyCategory.replace(/_/g, " ")} · {s.market} · {s.timeframe}
                    </p>
                  </div>
                  <div className="text-xs font-mono text-right whitespace-nowrap" style={{ color: "var(--color-fg-muted)" }}>
                    Stage {Math.max(0, stageIndex(s.status) + 1)}/{PIPELINE_ORDER.length}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="mt-4 rounded p-3 text-xs" style={{ background: "var(--color-surface-subtle)", borderLeft: "3px solid #ef4444" }}>
            <strong style={{ color: "#ef4444" }}>CRITICAL RULE:</strong>
            <span style={{ color: "var(--color-fg-muted)" }}> No strategy can be automatically promoted to LIVE. The MANUAL_APPROVAL → LIVE transition requires an explicit human approval token. This cannot be bypassed.</span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
