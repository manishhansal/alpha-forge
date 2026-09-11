/**
 * data-incident.service.ts — Data Foundation V3 §38.
 *
 * Durable `DataQualityIncident` recording with DEDUPLICATION / CORRELATION so a
 * single ongoing outage does not create thousands of duplicate rows.
 *
 * Correlation key = failureType + provider + instrumentId + intervalStr. While
 * an incident with the same key is OPEN, a repeat is folded into it
 * (affectedRecords incremented, detail.lastSeen updated) instead of inserting a
 * new row. A new OPEN incident is created only when none is open for that key.
 *
 * Lifecycle: OPEN → RESOLVED (resolveIncident). Fail-open: a persistence error
 * never breaks the data path.
 */

import "server-only";

import type { PrismaClient } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { mdLog } from "../health";

export type IncidentSeverity = "INFO" | "WARNING" | "ERROR" | "CRITICAL";

export type IncidentFailureType =
  | "PROVIDER_FAILED"
  | "STALE"
  | "MISSING"
  | "DUPLICATE"
  | "INVALID_OHLC"
  | "TIMESTAMP_REGRESSION"
  | "PROVIDER_DIVERGENCE"
  | "OPTION_CHAIN_INCOMPLETE"
  | "OI_STALE"
  | "IV_STALE"
  | "SNAPSHOT_SKEW"
  | "AUTH_FAILED"
  | "RATE_LIMITED"
  | "PERSISTENCE_FAILED";

export interface RecordIncidentInput {
  severity: IncidentSeverity;
  failureType: IncidentFailureType;
  provider?: string | null;
  instrumentId?: string | null;
  intervalStr?: string | null;
  rootCause?: string | null;
  /** Structured detail (never credentials). */
  detail?: Record<string, unknown> | null;
  requestId?: string | null;
  /** Records affected by THIS occurrence (added to the running total on dedup). */
  affectedRecords?: number;
  prisma?: PrismaClient;
}

function correlationKey(i: RecordIncidentInput): string {
  return [
    i.failureType,
    i.provider ?? "-",
    i.instrumentId ?? "-",
    i.intervalStr ?? "-",
  ].join("|");
}

/**
 * Record (or fold into) a data-quality incident. Returns the incident id or
 * null on persistence failure. Deduplicated by correlation key while OPEN.
 */
export async function recordDataIncident(
  input: RecordIncidentInput,
): Promise<string | null> {
  const prisma = input.prisma ?? getPrisma();
  const key = correlationKey(input);
  const now = new Date();

  mdLog("data_mismatch", {
    event: "DATA_QUALITY_INCIDENT",
    severity: input.severity,
    failureType: input.failureType,
    provider: input.provider ?? null,
    instrumentId: input.instrumentId ?? null,
    intervalStr: input.intervalStr ?? null,
    correlationKey: key,
    rootCause: input.rootCause ?? null,
  });

  try {
    // Find an OPEN incident with the same correlation key.
    const existing = await prisma.dataQualityIncident.findFirst({
      where: {
        status: "OPEN",
        failureType: input.failureType,
        provider: input.provider ?? null,
        instrumentId: input.instrumentId ?? null,
        intervalStr: input.intervalStr ?? null,
      },
      orderBy: { detectedAt: "desc" },
      select: { id: true, affectedRecords: true, detail: true },
    });

    if (existing) {
      const prevDetail = (existing.detail as Record<string, unknown> | null) ?? {};
      const occurrences = Number(prevDetail.occurrences ?? 1) + 1;
      await prisma.dataQualityIncident.update({
        where: { id: existing.id },
        data: {
          affectedRecords: existing.affectedRecords + (input.affectedRecords ?? 0),
          detail: {
            ...prevDetail,
            correlationKey: key,
            occurrences,
            lastSeen: now.toISOString(),
            lastDetail: (input.detail ?? null) as object | null,
          },
        },
      });
      return existing.id;
    }

    const row = await prisma.dataQualityIncident.create({
      data: {
        severity: input.severity,
        failureType: input.failureType,
        provider: input.provider ?? null,
        instrumentId: input.instrumentId ?? null,
        intervalStr: input.intervalStr ?? null,
        status: "OPEN",
        rootCause: input.rootCause ?? null,
        detail: {
          correlationKey: key,
          occurrences: 1,
          firstSeen: now.toISOString(),
          lastSeen: now.toISOString(),
          detail: (input.detail ?? null) as object | null,
        },
        requestId: input.requestId ?? null,
        affectedRecords: input.affectedRecords ?? 0,
      },
      select: { id: true },
    });
    return row.id;
  } catch (err) {
    mdLog("stale_data", {
      reason: "data_incident_persist_failed",
      failureType: input.failureType,
      error: (err as Error).message,
    });
    return null;
  }
}

/**
 * Resolve all OPEN incidents matching a correlation. Called when a provider
 * recovers or a gap is filled. Returns the number of incidents resolved.
 */
export async function resolveDataIncidents(match: {
  failureType?: IncidentFailureType;
  provider?: string | null;
  instrumentId?: string | null;
  intervalStr?: string | null;
  prisma?: PrismaClient;
}): Promise<number> {
  const prisma = match.prisma ?? getPrisma();
  try {
    const res = await prisma.dataQualityIncident.updateMany({
      where: {
        status: "OPEN",
        ...(match.failureType ? { failureType: match.failureType } : {}),
        ...(match.provider !== undefined ? { provider: match.provider } : {}),
        ...(match.instrumentId !== undefined ? { instrumentId: match.instrumentId } : {}),
        ...(match.intervalStr !== undefined ? { intervalStr: match.intervalStr } : {}),
      },
      data: { status: "RESOLVED", resolvedAt: new Date() },
    });
    return res.count;
  } catch (err) {
    mdLog("stale_data", {
      reason: "data_incident_resolve_failed",
      error: (err as Error).message,
    });
    return 0;
  }
}
