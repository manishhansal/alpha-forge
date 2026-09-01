/**
 * Phase 25 — Experiment History Page
 */

import type { Metadata } from "next";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageTransition } from "@/components/layout/PageTransition";
import { ResearchNav } from "@/components/research/research-nav";
import { ExperimentHistoryView } from "@/components/research/experiment-history-view";
import { ExperimentStore } from "@/lib/research/experiments/research-experiment-tracker";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Experiment History · Research · AlphaForge",
};

export default function ExperimentsPage() {
  const experiments = ExperimentStore.all();

  return (
    <PageTransition>
      <div className="space-y-6 p-4 md:p-6">
        <PageHeader
          title="Experiment History"
          subtitle={`${experiments.length} experiments recorded. Every experiment is immutable and reproducible.`}
        />
        <ResearchNav activeTab="experiments" />
        <ExperimentHistoryView experiments={experiments} />
      </div>
    </PageTransition>
  );
}
