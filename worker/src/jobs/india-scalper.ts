import { feedBar, type IndicatorConfig, type IndicatorHandle } from "@/features/indicators";
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
import { FNO_INDICES } from "@/lib/india/fno-symbols";
import { yahoo } from "@/services/india/yahoo";
import type { Candle } from "@/types/india/market";

import { workerConfig } from "../config";
import { getPrisma } from "../db";
import {
  indicatorStateKey,
  loadIndicatorState,
  saveIndicatorState,
} from "../indicator-state";
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

/** Default indicator configuration for India F&O indices. */
const INDICATOR_CONFIG: IndicatorConfig = {
  emaPeriod: 20,
  atrPeriod: 14,
  rsiPeriod: 14,
  bollingerPeriod: 20,
  bollingerK: 2,
};

/** NSE interval string → India yahoo interval map */
const TF_TO_INTERVAL: Record<IndiaScalpTimeframe, "1m" | "5m" | "15m"> = {
  "1m":  "1m",
  "5m":  "5m",
  "15m": "15m",
  "1d":  "5m",  // daily-based signals use 5m candles for intraday tracking
};

/**
 * Convert an India `Candle` (time in seconds) to the `OHLCVBar` shape
 * expected by `feedBar`. openTime and closeTime are derived from `time`
 * (seconds, IST-aligned Unix timestamp).
 */
function candleToBar(candle: Candle, intervalSec: number): Parameters<typeof feedBar>[1] {
  const openTimeMs = candle.time * 1000;
  return {
    openTime: openTimeMs,
    closeTime: openTimeMs + intervalSec * 1000 - 1,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume ?? 0,
  };
}

/**
 * Feed the latest 5-min candles for an F&O index into a persisted indicator
 * handle, then save the updated state back to Redis. This ensures indicator
 * state survives worker restarts — on the next tick, the handle is restored
 * and only new bars need to be fed (warm-up in ≤ 5 bars per Requirement 1.6).
 *
 * Best-effort — any error is logged and swallowed so the main trade-opening
 * logic is never blocked.
 */
async function refreshIndiaIndicatorState(
  yahooSymbol: string,
  underlying: string,
  timeframe: IndiaScalpTimeframe,
): Promise<void> {
  try {
    const interval = TF_TO_INTERVAL[timeframe];
    const intervalSec = interval === "1m" ? 60 : interval === "5m" ? 300 : 900;

    const candles = await yahoo.getHistorical({
      symbol: yahooSymbol,
      interval,
      range: "5d",
    });
    if (candles.length === 0) return;

    const key = indicatorStateKey("india-scalper", underlying, timeframe);
    const handle: IndicatorHandle = await loadIndicatorState(key, INDICATOR_CONFIG);

    for (const candle of candles) {
      feedBar(handle, candleToBar(candle, intervalSec));
    }

    await saveIndicatorState(key, handle);
  } catch (err) {
    log.warn("refreshIndiaIndicatorState failed", {
      underlying,
      timeframe,
      err: (err as Error).message,
    });
  }
}

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

            // Wire streaming indicator state persistence for F&O indices.
            // Fire-and-forget so Redis errors never block trade opening.
            void Promise.allSettled(
              FNO_INDICES.map((idx) =>
                refreshIndiaIndicatorState(idx.symbol, idx.underlying, tf),
              ),
            );

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
