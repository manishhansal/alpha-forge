import { NextResponse } from "next/server";

import { CACHE_TTL_SECONDS } from "@/lib/constants";
import { getMarketOverview } from "@/features/overview/fetch-overview";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const data = await getMarketOverview();
    return NextResponse.json(data, {
      headers: {
        "Cache-Control": `public, s-maxage=${CACHE_TTL_SECONDS.marketOverview}, stale-while-revalidate=60`,
      },
    });
  } catch (err) {
    console.error("[/api/market/overview] error:", err);
    return NextResponse.json(
      {
        error: true,
        code: "OVERVIEW_FAILED",
        message: (err as Error).message,
      },
      { status: 502 },
    );
  }
}
