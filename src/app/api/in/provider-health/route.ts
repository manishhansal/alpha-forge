import { NextResponse } from "next/server";
import { getProviderHealth, getDataServiceHealth } from "@/lib/data-service/client";

export const dynamic = "force-dynamic";

/**
 * GET /api/in/provider-health
 *
 * Returns provider health from data-service2.0.
 * AlphaForge does not directly know about individual providers —
 * data-service2.0 is the single source of truth for provider health.
 */
export async function GET(): Promise<Response> {
  const probeStart = Date.now();

  try {
    const [providers, health] = await Promise.allSettled([
      getProviderHealth(),
      getDataServiceHealth(),
    ]);

    const result: Record<string, { available: boolean; latency_ms: number; status?: string }> = {
      "data-service2": {
        available: health.status === "fulfilled",
        latency_ms: Date.now() - probeStart,
        status: health.status === "fulfilled" ? health.value.status : "DOWN",
      },
    };

    if (providers.status === "fulfilled") {
      for (const p of providers.value) {
        result[p.id] = {
          available: p.status === "UP",
          latency_ms: p.latencyMs ?? 0,
          status: p.status,
        };
      }
    }

    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json(
      {
        "data-service2": {
          available: false,
          latency_ms: Date.now() - probeStart,
          status: "DOWN",
          error: "DATA_SERVICE_UNAVAILABLE",
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
}
