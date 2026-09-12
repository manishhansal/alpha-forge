/**
 * GET /api/in/historical-data/gaps
 *
 * Returns detected data gaps with their recovery status and classification.
 * Reads from the live DataGap table.
 *
 * Query params:
 *   symbol    — filter by NSE symbol
 *   timeframe — filter by interval
 *   status    — filter by recovery status (PENDING | RECOVERED | UNRESOLVED)
 *   limit     — max results (default 100)
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
  const status    = params.get("status") ?? undefined;
  const limit     = Math.min(parseInt(params.get("limit") ?? "100"), 500);

  if (timeframe === "3m") {
    return NextResponse.json(
      { error: "3m is not a supported interval (permanently removed V8)", gaps: [] },
      { status: 400 }
    );
  }
  if (timeframe && !isSupportedInterval(timeframe)) {
    return NextResponse.json({ error: `Unsupported interval: ${timeframe}` }, { status: 400 });
  }

  try {
    const prisma = getPrisma();

    const where = {
      ...(symbol ? { instrumentId: symbol } : {}),
      ...(timeframe ? { intervalStr: timeframe } : {}),
      ...(status ? { recoveryStatus: status.toUpperCase() } : {}),
      // Never return legacy 3m gaps as "current" data gaps
      NOT: { intervalStr: "3m" },
    };

    const [gaps, summary] = await Promise.all([
      prisma.dataGap.findMany({
        where,
        orderBy: { detectedAt: "desc" },
        take: limit,
        select: {
          id: true, instrumentId: true, exchange: true, intervalStr: true,
          gapStart: true, gapEnd: true, durationSec: true,
          recoveryStatus: true, recoveryAttempts: true,
          expectedProvider: true, recoveryProvider: true,
          detectedAt: true, recoveredAt: true, reason: true,
        },
      }),
      prisma.dataGap.groupBy({
        by: ["recoveryStatus"],
        where: { NOT: { intervalStr: "3m" } },
        _count: { _all: true },
      }),
    ]);

    const gapsWithClassification = gaps.map((g) => ({
      ...g,
      gapStartIso: new Date(g.gapStart * 1000).toISOString(),
      gapEndIso: new Date(g.gapEnd * 1000).toISOString(),
      // Classify based on recovery status
      classification:
        g.recoveryStatus === "RECOVERED" ? "RECOVERED"
        : g.recoveryStatus === "MARKET_CLOSED" ? "MARKET_CLOSED"
        : g.recoveryStatus === "PENDING" ? "ACTUAL_DATA_GAP"
        : g.recoveryStatus === "UNRESOLVED" ? "UNRECOVERABLE"
        : g.recoveryStatus,
    }));

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      totalReturned: gapsWithClassification.length,
      summary: Object.fromEntries(summary.map((s) => [s.recoveryStatus, s._count._all])),
      filters: { symbol, timeframe, status },
      note3m: "3m gaps are excluded from this endpoint. 3m is permanently out of scope (V8).",
      gaps: gapsWithClassification,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Gaps query failed", detail: (err as Error).message },
      { status: 500 }
    );
  }
}
