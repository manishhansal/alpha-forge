import { feedBar, type IndicatorConfig, type IndicatorHandle } from "@/features/indicators";
import { getScalpSignals } from "@/features/scalping/fetch-signals";
import { openPaperTrade, resolveOpenTrades } from "@/features/scalping/paper-trader";
import type { ScalpStrategyId, ScalpTimeframe } from "@/features/scalping/types";
import { TRACKED_SYMBOLS } from "@/lib/constants";
import { getServerBroker } from "@/services/brokers/registry";
import type { KlineInterval } from "@/services/binance/klines";
import { checkAndSetTradeGuard, WorkerCheckpoint } from "@/lib/chaos/worker-resilience";
import { withDbRetry, paperTradeDLQ } from "@/lib/chaos/db-resilience";

import { workerConfig } from "../config";
import { getPrisma } from "../db";
import {
  indicatorStateKey,
  loadIndicatorState,
  saveIndicatorState,
} from "../indicator-state";
import { createLogger } from "../log";
import { getRedis } from "../redis";
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

/** Default indicator configuration used for state persistence. */
const INDICATOR_CONFIG: IndicatorConfig = {
  emaPeriod: 20,
  atrPeriod: 14,
  rsiPeriod: 14,
  bollingerPeriod: 20,
  bollingerK: 2,
};

const TIMEFRAME_TO_INTERVAL: Record<ScalpTimeframe, KlineInterval> = {
  "1m": "1m",
  "5m": "5m",
  "15m": "15m",
};

/** Required bars to maintain a warm indicator handle. */
const REQUIRED_BARS = 200;

/**
 * Feed the latest candles from the broker into a persisted indicator handle,
 * then save the updated state back to Redis. This ensures indicator state
 * survives worker restarts — on the next tick, the handle is restored and
 * only new bars need to be fed (warm-up in ≤ 5 bars per Requirement 1.6).
 *
 * Best-effort — any error is logged and swallowed so the main trade-opening
 * logic is never blocked.
 */
