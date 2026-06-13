import { NextResponse } from "next/server";

import { CACHE_TTL_SECONDS } from "@/lib/constants";
import { getFuturesOverview } from "@/features/futures/aggregate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const data = await getFuturesOverview();
    return NextResponse.json(data, {
      headers: {
        "Cache-Control": `public, s-maxage=${CACHE_TTL_SECONDS.futuresOverview}, stale-while-revalidate=60`,
      },
    });
  } catch (err) {
    console.error("[/api/futures/overview] error:", err);
    return NextResponse.json(
      { error: true, code: "FUTURES_FAILED", message: (err as Error).message },
      { status: 502 },
    );
  }
}
