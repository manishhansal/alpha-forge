import { NextResponse } from "next/server";
import { isMLServiceHealthy, mlFetch } from "@/lib/india/ml-client";
import { cache } from "@/services/india/cache";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes (Requirement 4.5)

export interface GexResult {
  symbol: string;
  spot: number;
  strikes: number[];
  gexPerStrike: number[];
  aggregateGex: number;
  gammaFlip: number;
  expectedMovePct: number;
  positiveGexWall: number;
  negativeGexWall: number;
  computedAt: string;
  available: boolean;
  reason?: string;
}

/**
 * GET /api/in/gex?symbol=NIFTY
 *
 * Returns Dealer Gamma Exposure (GEX) analytics for the given NSE symbol.
 *
 * Calls the ML service POST /analytics/gex with a chain snapshot.
 * Results are cached in Redis for 5 minutes (Requirement 4.5).
 *
 * Returns { available: false, reason: "ML service unreachable" } when the
 * ML service is down — never a 5xx (Requirements 4.6, 13.1).
 *
 * Validates: Requirements 4.5, 4.6, 13.1
 */
export async function GET(req: Request): Promise<Response> {
  const { searchParams } = new URL(req.url);
  const symbol = (searchParams.get("symbol") ?? "NIFTY").toUpperCase();

  const cacheKey = `gex:${symbol}`;

  try {
    // Check cache first
    const cached = await cache.get<GexResult>(cacheKey);
    if (cached !== undefined && cached !== null) {
      return NextResponse.json(cached, {
        headers: { "Cache-Control": "no-store" },
      });
    }

    // Check ML service health
    const healthy = await isMLServiceHealthy();
    if (!healthy) {
      const unavailable: GexResult = {
        symbol,
        spot: 0,
        strikes: [],
        gexPerStrike: [],
        aggregateGex: 0,
        gammaFlip: 0,
        expectedMovePct: 0,
        positiveGexWall: 0,
        negativeGexWall: 0,
        computedAt: new Date().toISOString(),
        available: false,
        reason: "ML service unreachable",
      };
      return NextResponse.json(unavailable, {
        headers: { "Cache-Control": "no-store" },
      });
    }

    // Call ML service with chain snapshot
    const mlResult = await mlFetch<GexResult>("/analytics/gex", {
      symbol,
    });

    if (!mlResult) {
      const unavailable: GexResult = {
        symbol,
        spot: 0,
        strikes: [],
        gexPerStrike: [],
        aggregateGex: 0,
        gammaFlip: 0,
        expectedMovePct: 0,
        positiveGexWall: 0,
        negativeGexWall: 0,
        computedAt: new Date().toISOString(),
        available: false,
        reason: "ML service returned no data",
      };
      return NextResponse.json(unavailable, {
        headers: { "Cache-Control": "no-store" },
      });
    }

    const response: GexResult = {
      ...mlResult,
      symbol,
      available: true,
      computedAt: mlResult.computedAt ?? new Date().toISOString(),
    };

    await cache.set(cacheKey, response, CACHE_TTL_MS);

    return NextResponse.json(response, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    const reason =
      err instanceof Error ? err.message : "ML service unreachable";
    console.warn(`[gex] ${symbol} failed: ${reason}`);

    const unavailable: GexResult = {
      symbol,
      spot: 0,
      strikes: [],
      gexPerStrike: [],
      aggregateGex: 0,
      gammaFlip: 0,
      expectedMovePct: 0,
      positiveGexWall: 0,
      negativeGexWall: 0,
      computedAt: new Date().toISOString(),
      available: false,
      reason,
    };

    return NextResponse.json(unavailable, {
      headers: { "Cache-Control": "no-store" },
    });
  }
}
