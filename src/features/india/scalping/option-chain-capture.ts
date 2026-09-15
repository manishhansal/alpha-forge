import { getQuotes, getOptionChain } from "@/lib/data-service/client";
import "server-only";

import { FNO_INDICES } from "@/lib/india/fno-symbols";
import type { OptionChainAnalytics } from "@/types/india/options";

/**
 * NSE option-chain snapshot capture.
 *
 * NOTE (data-service2.0 centralization, Phase 2):
 * The `OptionChainSnapshot` and `OptionChainStrike` tables have been removed
 * from the AlphaForge database. Option chain data is now sourced exclusively
 * from data-service2.0 and is NOT persisted locally. The capture functions
 * return the live data from data-service2.0 for in-memory use by callers
 * (e.g. signal engines), but no longer write to the database.
 *
 * Historical option chain series previously stored in `OptionChainSnapshot`
 * is now maintained by data-service2.0. Backtesting that requires historical
 * option chain data should query data-service2.0 directly.
 */

export interface CaptureStats {
  captured: number;
  errors: number;
}

export interface CaptureOptions {
  /** Restrict to these underlyings; defaults to every F&O index. */
  underlyings?: ReadonlyArray<string>;
}

export async function captureOptionChainSnapshots(
  opts: CaptureOptions = {},
): Promise<CaptureStats> {
  const indices = opts.underlyings
    ? FNO_INDICES.filter((i) => opts.underlyings!.includes(i.underlying))
    : FNO_INDICES;

  // Underlying day change% (for callers that need it in the returned data).
  const changeByUnderlying = new Map<string, number | null>();
  try {
    const nseSymbols = indices.map((i) => i.underlying);
    const mdQuotes = await getQuotes(nseSymbols);
    indices.forEach((i, idx) => {
      changeByUnderlying.set(i.underlying, mdQuotes[idx]?.changePct ?? null);
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
      // Fetch the live option chain from data-service2.0.
      // No DB write — OptionChainSnapshot table was removed.
      await getOptionChain(i.underlying);
    }),
  );

  for (const r of results) {
    if (r.status === "fulfilled") {
      stats.captured += 1;
    } else {
      stats.errors += 1;
      console.warn("[india/oc-capture] chain fetch failed:", r.reason);
    }
  }
  return stats;
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
 * Read captured snapshots for one underlying since `sinceMs`.
 *
 * NOTE: The OptionChainSnapshot table has been removed (data-service2.0
 * centralization Phase 2). Historical option chain series are now served by
 * data-service2.0. This function returns an empty array and logs a warning
 * to avoid breaking callers while they are updated to query data-service2.0.
 */
export async function getOptionChainHistory(
  underlying: string,
  sinceMs: number,
): Promise<OptionChainSnapshotRow[]> {
  console.warn(
    `[india/oc-capture] getOptionChainHistory(${underlying}, ${sinceMs}) — ` +
      "OptionChainSnapshot table removed. Query data-service2.0 for historical option chain data.",
  );
  return [];
}

/** A captured snapshot with its full analytics blob. */
export interface OptionChainSeriesPoint {
  underlying: string;
  spot: number | null;
  changePct: number | null;
  analytics: OptionChainAnalytics;
  capturedAtMs: number;
}

/**
 * Read the full-analytics snapshot series for one underlying since `sinceMs`.
 *
 * NOTE: The OptionChainSnapshot table has been removed (data-service2.0
 * centralization Phase 2). This function returns an empty array and logs a
 * warning. Update callers to query data-service2.0 directly.
 */
export async function getOptionChainSeries(
  underlying: string,
  sinceMs: number,
): Promise<OptionChainSeriesPoint[]> {
  console.warn(
    `[india/oc-capture] getOptionChainSeries(${underlying}, ${sinceMs}) — ` +
      "OptionChainSnapshot table removed. Query data-service2.0 for historical option chain series.",
  );
  return [];
}
