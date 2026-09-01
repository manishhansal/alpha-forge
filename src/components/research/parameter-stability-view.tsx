"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface StrategyOption { id: string; name: string; status: string }

export function ParameterStabilityView({ strategies }: { strategies: StrategyOption[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Parameter Stability Analysis</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm mb-4" style={{ color: "var(--color-fg-muted)" }}>
          For each optimised parameter, the neighbourhood (±N steps) is tested. A robust strategy
          has a flat performance plateau. An overfit strategy has a single peak surrounded by losses.
        </p>
        <div className="text-center py-8 text-sm" style={{ color: "var(--color-fg-muted)" }}>
          Parameter stability analysis will appear here after running the research pipeline.
          <br />
          <span className="mt-2 block text-xs">
            STABLE = flat neighbourhood · MODERATE = some sensitivity · OVERFIT_SUSPECTED = knife edge
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
