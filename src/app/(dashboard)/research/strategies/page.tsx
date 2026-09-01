/**
 * Phase 25 — Strategy Detail Index
 * Lists all strategies with hypothesis status and detailed drill-down links.
 */

import type { Metadata } from "next";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageTransition } from "@/components/layout/PageTransition";
import { ResearchNav } from "@/components/research/research-nav";
import { StrategyInventoryTable } from "@/components/research/strategy-inventory-table";
import { StrategyRegistry } from "@/lib/research/registry/strategy-registry";
import { HypothesisRegistry } from "@/lib/research/hypothesis/strategy-hypothesis";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Strategy Inventory · Research · AlphaForge",
};

export default async function StrategiesPage() {
  const strategies = StrategyRegistry.getAll();
  const enriched = strategies.map((s) => ({
    ...s,
    hypothesis: HypothesisRegistry.getOrDefault(s.strategyId),
  }));

  return (
    <PageTransition>
      <div className="space-y-6 p-4 md:p-6">
        <PageHeader
          title="Strategy Inventory"
          subtitle={`${strategies.length} strategies registered. Every strategy must have a hypothesis before validation.`}
        />
        <ResearchNav activeTab="strategies" />
        <StrategyInventoryTable strategies={enriched} />
      </div>
    </PageTransition>
  );
}
