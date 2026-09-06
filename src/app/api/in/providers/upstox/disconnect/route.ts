/**
 * POST /api/in/providers/upstox/disconnect
 *
 * Revokes the current Upstox OAuth session and clears the server-side token state.
 *
 * SECURITY:
 *   - No token values are ever sent to or from the browser
 *   - The token is only cleared from server-side memory
 *   - No Upstox revocation API call (Upstox v2 does not expose a token-revocation endpoint;
 *     the token will expire naturally after its lifetime)
 */

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { setDisconnected, setReauthRequired } from "@/lib/market-data/providers/upstox-token-state";
import { mdLog } from "@/lib/market-data/health";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(): Promise<Response> {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  setDisconnected();
  mdLog("provider_selected", {
    providerId: "upstox",
    event:      "oauth_disconnected",
    initiatedBy: session.user.id ?? "unknown",
  });

  return NextResponse.json({
    success: true,
    state:   "DISCONNECTED",
    message: "Upstox disconnected. Data requests will fall back to Yahoo Finance.",
  });
}
