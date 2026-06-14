import "server-only";

import type { PrismaClient } from "@prisma/client";

import { getIndiaBacktestScores } from "@/features/india/scalping/backtest";
import {
  summariseTrades,
  summaryToScoreInput,
  type IndiaBacktestExitReason,
} from "@/features/india/scalping/backtest-core";
import { getIndiaClosedTradesByStrategy } from "@/features/india/scalping/journal";
import { getIndiaOptionChainReplayScores } from "@/features/india/scalping/option-chain-replay";
import {
  scoreIndiaStrategy,
  type IndiaStrategyScore,
} from "@/features/india/scalping/strategy-score";
import type {
  IndiaPaperTradeStatus,
  IndiaScalpStrategyId,
} from "@/features/india/scalping/types";

/**
 * Single entry-point for the Strategies page: blends the two scoring
 * sources into one per-strategy map.
 *
 *   - Price strategies (Range Expansion / Momentum / Volume Breakout) →
 *     5-year OHLCV backtest score (`backtest.ts`).
 *   - Option-chain strategies (PCR / IV / OI build-up / Liquidity Edge /
 *     Max-Pain Gravity) → option-chain *replay* backtest score once enough
 *     captured snapshots have accrued (`option-chain-replay.ts`), otherwise
 *     the live paper-trade score from the journal.
 *
 * Precedence per id: OHLCV backtest (price) and OC replay (option-chain)
 * win over the live record; anything not yet covered falls back to live.
 * Any source failing degrades to the others rather than blanking the badges.
 */

type ScoreMap = Partial<Record<IndiaScalpStrategyId, IndiaStrategyScore>>;

function statusToReason(status: IndiaPaperTradeStatus): IndiaBacktestExitReason {
  if (status === "WIN") return "TARGET";
  if (status === "LOSS") return "STOP";
  return "EXPIRED";
}

async function getIndiaLiveScores(prisma?: PrismaClient): Promise<ScoreMap> {
  const byStrategy = await getIndiaClosedTradesByStrategy(prisma);
  const out: ScoreMap = {};
  for (const [id, trades] of byStrategy) {
    const summary = summariseTrades(
      trades.map((t) => ({ pnlPct: t.pnlPct, reason: statusToReason(t.status) })),
    );
    const score = scoreIndiaStrategy(summaryToScoreInput(id, summary, "paper-trade"));
    if (score) out[id] = score;
  }
  return out;
}

export async function getIndiaStrategyScores(
  prisma?: PrismaClient,
): Promise<ScoreMap> {
  const [live, backtest, replay] = await Promise.all([
    getIndiaLiveScores(prisma).catch((err) => {
      console.warn("[india/score-board] live scoring failed", err);
      return {} as ScoreMap;
    }),
    getIndiaBacktestScores().catch((err) => {
      console.warn("[india/score-board] backtest scoring failed", err);
      return {} as ScoreMap;
    }),
    getIndiaOptionChainReplayScores({ prisma }).catch((err) => {
      console.warn("[india/score-board] OC replay scoring failed", err);
      return {} as ScoreMap;
    }),
  ]);
  // Precedence: live record is the base; the 5y OHLCV backtest overrides the
  // price ids and the option-chain replay overrides the OC ids (when each
  // has enough data to emit a score).
  return { ...live, ...replay, ...backtest };
}
