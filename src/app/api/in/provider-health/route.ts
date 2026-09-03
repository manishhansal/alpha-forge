import { NextResponse } from "next/server";
import { registry } from "@/lib/market-data/registry";
import type { ProviderHealth } from "@/lib/market-data/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/in/provider-health
 *
 * Aggregates health snapshots from the ProviderRegistry (all 5 providers) with
 * a live probe to the data-service /monitoring/health endpoint. Returns a single
 * JSON object keyed by provider id — always HTTP 200.
 *
 * Shape per entry:
 *   { available: boolean, latency_ms: number }
 *
 * If DATA_SERVICE_URL is unset or the data-service is unreachable, the
 * `scrapling` entry is { available: false, latency_ms: 0 } rather than an
 * error response.
 */
export async function GET(): Promise<Response> {
  // ── 1. Snapshot all registry providers ─────────────────────────────────────
  const healthSnapshots: ProviderHealth[] = registry.getHealth();

  // Build the base result from the registry health state.
  const result: Record<string, { available: boolean; latency_ms: number }> = {};

  for (const h of healthSnapshots) {
    result[h.providerId] = {
      available: h.status === "healthy",
      latency_ms: h.latencyP50Ms ?? 0,
    };
  }

  // ── 2. Probe data-service for the scrapling entry ───────────────────────────
  const dataServiceUrl = process.env.DATA_SERVICE_URL;

  if (dataServiceUrl) {
    const probeStart = Date.now();

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3_000); // 3s timeout

      const res = await fetch(`${dataServiceUrl}/monitoring/health`, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });

      clearTimeout(timeout);

      const latencyMs = Date.now() - probeStart;

      if (res.ok) {
        // Data-service is reachable — override the scrapling registry entry
        // with live latency from the actual probe and mark it available.
        result["scrapling"] = {
          available: true,
          latency_ms: latencyMs,
        };
      } else {
        // Reachable but returned a non-OK status — mark degraded.
        result["scrapling"] = {
          available: false,
          latency_ms: latencyMs,
        };
      }
    } catch {
      // Unreachable (timeout, connection refused, DNS failure, etc.) — always
      // return available: false, latency_ms: 0 per requirement 12.5.
      result["scrapling"] = {
        available: false,
        latency_ms: 0,
      };
    }
  } else {
    // DATA_SERVICE_URL not configured — scrapling is unavailable.
    result["scrapling"] = {
      available: false,
      latency_ms: 0,
    };
  }

  // ── 3. Always return HTTP 200 ───────────────────────────────────────────────
  return NextResponse.json(result, {
    headers: { "Cache-Control": "no-store" },
  });
}
