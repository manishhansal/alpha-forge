import { NextResponse } from "next/server";
import { isMLServiceHealthy, mlFetch } from "@/lib/india/ml-client";
import { cache } from "@/services/india/cache";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes

export interface VpinResponse {
  symbol: string;
  vpin: number;
  bucketHistory: number[];
  classification: "toxic" | "elevated" | "benign";
  available: boolean;
  reason?: string;
}

/**
 * GET /api/in/order-flow?symbol=NIFTY
 *
 * Returns the VPIN (Volume-synchronized Probability of Informed Trading)
 * order-flow toxicity indicator for the given symbol.
 *
 * Calls the ML service POST /analytics/vpin with recent OHLCV bars.
 * Cached in Redis for 2 minutes.
 * Returns { available: false, reason: "..." } on any ML service failure
 * — never a 5xx.
 *
 * Validates: Requirements 7.5, 7.6, 13.1
 */
export async function GET(req: Request): Promise<Response> {
  const { searchParams } = new URL(req.url);
  const symbol = (searchParams.get("symbol") ?? "NIFTY").toUpperCase();

  const cacheKey = `order-flow:${symbol}`;

  try {
    // Check cache first
    const cached = await cache.get<VpinResponse>(cacheKey);
    if (cached !== undefined && cached !== null) {
      return NextResponse.json(cached, {
        headers: { "Cache-Control": "no-store" },
      });
    }

    // Check if ML service is healthy
    const healthy = await isMLServiceHealthy();
    if (!healthy) {
      const unavailable: VpinResponse = {
        symbol,
        vpin: 0,
        bucketHistory: [],
        classification: "benign",
        available: false,
        reason: "ML service unreachable",
      };
      return NextResponse.json(unavailable, {
        headers: { "Cache-Control": "no-store" },
      });
    }

    // Call ML service
    const mlResult = await mlFetch<VpinResponse>("/analytics/vpin", {
      symbol,
    });

    if (!mlResult) {
      const unavailable: VpinResponse = {
        symbol,
        vpin: 0,
        bucketHistory: [],
        classification: "benign",
        available: false,
        reason: "ML service returned no data",
      };
      return NextResponse.json(unavailable, {
        headers: { "Cache-Control": "no-store" },
      });
    }

    const response: VpinResponse = {
      ...mlResult,
      symbol,
      available: true,
    };

    await cache.set(cacheKey, response, CACHE_TTL_MS);

    return NextResponse.json(response, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    const reason =
      err instanceof Error ? err.message : "ML service unreachable";
    console.warn(`[order-flow] ${symbol} failed: ${reason}`);

    const unavailable: VpinResponse = {
      symbol,
      vpin: 0,
      bucketHistory: [],
      classification: "benign",
      available: false,
      reason,
    };

    return NextResponse.json(unavailable, {
      headers: { "Cache-Control": "no-store" },
    });
  }
}
