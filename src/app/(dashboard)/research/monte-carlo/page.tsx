/**
 * Phase 25 — Monte Carlo Analysis Page
 */

import type { Metadata } from "next";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageTransition } from "@/components/layout/PageTransition";
import { ResearchNav } from "@/components/research/research-nav";
import { MonteCarloView } from "@/components/research/monte-carlo-view";
import { StrategyRegistry } from "@/lib/research/registry/strategy-registry";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Monte Carlo Analysis · Research · AlphaForge",
};

export default function MonteCarloPage() {
  const strategies = StrategyRegistry.getAll().map((s) => ({
    id: s.strategyId,
    name: s.strategyName,
    status: s.status,
  }));

  return (
    <PageTransition>
      <div className="space-y-6 p-4 md:p-6">
        <PageHeader
          title="Monte Carlo Robustness"
          subtitle="10,000 simulations per strategy. Is the performance stable or lucky?"
        />
        <ResearchNav activeTab="monte-carlo" />
        <MonteCarloView strategies={strategies} />
      </div>
    </PageTransition>
  );
}
