import { NextResponse } from "next/server";
import {
  getAutoTradingAnalytics,
  type AnalyticsRange,
} from "@/features/india/paper-trading/auto-trader";

export const dynamic  = "force-dynamic";
export const revalidate = 0;

const VALID_RANGES: AnalyticsRange[] = ["1d", "7d", "15d", "30d", "6mo", "1y", "all"];

/**
 * GET /api/in/paper-trade/analytics?range=30d
 *
 * Returns auto paper-trading analytics aggregated over the requested range.
 * `range` must be one of: 1d | 7d | 15d | 30d | 6mo | 1y | all
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const rangeParam = (searchParams.get("range") ?? "30d") as AnalyticsRange;
  const range      = VALID_RANGES.includes(rangeParam) ? rangeParam : "30d";

  try {
    const data = await getAutoTradingAnalytics(range);
    return NextResponse.json(data, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Analytics failed" },
      { status: 502 },
    );
  }
}
