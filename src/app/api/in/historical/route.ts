/**
 * GET /api/in/historical?symbol=RELIANCE&interval=1d&from=...&to=...
 *
 * Returns historical OHLCV candles from data-service2.0.
 * All market data flows exclusively through data-service2.0.
 */
import { NextResponse } from "next/server";
import { getHistorical, DataServiceUnavailableError } from "@/lib/data-service/client";
import { isSupportedInterval } from "@/lib/market-data/types";
import type { Interval } from "@/types/india";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** GET /api/in/historical?symbol=RELIANCE&interval=1d&from=2025-01-01&to=2026-01-01 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const symbol = searchParams.get("symbol") ?? "";
  const interval = (searchParams.get("interval") ?? "1d") as Interval;
  const from = searchParams.get("from") ?? undefined;
  const to = searchParams.get("to") ?? undefined;
  const exchange = searchParams.get("exchange") ?? "NSE";

  if (!symbol) {
    return NextResponse.json({ error: "symbol is required" }, { status: 400 });
  }
  if (!isSupportedInterval(interval)) {
    return NextResponse.json(
      { error: `Invalid interval "${interval}"`, valid: ["1m", "5m", "10m", "15m", "30m", "1h", "1d", "1w", "1M"] },
      { status: 400 },
    );
  }

  try {
    const candles = await getHistorical({ symbol, interval, from, to, exchange });
    return NextResponse.json(
      { symbol, interval, exchange, from, to, candles, source: "data-service2" },
      { headers: { "Cache-Control": ["1d","1w","1M"].includes(interval) ? "public, s-maxage=300, stale-while-revalidate=600" : "public, s-maxage=60, stale-while-revalidate=120" } },
    );
  } catch (err) {
    if (err instanceof DataServiceUnavailableError) {
      return NextResponse.json(
        { error: "DATA_SERVICE_UNAVAILABLE", message: err.message },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
