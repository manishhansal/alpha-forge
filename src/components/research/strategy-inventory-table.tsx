"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "./status-badge";
import type { StrategyMeta, StrategyHypothesis } from "@/lib/research/types";

type EnrichedStrategy = StrategyMeta & { hypothesis: StrategyHypothesis };

export function StrategyInventoryTable({ strategies }: { strategies: EnrichedStrategy[] }) {
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Strategy Inventory ({strategies.length})</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm" aria-label="Strategy inventory">
            <thead>
              <tr style={{ borderBottom: "1px solid var(--color-border)" }}>
                {["ID", "Name", "Market", "Category", "Timeframe", "Status", "Hypothesis"].map((col) => (
                  <th key={col} scope="col" className="px-4 py-3 text-left text-xs font-medium" style={{ color: "var(--color-fg-muted)" }}>
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {strategies.map((s, i) => {
                const isExpanded = expanded === s.strategyId;
                return (
                  <>
                    <tr
                      key={s.strategyId}
                      className="cursor-pointer transition-colors hover:opacity-80"
                      style={{
                        borderBottom: "1px solid var(--color-border)",
                        background: i % 2 === 0 ? "transparent" : "var(--color-surface-subtle)",
                      }}
                      onClick={() => setExpanded(isExpanded ? null : s.strategyId)}
                      aria-expanded={isExpanded}
                    >
                      <td className="px-4 py-2.5 font-mono text-xs" style={{ color: "var(--color-fg-muted)" }}>
                        {s.strategyId}
                      </td>
                      <td className="px-4 py-2.5 font-medium" style={{ color: "var(--color-fg)" }}>
                        {s.strategyName}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-xs" style={{ color: "var(--color-fg-muted)" }}>
                        {s.market}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-xs" style={{ color: "var(--color-fg-muted)" }}>
                        {s.strategyCategory.replace(/_/g, " ")}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs" style={{ color: "var(--color-fg-muted)" }}>
                        {s.timeframe}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5">
                        <StatusBadge status={s.status} />
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5">
                        <span className="text-xs font-medium" style={{ color: s.hypothesis.status === "DEFINED" ? "#22c55e" : "#fbbf24" }}>
                          {s.hypothesis.status === "DEFINED" ? "✓ Defined" : "⚠ Unvalidated"}
                        </span>
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr key={`${s.strategyId}-expanded`} style={{ background: "var(--color-surface-subtle)" }}>
                        <td colSpan={7} className="px-4 py-4">
                          <div className="grid gap-4 md:grid-cols-2 text-sm">
                            <div>
                              <p className="text-xs font-semibold mb-1" style={{ color: "var(--color-fg-muted)" }}>HYPOTHESIS</p>
                              <p style={{ color: "var(--color-fg)" }}>{s.hypothesis.hypothesis}</p>
                            </div>
                            <div>
                              <p className="text-xs font-semibold mb-1" style={{ color: "var(--color-fg-muted)" }}>EXPECTED EDGE</p>
                              <p style={{ color: "var(--color-fg)" }}>{s.hypothesis.expectedEdge}</p>
                            </div>
                            <div>
                              <p className="text-xs font-semibold mb-1" style={{ color: "var(--color-fg-muted)" }}>EXPECTED FAILURE MODE</p>
                              <p style={{ color: "var(--color-fg)" }}>{s.hypothesis.expectedFailureMode}</p>
                            </div>
                            <div>
                              <p className="text-xs font-semibold mb-1" style={{ color: "var(--color-fg-muted)" }}>WHAT WOULD INVALIDATE</p>
                              <p style={{ color: "var(--color-fg)" }}>{s.hypothesis.whatWouldInvalidate}</p>
                            </div>
                            <div>
                              <p className="text-xs font-semibold mb-1" style={{ color: "var(--color-fg-muted)" }}>ENTRY LOGIC</p>
                              <p style={{ color: "var(--color-fg)" }}>{s.entryLogic}</p>
                            </div>
                            <div>
                              <p className="text-xs font-semibold mb-1" style={{ color: "var(--color-fg-muted)" }}>EXPECTED REGIMES</p>
                              <p className="font-mono text-xs" style={{ color: "var(--color-fg)" }}>
                                {s.hypothesis.expectedRegime.join(", ")}
                              </p>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
