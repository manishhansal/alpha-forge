/**
 * GET /api/research/correlation
 * Returns the strategy correlation matrix and cluster assignments.
 */

import { NextResponse } from "next/server";
import { StrategyRegistry } from "@/lib/research/registry/strategy-registry";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const strategies = StrategyRegistry.getAll();

  return NextResponse.json({
    strategies: strategies.map((s) => ({
      strategyId: s.strategyId,
      strategyName: s.strategyName,
      strategyCategory: s.strategyCategory,
      market: s.market,
    })),
    correlationMatrix: null,  // populated after research pipeline runs
    clusters: [],
    message: "No correlation data available yet. Run the research pipeline first.",
    generatedAt: new Date().toISOString(),
  });
}
