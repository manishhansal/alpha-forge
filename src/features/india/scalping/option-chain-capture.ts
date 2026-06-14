import "server-only";

import type { PrismaClient } from "@prisma/client";

import { getPrisma } from "@/lib/prisma";
import { FNO_INDICES } from "@/lib/india/fno-symbols";
import { nse } from "@/services/india/nse";
import { yahoo } from "@/services/india/yahoo";
import type { OptionChain } from "@/types/india";
import type { OptionChainAnalytics } from "@/types/india/options";

/**
 * NSE option-chain snapshot capture.
 *
 * NSE only serves the *live* option chain — there is no history endpoint —
 * so the option-chain strategies (PCR / IV / OI build-up / Liquidity Edge /
 * Max-Pain Gravity) can't be backtested on past data the way the price
 * strategies can. This module persists the aggregated chain analytics for
 * each F&O index on a cadence (driven by the `india-oc-capture` worker)
 * into `OptionChainSnapshot`, building that missing history over time.
 *
 * Capture is unconditional here (so a manual/backfill call always writes);
 * the worker is responsible for only calling it during market hours.
 */

export interface CaptureStats {
  captured: number;
  errors: number;
}

export interface CaptureOptions {
  prisma?: PrismaClient;
  /** Restrict to these underlyings; defaults to every F&O index. */
  underlyings?: ReadonlyArray<string>;
}

export async function captureOptionChainSnapshots(
  opts: CaptureOptions = {},
): Promise<CaptureStats> {
  const prisma = opts.prisma ?? getPrisma();
  const indices = opts.underlyings
    ? FNO_INDICES.filter((i) => opts.underlyings!.includes(i.underlying))
    : FNO_INDICES;

  // Underlying day change% (for replaying OI build-up = price × OI). Best
  // effort — a failed quote lookup just leaves changePct null.
  const changeByUnderlying = new Map<string, number | null>();
  try {
    const quotes = await yahoo.getQuotes(indices.map((i) => i.symbol));
    indices.forEach((i, idx) => {
      changeByUnderlying.set(i.underlying, quotes[idx]?.changePct ?? null);
    });
  } catch (err) {
    console.warn(
      "[india/oc-capture] index quote lookup failed:",
      (err as Error).message,
    );
  }

  const stats: CaptureStats = { captured: 0, errors: 0 };
  const results = await Promise.allSettled(
    indices.map(async (i) => {
      const chain = await nse.getOptionChain(i.underlying);
      await prisma.optionChainSnapshot.create({
        data: snapshotData(
          i.underlying,
          chain,
          changeByUnderlying.get(i.underlying) ?? null,
        ),
      });
    }),
  );

  for (const r of results) {
    if (r.status === "fulfilled") {
      stats.captured += 1;
    } else {
      stats.errors += 1;
      console.warn("[india/oc-capture] snapshot failed:", r.reason);
    }
  }
  return stats;
}

function snapshotData(
  underlying: string,
  chain: OptionChain,
  changePct: number | null,
) {
  const a = chain.analytics;
  return {
    underlying,
    expiry: chain.expiry,
    spot: chain.spot,
    changePct,
    pcrOi: a.pcrOi,
    pcrVolume: a.pcrVolume,
    maxPain: a.maxPain,
    atmIv: a.atmIv,
    maxCeOiStrike: a.maxCeOiStrike,
    maxPeOiStrike: a.maxPeOiStrike,
    totalCeOi: a.totalCeOi,
    totalPeOi: a.totalPeOi,
    totalCeOiChange: a.totalCeOiChange,
    totalPeOiChange: a.totalPeOiChange,
    analytics: a as unknown as Record<string, number | null>,
  };
}

export interface OptionChainSnapshotRow {
  id: string;
  underlying: string;
  expiry: string;
  spot: number | null;
  changePct: number | null;
  pcrOi: number | null;
  maxPain: number | null;
  atmIv: number | null;
  totalCeOiChange: number;
  totalPeOiChange: number;
  capturedAt: Date;
}

/**
 * Read captured snapshots for one underlying since `sinceMs`, oldest-first
 * — the chronological series a future option-chain backtester replays.
 */
export async function getOptionChainHistory(
  underlying: string,
  sinceMs: number,
  prisma?: PrismaClient,
): Promise<OptionChainSnapshotRow[]> {
  const db = prisma ?? getPrisma();
  const rows = await db.optionChainSnapshot.findMany({
    where: { underlying, capturedAt: { gte: new Date(sinceMs) } },
    orderBy: { capturedAt: "asc" },
    take: 5000,
    select: {
      id: true,
      underlying: true,
      expiry: true,
      spot: true,
      changePct: true,
      pcrOi: true,
      maxPain: true,
      atmIv: true,
      totalCeOiChange: true,
      totalPeOiChange: true,
      capturedAt: true,
    },
  });
  return rows;
}

/** A captured snapshot with its full analytics blob — the input the
 *  option-chain replay backtester reconstructs signals from. */
export interface OptionChainSeriesPoint {
  underlying: string;
  spot: number | null;
  changePct: number | null;
  analytics: OptionChainAnalytics;
  capturedAtMs: number;
}

/**
 * Read the full-analytics snapshot series for one underlying since
 * `sinceMs`, oldest-first — used by `option-chain-replay.ts` to replay the
 * option-chain strategies bar-by-bar.
 */
export async function getOptionChainSeries(
  underlying: string,
  sinceMs: number,
  prisma?: PrismaClient,
): Promise<OptionChainSeriesPoint[]> {
  const db = prisma ?? getPrisma();
  const rows = await db.optionChainSnapshot.findMany({
    where: { underlying, capturedAt: { gte: new Date(sinceMs) } },
    orderBy: { capturedAt: "asc" },
    take: 20_000,
    select: { underlying: true, spot: true, changePct: true, analytics: true, capturedAt: true },
  });
  return rows.map((r) => ({
    underlying: r.underlying,
    spot: r.spot,
    changePct: r.changePct,
    analytics: r.analytics as unknown as OptionChainAnalytics,
    capturedAtMs: r.capturedAt.getTime(),
  }));
}
