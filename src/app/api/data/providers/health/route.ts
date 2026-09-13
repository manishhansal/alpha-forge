/**
 * GET /api/data/providers/health — Data Foundation V5 §6/§12, Req 15.5.
 *
 * Returns per-provider health state including:
 *   id, status, lastSuccessAt, latencyMs (p50/p95/p99),
 *   successRate, requestCount, errorCount.
 *
 * SECURITY (§74 / Req 21.2): NEVER returns secrets, credentials, API keys,
 * tokens, or any field whose name or value constitutes a credential.
 * `authenticated` is derived from real ProviderObservation rows only.
 *
 * Serialisation-layer credential strip (Req 21.2, 12.5, 15.5):
 *   Any field whose NAME matches a credential pattern is removed from the
 *   response before it is sent, regardless of how it arrived here. This is a
 *   defence-in-depth guarantee — callers of this route must NEVER rely on
 *   field omission elsewhere in the call chain to keep credentials out of the
 *   response.
 */

import { NextResponse } from "next/server";

import { getAllProviderHealth } from "@/lib/market-data/health";
import { getProviderConfigHealth } from "@/lib/market-data/services/config-health.service";
import { computeProviderReliability } from "@/lib/market-data/services/provider-reliability.service";
import { providerRuntimeAvailable } from "@/lib/market-data/provider-selection";
import { loadWorkerCredentialsFromDb, workerCredentialStatus } from "@/lib/market-data/worker-credentials";
import type { ProviderId } from "@/lib/market-data/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ──────────────────────────────────────────────────────────────────────────────
// Credential field name patterns (Req 21.2).
// Any field in the serialised response whose name matches one of these patterns
// is stripped before the HTTP response is sent — defence-in-depth regardless of
// what upstream services may accidentally include in their return values.
// ──────────────────────────────────────────────────────────────────────────────
const CREDENTIAL_FIELD_PATTERNS: readonly RegExp[] = [
  /secret/i,
  /password/i,
  /passwd/i,
  /token(?!Count|s\b)/i, // "token" alone; NOT "tokenCount" or "tokens"
  /apiKey/i,
  /api_key/i,
  /pin$/i,
  /totp/i,
  /credential(?!s?Complete|Source|IdentityHash)/i, // NOT "credentialsComplete" etc.
  /private/i,
  /encryptionKey/i,
  /encryption_key/i,
  /clientSecret/i,
  /client_secret/i,
];

function isCredentialFieldName(key: string): boolean {
  return CREDENTIAL_FIELD_PATTERNS.some((p) => p.test(key));
}

/**
 * Recursively strip credential fields from an arbitrary object before
 * serialisation. Operates on plain-object / array values only; does not mutate
 * the input.
 */
function stripCredentialFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripCredentialFields);
  }
  if (value !== null && typeof value === "object") {
    const safe: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (!isCredentialFieldName(k)) {
        safe[k] = stripCredentialFields(v);
      }
    }
    return safe;
  }
  return value;
}

export async function GET() {
  // Load DB-stored broker credentials into the process override so runtime
  // availability reflects frontend-configured credentials (not just .env).
  // Best-effort — health should still render if this fails.
  try {
    await loadWorkerCredentialsFromDb();
  } catch {
    /* ignore — reflected as runtimeAvailable=false below */
  }

  const [config, reliability, circuitHealth] = await Promise.all([
    getProviderConfigHealth(),
    computeProviderReliability(),
    Promise.resolve(getAllProviderHealth()),
  ]);

  const relByProvider = new Map(reliability.map((r) => [r.provider, r]));
  const circuitByProvider = new Map(circuitHealth.map((h) => [h.providerId, h]));

  const providers: Record<string, unknown> = {};
  for (const c of config) {
    const rel = relByProvider.get(c.provider);
    const circuit = circuitByProvider.get(c.provider as ProviderId);

    providers[c.provider] = {
      // ── Identity ───────────────────────────────────────────────────────────
      id: c.provider,
      // ── Status (from circuit-breaker) ──────────────────────────────────────
      status: circuit?.status ?? "healthy",
      // ── Timestamps (from circuit-breaker, ISO-8601 UTC) ────────────────────
      lastSuccessAt: circuit?.lastSuccessAt ?? null,
      lastFailureAt: circuit?.lastFailureAt ?? null,
      // ── Latency percentiles over rolling window of last 100 requests ───────
      latencyMs: {
        p50: circuit?.latencyP50Ms ?? null,
        p95: circuit?.latencyP95Ms ?? null,
        p99: circuit?.latencyP99Ms ?? null,
      },
      // ── Request counters (from circuit-breaker, Req 15.1) ──────────────────
      requestCount: circuit?.requestCount ?? 0,
      successCount: circuit?.successCount ?? 0,
      errorCount: circuit?.errorCount ?? 0,
      successRate: circuit?.successRate ?? null,
      // ── Circuit breaker state ──────────────────────────────────────────────
      circuitOpen: circuit?.circuitOpen ?? false,
      circuitRetryAt: circuit?.circuitRetryAt ?? null,
      currentHealthScore: circuit?.score ?? 100,
      // ── Configuration & runtime (no credential values exposed) ────────────
      configured: c.configured,
      credentialsComplete: c.credentialsComplete,
      runtimeAvailable: providerRuntimeAvailable(c.provider as ProviderId),
      authenticated: c.authenticated,
      authenticationCheckedAt: c.lastValidatedAt,
      capabilities: c.capabilities,
      // ── Reliability (from ProviderObservation rows) ────────────────────────
      reliability: rel
        ? {
            sampleCount: rel.sampleCount,
            successRate: rel.successRate,
            status: rel.reliabilityStatus,
            latencyMsP50: rel.latencyMsP50,
            latencyMsP95: rel.latencyMsP95,
          }
        : { sampleCount: 0, status: "NOT_VERIFIED" },
    };
  }

  return NextResponse.json(
    stripCredentialFields({
      generatedAt: new Date().toISOString(),
      // NOTE: workerCredentialStatus() returns only key names and presence booleans
      // — never credential values. See Req 21.2.
      workerCredentials: workerCredentialStatus(),
      providers,
    }),
  );
}
