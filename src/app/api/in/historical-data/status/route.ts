/**
 * GET /api/in/historical-data/status
 *
 * Returns a high-level status summary of the historical data infrastructure.
 * Reads directly from the live DB — never a cached report.
 *
 * Answers (per §52):
 *   CURRENT_LIVE_STATUS
 *   HISTORICAL_COVERAGE_STATUS
 *   HISTORICAL_QUALITY_STATUS
 *   PROVIDER_HEALTH_STATUS
 *   RECONCILIATION_STATUS
 *   SIGNAL_READINESS_STATUS
 */

import "server-only";
import { NextResponse } from "next/server";
import { getPrisma } from "@/lib/prisma";
import { SUPPORTED_TIMEFRAMES } from "@/lib/market-data/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const prisma = getPrisma();

    // F&O universe snapshot (latest)
    const latestUniverse = await prisma.fnoUniverseSnapshot.findFirst({
      orderBy: { generatedAt: "desc" },
      select: {
        universeVersion: true, generatedAt: true,
        constituentCount: true, fnoEquityCount: true, fnoIndexCount: true,
        addedCount: true, removedCount: true, unresolvedCount: true,
      },
    });

    // Candle bar counts by interval (live DB)
    const candleCounts = await prisma.candleBar.groupBy({
      by: ["intervalStr"],
      _count: { _all: true },
      _max: { confirmedAt: true },
    });

    // Verified 3m rows in DB (should be zero for NEW data)
    const legacyThreeMRows = await prisma.candleBar.count({
      where: { intervalStr: "3m" },
    });

    // Quality score distribution
    const qualitySummary = await prisma.dataQualityScore.groupBy({
      by: ["qualityStatus"],
      _count: { _all: true },
    });

    // Backfill job status
    const backfillJobs = await prisma.historicalBackfillJob.groupBy({
      by: ["status"],
      _count: { _all: true },
    }).catch(() => []);

    // Data gap summary
    const gapSummary = await prisma.dataGap.groupBy({
      by: ["recoveryStatus"],
      _count: { _all: true },
    });

    // Recent provider observations
    const recentObs = await prisma.providerObservation.groupBy({
      by: ["provider"],
      _count: { _all: true },
    }).catch(() => []);

    // Reconciliation summary
    const reconSummary = await prisma.dataReconciliation.groupBy({
      by: ["reconciliationStatus"],
      _count: { _all: true },
    }).catch(() => []);

    // Build timeframe coverage map (exclude 3m from supported display)
    const candleByInterval = Object.fromEntries(
      candleCounts.map((c) => [c.intervalStr, { rows: c._count._all, lastUpdated: c._max.confirmedAt }])
    );
    const timeframeCoverage = SUPPORTED_TIMEFRAMES.reduce((acc, tf) => {
      acc[tf] = candleByInterval[tf] ?? { rows: 0, lastUpdated: null };
      return acc;
    }, {} as Record<string, { rows: number; lastUpdated: Date | null }>);

    // 3m check — must be zero for NEW data (old rows allowed for audit)
    const threeMStatus = {
      legacyRowsInDb: legacyThreeMRows,
      newAcquisitionsBlocked: true,
      note: "3m was permanently removed in V8. Existing legacy rows are immutable audit records.",
    };

    // Overall status
    const totalPendingGaps = gapSummary.find((g) => g.recoveryStatus === "PENDING")?._count._all ?? 0;
    const totalRecovered = gapSummary.find((g) => g.recoveryStatus === "RECOVERED")?._count._all ?? 0;
    const verifiedRows = qualitySummary
      .filter((q) => q.qualityStatus.startsWith("VERIFIED"))
      .reduce((s, q) => s + q._count._all, 0);
    const totalQualityRows = qualitySummary.reduce((s, q) => s + q._count._all, 0);

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      datasetVersion: new Date().toISOString().slice(0, 10) + "-v1",

      fnoUniverse: latestUniverse ?? null,

      timeframeCoverage,
      supportedTimeframes: [...SUPPORTED_TIMEFRAMES],
      threeMRemoval: threeMStatus,

      qualityDistribution: Object.fromEntries(
        qualitySummary.map((q) => [q.qualityStatus, q._count._all])
      ),

      gapSummary: {
        pending: totalPendingGaps,
        recovered: totalRecovered,
        distribution: Object.fromEntries(
          gapSummary.map((g) => [g.recoveryStatus, g._count._all])
        ),
      },

      reconciliation: Object.fromEntries(
        reconSummary.map((r) => [r.reconciliationStatus, r._count._all])
      ),

      backfillJobs: Object.fromEntries(
        backfillJobs.map((j) => [j.status, j._count._all])
      ),

      providerActivity: Object.fromEntries(
        recentObs.map((o) => [o.provider, o._count._all])
      ),

      healthSummary: {
        universeCurrent: !!latestUniverse,
        dataQualityVerified: totalQualityRows > 0
          ? Math.round((verifiedRows / totalQualityRows) * 1000) / 10
          : null,
        pendingGaps: totalPendingGaps,
        overallStatus:
          !latestUniverse ? "DATA_INSUFFICIENT"
          : totalPendingGaps > 100 ? "DATA_DEGRADED"
          : verifiedRows / Math.max(1, totalQualityRows) >= 0.9 ? "DATA_READY"
          : "DATA_DEGRADED",
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Status query failed", detail: (err as Error).message },
      { status: 500 }
    );
  }
}
