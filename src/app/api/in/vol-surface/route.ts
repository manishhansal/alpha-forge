import { NextResponse } from "next/server";
import { cache } from "@/services/india/cache";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const ML_SERVICE_URL =
  process.env.ML_SERVICE_URL ?? "http://localhost:8100";

const ML_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SVIParams {
  a: number;
  b: number;
  rho: number;
  m: number;
  sigma: number;
}

export interface VolSurfaceResponse {
  symbol: string;
  expiries: string[];
  ivByExpiry: Record<string, { strike: number; iv: number }[]>;
  termStructure: { daysToExpiry: number; atmIv: number }[];
  sviParams: Record<string, SVIParams>;
  available: boolean;
  reason?: string;
}

// ---------------------------------------------------------------------------
// GET /api/in/vol-surface?symbol=NIFTY
// ---------------------------------------------------------------------------

/**
 * GET /api/in/vol-surface?symbol=NIFTY
 *
 * Returns the SVI-fitted implied volatility surface for the given symbol.
 * Includes per-expiry IV smile arrays, SVI parameters, and ATM term structure.
 *
 * Calls the ML service GET /analytics/vol-surface?symbol=NIFTY.
 * Cached in Redis for 5 minutes.
 * Returns { available: false, reason: "..." } on any ML service failure
 * — never a 5xx.
 *
 * Validates: Requirements 5.3, 5.4, 13.1
 */
export async function GET(req: Request): Promise<Response> {
  const { searchParams } = new URL(req.url);
  const symbol = (searchParams.get("symbol") ?? "NIFTY").toUpperCase();

  const cacheKey = `vol-surface:${symbol}`;

  try {
    // Check cache first
    const cached = await cache.get<VolSurfaceResponse>(cacheKey);
    if (cached !== undefined && cached !== null) {
      return NextResponse.json(cached, {
        headers: { "Cache-Control": "no-store" },
      });
    }

    // Call ML service
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ML_TIMEOUT_MS);

    let mlRes: Response;
    try {
      mlRes = await fetch(
        `${ML_SERVICE_URL}/analytics/vol-surface?symbol=${encodeURIComponent(symbol)}`,
        {
          signal: controller.signal,
          cache: "no-store",
        },
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!mlRes.ok) {
      const unavailable: VolSurfaceResponse = {
        symbol,
        expiries: [],
        ivByExpiry: {},
        termStructure: [],
        sviParams: {},
        available: false,
        reason: `ML service returned ${mlRes.status}`,
      };
      return NextResponse.json(unavailable, {
        headers: { "Cache-Control": "no-store" },
      });
    }

    const mlData = (await mlRes.json()) as Record<string, unknown>;

    const response: VolSurfaceResponse = {
      symbol,
      expiries: (mlData.expiries as string[]) ?? [],
      ivByExpiry:
        (mlData.ivByExpiry as Record<
          string,
          { strike: number; iv: number }[]
        >) ?? {},
      termStructure:
        (mlData.termStructure as {
          daysToExpiry: number;
          atmIv: number;
        }[]) ?? [],
      sviParams: (mlData.sviParams as Record<string, SVIParams>) ?? {},
      available: true,
    };

    await cache.set(cacheKey, response, CACHE_TTL_MS);

    return NextResponse.json(response, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    const reason =
      err instanceof Error ? err.message : "ML service unreachable";
    console.warn(`[vol-surface] ${symbol} failed: ${reason}`);

    const unavailable: VolSurfaceResponse = {
      symbol,
      expiries: [],
      ivByExpiry: {},
      termStructure: [],
      sviParams: {},
      available: false,
      reason,
    };

    return NextResponse.json(unavailable, {
      headers: { "Cache-Control": "no-store" },
    });
  }
}
