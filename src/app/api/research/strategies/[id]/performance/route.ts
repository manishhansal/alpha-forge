/**
 * GET /api/research/strategies/:id/performance
 * Returns the multi-period performance scorecard for a strategy.
 * All metrics are computed and returned for IS, VALIDATION, FINAL_OOS, PAPER, SHADOW.
 *
 * In production this reads from the database where experiment results are stored.
 * The stub below returns a skeleton response for development.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { StrategyRegistry } from "@/lib/research/registry/strategy-registry";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const paramsSchema = z.object({ id: z.string().min(1).max(64) });

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let parsed: { id: string };
  try {
    parsed = paramsSchema.parse(await params);
  } catch {
    return NextResponse.json({ error: true, code: "INVALID_PARAMS" }, { status: 400 });
  }

  const meta = StrategyRegistry.get(parsed.id);
  if (!meta) {
    return NextResponse.json(
      { error: true, code: "NOT_FOUND", message: `Strategy "${parsed.id}" not found` },
      { status: 404 },
    );
  }

  // TODO: In production, load from ExperimentStore / database
  return NextResponse.json({
    strategyId: parsed.id,
    strategyName: meta.strategyName,
    status: meta.status,
    performanceReport: null,
    message: "No backtest results available yet. Run the research pipeline first.",
  });
}
