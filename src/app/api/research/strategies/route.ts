/**
 * GET /api/research/strategies
 * Returns the full strategy inventory with current status, hypothesis status,
 * and confidence scores for every registered strategy.
 */

import { NextResponse } from "next/server";
import { StrategyRegistry } from "@/lib/research/registry/strategy-registry";
import { HypothesisRegistry } from "@/lib/research/hypothesis/strategy-hypothesis";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const strategies = StrategyRegistry.getAll();

    const payload = strategies.map((meta) => {
      const hypothesis = HypothesisRegistry.getOrDefault(meta.strategyId);
      return {
        strategyId: meta.strategyId,
        strategyName: meta.strategyName,
        version: meta.version,
        market: meta.market,
        instrumentType: meta.instrumentType,
        timeframe: meta.timeframe,
        strategyCategory: meta.strategyCategory,
        status: meta.status,
        hypothesisStatus: hypothesis.status,
        registeredAt: meta.registeredAt,
        lastUpdatedAt: meta.lastUpdatedAt,
      };
    });

    return NextResponse.json({ strategies: payload, total: payload.length });
  } catch (err) {
    console.error("[GET /api/research/strategies]", err);
    return NextResponse.json(
      { error: true, code: "STRATEGIES_FAILED", message: (err as Error).message },
      { status: 500 },
    );
  }
}
