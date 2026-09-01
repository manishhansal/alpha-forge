/**
 * GET /api/research/promotion
 * Returns promotion pipeline status for all strategies.
 * Shows which gates each strategy has passed/failed and what is blocking promotion.
 */

import { NextResponse } from "next/server";
import { StrategyRegistry } from "@/lib/research/registry/strategy-registry";
import { HypothesisRegistry } from "@/lib/research/hypothesis/strategy-hypothesis";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const strategies = StrategyRegistry.getAll();

  const pipeline = strategies.map((meta) => {
    const hypothesis = HypothesisRegistry.getOrDefault(meta.strategyId);

    const nextStepBlockers: string[] = [];

    if (meta.status === "EXPERIMENTAL") {
      if (hypothesis.status !== "DEFINED") {
        nextStepBlockers.push("Hypothesis not defined — define hypothesis before proceeding to RESEARCH");
      }
    }

    if (meta.status === "RESEARCH") {
      nextStepBlockers.push("Awaiting backtest execution and OOS performance validation");
    }

    return {
      strategyId: meta.strategyId,
      strategyName: meta.strategyName,
      currentStatus: meta.status,
      hypothesisStatus: hypothesis.status,
      nextStepBlockers,
      readyForPromotion: nextStepBlockers.length === 0,
    };
  });

  return NextResponse.json({
    pipeline,
    total: pipeline.length,
    readyForPromotion: pipeline.filter((p) => p.readyForPromotion).length,
    generatedAt: new Date().toISOString(),
  });
}
