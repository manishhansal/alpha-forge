/**
 * GET /api/v1/market/quote?symbol=RELIANCE
 *
 * Canonical v1 single-symbol live quote endpoint.
 * Routes through DataServiceClient → ProviderRegistry → withFailover.
 *
 * Query params:
 *   symbol   (required) — NSE trading symbol or index (e.g. "RELIANCE", "NIFTY")
 *
 * Response: { data: MDQuote | null, metadata: { requestedAt, symbol } }
 */

import { NextResponse } from "next/server";
import { DataServiceClient } from "@/lib/data-service/client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const symbol = searchParams.get("symbol")?.trim();

  if (!symbol) {
    return NextResponse.json(
      { error: "symbol is required", code: "MISSING_PARAM" },
      { status: 400 },
    );
  }

  const requestedAt = new Date().toISOString();

  try {
    const quote = await DataServiceClient.market.quote(symbol);
    return NextResponse.json({
      data: quote,
      metadata: {
        symbol,
        requestedAt,
        provider: quote?.provider ?? null,
        fetchedAt: quote?.fetchedAt ?? requestedAt,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: msg, code: "PROVIDER_ERROR", symbol, requestedAt },
      { status: 502 },
    );
  }
}
