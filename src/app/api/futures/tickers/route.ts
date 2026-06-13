import { NextResponse } from "next/server";

import { getFuturesTickers } from "@/features/futures/aggregate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Lightweight 24h ticker poll for the futures page price bar. Single REST
 * round-trip to the active broker (~200ms on Delta India). Designed for a
 * 1-second client refetch (`setInterval` in `<FuturesTickerBar />`); we set
 * `Cache-Control: no-store` so every request hits the handler and returns a
 * fresh Delta ticker snapshot.
 */
export async function GET() {
  try {
    const tickers = await getFuturesTickers();
    return NextResponse.json(
      { generatedAt: Date.now(), tickers },
      {
        // No CDN/edge caching — the route is called once per second per
        // client and we want each request to hit our handler so it returns
        // a fresh Delta ticker snapshot. `Cache-Control: no-store` is
        // explicit so any intermediate proxy can't serve a stale copy.
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch (err) {
    console.error("[/api/futures/tickers] error:", err);
    return NextResponse.json(
      { error: true, code: "TICKERS_FAILED", message: (err as Error).message },
      { status: 502 },
    );
  }
}
