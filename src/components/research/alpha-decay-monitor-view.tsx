"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DecayStateBadge } from "./status-badge";
import type { DecayState } from "@/lib/research/types";

interface StrategyOption {
  id: string;
  name: string;
  status: string;
  market: string;
}

// Placeholder decay states (will be replaced with live data from the decay monitor)
const PLACEHOLDER_STATES: DecayState[] = ["HEALTHY", "HEALTHY", "WARNING", "HEALTHY", "DEGRADED", "HEALTHY"];

export function AlphaDecayMonitorView({ strategies }: { strategies: StrategyOption[] }) {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Rolling Performance Monitor</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm mb-4" style={{ color: "var(--color-fg-muted)" }}>
            Rolling Sharpe, Expectancy, Win Rate, Profit Factor compared against historical OOS baseline.
            Deviations beyond 1σ trigger WARNING; beyond 2σ trigger DEGRADED; beyond 3σ trigger CRITICAL.
          </p>
          <div className="grid gap-3 md:grid-cols-2">
            {strategies.map((s, i) => {
              const state: DecayState = PLACEHOLDER_STATES[i % PLACEHOLDER_STATES.length];
              return (
                <div
                  key={s.id}
                  className="flex items-center justify-between rounded p-3"
                  style={{ background: "var(--color-surface-subtle)", border: "1px solid var(--color-border)" }}
                >
                  <div>
                    <p className="text-sm font-medium" style={{ color: "var(--color-fg)" }}>{s.name}</p>
                    <p className="text-xs" style={{ color: "var(--color-fg-muted)" }}>{s.market}</p>
                  </div>
                  <div className="text-right">
                    <DecayStateBadge state={state} />
                    <p className="mt-1 text-xs font-mono" style={{ color: "var(--color-fg-muted)" }}>
                      rolling Sharpe: —
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
          <p className="mt-4 text-xs" style={{ color: "var(--color-fg-muted)" }}>
            Decay states will be computed automatically after the research pipeline runs and produces OOS baseline metrics.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
