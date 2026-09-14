import { NextResponse } from "next/server";
import { getQuote, DataServiceUnavailableError } from "@/lib/data-service/client";

export const dynamic = "force-dynamic";

/**
 * GET /api/in/nifty-bias
 *
 * Returns the NIFTY 50 bias (BULLISH/BEARISH) via data-service2.0.
 * All market data flows exclusively through data-service2.0.
 */
export async function GET() {
  try {
    const quote = await getQuote("NIFTY", "NSE");
    const ltp = quote.ltp ?? 0;
    const bias =
      ltp && quote.changePct != null
        ? quote.changePct > 0
          ? "BULLISH"
          : "BEARISH"
        : "-";

    return NextResponse.json(
      { bias, price: ltp ? Number(ltp).toFixed(2) : "-" },
      { headers: { "Cache-Control": "public, s-maxage=10, stale-while-revalidate=20" } },
    );
  } catch (err) {
    if (err instanceof DataServiceUnavailableError) {
      return NextResponse.json({ bias: "DATA_SERVICE_UNAVAILABLE", price: "-" });
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Nifty bias API error:", msg);
    return NextResponse.json({ bias: "ERROR", price: "-" });
  }
}
