/**
 * GET /api/in/providers/upstox/connect
 *
 * Initiates the Upstox OAuth 2.0 flow for EXECUTION-ONLY broker connection.
 * Market data does NOT come from Upstox — use data-service2.0 for all market data.
 */
import { type NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest): Promise<Response> {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const clientId = process.env.UPSTOX_CLIENT_ID;

  if (!clientId) {
    return NextResponse.json(
      { error: "UPSTOX_CLIENT_ID not configured" },
      { status: 400 },
    );
  }

  const redirectUri =
    process.env.UPSTOX_REDIRECT_URI ??
    `${appUrl}/api/in/providers/upstox/callback`;

  const authUrl = new URL("https://api.upstox.com/v2/login/authorization/dialog");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");

  // Optional: pull state from the request to protect against CSRF
  const state = new URL(request.url).searchParams.get("state") ?? "";
  if (state) authUrl.searchParams.set("state", state);

  return NextResponse.redirect(authUrl.toString());
}
