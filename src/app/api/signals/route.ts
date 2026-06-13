import { NextResponse } from "next/server";

import { CACHE_TTL_SECONDS } from "@/lib/constants";
import { getSignals } from "@/features/signals/fetch-signals";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const data = await getSignals();
    return NextResponse.json(data, {
      headers: {
        "Cache-Control": `public, s-maxage=${CACHE_TTL_SECONDS.signals}, stale-while-revalidate=60`,
      },
    });
  } catch (err) {
    console.error("[/api/signals] error:", err);
    return NextResponse.json(
      { error: true, code: "SIGNALS_FAILED", message: (err as Error).message },
      { status: 502 },
    );
  }
}
