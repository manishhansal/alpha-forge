/**
 * GET /api/in/opportunity-engine/attribution
 *
 * Returns performance attribution report decomposing P&L by:
 *   - Strategy selection
 *   - Regime attribution
 *   - Entry timing (MFE/MAE analysis)
 *   - Exit attribution
 *   - ML contribution
 *   - Cost drag
 *
 * Query params:
 *   days — lookback window (default: 30)
 */

import { NextResponse, type NextRequest } from "next/server";
import { getPrisma } from "@/lib/prisma";
import {
  buildPerformanceAttribution,
  analyzeMFEMAE,
  type AttributedTrade,
} from "@/lib/opportunity-engine";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const days = Math.min(365, Math.max(1, Number(req.nextUrl.searchParams.get("days") ?? "30") || 30));

  try {
    const db = getPrisma();
    const since = new Date(Date.now() - days * 86_400_000);

    const rawTrades = await db.paperTrade.findMany({
      where: {
        source: { startsWith: "in:" },
        status: { in: ["WIN", "LOSS", "EXPIRED"] },
        openedAt: { gte: since },
        pnlPct: { not: null },
        closedAt: { not: null },
      },
      select: {
        id: true,
        source: true,
        symbol: true,
        direction: true,
        entry: true,
        exitPrice: true,
        stopLoss: true,
        target: true,
        notional: true,
        status: true,
        pnlPct: true,
        pnlUsd: true,
        meta: true,
        openedAt: true,
        closedAt: true,
      },
    });

    // Map to AttributedTrade
    const attributed: AttributedTrade[] = rawTrades.map(t => {
      const meta = (t.meta ?? {}) as Record<string, unknown>;
      const strategyId = (t.source.split(":")[1] ?? "UNKNOWN").toUpperCase();
      const won = t.status === "WIN";
      const pnlPct = t.pnlPct ?? 0;
      const pnlINR = t.pnlUsd ?? 0; // pnlUsd is actually INR in paper trades
      const exitReason: AttributedTrade["exitReason"] =
        t.status === "WIN" ? "TARGET" :
        t.status === "LOSS" ? "STOP" : "EOD";
      const holdMinutes = t.closedAt && t.openedAt
        ? (t.closedAt.getTime() - t.openedAt.getTime()) / 60000
        : null;

      return {
        tradeId: t.id,
        strategyId,
        instrument: t.symbol,
        direction: t.direction,
        entry: t.entry,
        exit: t.exitPrice ?? t.entry,
        stopLoss: t.stopLoss,
        target1: t.target,
        target2: t.target,
        positionSizeINR: t.notional,
        won,
        pnlPct,
        pnlINR,
        exitReason,
        mfePct: null, // not tracked in current schema
        maePct: null,
        timeToMfe: holdMinutes,
        timeToMae: null,
        mfeToTargetCapturePct: won ? Math.min(1, pnlPct / Math.abs(t.target - t.entry) * t.entry / 100) : null,
        qualityScore: typeof meta.score === "number" ? meta.score : 0.5,
        netEV: typeof meta.netEV === "number" ? meta.netEV : 0,
        regime: typeof meta.regime === "string" ? meta.regime : "UNKNOWN",
        mlProbability: null,
        hadMLBoost: false,
        estimatedCostsPct: 0.15, // conservative estimate (3 bps × 5 cost components)
        estimatedSlippagePct: 0.05,
        openedAt: t.openedAt.getTime(),
        closedAt: t.closedAt?.getTime() ?? t.openedAt.getTime(),
      };
    });

    const attribution = buildPerformanceAttribution(
      `Last ${days} days`,
      attributed,
    );

    const mfeMae = analyzeMFEMAE(attributed);

    return NextResponse.json({
      windowDays: days,
      totalTrades: attributed.length,
      attribution,
      mfeMae,
      generatedAt: Date.now(),
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Attribution computation failed", detail: String(err) },
      { status: 500 },
    );
  }
}
