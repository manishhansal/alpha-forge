"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface StrategyOption { id: string; name: string; status: string }

export function MonteCarloView({ strategies }: { strategies: StrategyOption[] }) {
  const [selected, setSelected] = useState(strategies[0]?.id ?? "");

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center gap-3">
            <CardTitle className="text-sm">Monte Carlo Robustness</CardTitle>
            <select
              className="rounded border px-2 py-1 text-xs"
              style={{ background: "var(--color-surface)", borderColor: "var(--color-border)", color: "var(--color-fg)" }}
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              aria-label="Select strategy for Monte Carlo analysis"
            >
              {strategies.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-3 text-sm">
            {[
              "TRADE_SHUFFLE", "BOOTSTRAP", "RETURN_PERTURB",
              "SLIPPAGE_PERTURB", "COST_PERTURB", "MISSED_TRADES", "PARTIAL_FILL",
            ].map((simType) => (
              <div
                key={simType}
                className="rounded p-3 text-center"
                style={{ background: "var(--color-surface-subtle)", border: "1px solid var(--color-border)" }}
              >
                <p className="text-xs font-medium mb-2" style={{ color: "var(--color-fg)" }}>
                  {simType.replace(/_/g, " ")}
                </p>
                <p className="text-2xl font-bold font-mono" style={{ color: "var(--color-fg-muted)" }}>—</p>
                <p className="text-xs mt-1" style={{ color: "var(--color-fg-muted)" }}>Awaiting pipeline</p>
              </div>
            ))}
          </div>
          <p className="mt-4 text-xs text-center" style={{ color: "var(--color-fg-muted)" }}>
            Run 10,000 iterations per simulation type. Results show probability of loss, probability of ruin, and Sharpe distribution.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
