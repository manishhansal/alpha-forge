"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { VerdictBadge } from "./verdict-badge";
import type { SignalQualityReport, StrategyVerdict } from "@/lib/signal-quality/types";

const VERDICT_QUESTIONS: Record<StrategyVerdict, string> = {
  HIGH_QUALITY:      "Ready for governance pipeline",
  PROMISING:         "Accumulate more data; track closely",
  NEEDS_MORE_DATA:   "Cannot evaluate — insufficient trades",
  WEAK:              "Requires parameter review or filtering improvement",
  DEGRADED:          "Multiple metrics failing — do not scale",
  DISABLE_CANDIDATE: "Recommend disabling pending systematic review",
};

export function FinalVerdictsPanel({
  verdicts,
}: {
  verdicts: SignalQualityReport["finalVerdicts"];
}) {
  const grouped = verdicts.reduce(
    (acc, v) => {
      if (!acc[v.verdict]) acc[v.verdict] = [];
      acc[v.verdict].push(v);
      return acc;
    },
    {} as Record<StrategyVerdict, typeof verdicts>,
  );

  const order: StrategyVerdict[] = [
    "HIGH_QUALITY",
    "PROMISING",
    "NEEDS_MORE_DATA",
    "WEAK",
    "DEGRADED",
    "DISABLE_CANDIDATE",
  ];

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold tracking-tight">
          Final Strategy Verdicts
        </CardTitle>
        <p className="text-[11px]" style={{ color: "var(--color-fg-subtle)" }}>
          Which strategies should move forward? Only evidence counts.
          A sophisticated signal is not automatically a profitable signal.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {order.map((verdict) => {
          const group = grouped[verdict];
          if (!group || group.length === 0) return null;
          return (
            <div key={verdict}>
              <div className="mb-2 flex items-center gap-2">
                <VerdictBadge verdict={verdict} />
                <p className="text-[11px]" style={{ color: "var(--color-fg-subtle)" }}>
                  {VERDICT_QUESTIONS[verdict]}
                </p>
              </div>
              <div className="space-y-1.5">
                {group.map((v) => (
                  <div
                    key={v.strategyId}
                    className="flex items-start justify-between rounded-lg border p-3"
                    style={{
                      borderColor: "var(--color-border)",
                      background: "var(--color-surface)",
                    }}
                  >
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <p className="text-[12px] font-semibold" style={{ color: "var(--color-fg)" }}>
                          {v.label}
                        </p>
                        <span className="text-[10px]" style={{ color: "var(--color-fg-subtle)" }}>
                          ({v.strategyId})
                        </span>
                      </div>
                      <p className="mt-0.5 text-[11px]" style={{ color: "var(--color-fg-muted)" }}>
                        {v.justification}
                      </p>
                    </div>
                    <div className="ml-4 text-right shrink-0">
                      <p
                        className="text-xl font-bold tabular-nums"
                        style={{
                          color:
                            v.score >= 75
                              ? "var(--color-bull)"
                              : v.score >= 50
                              ? "var(--color-warning)"
                              : "var(--color-bear)",
                        }}
                      >
                        {v.score}
                      </p>
                      <p className="text-[9px]" style={{ color: "var(--color-fg-subtle)" }}>
                        / 100 · n={v.sampleSize}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
        {verdicts.length === 0 && (
          <p className="py-4 text-center text-[12px]" style={{ color: "var(--color-fg-subtle)" }}>
            No strategies have resolved trades in the evaluation window.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
