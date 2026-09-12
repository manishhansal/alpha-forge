/**
 * GET /api/v1/market/universe/fno
 *
 * Returns the current NSE F&O eligible equity universe.
 * Only CURRENTLY LISTED F&O equities — no delisted, no historical.
 *
 * Response: { data: Instrument[], metadata: { count, source, requestedAt } }
 */

import { NextResponse } from "next/server";
import { DataServiceClient } from "@/lib/data-service/client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const requestedAt = new Date().toISOString();

  try {
    const universe = await DataServiceClient.universe.fno();
    return NextResponse.json({
      data: universe,
      metadata: {
        count: universe.length,
        source: "instrument_master",
        description: "Currently listed NSE F&O eligible equities",
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
