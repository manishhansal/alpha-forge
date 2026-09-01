"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function CorrelationView() {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Return Correlation Matrix</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm mb-4" style={{ color: "var(--color-fg-muted)" }}>
            Strategies with correlation &gt; 0.70 are clustered. Cluster capital is capped
            to prevent over-concentration in effectively identical exposures.
          </p>
          <div className="text-center py-8 text-sm" style={{ color: "var(--color-fg-muted)" }}>
            Correlation matrix will appear here after running the research pipeline.
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Strategy Clusters</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-center py-6 text-xs" style={{ color: "var(--color-fg-muted)" }}>
            Cluster assignments will appear after correlation analysis is complete.
            <br />
            Each cluster has a max capital allocation cap to prevent correlated drawdowns.
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
