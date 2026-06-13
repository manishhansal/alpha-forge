import { NextResponse } from "next/server";

import { CACHE_TTL_SECONDS } from "@/lib/constants";
import { getCryptoAiSignals } from "@/features/ai-signals/crypto-builder";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/ai-signals — crypto AI Signals feed.
 *
 * Returns the per-symbol AI signals plus a market-regime banner. Cached at
 * the engine layer (Redis, signals TTL) so two near-simultaneous requests
 * share a single upstream fan-out.
 */
export async function GET() {
  try {
    const data = await getCryptoAiSignals();
    return NextResponse.json(data, {
      headers: {
        "Cache-Control": `public, s-maxage=${CACHE_TTL_SECONDS.signals}, stale-while-revalidate=60`,
      },
    });
  } catch (err) {
    console.error("[/api/ai-signals] error:", err);
    return NextResponse.json(
      {
        error: true,
        code: "AI_SIGNALS_FAILED",
        message: (err as Error).message,
      },
      { status: 502 },
    );
  }
}
