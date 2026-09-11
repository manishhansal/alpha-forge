/**
 * config-health.service.ts — Data Foundation V4 §12.
 *
 * Provider configuration health WITHOUT ever returning secrets. Reports, per
 * provider: whether it is configured, whether the credential set is COMPLETE
 * (all required fields present — reported as booleans/field-name lists only,
 * never values), whether it has been runtime-authenticated (from real provider
 * observations), and its declared capabilities.
 *
 * `authenticated` is evidence-based: it is true only when a REAL successful
 * observation exists for the provider (from `provider_reliability`), NOT merely
 * because a credential string is present. A credential being present in the
 * env/frontend does NOT mean "configured & working" (§12).
 *
 * SECURITY (§55): this module reads env var PRESENCE only (via `!!`), never
 * their values, and returns no secret material.
 */

import "server-only";

import type { PrismaClient } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import type { ProviderId } from "../types";
import { capabilityRow } from "../provider-capability-matrix";
import { computeProviderReliability } from "./provider-reliability.service";

export interface ProviderConfigHealth {
  provider: ProviderId;
  configured: boolean;
  credentialsComplete: boolean;
  /** Names (NOT values) of required credential fields that are missing. */
  missingCredentialFields: string[];
  /** Evidence-based: true only with a real successful observation. */
  authenticated: boolean;
  lastValidatedAt: string | null;
  capabilities: string[];
  /** How the credential source is resolved (env / per-user DB / none). */
  credentialSource: "env" | "per_user_db_possible" | "none";
}

/** Presence-only checks — never read the values. */
function present(name: string): boolean {
  const v = process.env[name];
  return typeof v === "string" && v.trim().length > 0;
}

function angelCreds(): { complete: boolean; missing: string[] } {
  const req = ["SMARTAPI_API_KEY", "SMARTAPI_CLIENT_CODE", "SMARTAPI_PIN", "SMARTAPI_TOTP_SECRET"];
  const missing = req.filter((f) => !present(f));
  return { complete: missing.length === 0, missing };
}

function upstoxCreds(): { complete: boolean; missing: string[] } {
  // Data-only flows accept EITHER a ready token (analytics/access) OR a full
  // OAuth client (id+secret). Report the token path as the required minimum.
  const hasToken = present("UPSTOX_ANALYTICS_TOKEN") || present("UPSTOX_ACCESS_TOKEN");
  const hasOAuth = present("UPSTOX_CLIENT_ID") && present("UPSTOX_CLIENT_SECRET");
  const complete = hasToken || hasOAuth;
  const missing = complete ? [] : ["UPSTOX_ANALYTICS_TOKEN|UPSTOX_ACCESS_TOKEN|(UPSTOX_CLIENT_ID+UPSTOX_CLIENT_SECRET)"];
  return { complete, missing };
}

/**
 * Compute config health for the whole provider chain. `prisma` optional so the
 * authenticated/lastValidatedAt evidence can be read from observations.
 */
export async function getProviderConfigHealth(
  prisma: PrismaClient = getPrisma(),
): Promise<ProviderConfigHealth[]> {
  const reliability = await computeProviderReliability(prisma);
  const relByProvider = new Map(reliability.map((r) => [r.provider, r]));

  const caps = (p: ProviderId): string[] => {
    const row = capabilityRow(p);
    if (!row) return [];
    return Object.entries(row.intervals)
      .filter(([, c]) => c?.supported)
      .map(([iv, c]) => `${iv}:${c!.history ? "H+L" : c!.live ? "L" : "?"}`);
  };

  const evidence = (p: ProviderId) => {
    const r = relByProvider.get(p);
    const authed = !!r && r.successCount > 0;
    return { authenticated: authed, lastValidatedAt: authed ? r!.observationWindow.last : null };
  };

  // scrapling (data-service) — no broker credentials; "configured" == URL set.
  const dataServiceConfigured = present("DATA_SERVICE_URL");
  const angel = angelCreds();
  const upstox = upstoxCreds();

  const rows: ProviderConfigHealth[] = [
    {
      provider: "scrapling",
      configured: dataServiceConfigured,
      credentialsComplete: dataServiceConfigured,
      missingCredentialFields: dataServiceConfigured ? [] : ["DATA_SERVICE_URL"],
      ...evidence("scrapling"),
      capabilities: caps("scrapling"),
      credentialSource: dataServiceConfigured ? "env" : "none",
    },
    {
      provider: "angel_one",
      configured: angel.complete,
      credentialsComplete: angel.complete,
      missingCredentialFields: angel.missing,
      ...evidence("angel_one"),
      capabilities: caps("angel_one"),
      credentialSource: angel.complete ? "env" : "per_user_db_possible",
    },
    {
      provider: "upstox",
      configured: upstox.complete,
      credentialsComplete: upstox.complete,
      missingCredentialFields: upstox.missing,
      ...evidence("upstox"),
      capabilities: caps("upstox"),
      credentialSource: upstox.complete ? "env" : "per_user_db_possible",
    },
    {
      provider: "yahoo",
      configured: true, // no credentials required
      credentialsComplete: true,
      missingCredentialFields: [],
      ...evidence("yahoo"),
      capabilities: caps("yahoo"),
      credentialSource: "none",
    },
  ];
  return rows;
}
