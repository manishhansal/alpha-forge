import { NextResponse } from "next/server";
import { getQuote, DataServiceUnavailableError } from "@/lib/data-service/client";
import { getSimulatedNiftyBias } from "@/lib/data-service/simulated-india";

export const dynamic = "force-dynamic";

/**
 * GET /api/in/nifty-bias
 *
 * Returns the NIFTY 50 bias (BULLISH/BEARISH) via data-service2.0.
 * Falls back to simulated data when the data service is unavailable.
 */
export async function GET() {
  try {
    const quote = await getQuote("NIFTY", "NSE");
    const ltp = quote.ltp ?? 0;

    // If the quote came back but has no session data (null changePct),
    // fall back to simulated so the UI shows a meaningful bias.
    if (!ltp || quote.changePct == null) {
      const sim = getSimulatedNiftyBias();
      return NextResponse.json(sim, {
        headers: { "Cache-Control": "public, s-maxage=10, stale-while-revalidate=20" },
      });
    }

    const bias = quote.changePct > 0 ? "BULLISH" : "BEARISH";
    return NextResponse.json(
      { bias, price: Number(ltp).toFixed(2) },
      { headers: { "Cache-Control": "public, s-maxage=10, stale-while-revalidate=20" } },
    );
  } catch (err) {
    if (err instanceof DataServiceUnavailableError) {
      // Return simulated bias so the UI shows something useful.
      const sim = getSimulatedNiftyBias();
      return NextResponse.json(sim, {
        headers: { "Cache-Control": "public, s-maxage=10, stale-while-revalidate=20" },
      });
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Nifty bias API error:", msg);
    const sim = getSimulatedNiftyBias();
    return NextResponse.json(sim, {
      headers: { "Cache-Control": "public, s-maxage=5, stale-while-revalidate=10" },
    });
  }
}
