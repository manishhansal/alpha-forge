/**
 * Phase 25 — Promotion Pipeline Page
 */

import type { Metadata } from "next";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageTransition } from "@/components/layout/PageTransition";
import { ResearchNav } from "@/components/research/research-nav";
import { PromotionPipelineView } from "@/components/research/promotion-pipeline-view";
import { StrategyRegistry } from "@/lib/research/registry/strategy-registry";
import { HypothesisRegistry } from "@/lib/research/hypothesis/strategy-hypothesis";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Promotion Pipeline · Research · AlphaForge",
};

export default function PromotionPipelinePage() {
  const strategies = StrategyRegistry.getAll();
  const enriched = strategies.map((s) => ({
    ...s,
    hypothesis: HypothesisRegistry.getOrDefault(s.strategyId),
  }));

  return (
    <PageTransition>
      <div className="space-y-6 p-4 md:p-6">
        <PageHeader
          title="Promotion Pipeline"
          subtitle="Evidence gates that must be cleared before a strategy advances. LIVE always requires human approval."
        />
        <ResearchNav activeTab="promotion-pipeline" />
        <PromotionPipelineView strategies={enriched} />
      </div>
    </PageTransition>
  );
}
