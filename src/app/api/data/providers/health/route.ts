/**
 * GET /api/data/providers/health
 *
 * Returns provider health from data-service2.0.
 * After the data-service2.0 centralization, AlphaForge no longer maintains
 * its own provider health state. Health is proxied from data-service2.0.
 *
 * SECURITY: never returns credentials or provider API keys.
 */
import { NextResponse } from "next/server";
import { getProviderHealth, getDataServiceHealth } from "@/lib/data-service/client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CREDENTIAL_FIELD_PATTERNS: readonly RegExp[] = [
  /secret/i,
  /password/i,
  /token(?!Count|s\b)/i,
  /apiKey/i,
  /api_key/i,
  /pin$/i,
  /totp/i,
  /credential/i,
  /private/i,
];

function stripCredentials(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(stripCredentials);
  if (obj && typeof obj === "object") {
    return Object.fromEntries(
      Object.entries(obj as Record<string, unknown>)
        .filter(([k]) => !CREDENTIAL_FIELD_PATTERNS.some((p) => p.test(k)))
        .map(([k, v]) => [k, stripCredentials(v)]),
    );
  }
  return obj;
}

export async function GET(): Promise<Response> {
  try {
    const [providers, health] = await Promise.allSettled([
      getProviderHealth(),
      getDataServiceHealth(),
    ]);

    const result = {
      dataService: {
        status: health.status === "fulfilled" ? health.value.status : "DOWN",
        available: health.status === "fulfilled",
        source: "data-service2",
      },
      providers:
        providers.status === "fulfilled"
          ? providers.value.map((p) => ({
              id: p.id,
              status: p.status,
              available: p.status === "UP",
              latencyMs: p.latencyMs ?? null,
              lastCheckedAt: p.lastCheckedAt ?? null,
            }))
          : [],
      fetchedAt: new Date().toISOString(),
    };

    return NextResponse.json(stripCredentials(result), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json(
      {
        dataService: { status: "DOWN", available: false, source: "data-service2" },
        providers: [],
        error: "DATA_SERVICE_UNAVAILABLE",
        fetchedAt: new Date().toISOString(),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
}
