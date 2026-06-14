import { getIndiaScalpSignals } from "@/features/india/scalping/fetch-signals";
import {
  getIndiaIntradayAtr,
  openIndiaPaperTrade,
  resolveIndiaOpenTrades,
} from "@/features/india/scalping/paper-trader";
import type {
  IndiaScalpStrategyId,
  IndiaScalpTimeframe,
} from "@/features/india/scalping/types";

import { workerConfig } from "../config";
import { getPrisma } from "../db";
import { createLogger } from "../log";
import { scheduleJob, type JobHandle } from "../scheduler";

const log = createLogger("worker:india-scalper");

/**
 * Timeframes the India F&O paper-trader fans out across each tick. Same
 * lane model as the crypto scalper — one paper-trade lane per
 * (symbol × strategy × timeframe) so the journal carries the full track
 * record and the UI filters down to the lanes the user attached.
 */
const TIMEFRAMES: ReadonlyArray<IndiaScalpTimeframe> = ["1m", "5m", "15m"];

/**
 * Two-stage tick (mirrors the crypto scalper):
 *   1. Pull the latest India signals per timeframe; size each fresh
 *      trigger off a real intraday ATR (NSE tick-rounded) and open a
 *      paper trade unless it dedupes against an OPEN lane or falls inside
 *      the expiry-day cooldown.
 *   2. Walk every OPEN India trade and resolve it against fresh 5m candles.
 *
 * ATR is fetched once per unique symbol per tick (Yahoo memoises the call)
 * so fanning out across timeframes stays cheap.
 */
export function startIndiaScalperJob(): JobHandle {
  return scheduleJob(
    {
      name: "india-scalper",
      intervalMs: workerConfig.indiaScalper.intervalMs,
      runOnStart: false,
      tick: async () => {
        const child = log.child("tick");
        const prisma = getPrisma();

        let opened = 0;
        let dupSignal = 0;
        let alreadyOpen = 0;
        let cooldown = 0;
        const atrBySymbol = new Map<string, number | null>();
        const openedByStrategy: Partial<Record<IndiaScalpStrategyId, number>> = {};

        for (const tf of TIMEFRAMES) {
          try {
            const { signals } = await getIndiaScalpSignals({ timeframe: tf });
            for (const sig of signals) {
              if (!atrBySymbol.has(sig.symbol)) {
                atrBySymbol.set(sig.symbol, await getIndiaIntradayAtr(sig.symbol));
              }
              const atr = atrBySymbol.get(sig.symbol) ?? undefined;

              const result = await openIndiaPaperTrade(sig, {
                prisma,
                atr: atr ?? undefined,
              });
              if (result.opened) {
                opened += 1;
                openedByStrategy[sig.strategyId] =
                  (openedByStrategy[sig.strategyId] ?? 0) + 1;
              } else if (result.reason === "duplicate-signal") {
                dupSignal += 1;
              } else if (result.reason === "already-open") {
                alreadyOpen += 1;
              } else if (result.reason === "expiry-cooldown") {
                cooldown += 1;
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
          resolveStats = await resolveIndiaOpenTrades(prisma);
        } catch (err) {
          child.warn("resolve failed", { err: (err as Error).message });
        }

        if (
          opened > 0 ||
          (resolveStats &&
            resolveStats.wins + resolveStats.losses + resolveStats.expired > 0)
        ) {
          child.info("tick", {
            opened,
            dupSignal,
            alreadyOpen,
            cooldown,
            byStrategy: openedByStrategy,
            ...(resolveStats ?? {}),
          });
        }
      },
    },
    log,
  );
}
