import { NextResponse } from "next/server";

import { getIndiaExpiryTrades } from "@/features/india/expiry-trades/builder";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/in/expiry-trades — expiry-day index plays.
 *
 * On a NIFTY (Tue) / SENSEX (Thu) expiry day returns the Gamma Blast and
 * Hero Zero option-buying setups for the expiring index(es). On every other
 * day returns `isExpiryDay: false` with no index blocks.
 */
export async function GET() {
  try {
    const data = await getIndiaExpiryTrades();
    return NextResponse.json(data, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    console.error("[/api/in/expiry-trades] error:", err);
    return NextResponse.json(
      {
        error: true,
        code: "INDIA_EXPIRY_TRADES_FAILED",
        message: (err as Error).message,
      },
      { status: 502 },
    );
  }
}
