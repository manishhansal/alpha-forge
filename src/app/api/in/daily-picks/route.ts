import { NextResponse } from "next/server";

import { getIndiaDailyPicks } from "@/features/india/daily-picks/builder";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/in/daily-picks — today's Daily Picks board.
 *
 * Returns the top three F&O signals per bucket (Momentum / Short Setups /
 * Scalping / Potential), frozen for the trading day and live-tracked against
 * the latest mark (P&L, progress-to-target, TARGET_HIT / STOP_HIT).
 */
export async function GET() {
  try {
    const data = await getIndiaDailyPicks();
    return NextResponse.json(data, {
      // 10s shared-cache: concurrent browser tabs / CDN nodes reuse one
      // server-side execution per 10s window. stale-while-revalidate lets
      // the client show the previous result instantly while a fresh one
      // is fetched in the background.
      headers: { "Cache-Control": "public, s-maxage=10, stale-while-revalidate=20" },
    });
  } catch (err) {
    console.error("[/api/in/daily-picks] error:", err);
    return NextResponse.json(
      {
        error: true,
        code: "INDIA_DAILY_PICKS_FAILED",
        message: (err as Error).message,
      },
      { status: 502 },
    );
  }
}
