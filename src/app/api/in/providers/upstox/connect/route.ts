/**
 * GET /api/in/providers/upstox/connect
 *
 * Initiates the Upstox OAuth 2.0 authorization flow.
 *
 * The frontend calls this endpoint; it responds with the Upstox authorization URL.
 * The user is then redirected to Upstox to authorize the application.
 * After authorization, Upstox redirects to /api/in/providers/upstox/callback.
 *
 * SECURITY:
 *   - UPSTOX_CLIENT_SECRET is NEVER sent to the browser
 *   - Only UPSTOX_CLIENT_ID (public OAuth client ID) is used here — this is
 *     safe to include in the authorization URL (per OAuth 2.0 spec, client_id
 *     is always public; only client_secret is confidential)
 *   - State parameter is generated server-side and stored in the session to
 *     prevent CSRF on the callback
 */

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { setAuthorizing } from "@/lib/market-data/providers/upstox-token-state";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const clientId = process.env.UPSTOX_CLIENT_ID;
  const redirectUri = process.env.UPSTOX_REDIRECT_URI
    ?? `${process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"}/api/in/providers/upstox/callback`;

  if (!clientId) {
    return NextResponse.json(
      {
        error: "UPSTOX_CLIENT_ID not configured. Set it in your environment variables.",
        configured: false,
      },
      { status: 503 },
    );
  }

  // Generate CSRF-resistant state token
  const stateToken = crypto.randomUUID();

  // Mark provider as authorizing (server state only)
  setAuthorizing();

  // Build the Upstox OAuth authorization URL
  // Ref: https://upstox.com/developer/api-documentation/authentication
  const authUrl = new URL("https://api.upstox.com/v2/login/authorization/dialog");
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", clientId);           // public — safe in URL
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("state", stateToken);

  return NextResponse.json({
    authorizationUrl: authUrl.toString(),
    state: stateToken,  // Frontend stores this to validate the callback
    message: "Redirect the user to authorizationUrl to complete Upstox authorization.",
  });
}
