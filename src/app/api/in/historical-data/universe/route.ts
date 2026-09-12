/**
 * GET /api/in/historical-data/universe
 *
 * Returns the current F&O universe snapshot and constituent details.
 * Reads from the live FnoUniverseSnapshot table.
 *
 * Query params:
 *   version  — specific snapshot version (default: latest)
 *   status   — filter by lifecycle status (ACTIVE | ADDED | REMOVED)
 */

import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { getPrisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const version      = params.get("version") ?? undefined;
  const statusFilter = params.get("status") ?? undefined;

  try {
    const prisma = getPrisma();

    const snapshot = version
      ? await prisma.fnoUniverseSnapshot.findUnique({
          where: { universeVersion: version },
          include: { constituents: true },
        })
      : await prisma.fnoUniverseSnapshot.findFirst({
          orderBy: { generatedAt: "desc" },
          include: { constituents: true },
        });

    if (!snapshot) {
      return NextResponse.json({
        error: "No F&O universe snapshot found. Run 'data:refresh-universe' to generate one.",
        hint: "npm run data:refresh-universe",
      }, { status: 404 });
    }

    const constituents = statusFilter
      ? snapshot.constituents.filter((c) => c.lifecycleStatus === statusFilter.toUpperCase())
      : snapshot.constituents;

    // Historical snapshots list (versions only)
    const allVersions = await prisma.fnoUniverseSnapshot.findMany({
      orderBy: { generatedAt: "desc" },
      take: 10,
      select: { universeVersion: true, generatedAt: true, constituentCount: true },
    });

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      universe: {
        version: snapshot.universeVersion,
        generatedAt: snapshot.generatedAt,
        effectiveFrom: snapshot.effectiveFrom,
        effectiveTo: snapshot.effectiveTo,
        sourceProvider: snapshot.sourceProvider,
        checksum: snapshot.checksum,
        constituentCount: snapshot.constituentCount,
        fnoEquityCount: snapshot.fnoEquityCount,
        fnoIndexCount: snapshot.fnoIndexCount,
        addedCount: snapshot.addedCount,
        removedCount: snapshot.removedCount,
        suspendedCount: snapshot.suspendedCount,
        unresolvedCount: snapshot.unresolvedCount,
      },
      constituents: constituents.map((c) => ({
        symbol: c.symbol,
        exchange: c.exchange,
        isin: c.isin,
        instrumentType: c.instrumentType,
        angelToken: c.angelToken,
        angelSymbol: c.angelSymbol,
        upstoxKey: c.upstoxKey,
        upstoxSymbol: c.upstoxSymbol,
        lifecycleStatus: c.lifecycleStatus,
        fnoEligible: c.fnoEligible,
        firstSeen: c.firstSeen,
        lastSeen: c.lastSeen,
      })),
      totalReturned: constituents.length,
      filters: { status: statusFilter },
      recentSnapshots: allVersions,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Universe query failed", detail: (err as Error).message },
      { status: 500 }
    );
  }
}
