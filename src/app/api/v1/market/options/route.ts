/**
 * GET /api/v1/market/options?underlying=NIFTY[&expiry=2026-09-25]
 *
 * Canonical v1 option chain endpoint.
 * Routes: data-service → Angel One → Upstox  (Yahoo has NO option chain capability)
 *
 * Query params:
 *   underlying  (required) — NSE underlying (e.g. "NIFTY", "BANKNIFTY", "RELIANCE")
 *   expiry      (optional) — ISO-8601 date string; defaults to nearest upcoming expiry
 *
 * Response: { data: OptionChain, metadata: { underlying, expiry, requestedAt, marketStatus } }
 */

import { NextResponse } from "next/server";
import { DataServiceClient } from "@/lib/data-service/client";
import { isNseMarketOpenIST } from "@/lib/india/market-hours";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const underlying = searchParams.get("underlying")?.trim().toUpperCase();
  const expiry = searchParams.get("expiry")?.trim() ?? undefined;

  if (!underlying) {
    return NextResponse.json(
      { error: "underlying is required (e.g. NIFTY, BANKNIFTY, RELIANCE)", code: "MISSING_PARAM" },
      { status: 400 },
    );
  }

  const requestedAt = new Date().toISOString();
  const marketStatus = isNseMarketOpenIST(new Date()) ? "OPEN" : "CLOSED";

  try {
    const chain = await DataServiceClient.market.options(underlying, expiry);
    return NextResponse.json({
      data: chain,
      metadata: {
        underlying,
        expiry: chain.expiry,
        availableExpiries: chain.expiries,
        spot: chain.spot,
        provider: chain.provider,
        fetchedAt: chain.fetchedAt,
        requestedAt,
        marketStatus,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Distinguish market-closed from actual provider failure
    if (marketStatus === "CLOSED") {
      return NextResponse.json(
        {
          error: "Option chain unavailable — market is currently closed",
          code: "MARKET_CLOSED",
          underlying,
          marketStatus,
          requestedAt,
        },
        { status: 503 },
      );
    }
    return NextResponse.json(
      { error: msg, code: "PROVIDER_ERROR", underlying, requestedAt },
      { status: 502 },
    );
  }
}
