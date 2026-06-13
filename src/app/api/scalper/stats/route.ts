import { NextResponse } from "next/server";

import { getJournalStats } from "@/features/scalping/journal";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const stats = await getJournalStats();
    return NextResponse.json(stats);
  } catch (err) {
    console.error("[/api/scalper/stats] error:", err);
    return NextResponse.json(
      { error: true, code: "STATS_FAILED", message: (err as Error).message },
      { status: 500 },
    );
  }
}
