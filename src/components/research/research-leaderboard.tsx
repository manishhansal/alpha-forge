"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "./status-badge";
import { HypothesisRegistry } from "@/lib/research/hypothesis/strategy-hypothesis";
import type { StrategyMeta } from "@/lib/research/types";

const VIEWS = ["ALL", "RESEARCH", "VALIDATED", "PAPER", "LIVE_CANDIDATE", "DISABLED"] as const;

const VIEW_FILTER: Record<string, string[]> = {
  ALL: ["EXPERIMENTAL", "RESEARCH", "BACKTEST_VALIDATED", "WALK_FORWARD_VALIDATED", "SHADOW", "PAPER", "LIVE_CANDIDATE", "MANUAL_APPROVAL", "LIVE", "WARNING", "DEGRADED"],
  RESEARCH: ["RESEARCH", "BACKTEST_VALIDATED", "WALK_FORWARD_VALIDATED"],
  VALIDATED: ["WALK_FORWARD_VALIDATED", "SHADOW"],
  PAPER: ["PAPER"],
  LIVE_CANDIDATE: ["LIVE_CANDIDATE", "MANUAL_APPROVAL", "LIVE"],
  DISABLED: ["DISABLED"],
};

export function ResearchLeaderboard({ strategies }: { strategies: StrategyMeta[] }) {
  const [view, setView] = useState<string>("ALL");

  const filtered = strategies.filter((s) =>
    VIEW_FILTER[view]?.includes(s.status),
  );

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="text-base">Strategy Leaderboard</CardTitle>
          <div className="flex flex-wrap gap-1" role="tablist" aria-label="Leaderboard filter">
            {VIEWS.map((v) => (
              <button
                key={v}
                role="tab"
                aria-selected={view === v}
                onClick={() => setView(v)}
                className="rounded px-2.5 py-1 text-xs font-medium transition-colors"
                style={
                  view === v
                    ? { background: "var(--color-accent)", color: "#fff" }
                    : { background: "transparent", color: "var(--color-fg-muted)", border: "1px solid var(--color-border)" }
                }
              >
                {v.replace(/_/g, " ")}
              </button>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm" aria-label="Strategy leaderboard">
            <thead>
              <tr style={{ borderBottom: "1px solid var(--color-border)" }}>
                {["Strategy", "Market", "Category", "Timeframe", "Status", "Hypothesis", "OOS Sharpe", "Paper Sharpe", "Confidence"].map(
                  (col) => (
                    <th
                      key={col}
                      scope="col"
                      className="whitespace-nowrap px-4 py-3 text-left text-xs font-medium"
                      style={{ color: "var(--color-fg-muted)" }}
                    >
                      {col}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-4 py-8 text-center text-sm" style={{ color: "var(--color-fg-muted)" }}>
                    No strategies in this view.
                  </td>
                </tr>
              )}
              {filtered.map((s, i) => {
                const hyp = HypothesisRegistry.getOrDefault(s.strategyId);
                const isUnvalidated = hyp.status !== "DEFINED";
                return (
                  <tr
                    key={s.strategyId}
                    className="transition-colors hover:opacity-80"
                    style={{ borderBottom: "1px solid var(--color-border)", background: i % 2 === 0 ? "transparent" : "var(--color-surface-subtle)" }}
                  >
                    <td className="px-4 py-3">
                      <div className="font-medium" style={{ color: "var(--color-fg)" }}>
                        {s.strategyName}
                      </div>
                      <div className="text-xs mt-0.5" style={{ color: "var(--color-fg-muted)" }}>
                        v{s.version}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-xs" style={{ color: "var(--color-fg-muted)" }}>
                      {s.market}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-xs" style={{ color: "var(--color-fg-muted)" }}>
                      {s.strategyCategory.replace(/_/g, " ")}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-xs font-mono" style={{ color: "var(--color-fg-muted)" }}>
                      {s.timeframe}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3">
                      <StatusBadge status={s.status} />
                    </td>
                    <td className="whitespace-nowrap px-4 py-3">
                      <span
                        className="text-xs font-medium"
                        style={{ color: isUnvalidated ? "#fbbf24" : "#22c55e" }}
                      >
                        {isUnvalidated ? "⚠ UNVALIDATED" : "✓ DEFINED"}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-xs font-mono" style={{ color: "var(--color-fg-muted)" }}>
                      —
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-xs font-mono" style={{ color: "var(--color-fg-muted)" }}>
                      —
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-xs font-mono" style={{ color: "var(--color-fg-muted)" }}>
                      —
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="px-4 py-3 text-xs" style={{ color: "var(--color-fg-muted)", borderTop: "1px solid var(--color-border)" }}>
          {filtered.length} strategies · OOS metrics populated after research pipeline execution
        </div>
      </CardContent>
    </Card>
  );
}
