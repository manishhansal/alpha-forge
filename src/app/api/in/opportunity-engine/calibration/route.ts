/**
 * GET /api/in/opportunity-engine/calibration
 *
 * Returns probability calibration reports for all strategies with resolved paper trades.
 *
 * Computes:
 *   - Brier score per strategy
 *   - Expected Calibration Error (ECE)
 *   - Reliability curves (10 bins)
 *   - Score monotonicity across quality buckets
 *   - Sample-size awareness
 *
 * Query params:
 *   strategy — specific strategy ID (default: all)
 *   days     — lookback window in days (default: 90)
 */

import { NextResponse, type NextRequest } from "next/server";
import { getPrisma } from "@/lib/prisma";
import {
  computeCalibrationReport,
  computeShrunkenWinRate,
  type TradeOutcome,
} from "@/lib/opportunity-engine";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const strategyFilter = params.get("strategy") ?? null;
  const days = Math.min(365, Math.max(7, Number(params.get("days") ?? "90") || 90));

  try {
    const db = getPrisma();
    const since = new Date(Date.now() - days * 86_400_000);

    // Fetch resolved paper trades
    const trades = await db.paperTrade.findMany({
      where: {
        source: { startsWith: "in:" },
        status: { in: ["WIN", "LOSS", "EXPIRED"] },
        openedAt: { gte: since },
        pnlPct: { not: null },
      },
      select: {
        source: true,
        status: true,
        pnlPct: true,
        meta: true,
      },
    });

    // Group by strategy
    const byStrategy = new Map<string, TradeOutcome[]>();

    for (const trade of trades) {
      const strategyId = (trade.source.split(":")[1] ?? "UNKNOWN").toUpperCase();
      if (strategyFilter && strategyId !== strategyFilter) continue;

      const meta = (trade.meta ?? {}) as Record<string, unknown>;
      const confidence = typeof meta.confidence === "number" ? meta.confidence : 0.5;
      const score = typeof meta.score === "number" ? meta.score * 100 : 50;
      const won = trade.status === "WIN";

      const outcomes = byStrategy.get(strategyId) ?? [];
      outcomes.push({ predictedProbability: confidence, score, won, pnlPct: trade.pnlPct });
      byStrategy.set(strategyId, outcomes);
    }

    // Compute calibration report for each strategy
    const reports: Record<string, unknown> = {};
    for (const [strategyId, outcomes] of byStrategy.entries()) {
      const report = computeCalibrationReport(strategyId, outcomes);
      const winRate = computeShrunkenWinRate(
        outcomes.filter(o => o.won).length,
        outcomes.length,
      );
      reports[strategyId] = {
        ...report,
        shrunkenWinRate: winRate,
      };
    }

    // Overall system calibration
    const allOutcomes: TradeOutcome[] = [...byStrategy.values()].flat();
    const overallReport = computeCalibrationReport("ALL_STRATEGIES", allOutcomes);
    const overallWinRate = computeShrunkenWinRate(
      allOutcomes.filter(o => o.won).length,
      allOutcomes.length,
    );

    return NextResponse.json({
      windowDays: days,
      totalTrades: trades.length,
      strategiesEvaluated: byStrategy.size,
      overall: { ...overallReport, shrunkenWinRate: overallWinRate },
      byStrategy: reports,
      generatedAt: Date.now(),
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Calibration computation failed", detail: String(err) },
      { status: 500 },
    );
  }
}
