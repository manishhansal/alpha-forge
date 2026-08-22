import { NextResponse } from "next/server";
import { cache } from "@/services/india/cache";
import { runScanner } from "@/services/india/scanner/engine";
import { snapshotFnoTrendScan } from "@/features/india/fno-trend-history/service";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * GET /api/in/fno-bullish-trend?limit=50[&bust=1]
 *
 * Returns NSE F&O stocks passing the full 14-condition daily bullish trend
 * screener (MA + ADX + MACD). Results are persisted to FnoTrendScan once
 * per IST trading day so the board builds a track record.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const limit = Math.min(100, Math.max(5, Number(searchParams.get("limit") ?? 50)));
  const bust = searchParams.get("bust") === "1";

  if (bust) {
    await cache.invalidate("scanner:fno-bullish-trend");
  }

  try {
    const result = await runScanner("fno-bullish-trend", limit);

    // Persist today's results (fail-soft — snapshot failure never blocks the response)
    if (result.hits.length > 0) {
      void snapshotFnoTrendScan(result.hits, "BULLISH").catch(() => null);
    }

    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Scanner failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
