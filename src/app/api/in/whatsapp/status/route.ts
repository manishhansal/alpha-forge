import { NextResponse } from "next/server";

import { env } from "@/lib/env";
import { redis } from "@/lib/redis";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CONNECTIVITY_TIMEOUT_MS = 5_000;
const LAST_DISPATCH_KEY = "whatsapp:last-dispatch";

/**
 * Attempt a lightweight GET to the Evolution API base URL to check reachability.
 * Returns true when the server responds (any HTTP status), false on network error
 * or timeout.
 */
async function checkEvolutionReachable(baseUrl: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONNECTIVITY_TIMEOUT_MS);
  try {
    await fetch(baseUrl + "/", {
      method: "GET",
      signal: controller.signal,
      // Avoid following redirects — we only care that the host is reachable.
      redirect: "manual",
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * GET /api/in/whatsapp/status
 *
 * Returns the current Evolution API integration status:
 * - `configured`     — both WHATSAPP_EVOLUTION_API_URL and WHATSAPP_INSTANCE are set
 * - `reachable`      — Evolution API responded within 5 s (only attempted when configured)
 * - `instance`       — the configured instance name, or null when not set
 * - `lastDispatchAt` — ISO timestamp of the last successful WhatsApp dispatch, or null
 *
 * Requirements: 10.5
 */
export async function GET() {
  const apiUrl = env.WHATSAPP_EVOLUTION_API_URL ?? null;
  const instance = env.WHATSAPP_INSTANCE ?? null;

  const configured = Boolean(apiUrl && instance);

  // Only probe the network when both env vars are set.
  let reachable = false;
  if (configured && apiUrl) {
    reachable = await checkEvolutionReachable(apiUrl);
  }

  // Read the last-dispatch timestamp from Redis (best-effort — null on any error).
  let lastDispatchAt: string | null = null;
  try {
    lastDispatchAt = await redis.get(LAST_DISPATCH_KEY);
  } catch (err) {
    console.warn("[whatsapp/status] Redis read failed:", (err as Error).message);
  }

  return NextResponse.json(
    {
      reachable,
      instance,
      lastDispatchAt,
      configured,
    },
    {
      headers: { "Cache-Control": "no-store" },
    },
  );
}
