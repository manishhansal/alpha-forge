import { NextResponse } from "next/server";

import { CACHE_TTL_SECONDS } from "@/lib/constants";
import { getSentiment } from "@/features/sentiment/fetch-sentiment";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const data = await getSentiment();
    return NextResponse.json(data, {
      headers: {
        "Cache-Control": `public, s-maxage=${CACHE_TTL_SECONDS.sentiment}, stale-while-revalidate=60`,
      },
    });
  } catch (err) {
    console.error("[/api/sentiment] error:", err);
    return NextResponse.json(
      { error: true, code: "SENTIMENT_FAILED", message: (err as Error).message },
      { status: 502 },
    );
  }
}
