/**
 * GET /api/research/leaderboard
 * Returns the strategy leaderboard sorted by configurable metrics.
 *
 * Query params:
 *   view   = ALL | RESEARCH | VALIDATED | PAPER | LIVE_CANDIDATE | DISABLED
 *   sortBy = confidenceScore | oosSharpe | calmar | expectancy | netSharpe
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { StrategyRegistry } from "@/lib/research/registry/strategy-registry";
import { buildLeaderboard } from "@/lib/research/leaderboard/strategy-leaderboard";
import type { LeaderboardView } from "@/lib/research/types";
import type { LeaderboardEntry } from "@/lib/research/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const querySchema = z.object({
  view: z.enum(["ALL", "RESEARCH", "VALIDATED", "PAPER", "LIVE_CANDIDATE", "DISABLED"]).default("ALL"),
  sortBy: z.enum(["confidenceScore", "oosSharpe", "calmar", "expectancy", "netSharpe", "maxDrawdown", "profitFactor"]).default("confidenceScore"),
});

export async function GET(req: Request) {
  let query: { view: LeaderboardView; sortBy: keyof LeaderboardEntry };
  try {
    const url = new URL(req.url);
    const raw = Object.fromEntries(url.searchParams);
    query = querySchema.parse(raw) as { view: LeaderboardView; sortBy: keyof LeaderboardEntry };
  } catch {
    return NextResponse.json({ error: true, code: "INVALID_PARAMS" }, { status: 400 });
  }

  const strategies = StrategyRegistry.getAll();

  // Build leaderboard inputs from registry metadata
  // In production, confidence scores and performance metrics would come from the database
  const inputs = strategies.map((s) => ({
    strategyId: s.strategyId,
    confidenceScore: undefined, // populated from research pipeline results
    finalOosSharpe: undefined,
    netSharpe: undefined,
    maxDrawdown: undefined,
    profitFactor: undefined,
    tradeCount: undefined,
    regimeFitScore: undefined,
    expectancy: undefined,
    calmar: undefined,
    recentDecayState: undefined,
  }));

  const leaderboard = buildLeaderboard(inputs, query.view, query.sortBy);

  return NextResponse.json(leaderboard);
}
