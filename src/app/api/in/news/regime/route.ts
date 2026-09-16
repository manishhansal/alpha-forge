import { NextResponse } from "next/server";
import { fetchRegime } from "@/services/india/news/sentinel-client";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * GET /api/in/news/regime
 *
 * Returns the current market regime classification from SentinelPulse for
 * nifty50, banknifty, and broad_market.
 *
 * Response shape: NewsRegimeResponse (see src/types/india/news.ts)
 */
export async function GET() {
  try {
    const raw = await fetchRegime();

    if (!raw) {
      return NextResponse.json(
        {
          asOf: new Date().toISOString(),
          nifty50: null,
          banknifty: null,
          broadMarket: null,
          nextUpdateAt: null,
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    const mapEntry = (
      e: NonNullable<typeof raw.markets>[keyof typeof raw.markets],
    ) =>
      e
        ? {
            regime: e.regime,
            confidence: e.confidence,
            since: e.since,
            breadthScore: e.breadth_score ?? null,
            volatilityPercentile: e.volatility_percentile ?? null,
          }
        : null;

    return NextResponse.json(
      {
        asOf: raw.as_of,
        nifty50: mapEntry(raw.markets.nifty50),
        banknifty: mapEntry(raw.markets.banknifty),
        broadMarket: mapEntry(raw.markets.broad_market),
        nextUpdateAt: raw.next_update_at ?? null,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Regime fetch failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
