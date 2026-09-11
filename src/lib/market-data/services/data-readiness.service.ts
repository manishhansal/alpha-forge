/**
 * data-readiness.service.ts — Data Foundation V3 §28/§29/§30/§53.
 *
 * Capability-specific data readiness + a single machine-readable market-session
 * readiness contract, all DB-derived. Answers the final contract questions:
 * "Can I trade this? Why? Which provider? Is it stale? Is it complete? Are there
 * unresolved gaps?".
 *
 * Statuses (§29): DATA_READY | DATA_DEGRADED | DATA_INSUFFICIENT | DATA_BLOCKED.
 * A capability with 0 rows is NEVER DATA_READY. Readiness is per-capability;
 * a single global label never hides a capability-specific deficiency.
 */

import "server-only";

import type { PrismaClient } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { nseCalendar } from "@/lib/india/nse-trading-calendar";
import type { Interval } from "../types";
import { buildCoverageMatrix } from "./coverage.service";
import { V3_INTRADAY_INTERVALS } from "../provider-capability-matrix";

export type ReadinessStatus =
  | "DATA_READY"
  | "DATA_DEGRADED"
  | "DATA_INSUFFICIENT"
  | "DATA_BLOCKED";

export interface CapabilityReadiness {
  capability: string; // e.g. "1m equities", "index options"
  interval?: Interval;
  status: ReadinessStatus;
  instruments: number;
  actualBars: number;
  expectedBars: number | null;
  completeness: number | null;
  unresolvedGaps: number;
  reasons: string[];
}

/** Score a completeness fraction into a readiness status. */
function scoreCompleteness(actual: number, completeness: number | null): ReadinessStatus {
  if (actual === 0) return "DATA_INSUFFICIENT";
  if (completeness == null) return "DATA_DEGRADED";
  if (completeness >= 0.98) return "DATA_READY";
  if (completeness >= 0.8) return "DATA_DEGRADED";
  return "DATA_INSUFFICIENT";
}

/** Readiness for one candle interval across the persisted universe. */
export async function intervalReadiness(
  interval: Interval,
  exchange = "NSE",
  prisma: PrismaClient = getPrisma(),
): Promise<CapabilityReadiness> {
  const matrix = await buildCoverageMatrix({ exchange, interval, prisma });
  const cells = matrix.filter((c) => c.interval === interval);
  const instruments = cells.length;
  const actualBars = cells.reduce((s, c) => s + c.actualBars, 0);
  const expectedBars = cells.reduce<number | null>((s, c) => {
    if (c.expectedBars == null) return s;
    return (s ?? 0) + c.expectedBars;
  }, null);
  const completeness =
    expectedBars && expectedBars > 0 ? Math.min(1, actualBars / expectedBars) : null;

  const unresolvedGaps = await prisma.dataGap.count({
    where: { exchange, intervalStr: interval, recoveryStatus: { notIn: ["RECOVERED"] } },
  });

  let status = scoreCompleteness(actualBars, completeness);
  const reasons: string[] = [];
  if (actualBars === 0) reasons.push(`${interval}_no_persisted_bars`);
  if (unresolvedGaps > 0) {
    reasons.push(`${unresolvedGaps}_unresolved_gaps`);
    if (status === "DATA_READY") status = "DATA_DEGRADED";
  }
  if (completeness != null && completeness < 0.98 && actualBars > 0) {
    reasons.push(`completeness_${completeness.toFixed(3)}`);
  }

  return {
    capability: `${interval} candles`,
    interval,
    status,
    instruments,
    actualBars,
    expectedBars,
    completeness,
    unresolvedGaps,
    reasons,
  };
}

/** Option-chain readiness (aggregate index snapshots today; strike-level absent). */
export async function optionReadiness(
  prisma: PrismaClient = getPrisma(),
): Promise<{ index: CapabilityReadiness; stock: CapabilityReadiness }> {
  const byUnderlying = await prisma.optionChainSnapshot.groupBy({
    by: ["underlying"],
    _count: { _all: true },
    _max: { capturedAt: true },
  });
  const total = byUnderlying.reduce((s, g) => s + g._count._all, 0);
  const lastCaptured = byUnderlying.reduce<Date | null>((acc, g) => {
    const t = g._max.capturedAt;
    if (t && (!acc || t > acc)) return t;
    return acc;
  }, null);

  const indexReasons: string[] = [];
  // Aggregate-only (no per-strike OI/IV history) → cannot be DATA_READY for
  // the full option contract; best achievable here is DATA_DEGRADED.
  const indexStatus: ReadinessStatus = total === 0 ? "DATA_INSUFFICIENT" : "DATA_DEGRADED";
  indexReasons.push("aggregate_analytics_only_no_strike_level_history");
  if (lastCaptured) {
    const ageMin = (Date.now() - lastCaptured.getTime()) / 60000;
    indexReasons.push(`last_snapshot_${Math.round(ageMin)}min_ago`);
  }

  return {
    index: {
      capability: "index options",
      status: indexStatus,
      instruments: byUnderlying.length,
      actualBars: total,
      expectedBars: null,
      completeness: null,
      unresolvedGaps: 0,
      reasons: indexReasons,
    },
    stock: {
      capability: "stock options",
      status: "DATA_INSUFFICIENT",
      instruments: 0,
      actualBars: 0,
      expectedBars: null,
      completeness: null,
      unresolvedGaps: 0,
      reasons: ["no_stock_option_snapshots_persisted"],
    },
  };
}

export interface MarketSessionReadiness {
  queriedAt: string;
  marketOpen: boolean;
  overall: ReadinessStatus;
  capabilities: CapabilityReadiness[];
  reasons: string[];
}

/** Combine capability readiness into a single worst-case overall status. */
function worstReadiness(list: ReadinessStatus[]): ReadinessStatus {
  const order: ReadinessStatus[] = ["DATA_BLOCKED", "DATA_INSUFFICIENT", "DATA_DEGRADED", "DATA_READY"];
  let worst: ReadinessStatus = "DATA_READY";
  for (const s of list) {
    if (order.indexOf(s) < order.indexOf(worst)) worst = s;
  }
  return worst;
}

/**
 * The single market-session readiness evaluation (§30/§53). DB-derived,
 * machine-readable. `overall` is the worst capability status. Never maps 0 rows
 * to DATA_READY.
 */
export async function evaluateMarketSessionReadiness(
  prisma: PrismaClient = getPrisma(),
): Promise<MarketSessionReadiness> {
  const now = Date.now();
  const daily = await intervalReadiness("1d", "NSE", prisma);
  const intraday: CapabilityReadiness[] = [];
  for (const iv of V3_INTRADAY_INTERVALS) {
    intraday.push(await intervalReadiness(iv, "NSE", prisma));
  }
  const options = await optionReadiness(prisma);

  const capabilities = [daily, ...intraday, options.index, options.stock];
  const overall = worstReadiness(capabilities.map((c) => c.status));
  const reasons = capabilities
    .filter((c) => c.status !== "DATA_READY")
    .map((c) => `${c.capability}:${c.status}`);

  return {
    queriedAt: new Date(now).toISOString(),
    marketOpen: nseCalendar.isMarketOpen(now),
    overall,
    capabilities,
    reasons,
  };
}
