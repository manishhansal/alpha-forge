/**
 * GET /api/data/providers/health — Data Foundation V5 §6/§12.
 *
 * Provider configuration + runtime health. Reports, per provider:
 * configured / credentialsComplete / runtimeAvailable / authenticated (evidence-
 * based from real observations) / capabilities / reliability sample size.
 *
 * SECURITY (§74): NEVER returns secrets. Credential detection is presence-only;
 * `authenticated` is derived from real ProviderObservation rows, not from
 * credential presence.
 */

import { NextResponse } from "next/server";

import { getProviderConfigHealth } from "@/lib/market-data/services/config-health.service";
import { computeProviderReliability } from "@/lib/market-data/services/provider-reliability.service";
import { providerRuntimeAvailable } from "@/lib/market-data/provider-selection";
import { loadWorkerCredentialsFromDb, workerCredentialStatus } from "@/lib/market-data/worker-credentials";
import type { ProviderId } from "@/lib/market-data/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  // Load DB-stored broker credentials into the process override so runtime
  // availability reflects frontend-configured credentials (not just .env).
  // Best-effort — health should still render if this fails.
  try {
    await loadWorkerCredentialsFromDb();
  } catch {
    /* ignore — reflected as runtimeAvailable=false below */
  }

  const [config, reliability] = await Promise.all([
    getProviderConfigHealth(),
    computeProviderReliability(),
  ]);
  const relByProvider = new Map(reliability.map((r) => [r.provider, r]));

  const providers: Record<string, unknown> = {};
  for (const c of config) {
    const rel = relByProvider.get(c.provider);
    providers[c.provider] = {
      configured: c.configured,
      credentialsComplete: c.credentialsComplete,
      missingCredentialFields: c.missingCredentialFields,
      runtimeAvailable: providerRuntimeAvailable(c.provider as ProviderId),
      authenticated: c.authenticated,
      authenticationCheckedAt: c.lastValidatedAt,
      capabilities: c.capabilities,
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

  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    workerCredentials: workerCredentialStatus(),
    providers,
  });
}
