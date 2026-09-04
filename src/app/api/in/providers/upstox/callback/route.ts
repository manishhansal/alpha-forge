/**
 * GET /api/in/providers/upstox/callback
 *
 * Upstox OAuth 2.0 callback handler.
 *
 * Upstox redirects here after the user authorizes the application.
 * This endpoint exchanges the authorization code for an access token
 * SERVER-SIDE, then redirects the user back to the dashboard.
 *
 * SECURITY INVARIANTS:
 *   - The authorization code is exchanged SERVER-SIDE only
 *   - UPSTOX_CLIENT_SECRET is used only here, server-side, and is NEVER
 *     included in any response sent to the browser
 *   - The access token is stored in server memory (_oauthState) only
 *   - The frontend is redirected to the dashboard page with only a status
 *     flag — no token, no code, no secret
 *   - Error details are logged server-side; only generic messages reach browser
 */

import { type NextRequest, NextResponse } from "next/server";
import { exchangeUpstoxCode } from "@/lib/market-data/providers/upstox";
import { setConnected, setError } from "@/lib/market-data/providers/upstox-token-state";
import { mdLog } from "@/lib/market-data/health";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest): Promise<Response> {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const dashboardUrl = `${appUrl}/in/settings?upstox=`;

  const { searchParams } = new URL(request.url);
  const code  = searchParams.get("code");
  const error = searchParams.get("error");
  const errorDesc = searchParams.get("error_description");

  // Handle OAuth error from Upstox
  if (error) {
    const reason = errorDesc ?? error;
    setError(`OAuth error: ${reason}`);
    mdLog("provider_failure", {
      providerId: "upstox",
      kind:       "auth_failure",
      message:    `OAuth callback error: ${error}`,
      // errorDesc may contain user-readable info — log but don't include raw
    });
    return NextResponse.redirect(`${dashboardUrl}error&reason=oauth_denied`);
  }

  if (!code) {
    setError("No authorization code received from Upstox");
    return NextResponse.redirect(`${dashboardUrl}error&reason=no_code`);
  }

  const redirectUri = process.env.UPSTOX_REDIRECT_URI
    ?? `${appUrl}/api/in/providers/upstox/callback`;

  try {
    // Exchange code for token SERVER-SIDE (client_secret never reaches browser)
    const { accessToken, expiresIn } = await exchangeUpstoxCode(code, redirectUri);

    // Store in server-side token state — import setConnected from token-state module
    setConnected(accessToken, expiresIn);

    mdLog("provider_selected", {
      providerId: "upstox",
      event:      "oauth_connected",
      expiresIn,
    });

    // Redirect to dashboard with success flag — NO token in URL
    return NextResponse.redirect(`${dashboardUrl}connected`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    // Redact any token material from error messages before logging
    const sanitized = msg
      .replace(/code=\S+/gi, "code=[REDACTED]")
      .replace(/access_token=\S+/gi, "access_token=[REDACTED]");

    setError(`Token exchange failed: ${sanitized}`);
    mdLog("provider_failure", {
      providerId: "upstox",
      kind:       "auth_failure",
      message:    "OAuth code exchange failed",
    });

    return NextResponse.redirect(`${dashboardUrl}error&reason=exchange_failed`);
  }
}
