import { NextResponse } from "next/server";

import { getIndiaDailyPicks } from "@/features/india/daily-picks/builder";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/in/daily-picks — today's Daily Picks board.
 *
 * Returns the top three F&O signals per bucket (Momentum / Scalping /
 * Potential), frozen for the trading day and live-tracked against the latest
 * mark (P&L, progress-to-target, TARGET_HIT / STOP_HIT).
 */
export async function GET() {
  try {
    const data = await getIndiaDailyPicks();
    return NextResponse.json(data, {
      headers: { "Cache-Control": "no-store" },
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
