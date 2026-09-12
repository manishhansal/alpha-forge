/**
 * GET /api/in/historical-data/coverage
 *
 * Returns the historical data coverage matrix — computed from the live DB.
 * Never returns a cached or static report.
 *
 * Query params:
 *   symbol     — filter by NSE symbol (optional)
 *   timeframe  — filter by interval (optional, e.g. "1d", "5m")
 *   provider   — filter by provider (optional)
 *   status     — filter by quality status (optional)
 *
 * Response shape: CoverageMatrixResponse
 */

import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { getPrisma } from "@/lib/prisma";
import { buildCoverageMatrix } from "@/lib/market-data/services/coverage.service";
import { isSupportedInterval } from "@/lib/market-data/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const symbol    = params.get("symbol") ?? undefined;
  const timeframe = params.get("timeframe") ?? undefined;
  const provider  = params.get("provider") ?? undefined;
  const statusFilter = params.get("status") ?? undefined;

  // Reject 3m explicitly
  if (timeframe === "3m") {
    return NextResponse.json(
      {
        error: "Interval '3m' is not supported. It was permanently removed in V8.",
        supportedIntervals: ["1m","5m","10m","15m","30m","1h","1d","1w","1M"],
      },
      { status: 400 }
    );
  }
  if (timeframe && !isSupportedInterval(timeframe)) {
    return NextResponse.json(
      { error: `Unsupported interval '${timeframe}'`, supported: ["1m","5m","10m","15m","30m","1h","1d","1w","1M"] },
      { status: 400 }
    );
  }

  try {
    const prisma = getPrisma();
    const cells = await buildCoverageMatrix({
      instrumentId: symbol,
      interval: timeframe,
      prisma,
    });

    // Enrich with provenance data from V8 tables
    const provenance = await prisma.dataProvenance.findMany({
      where: {
        ...(symbol ? { instrumentId: symbol } : {}),
        ...(timeframe ? { intervalStr: timeframe } : {}),
        ...(provider ? { provider } : {}),
      },
      orderBy: { fetchedAt: "desc" },
      take: 1000,
    });

    // Build provenance map for enrichment
    const provMap = new Map<string, typeof provenance[0]>();
    for (const p of provenance) {
      const key = `${p.instrumentId}:${p.intervalStr}`;
      if (!provMap.has(key)) provMap.set(key, p);
    }

    // Quality scores
    const qualityScores = await prisma.dataQualityScore.findMany({
      where: {
        ...(symbol ? { instrumentId: symbol } : {}),
        ...(timeframe ? { intervalStr: timeframe } : {}),
      },
      orderBy: { computedAt: "desc" },
      take: 1000,
    });
    const qualityMap = new Map<string, typeof qualityScores[0]>();
    for (const q of qualityScores) {
      const key = `${q.instrumentId}:${q.intervalStr}:${q.sessionDate}`;
      if (!qualityMap.has(key)) qualityMap.set(key, q);
    }

    const enrichedCells = cells.map((cell) => {
      const pKey = `${cell.instrumentId}:${cell.interval}`;
      const prov = provMap.get(pKey);
      const coveragePct = cell.completeness != null
        ? Math.round(cell.completeness * 1000) / 10
        : null;

      return {
        symbol: cell.instrumentId,
        exchange: cell.exchange,
        timeframe: cell.interval,
        actualBars: cell.actualBars,
        expectedBars: cell.expectedBars,
        coveragePct,
        missingBars: cell.expectedBars != null ? cell.expectedBars - cell.actualBars : null,
        firstBar: cell.firstIso,
        lastBar: cell.lastIso,
        provider: prov?.provider ?? null,
        authenticated: prov?.authenticated ?? null,
        provenance: prov?.sourceType ?? null,
        dataTrustStatus: prov?.dataTrustStatus ?? "UNKNOWN",
        datasetVersion: prov?.datasetVersion ?? null,
        status: prov
          ? (prov.dataTrustStatus === "VERIFIED_RECONCILED" ? "VERIFIED"
            : prov.dataTrustStatus === "VERIFIED_SINGLE_SOURCE" ? "VERIFIED"
            : prov.dataTrustStatus === "DEGRADED" ? "DEGRADED"
            : coveragePct != null && coveragePct < 95 ? "PARTIAL"
            : "AVAILABLE")
          : "UNKNOWN",
      };
    });

    // Apply status filter if given
    const filtered = statusFilter
      ? enrichedCells.filter((c) => c.status === statusFilter.toUpperCase())
      : enrichedCells;

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      datasetVersion: new Date().toISOString().slice(0, 10) + "-v1",
      totalRows: filtered.length,
      filters: { symbol, timeframe, provider, status: statusFilter },
      cells: filtered,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Coverage query failed", detail: (err as Error).message },
      { status: 500 }
    );
  }
}
