import { NextResponse } from "next/server";
import { cache } from "@/services/india/cache";
import { runScanner } from "@/services/india/scanner/engine";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * GET /api/in/fno-bearish-trend?limit=50[&bust=1]
 *
 * Returns NSE F&O stocks passing the full 14-condition daily bearish trend
 * screener (MA + ADX + MACD) — the exact bearish mirror of the bullish scanner.
 * Pass `bust=1` to invalidate the 5-minute cache and force a fresh scan.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const limit = Math.min(100, Math.max(5, Number(searchParams.get("limit") ?? 50)));
  const bust  = searchParams.get("bust") === "1";

  if (bust) {
    await cache.invalidate("scanner:fno-bearish-trend");
  }

  try {
    const result = await runScanner("fno-bearish-trend", limit);
    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Scanner failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
