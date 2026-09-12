/**
 * GET /api/in/historical-data/reconciliation
 *
 * Returns multi-source reconciliation records and statistics.
 * Answers §44: "source comparison" reports.
 */

import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { getPrisma } from "@/lib/prisma";
import { isSupportedInterval } from "@/lib/market-data/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const symbol    = params.get("symbol") ?? undefined;
  const timeframe = params.get("timeframe") ?? undefined;
  const limit     = Math.min(parseInt(params.get("limit") ?? "100"), 500);

  if (timeframe === "3m") {
    return NextResponse.json({ error: "3m not supported (V8 removal)" }, { status: 400 });
  }

  try {
    const prisma = getPrisma();

    const [records, summary] = await Promise.all([
      prisma.dataReconciliation.findMany({
        where: {
          ...(symbol ? { instrumentId: symbol } : {}),
          ...(timeframe ? { intervalStr: timeframe } : {}),
        },
        orderBy: { reconciledAt: "desc" },
        take: limit,
      }).catch(() => []),
      prisma.dataReconciliation.groupBy({
        by: ["reconciliationStatus", "providerA", "providerB"],
        _count: { _all: true },
        _avg: { maxOhlcDiff: true },
      }).catch(() => []),
    ]);

    // Compute match statistics
    const totalRecords = summary.reduce((s, r) => s + r._count._all, 0);
    const matched = summary
      .filter((r) => ["MATCHED", "WITHIN_TOLERANCE"].includes(r.reconciliationStatus))
      .reduce((s, r) => s + r._count._all, 0);
    const matchRate = totalRecords > 0 ? Math.round((matched / totalRecords) * 1000) / 10 : null;

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      totalRecords: records.length,
      statistics: {
        totalCompared: totalRecords,
        matched,
        matchRatePct: matchRate,
        distribution: Object.fromEntries(
          summary.map((r) => [r.reconciliationStatus, { count: r._count._all, avgDiff: r._avg.maxOhlcDiff }])
        ),
        byProviderPair: summary.map((r) => ({
          providerA: r.providerA,
          providerB: r.providerB,
          status: r.reconciliationStatus,
          count: r._count._all,
          avgMaxOhlcDiff: r._avg.maxOhlcDiff,
        })),
      },
      records: records.map((r) => ({
        ...r,
        timeIso: new Date(r.time * 1000).toISOString(),
      })),
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Reconciliation query failed", detail: (err as Error).message },
      { status: 500 }
    );
  }
}
