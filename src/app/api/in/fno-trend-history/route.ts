import { NextResponse } from "next/server";
import { getFnoTrendHistory } from "@/features/india/fno-trend-history/service";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * GET /api/in/fno-trend-history?days=14&type=ALL
 *
 * Returns historical FnO Bullish/Bearish Trend Scanner results with outcomes.
 *   days  — number of past trading days (1–60, default 14)
 *   type  — "BULLISH" | "BEARISH" | "ALL" (default ALL)
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const daysParam = searchParams.get("days");
  const typeParam = searchParams.get("type") ?? "ALL";

  const days = daysParam ? Math.min(60, Math.max(1, Number(daysParam))) : 14;
  const scanType =
    typeParam === "BULLISH" ? "BULLISH"
    : typeParam === "BEARISH" ? "BEARISH"
    : "ALL";

  try {
    const data = await getFnoTrendHistory({ days, scanType: scanType as "BULLISH" | "BEARISH" | "ALL" });
    return NextResponse.json(data, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Query failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
