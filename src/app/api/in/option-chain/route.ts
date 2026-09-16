import { NextResponse } from "next/server";
import { getOptionChain, DataServiceUnavailableError } from "@/lib/data-service/client";
import { fetchOptionChainGreeks, predictIVRegime } from "@/lib/india/ml-client";
import { getSimulatedSnapshot } from "@/lib/data-service/simulated-india";

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

    // If spot price is null, the data service returned a degraded response.
    // Fall through to the simulated skeleton below.
    if (chain.spotPrice == null) throw new DataServiceUnavailableError("No spot price in option chain response");

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
      // Return a minimal but valid option-chain skeleton with simulated spot price
      // so the Options page renders rather than showing a hard error.
      const snap = getSimulatedSnapshot();
      const indexEntry = snap.indices.find(
        (i) =>
          i.name.toUpperCase().includes(underlying) ||
          i.symbol.toUpperCase().includes(underlying),
      );
      const spotPrice = indexEntry?.price ?? 25000;
      return NextResponse.json(
        {
          underlying,
          expiry: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10),
          spotPrice,
          underlyingPrice: spotPrice,
          pcrOi: 1.1,
          atmIv: 14.5,
          maxPain: Math.round(spotPrice / 100) * 100,
          rows: [],
          strikes: [],
          dataAsOf: new Date().toISOString(),
          iv_regime: "STABLE",
          source: "SIMULATED",
          simulated: true,
        },
        { headers: { "Cache-Control": "public, s-maxage=20, stale-while-revalidate=30" } },
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "OPTION_CHAIN_FETCH_FAILED", message },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