async function refreshIndicatorState(
  symbol: string,
  timeframe: ScalpTimeframe,
): Promise<void> {
  try {
    const broker = getServerBroker();
    const symbolMeta = TRACKED_SYMBOLS.find((s) => s.id === symbol);
    if (!symbolMeta) return;

    const pair = broker.pairs.spot[symbolMeta.id];
    if (!pair) return;

    const interval = TIMEFRAME_TO_INTERVAL[timeframe];
    const candles = await broker.fetchKlines(pair, interval, REQUIRED_BARS);
    if (candles.length === 0) return;

    const key = indicatorStateKey("scalper", symbol, timeframe);
    const handle: IndicatorHandle = await loadIndicatorState(key, INDICATOR_CONFIG);

    // Feed all candles through the streaming handle (O(n) on first run,
    // O(few) on subsequent runs when state was persisted).
    for (const candle of candles) {
      feedBar(handle, candle);
    }

    await saveIndicatorState(key, handle);
  } catch (err) {
    log.warn("refreshIndicatorState failed", {
      symbol,
      timeframe,
      err: (err as Error).message,
    });
  }
}

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
 *
 * Chaos Engineering Hardening:
 *   - Scenario 8:  checkAndSetTradeGuard (Redis) provides a second layer of
 *     duplicate prevention on top of the DB findFirst dedup in paper-trader.ts,
 *     guarding against rapid restart between create and tick completion.
 *   - Scenario 9:  WorkerCheckpoint persists completed (symbol, timeframe)
 *     pairs so a crash mid-loop resumes without re-processing items.
 *   - Scenario 2:  DB writes are wrapped in withDbRetry; failures after all
 *     retries go to paperTradeDLQ for replay on next tick.
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

        let redis;
        try { redis = getRedis(); } catch { /* Redis unavailable — checkpoint/guard skipped */ }

        // ── Chaos Scenario 9: crash-recovery checkpoint ───────────────────
        const checkpoint = redis ? new WorkerCheckpoint(redis, "scalper") : null;
        const priorCheckpoint = await checkpoint?.load();
        if (priorCheckpoint) {
          child.warn("resuming from crash checkpoint", {
            phase: priorCheckpoint.phase,
            completed: priorCheckpoint.completedItems.length,
          });
        }
        await checkpoint?.start("open-trades");

        // ── Flush DLQ from previous failed ticks ──────────────────────────
        if (paperTradeDLQ.size > 0) {
          await paperTradeDLQ.flush(async (entry) => {
            const { signal, opts } = entry.payload as {
              signal: Parameters<typeof openPaperTrade>[0];
              opts: Parameters<typeof openPaperTrade>[1];
            };
            await openPaperTrade(signal, { ...opts, prisma });
          });
        }

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

            // Wire streaming indicator state persistence. Fire-and-forget so
            // Redis errors never block trade opening.
            void Promise.allSettled(
              TRACKED_SYMBOLS.map((s) => refreshIndicatorState(s.id, tf)),
            );

            for (const sig of signals) {
              const itemId = `${sig.symbol}:${tf}:${sig.triggeredAt}`;

              // Skip already-completed items from crash checkpoint
              if (checkpoint?.isCompleted(itemId)) {
                child.debug("skipping checkpoint-completed item", { itemId });
                continue;
              }

              // ── Chaos Scenario 8: Redis trade guard ──────────────────────
              if (redis) {
                const source = `${sig.strategyId}:${tf}`;
                const guard = await checkAndSetTradeGuard(
                  redis, source, sig.symbol, sig.triggeredAt,
                );
                if (guard.isDuplicate) {
                  dupSignal++;
                  await checkpoint?.markCompleted(itemId);
                  continue;
                }
              }

              // ── Chaos Scenario 2: DB retry + DLQ ─────────────────────────
              let result;
              try {
                result = await withDbRetry(
                  () => openPaperTrade(sig, { prisma }),
                  { label: `scalper:open:${sig.symbol}:${tf}`, maxAttempts: 3 },
                );
              } catch (dbErr) {
                paperTradeDLQ.enqueue(
                  "open-paper-trade",
                  { signal: sig, opts: { notional: undefined } },
                  (dbErr as Error).message,
                );
                child.warn("paper trade enqueued to DLQ after DB failure", {
                  symbol: sig.symbol, tf,
                });
                continue;
              }

              if (result.opened) {
                opened += 1;
                openedByStrategy[sig.strategyId] = (openedByStrategy[sig.strategyId] ?? 0) + 1;
                openedByTf[tf] = (openedByTf[tf] ?? 0) + 1;

                // Register the tradeId in the Redis guard so restart dedup works
                if (redis && result.tradeId) {
                  const source = `${sig.strategyId}:${tf}`;
                  await checkAndSetTradeGuard(redis, source, sig.symbol, sig.triggeredAt, result.tradeId);
                }
              } else if (result.reason === "duplicate-signal") {
                dupSignal += 1;
              } else if (result.reason === "already-open") {
                alreadyOpen += 1;
              }

              await checkpoint?.markCompleted(itemId);
            }
          } catch (err) {
            child.warn("signal fetch/open failed", {
              tf,
              err: (err as Error).message,
            });
          }
        }

        await checkpoint?.advancePhase("resolve-trades");

        let resolveStats;
        try {
          resolveStats = await withDbRetry(
            () => resolveOpenTrades(prisma),
            { label: "scalper:resolve", maxAttempts: 3 },
          );
        } catch (err) {
          child.warn("resolve failed", { err: (err as Error).message });
        }

        // Clear checkpoint on successful tick completion
        await checkpoint?.clear();

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
            dlqSize: paperTradeDLQ.size,
            ...(resolveStats ?? {}),
          });
        }
      },
    },
    log,
  );
}
