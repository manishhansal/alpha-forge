/**
 * GET /api/v1/market/quotes?symbols=RELIANCE,INFY,NIFTY
 *
 * Canonical v1 batch live-quotes endpoint.
 * Routes through DataServiceClient → ProviderRegistry → withFailover.
 *
 * Query params:
 *   symbols  (required) — comma-separated NSE symbols, max 100
 *
 * Response: { data: Array<MDQuote | null>, metadata: { symbols, count, requestedAt } }
 */

import { NextResponse } from "next/server";
import { DataServiceClient } from "@/lib/data-service/client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_SYMBOLS = 100;

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const raw = searchParams.get("symbols") ?? "";
  const symbols = raw.split(",").map((s) => s.trim()).filter(Boolean);

  if (symbols.length === 0) {
    return NextResponse.json(
      { error: "symbols is required (comma-separated)", code: "MISSING_PARAM" },
      { status: 400 },
    );
  }

  if (symbols.length > MAX_SYMBOLS) {
    return NextResponse.json(
      { error: `Too many symbols — max ${MAX_SYMBOLS}`, code: "TOO_MANY_SYMBOLS" },
      { status: 400 },
    );
  }

  const requestedAt = new Date().toISOString();

  try {
    const quotes = await DataServiceClient.market.quotes(symbols);
    return NextResponse.json({
      data: quotes,
      metadata: {
        symbols,
        count: quotes.length,
        requestedAt,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: msg, code: "PROVIDER_ERROR", requestedAt },
      { status: 502 },
    );
  }
}
