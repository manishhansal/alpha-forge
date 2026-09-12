/**
 * GET /api/v1/providers/status
 *
 * Provider health status endpoint (prompt §32).
 * Returns per-provider health: status, latency, success rate, circuit state.
 * NEVER exposes credentials, tokens, or secrets.
 *
 * Response:
 * {
 *   providers: Array<{
 *     id, status, lastSuccessAt, lastFailureAt,
 *     consecutiveFailures, consecutiveSuccesses,
 *     circuitOpen, circuitRetryAt,
 *     latencyP50Ms, latencyP99Ms
 *   }>
 * }
 */

import { NextResponse } from "next/server";
import { DataServiceClient } from "@/lib/data-service/client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const health = await DataServiceClient.observability.providerHealth();

    // Map to the public API shape — explicitly exclude anything credential-related
    const providers = health.map((h) => ({
      id: h.providerId,
      status: h.status,
      score: h.score,
      lastSuccessAt: h.lastSuccessAt,
      lastFailureAt: h.lastFailureAt,
      consecutiveFailures: h.consecutiveFailures,
      consecutiveSuccesses: h.consecutiveSuccesses,
      circuitOpen: h.circuitOpen,
      circuitRetryAt: h.circuitRetryAt,
      latencyP50Ms: h.latencyP50Ms,
      latencyP99Ms: h.latencyP99Ms,
      // Friendly status labels per spec §32
      connected: h.status === "healthy",
      authStatus: h.circuitOpen ? "CIRCUIT_OPEN" : h.status === "unhealthy" ? "AUTH_FAILED" : "CONNECTED",
    }));

    return NextResponse.json({
      providers,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: msg, code: "INTERNAL_ERROR" },
      { status: 500 },
    );
  }
}
