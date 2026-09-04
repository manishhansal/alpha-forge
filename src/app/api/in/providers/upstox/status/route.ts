/**
 * GET /api/in/providers/upstox/status
 *
 * Returns the current Upstox OAuth connection state for the frontend.
 *
 * SECURITY: This endpoint returns NO secrets — only public-safe status fields:
 *   - state: DISCONNECTED | AUTHORIZING | CONNECTED | TOKEN_EXPIRING | TOKEN_EXPIRED | REAUTH_REQUIRED | ERROR
 *   - expiresAt: UTC epoch-ms (number only, not the token itself)
 *   - connectedAt: UTC epoch-ms
 *   - message: human-readable status
 *   - dataOperational: boolean
 *
 * Token values, client secrets, and auth credentials are NEVER included
 * in this or any other API response sent to the browser.
 */

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getPublicStatus } from "@/lib/market-data/providers/upstox-token-state";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  // Require authenticated session — provider status is user-specific context
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const status = getPublicStatus();
  return NextResponse.json(status);
}
