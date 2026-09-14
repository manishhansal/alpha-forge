/**
 * GET /api/in/providers/upstox/callback
 *
 * Upstox OAuth 2.0 callback handler for EXECUTION-ONLY broker connection.
 *
 * NOTE: Upstox is connected here only for ORDER EXECUTION (placing/modifying
 * orders). Market data does NOT flow through Upstox — all market data comes
 * from data-service2.0.
 *
 * SECURITY:
 *   - Code exchanged server-side only
 *   - UPSTOX_CLIENT_SECRET never reaches the browser
 *   - Token stored in server-side state only
 *   - Only a status flag is sent back to the browser
 */
import { type NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// In-memory OAuth state (server-side only)
type UpstoxOAuthState = {
  status: "DISCONNECTED" | "AUTHORIZING" | "CONNECTED" | "ERROR";
  accessToken: string | null;
  expiresAt: number | null;
  error: string | null;
};

// Module-level state (persists for the lifetime of the server process)
let _oauthState: UpstoxOAuthState = {
  status: "DISCONNECTED",
  accessToken: null,
  expiresAt: null,
  error: null,
};

export function getUpstoxTokenState(): Readonly<UpstoxOAuthState> {
  return _oauthState;
}

export async function GET(request: NextRequest): Promise<Response> {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const dashboardUrl = `${appUrl}/in/settings?upstox=`;
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const error = searchParams.get("error");
  const errorDesc = searchParams.get("error_description");

  if (error) {
    _oauthState = {
      status: "ERROR",
      accessToken: null,
      expiresAt: null,
      error: `OAuth error: ${errorDesc ?? error}`,
    };
    console.warn("[upstox/callback] OAuth error:", error, errorDesc);
    return NextResponse.redirect(`${dashboardUrl}error&reason=oauth_denied`);
  }

  if (!code) {
    _oauthState = {
      status: "ERROR",
      accessToken: null,
      expiresAt: null,
      error: "No authorization code received",
    };
    return NextResponse.redirect(`${dashboardUrl}error&reason=no_code`);
  }

  const clientId = process.env.UPSTOX_CLIENT_ID;
  const clientSecret = process.env.UPSTOX_CLIENT_SECRET;
  const redirectUri =
    process.env.UPSTOX_REDIRECT_URI ??
    `${appUrl}/api/in/providers/upstox/callback`;

  if (!clientId || !clientSecret) {
    _oauthState = {
      status: "ERROR",
      accessToken: null,
      expiresAt: null,
      error: "Upstox client credentials not configured",
    };
    return NextResponse.redirect(`${dashboardUrl}error&reason=not_configured`);
  }

  try {
    const tokenRes = await fetch("https://api.upstox.com/v2/login/authorization/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!tokenRes.ok) {
      const body = await tokenRes.text();
      throw new Error(`Token exchange failed: HTTP ${tokenRes.status} — ${body}`);
    }

    const data = (await tokenRes.json()) as {
      access_token?: string;
      expires_in?: number;
    };

    if (!data.access_token) {
      throw new Error("No access_token in Upstox response");
    }

    _oauthState = {
      status: "CONNECTED",
      accessToken: data.access_token,
      expiresAt: data.expires_in
        ? Date.now() + data.expires_in * 1000
        : null,
      error: null,
    };

    console.info("[upstox/callback] OAuth connected (execution-only)");
    return NextResponse.redirect(`${dashboardUrl}connected`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    _oauthState = {
      status: "ERROR",
      accessToken: null,
      expiresAt: null,
      error: message,
    };
    console.error("[upstox/callback] Token exchange error:", message);
    return NextResponse.redirect(`${dashboardUrl}error&reason=token_exchange_failed`);
  }
}
