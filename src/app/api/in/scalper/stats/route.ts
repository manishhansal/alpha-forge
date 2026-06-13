import { NextResponse } from "next/server";

import { getIndiaJournalStats } from "@/features/india/scalping/journal";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/in/scalper/stats — India-scoped journal aggregates. */
export async function GET() {
  try {
    const stats = await getIndiaJournalStats();
    return NextResponse.json(stats);
  } catch (err) {
    console.error("[/api/in/scalper/stats] error:", err);
    return NextResponse.json(
      {
        error: true,
        code: "INDIA_STATS_FAILED",
        message: (err as Error).message,
      },
      { status: 500 },
    );
  }
}
