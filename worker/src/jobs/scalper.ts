import { getScalpSignals } from "@/features/scalping/fetch-signals";
import { openPaperTrade, resolveOpenTrades } from "@/features/scalping/paper-trader";
import type { ScalpStrategyId, ScalpTimeframe } from "@/features/scalping/types";

import { workerConfig } from "../config";
import { getPrisma } from "../db";
import { createLogger } from "../log";
import { scheduleJob, type JobHandle } from "../scheduler";

const log = createLogger("worker:scalper");

/**
 * Timeframes the worker fans out across on every tick. We deliberately open
 * a paper-trade lane per (symbol × strategy × timeframe) so the journal
 * always carries the full track record — the UI then filters down to the
 * lanes the user actually attached via the strategy picker. Keeping the
 * lanes in the DB means switching a timeframe on later instantly surfaces
 * history without having to re-run the worker.
 */
const TIMEFRAMES: ReadonlyArray<ScalpTimeframe> = ["1m", "5m", "15m"];

/**
 * Two-stage tick (repeated per timeframe):
 *   1. Pull the latest scalp signal per (symbol × strategy × timeframe);
 *      open a paper trade for any fresh trigger that doesn't dedupe against
 *      an existing OPEN row on the same strategy / timeframe lane.
 *   2. After all timeframes are scanned, walk all OPEN trades and try to
 *      close them against fresh 1m candles.
 *
 * The job is intentionally idempotent — running it more often only changes
 * the latency of TP/SL resolution, never the number of trades opened.
 */
export function startScalperJob(): JobHandle {
  return scheduleJob(
    {
      name: "scalper",
      intervalMs: workerConfig.scalper.intervalMs,
      runOnStart: false,
      tick: async () => {
        const child = log.child("tick");
        const prisma = getPrisma();

        let opened = 0;
        let dupSignal = 0;
        let alreadyOpen = 0;
        const openedByStrategy: Partial<Record<ScalpStrategyId, number>> = {};
        const openedByTf: Partial<Record<ScalpTimeframe, number>> = {};

        for (const tf of TIMEFRAMES) {
          try {
            const { signals } = await getScalpSignals({
              timeframe: tf,
              noCache: true,
            });
            for (const sig of signals) {
              const result = await openPaperTrade(sig, { prisma });
              if (result.opened) {
                opened += 1;
                openedByStrategy[sig.strategyId] = (openedByStrategy[sig.strategyId] ?? 0) + 1;
                openedByTf[tf] = (openedByTf[tf] ?? 0) + 1;
              } else if (result.reason === "duplicate-signal") {
                dupSignal += 1;
              } else if (result.reason === "already-open") {
                alreadyOpen += 1;
              }
            }
          } catch (err) {
            child.warn("signal fetch/open failed", {
              tf,
              err: (err as Error).message,
            });
          }
        }

        let resolveStats;
        try {
          resolveStats = await resolveOpenTrades(prisma);
        } catch (err) {
          child.warn("resolve failed", { err: (err as Error).message });
        }

        if (
          opened > 0 ||
          (resolveStats && resolveStats.wins + resolveStats.losses + resolveStats.expired > 0)
        ) {
          child.info("tick", {
            opened,
            dupSignal,
            alreadyOpen,
            byStrategy: openedByStrategy,
            byTimeframe: openedByTf,
            ...(resolveStats ?? {}),
          });
        }
      },
    },
    log,
  );
}
