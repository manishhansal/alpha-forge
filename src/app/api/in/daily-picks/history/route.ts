import { NextResponse } from "next/server";

import { getIndiaDailyPicksHistory } from "@/features/india/daily-picks/builder";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/in/daily-picks/history?days=14 — past trading days' Daily Picks
 * with their final outcomes (TARGET_HIT / STOP_HIT / OPEN). Today is excluded
 * (it lives on the live board). `days` is clamped to [1, 60].
 */
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const daysParam = searchParams.get("days");
    const days =
      daysParam != null && daysParam !== "" && Number.isFinite(Number(daysParam))
        ? Number(daysParam)
        : undefined;
    const data = await getIndiaDailyPicksHistory({ days });
    return NextResponse.json(data, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    console.error("[/api/in/daily-picks/history] error:", err);
    return NextResponse.json(
      {
        error: true,
        code: "INDIA_DAILY_PICKS_HISTORY_FAILED",
        message: (err as Error).message,
      },
      { status: 502 },
    );
  }
}
