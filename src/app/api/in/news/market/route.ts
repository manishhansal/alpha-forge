import { NextResponse } from "next/server";
import { fetchMarketIndia } from "@/services/india/news/sentinel-client";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * GET /api/in/news/market
 *
 * Returns a snapshot of the current India news landscape from SentinelPulse:
 * breadth metrics, regime classification, and the highest-impact active events.
 *
 * Thin proxy over SentinelPulse /api/v1/news/market/india.
 */
export async function GET() {
  try {
    const data = await fetchMarketIndia();

    if (!data) {
      return NextResponse.json(
        { asOf: new Date().toISOString(), breadth: null, regime: null, hotEvents: [] },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    return NextResponse.json(
      {
        asOf: data.as_of,
        breadth: data.breadth
          ? {
              advancingPct: data.breadth.advancing_articles_pct,
              decliningPct: data.breadth.declining_articles_pct,
              neutralPct: data.breadth.neutral_articles_pct,
              netBreadth: data.breadth.net_breadth,
              highImportanceCount: data.breadth.high_importance_count,
              windowMinutes: data.breadth.window_minutes,
            }
          : null,
        regime: data.regime,
        hotEvents: (data.hot_events ?? []).map((e) => ({
          eventId: e.event_id,
          eventType: e.event_type,
          headline: e.headline,
          importanceScore: e.importance_score,
          affectedAssets: e.affected_assets,
          publishedAt: e.published_at,
        })),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Market snapshot fetch failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
