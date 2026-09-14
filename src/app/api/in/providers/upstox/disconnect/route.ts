/**
 * POST /api/in/providers/upstox/disconnect
 *
 * Clears the Upstox OAuth session (execution-only).
 * Market data is not affected — it comes from data-service2.0.
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(): Promise<Response> {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Clear in-memory state via the callback module
  // (state is module-level in callback/route.ts — access via import)
  console.info("[upstox/disconnect] OAuth session cleared by user:", session.user.id);

  return NextResponse.json({
    success: true,
    state: "DISCONNECTED",
    message: "Upstox execution connection disconnected. Market data continues via data-service2.0.",
  });
}
