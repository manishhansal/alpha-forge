/**
 * GET /api/in/providers/upstox/status
 *
 * Returns the Upstox execution broker connection status.
 * Market data is not affected by this status — it always comes from data-service2.0.
 */
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const analyticsToken = process.env.UPSTOX_ANALYTICS_TOKEN;
  const accessToken = process.env.UPSTOX_ACCESS_TOKEN;
  const clientId = process.env.UPSTOX_CLIENT_ID;

  const configured = Boolean(clientId);
  const hasToken = Boolean(analyticsToken ?? accessToken);

  return NextResponse.json({
    status: hasToken ? "CONNECTED" : configured ? "DISCONNECTED" : "NOT_CONFIGURED",
    configured,
    // Never expose token values — only report whether they exist
    hasToken,
    purpose: "EXECUTION_ONLY",
    note: "Market data is served by data-service2.0 regardless of this status.",
  });
}
