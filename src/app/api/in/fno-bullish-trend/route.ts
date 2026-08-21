import { NextResponse } from "next/server";
import { runScanner } from "@/services/india/scanner/engine";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * GET /api/in/fno-bullish-trend?limit=50
 *
 * Returns NSE F&O stocks passing the full 14-condition daily bullish trend
 * screener (MA + ADX + MACD), mirroring the Chartink screener at:
 * https://chartink.com/screener/daily-fno-stocks-bullish-trend-scanner-moving-average-adx-macd-3
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const limit = Math.min(100, Math.max(5, Number(searchParams.get("limit") ?? 50)));

  try {
    const result = await runScanner("fno-bullish-trend", limit);
    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Scanner failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
