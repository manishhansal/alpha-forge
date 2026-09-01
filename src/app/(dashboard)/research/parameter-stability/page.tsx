/**
 * Phase 25 — Parameter Stability Page
 */

import type { Metadata } from "next";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageTransition } from "@/components/layout/PageTransition";
import { ResearchNav } from "@/components/research/research-nav";
import { ParameterStabilityView } from "@/components/research/parameter-stability-view";
import { StrategyRegistry } from "@/lib/research/registry/strategy-registry";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Parameter Stability · Research · AlphaForge",
};

export default function ParameterStabilityPage() {
  const strategies = StrategyRegistry.getAll().map((s) => ({
    id: s.strategyId,
    name: s.strategyName,
    status: s.status,
  }));

  return (
    <PageTransition>
      <div className="space-y-6 p-4 md:p-6">
        <PageHeader
          title="Parameter Stability"
          subtitle="Does the strategy require a magical parameter value? Neighbourhood analysis reveals overfitting."
        />
        <ResearchNav activeTab="parameter-stability" />
        <ParameterStabilityView strategies={strategies} />
      </div>
    </PageTransition>
  );
}
