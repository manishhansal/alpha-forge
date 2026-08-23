import { NextResponse } from "next/server";

import { getIndiaStrategyPnlSeries } from "@/features/india/scalping/journal";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * GET /api/in/paper-trade/strategy-pnl
 *
 * Returns per-strategy cumulative ₹ P&L time-series data for the
 * performance breakdown lightweight-charts line chart on the paper
 * trading page.
 *
 * Response shape:
 * ```json
 * {
 *   "MOMENTUM":  [{ "date": "2025-01-15", "cumulativePnl": 1200 }, ...],
 *   "BREAKOUT":  [...],
 *   ...
 * }
 * ```
 */
export async function GET() {
  try {
    const data = await getIndiaStrategyPnlSeries();
    return NextResponse.json(data, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to load strategy P&L" },
      { status: 502 },
    );
  }
}
