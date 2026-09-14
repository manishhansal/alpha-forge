import { NextResponse } from "next/server";
import { getOptionChain, DataServiceUnavailableError } from "@/lib/data-service/client";
import { fetchOptionChainGreeks, predictIVRegime } from "@/lib/india/ml-client";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * GET /api/in/option-chain?symbol=NIFTY&expiry=YYYY-MM-DD
 *
 * Returns the live option chain from data-service2.0.
 * All market data flows exclusively through data-service2.0.
 * No provider fallback — if data-service2.0 is unavailable, returns 503.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const underlying = (searchParams.get("symbol") ?? "NIFTY").toUpperCase();
  const expiry = searchParams.get("expiry") ?? undefined;

  try {
    const chain = await getOptionChain(underlying, expiry);

    // Enrich with ML greeks when available (best-effort)
    let enrichedRows = chain.rows;
    let iv_regime: string | null = null;

    try {
      const mlGreeks = await fetchOptionChainGreeks({
        chain: chain.rows,
        spot: chain.spotPrice ?? 0,
        india_vix: 15.0,
        expiry_dt: chain.expiry,
      });
      if (Array.isArray(mlGreeks) && mlGreeks.length > 0) {
        enrichedRows = mlGreeks as typeof chain.rows;
      }
    } catch {
      // ML enrichment is best-effort; use original rows on failure
    }

    try {
      const atm_iv = chain.atmIv ?? 0;
      const pcr = chain.pcrOi ?? 1;
      const ivResult = await predictIVRegime({
        data: [[atm_iv, pcr, 0, 15, 0]],
      });
      const raw = ivResult?.iv_regime ?? null;
      if (raw === "CRUSH" || raw === "STABLE" || raw === "SPIKE") {
        iv_regime = raw;
      }
    } catch {
      // IV regime is best-effort
    }

    return NextResponse.json(
      {
        underlying: chain.underlying,
        expiry: chain.expiry,
        spotPrice: chain.spotPrice,
        pcrOi: chain.pcrOi,
        atmIv: chain.atmIv,
        maxPain: chain.maxPain,
        rows: enrichedRows,
        // Backward-compat aliases
        strikes: enrichedRows,
        underlyingPrice: chain.spotPrice,
        dataAsOf: chain.dataAsOf,
        iv_regime,
        source: "data-service2",
      },
      { headers: { "Cache-Control": "public, s-maxage=20, stale-while-revalidate=30" } },
    );
  } catch (err) {
    if (err instanceof DataServiceUnavailableError) {
      return NextResponse.json(
        { error: "DATA_SERVICE_UNAVAILABLE", message: err.message },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "OPTION_CHAIN_FETCH_FAILED", message },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
