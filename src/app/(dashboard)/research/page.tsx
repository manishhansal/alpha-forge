/**
 * Phase 25 — Quant Research Dashboard — Home / Strategy Leaderboard
 *
 * Primary research hub displaying the strategy leaderboard with
 * confidence scores, OOS metrics, and promotion pipeline status.
 */

import { Suspense } from "react";
import type { Metadata } from "next";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageTransition } from "@/components/layout/PageTransition";
import { ResearchLeaderboard } from "@/components/research/research-leaderboard";
import { ResearchNav } from "@/components/research/research-nav";
import { ResearchSummaryCards } from "@/components/research/research-summary-cards";
import { Skeleton } from "@/components/ui/skeleton";
import { StrategyRegistry } from "@/lib/research/registry/strategy-registry";
import { HypothesisRegistry } from "@/lib/research/hypothesis/strategy-hypothesis";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Research Dashboard · AlphaForge V6",
  description: "Evidence-driven quant research platform for strategy validation and promotion.",
};

async function getResearchSummary() {
  const strategies = StrategyRegistry.getAll();
  const statusCounts: Record<string, number> = {};
  let hypothesisDefined = 0;

  for (const s of strategies) {
    statusCounts[s.status] = (statusCounts[s.status] ?? 0) + 1;
    if (HypothesisRegistry.isValidated(s.strategyId)) hypothesisDefined++;
  }

  return {
    total: strategies.length,
    statusCounts,
    hypothesisDefined,
    hypothesisUnvalidated: strategies.length - hypothesisDefined,
    liveStrategies: statusCounts["LIVE"] ?? 0,
    paperStrategies: statusCounts["PAPER"] ?? 0,
    researchStrategies:
      (statusCounts["RESEARCH"] ?? 0) +
      (statusCounts["BACKTEST_VALIDATED"] ?? 0) +
      (statusCounts["WALK_FORWARD_VALIDATED"] ?? 0),
    disabledStrategies: statusCounts["DISABLED"] ?? 0,
    strategies,
  };
}

export default async function ResearchPage() {
  const summary = await getResearchSummary();

  return (
    <PageTransition>
      <div className="space-y-6 p-4 md:p-6">
        <PageHeader
          title="Quant Research Platform"
          subtitle="Evidence-driven strategy evaluation. Every strategy must prove its edge."
        />

        <ResearchNav activeTab="leaderboard" />

        <Suspense fallback={<div className="grid grid-cols-2 gap-4 md:grid-cols-4"><Skeleton className="h-24" /><Skeleton className="h-24" /><Skeleton className="h-24" /><Skeleton className="h-24" /></div>}>
          <ResearchSummaryCards summary={summary} />
        </Suspense>

        <Suspense fallback={<Skeleton className="h-96 w-full" />}>
          <ResearchLeaderboard strategies={summary.strategies} />
        </Suspense>
      </div>
    </PageTransition>
  );
}
