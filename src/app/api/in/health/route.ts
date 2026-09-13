import { NextResponse } from "next/server";
import { cache } from "@/services/india/cache";
// isAngelConfigured is a broker config check — not market-data acquisition.
// See DATA_SERVICE_PRE_REFACTOR_AUDIT.md for documented exceptions.
// eslint-disable-next-line no-restricted-imports
import { isAngelConfigured } from "@/services/india/angelone";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * GET /api/in/health
 *
 * Reports the active Indian-market cache backend (memory vs redis) and a
 * tiny round-trip test so you can verify Redis is actually reachable.
 */
export async function GET() {
  const probeKey = "health:probe";
  const probeVal = { ts: Date.now() };
  let roundTrip: "ok" | "fail" = "fail";
  let error: string | null = null;
  try {
    await cache.set(probeKey, probeVal, 5_000);
    const back = await cache.get<typeof probeVal>(probeKey);
    if (back?.ts === probeVal.ts) roundTrip = "ok";
  } catch (e: unknown) {
    error = e instanceof Error ? e.message : String(e);
  }

  return NextResponse.json({
    cache: {
      backend: cache.backendId,
      configured: {
        redisUrl: Boolean(process.env.REDIS_URL),
      },
      roundTrip,
      error,
    },
    broker: process.env.INDIA_BROKER ?? process.env.BROKER ?? "yahoo",
    grow: {
      live: Boolean(process.env.GROWW_API_KEY && process.env.GROWW_API_SECRET),
    },
    angel: {
      live: isAngelConfigured(),
    },
    fetchedAt: new Date().toISOString(),
  });
}
