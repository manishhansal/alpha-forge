/**
 * GET /api/in/historical-data/universe
 *
 * Returns the current F&O universe from data-service2.0.
 *
 * The `FnoUniverseSnapshot` and `FnoUniverseEntry` tables were dropped from
 * the AlphaForge database as part of the data-service2.0 centralization
 * refactor (Phase 2). The canonical F&O universe is now owned and served
 * exclusively by data-service2.0.
 *
 * Query params:
 *   version  — specific snapshot version (passed through to data-service2.0)
 *   status   — filter by lifecycle status (ACTIVE | ADDED | REMOVED)
 */

import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { getFNOUniverse } from "@/lib/data-service/client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const statusFilter = params.get("status") ?? undefined;

  try {
    const constituents = await getFNOUniverse();

    // Apply optional lifecycle status filter
    const filtered = statusFilter
      ? (constituents as Array<Record<string, unknown>>).filter(
          (c) =>
            typeof c.lifecycleStatus === "string" &&
            c.lifecycleStatus === statusFilter.toUpperCase()
        )
      : (constituents as Array<Record<string, unknown>>);

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      source: "data-service2.0",
      note: "F&O universe is now owned by data-service2.0. FnoUniverseSnapshot and FnoUniverseEntry tables have been removed from the AlphaForge database.",
      universe: {
        constituentCount: constituents.length,
        filteredCount: filtered.length,
      },
      constituents: filtered,
      totalReturned: filtered.length,
      filters: { status: statusFilter ?? null },
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: "Universe query failed",
        detail: (err as Error).message,
        hint: "Ensure data-service2.0 is running and DATA_SERVICE_2_URL is configured.",
      },
      { status: 502 }
    );
  }
}
