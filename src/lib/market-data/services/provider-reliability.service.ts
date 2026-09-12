/**
 * provider-reliability.service.ts — Data Foundation V4 §13/§16/§19.
 *
 * Computes provider reliability + a RUNTIME-AWARE capability matrix from the
 * durable `ProviderObservation` table, with strict SAMPLE-SIZE HONESTY:
 *
 *   - Reliability is NEVER reported as a bare percentage from a tiny sample.
 *     Below `MIN_SAMPLE` observations for a (provider, capability), the status
 *     is INSUFFICIENT_SAMPLE and no reliability figure is asserted.
 *   - Demo/test observations (instrumentId matching the demo pattern) are
 *     EXCLUDED so they can never inflate a provider's real reliability (§10/§61).
 *   - A capability is only marked LIVE_RUNTIME_VERIFIED when there is at least
 *     one REAL successful observation for it; otherwise NOT_VERIFIED. Only
 *     runtime evidence upgrades certification (§16).
 */

import "server-only";

import type { PrismaClient } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import type { Interval, ProviderId } from "../types";
import {
  PROVIDER_CAPABILITY_MATRIX,
  intervalCapability,
} from "../provider-capability-matrix";

/** Minimum observations before a reliability % may be asserted. */
export const MIN_SAMPLE = 20;

const DEMO_NAME = /(__V3DEMO__|__V4DEMO__|demo|fixture|mock|test[_-]?instrument|synthetic)/i;

export type RuntimeStatus =
  | "LIVE_RUNTIME_VERIFIED"
  | "NOT_VERIFIED"
  | "INSUFFICIENT_SAMPLE";

export interface ProviderReliability {
  provider: string;
  /** Total REAL observations (demo excluded). */
  sampleCount: number;
  demoExcluded: number;
  successCount: number;
  failureCount: number;
  /** null when sampleCount < MIN_SAMPLE — never a false 100%. */
  successRate: number | null;
  reliabilityStatus: RuntimeStatus;
  /** Observation window (ISO), null when no real observations. */
  observationWindow: { first: string | null; last: string | null };
  /** p50/p95 latency ms from real observations, when recorded. */
  latencyMsP50: number | null;
  latencyMsP95: number | null;
}

interface ObsMetric {
  outcome?: string;
  latencyMs?: number | null;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

/** Compute per-provider reliability from REAL observations only. */
export async function computeProviderReliability(
  prisma: PrismaClient = getPrisma(),
): Promise<ProviderReliability[]> {
  const rows = await prisma.providerObservation.findMany({
    select: { provider: true, instrumentId: true, receivedAt: true, rawPayload: true },
    orderBy: { receivedAt: "asc" },
  });

  const byProvider = new Map<string, { real: Array<{ receivedAt: Date; metric: ObsMetric }>; demo: number }>();
  for (const r of rows) {
    const bucket = byProvider.get(r.provider) ?? { real: [], demo: 0 };
    if (DEMO_NAME.test(r.instrumentId)) {
      bucket.demo += 1;
    } else {
      const payload = (r.rawPayload as { __metrics?: ObsMetric } | null) ?? null;
      bucket.real.push({ receivedAt: r.receivedAt, metric: payload?.__metrics ?? {} });
    }
    byProvider.set(r.provider, bucket);
  }

  const result: ProviderReliability[] = [];
  for (const [provider, b] of byProvider) {
    const sample = b.real.length;
    const success = b.real.filter((o) => o.metric.outcome === "SUCCESS").length;
    const failure = sample - success;
    const latencies = b.real
      .map((o) => o.metric.latencyMs)
      .filter((x): x is number => typeof x === "number")
      .sort((a, z) => a - z);

    const status: RuntimeStatus =
      sample === 0 ? "NOT_VERIFIED" : sample < MIN_SAMPLE ? "INSUFFICIENT_SAMPLE" : "LIVE_RUNTIME_VERIFIED";

    result.push({
      provider,
      sampleCount: sample,
      demoExcluded: b.demo,
      successCount: success,
      failureCount: failure,
      successRate: status === "LIVE_RUNTIME_VERIFIED" ? success / sample : null,
      reliabilityStatus: status,
      observationWindow: {
        first: b.real[0]?.receivedAt.toISOString() ?? null,
        last: b.real[b.real.length - 1]?.receivedAt.toISOString() ?? null,
      },
      latencyMsP50: percentile(latencies, 50),
      latencyMsP95: percentile(latencies, 95),
    });
  }
  return result.sort((a, z) => a.provider.localeCompare(z.provider));
}

export interface RuntimeCapabilityCell {
  provider: ProviderId;
  interval: Interval;
  staticSupported: boolean;
  staticHistory: boolean;
  /** VERIFIED only with a real successful observation; else NOT_VERIFIED. */
  runtime: RuntimeStatus;
}

/**
 * Build the runtime-aware capability matrix (§16): static capability (what the
 * provider claims) vs runtime (what we actually retrieved successfully). Only a
 * REAL successful CANDLE observation for that provider+interval upgrades runtime
 * to LIVE_RUNTIME_VERIFIED.
 */
export async function buildRuntimeCapabilityMatrix(
  prisma: PrismaClient = getPrisma(),
): Promise<RuntimeCapabilityCell[]> {
  const rows = await prisma.providerObservation.findMany({
    where: { dataType: "CANDLE" },
    select: { provider: true, instrumentId: true, rawPayload: true },
  });

  // Set of (provider|interval) with at least one REAL success.
  const verified = new Set<string>();
  const sampled = new Map<string, number>();
  for (const r of rows) {
    if (DEMO_NAME.test(r.instrumentId)) continue; // demo never verifies runtime
    const m = (r.rawPayload as { __metrics?: { interval?: string; outcome?: string } } | null)?.__metrics;
    if (!m?.interval) continue;
    const key = `${r.provider}|${m.interval}`;
    sampled.set(key, (sampled.get(key) ?? 0) + 1);
    if (m.outcome === "SUCCESS") verified.add(key);
  }

  // 3m intentionally absent — not a supported AlphaForge interval (V8 removal).
  const intervals: Interval[] = ["1m", "5m", "10m", "15m", "30m", "1h", "1d"];
  const cells: RuntimeCapabilityCell[] = [];
  for (const row of PROVIDER_CAPABILITY_MATRIX) {
    for (const iv of intervals) {
      const cap = intervalCapability(row.provider, iv);
      if (!cap.supported) continue;
      const key = `${row.provider}|${iv}`;
      const runtime: RuntimeStatus = verified.has(key)
        ? "LIVE_RUNTIME_VERIFIED"
        : (sampled.get(key) ?? 0) > 0
          ? "INSUFFICIENT_SAMPLE"
          : "NOT_VERIFIED";
      cells.push({
        provider: row.provider,
        interval: iv,
        staticSupported: cap.supported,
        staticHistory: cap.history,
        runtime,
      });
    }
  }
  return cells;
}
