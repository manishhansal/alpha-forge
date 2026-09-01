/**
 * Phase 25 — Strategy Correlation Page
 */

import type { Metadata } from "next";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageTransition } from "@/components/layout/PageTransition";
import { ResearchNav } from "@/components/research/research-nav";
import { CorrelationView } from "@/components/research/correlation-view";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Strategy Correlation · Research · AlphaForge",
};

export default function CorrelationPage() {
  return (
    <PageTransition>
      <div className="space-y-6 p-4 md:p-6">
        <PageHeader
          title="Strategy Correlation & Redundancy"
          subtitle="Highly correlated strategies do not diversify risk. Cluster analysis prevents capital over-concentration."
        />
        <ResearchNav activeTab="correlation" />
        <CorrelationView />
      </div>
    </PageTransition>
  );
}
