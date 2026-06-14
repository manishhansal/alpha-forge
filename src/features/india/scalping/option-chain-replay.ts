import "server-only";

import type { PrismaClient } from "@prisma/client";

import {
  summariseTrades,
  summaryToScoreInput,
  type IndiaBacktestTrade,
} from "@/features/india/scalping/backtest-core";
import {
  getOptionChainSeries,
  type OptionChainSeriesPoint,
} from "@/features/india/scalping/option-chain-capture";
import {
  OC_REPLAY_STRATEGY_IDS,
  replayOptionChainStrategy,
  type OcReplayStrategyId,
  type ReplaySnapshot,
} from "@/features/india/scalping/option-chain-replay-core";
import {
  scoreIndiaStrategy,
  type IndiaStrategyScore,
} from "@/features/india/scalping/strategy-score";
import type { IndiaScalpStrategyId } from "@/features/india/scalping/types";
import { FNO_INDICES } from "@/lib/india/fno-symbols";

/**
 * Option-chain *replay* score runner. Reads the captured snapshot history
 * (see `option-chain-capture.ts`) for each F&O index, replays the five
 * option-chain strategies bar-by-bar through the pure engine, pools the
 * resolved trades across indices and grades them on the SAME
 * `scoreIndiaStrategy` scale as the OHLCV backtest and the live journal.
 *
 * This is the long-promised "replay engine" — but it only emits a score
 * once enough real snapshots have accrued (see `MIN_SNAPSHOTS` /
 * `MIN_TRADES`). Until then it returns nothing for a strategy and the
 * blended board falls back to that strategy's live paper-trade record.
 *
 * Cached in-process for 30 minutes — the snapshot table only grows every
 * ~5 minutes during market hours so re-querying on every render is wasteful.
 */

type ReplayScoreMap = Partial<Record<IndiaScalpStrategyId, IndiaStrategyScore>>;

/** Look back this far for snapshots (well beyond what exists today). */
const LOOKBACK_MS = 2 * 365 * 24 * 60 * 60 * 1000;
/** Don't score a strategy off thin history — these guard against noise. */
const MIN_SNAPSHOTS = 200;
const MIN_TRADES = 12;

const CACHE_TTL_MS = 30 * 60 * 1000;

interface CacheEntry {
  at: number;
  promise: Promise<ReplayScoreMap>;
}
let cacheEntry: CacheEntry | null = null;

/**
 * Get replay-derived scores for the option-chain strategies. Cached for
 * 30m; a failed/empty run is not cached so the next caller retries.
 */
export function getIndiaOptionChainReplayScores(opts?: {
  force?: boolean;
  prisma?: PrismaClient;
}): Promise<ReplayScoreMap> {
  const now = Date.now();
  if (!opts?.force && cacheEntry && now - cacheEntry.at < CACHE_TTL_MS) {
    return cacheEntry.promise;
  }
  const entry: CacheEntry = {
    at: now,
    promise: computeReplayScores(opts?.prisma),
  };
  cacheEntry = entry;
  entry.promise.catch(() => {
    if (cacheEntry === entry) cacheEntry = null;
  });
  return entry.promise;
}

function toReplaySnapshots(points: OptionChainSeriesPoint[]): ReplaySnapshot[] {
  return points.map((p) => ({
    underlying: p.underlying,
    spot: p.spot,
    changePct: p.changePct,
    analytics: p.analytics,
    capturedAtMs: p.capturedAtMs,
  }));
}

async function computeReplayScores(
  prisma?: PrismaClient,
): Promise<ReplayScoreMap> {
  const since = Date.now() - LOOKBACK_MS;

  const loaded = await Promise.allSettled(
    FNO_INDICES.map(async (idx) => {
      const points = await getOptionChainSeries(idx.underlying, since, prisma);
      return toReplaySnapshots(points);
    }),
  );

  const series: ReplaySnapshot[][] = [];
  let totalSnapshots = 0;
  for (const r of loaded) {
    if (r.status === "fulfilled") {
      if (r.value.length >= 2) series.push(r.value);
      totalSnapshots += r.value.length;
    } else {
      console.warn("[india/oc-replay] series fetch failed", r.reason);
    }
  }
  // Not enough captured history yet — let the live record carry the badge.
  if (totalSnapshots < MIN_SNAPSHOTS || series.length === 0) return {};

  const out: ReplayScoreMap = {};
  for (const id of OC_REPLAY_STRATEGY_IDS as ReadonlyArray<OcReplayStrategyId>) {
    const pooled: IndiaBacktestTrade[] = series.flatMap((snaps) =>
      replayOptionChainStrategy(snaps, id),
    );
    if (pooled.length < MIN_TRADES) continue;
    const summary = summariseTrades(pooled);
    const score = scoreIndiaStrategy(summaryToScoreInput(id, summary, "backtest"));
    if (score) out[id] = score;
  }
  return out;
}
