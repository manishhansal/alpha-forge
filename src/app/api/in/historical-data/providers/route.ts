/**
 * GET /api/in/historical-data/providers
 *
 * Returns provider status from data-service2.0.
 * After the centralization, AlphaForge does not maintain a local provider matrix —
 * data-service2.0 manages all providers.
 */
import "server-only";
import { NextResponse } from "next/server";
import { getProviderHealth } from "@/lib/data-service/client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const providers = await getProviderHealth();
    return NextResponse.json({
      source: "data-service2",
      providers: providers.map((p) => ({
        id: p.id,
        status: p.status,
        available: p.status === "UP",
        latencyMs: p.latencyMs ?? null,
        lastCheckedAt: p.lastCheckedAt ?? null,
      })),
      note: "Provider management is handled exclusively by data-service2.0. AlphaForge is a consumer only.",
      fetchedAt: new Date().toISOString(),
    });
  } catch {
    return NextResponse.json(
      { error: "DATA_SERVICE_UNAVAILABLE", providers: [], source: "data-service2" },
      { status: 503 },
    );
  }
}
