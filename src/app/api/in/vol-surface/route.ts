import { NextResponse } from "next/server";
import { cache } from "@/services/india/cache";
import { fetchVolSurface } from "@/lib/india/ml-client";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

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
 * Routes through ml-client.ts (fetchVolSurface) which respects ML_MODE and
 * encapsulates timeout, retry, and circuit-break logic.
 *
 * Returns { available: false, reason: "..." } on any ML service failure — never a 5xx.
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

    // Delegate to the canonical ML client (respects ML_MODE, timeouts, etc.)
    const mlData = await fetchVolSurface(symbol);

    if (!mlData) {
      const unavailable: VolSurfaceResponse = {
        symbol,
        expiries: [],
        ivByExpiry: {},
        termStructure: [],
        sviParams: {},
        available: false,
        reason: "ML service unreachable or returned no data",
      };
      return NextResponse.json(unavailable, {
        headers: { "Cache-Control": "no-store" },
      });
    }

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
