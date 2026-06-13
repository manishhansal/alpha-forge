import { NextResponse } from "next/server";
import { z } from "zod";

import { CACHE_TTL_SECONDS } from "@/lib/constants";
import { getOptionsOverview } from "@/features/options/fetch-options";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const querySchema = z.object({
  currency: z.enum(["BTC", "ETH", "SOL"]).default("BTC"),
});

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    currency: url.searchParams.get("currency") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: true, code: "BAD_REQUEST", message: "Invalid currency. Use BTC, ETH, or SOL." },
      { status: 400 },
    );
  }
  try {
    const data = await getOptionsOverview(parsed.data.currency);
    return NextResponse.json(data, {
      headers: {
        "Cache-Control": `public, s-maxage=${CACHE_TTL_SECONDS.optionsOverview}, stale-while-revalidate=120`,
      },
    });
  } catch (err) {
    console.error("[/api/options/overview] error:", err);
    return NextResponse.json(
      { error: true, code: "OPTIONS_FAILED", message: (err as Error).message },
      { status: 502 },
    );
  }
}
