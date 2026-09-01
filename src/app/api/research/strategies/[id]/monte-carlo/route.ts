/**
 * GET /api/research/strategies/:id/monte-carlo
 * Returns Monte Carlo robustness results for a strategy.
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
    return NextResponse.json({ error: true, code: "NOT_FOUND" }, { status: 404 });
  }

  return NextResponse.json({
    strategyId: parsed.id,
    strategyName: meta.strategyName,
    monteCarlo: null,
    message: "No Monte Carlo results available yet. Run the research pipeline first.",
  });
}
