/**
 * Phase 25 — Alpha Decay Monitor Page
 */

import type { Metadata } from "next";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageTransition } from "@/components/layout/PageTransition";
import { ResearchNav } from "@/components/research/research-nav";
import { AlphaDecayMonitorView } from "@/components/research/alpha-decay-monitor-view";
import { StrategyRegistry } from "@/lib/research/registry/strategy-registry";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Alpha Decay Monitor · Research · AlphaForge",
};

export default function AlphaDecayPage() {
  const strategies = StrategyRegistry.getAll().map((s) => ({
    id: s.strategyId,
    name: s.strategyName,
    status: s.status,
    market: s.market,
  }));

  return (
    <PageTransition>
      <div className="space-y-6 p-4 md:p-6">
        <PageHeader
          title="Alpha Decay Monitor"
          subtitle="A strategy should not be trusted indefinitely. Rolling metrics detect when the edge is fading."
        />
        <ResearchNav activeTab="alpha-decay" />
        <AlphaDecayMonitorView strategies={strategies} />
      </div>
    </PageTransition>
  );
}
