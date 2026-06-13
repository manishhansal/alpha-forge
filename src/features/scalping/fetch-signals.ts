import "server-only";

import { CACHE_TTL_SECONDS, REDIS_KEYS, TRACKED_SYMBOLS } from "@/lib/constants";
import { cached } from "@/lib/redis";
import { DEFAULT_STRATEGY_IDS, runScalpEngine } from "@/features/scalping/engine";
import type {
  ScalpSignal,
  ScalpSignalsResponse,
  ScalpStrategyId,
  ScalpTimeframe,
} from "@/features/scalping/types";
import { getServerBroker } from "@/services/brokers/registry";
import type { KlineInterval } from "@/services/binance/klines";

export interface FetchScalpOptions {
  /** Defaults to 5m — the timeframe most actively traded by scalp setups. */
  timeframe?: ScalpTimeframe;
  /** Bypass the Redis cache. Used by the worker tick to ensure fresh data. */
  noCache?: boolean;
  /**
   * Restrict the response to the supplied strategies. Defaults to every
   * registered strategy. Order doesn't matter — output is grouped by symbol
   * then by strategy evaluation order.
   */
  strategies?: ReadonlyArray<ScalpStrategyId>;
}

const TIMEFRAME_TO_INTERVAL: Record<ScalpTimeframe, KlineInterval> = {
  "1m": "1m",
  "5m": "5m",
  "15m": "15m",
};

const REQUIRED_BARS = 200;

async function buildResponse(
  timeframe: ScalpTimeframe,
  strategies: ReadonlyArray<ScalpStrategyId>,
): Promise<ScalpSignalsResponse> {
  const broker = getServerBroker();
  const interval = TIMEFRAME_TO_INTERVAL[timeframe];
  const perSymbol = await Promise.all(
    TRACKED_SYMBOLS.map(async (s) => {
      const pair = broker.pairs.spot[s.id];
      try {
        const candles = await broker.fetchKlines(pair, interval, REQUIRED_BARS);
        // Drop the in-progress bar so we never fire a signal on an unclosed
        // candle (the broker's last entry is typically the live bar).
        const closed = candles.length > 0 ? candles.slice(0, -1) : candles;
        return runScalpEngine({
          symbol: s.id,
          timeframe,
          candles: closed,
          strategies,
        });
      } catch (err) {
        console.warn(
          `[scalper] kline fetch failed for ${pair} ${interval}:`,
          (err as Error).message,
        );
        return [] as ScalpSignal[];
      }
    }),
  );

  const signals = perSymbol.flat();

  return {
    generatedAt: Date.now(),
    timeframe,
    signals,
  };
}

/**
 * Cache key for a (timeframe, strategy-set) combination. The cache always
 * runs every registered strategy server-side and slices the response down
 * to the requested ids — that way the worker, the page, and per-user
 * filters all share one expensive kline fetch.
 */
function cacheKey(timeframe: ScalpTimeframe): string {
  return `${REDIS_KEYS.scalper.signals}:${timeframe}:all`;
}

export async function getScalpSignals(
  opts: FetchScalpOptions = {},
): Promise<ScalpSignalsResponse> {
  const timeframe = opts.timeframe ?? "5m";
  const requested = opts.strategies && opts.strategies.length > 0
    ? opts.strategies
    : DEFAULT_STRATEGY_IDS;

  const fullResponse = opts.noCache
    ? await buildResponse(timeframe, DEFAULT_STRATEGY_IDS)
    : await cached(
        cacheKey(timeframe),
        CACHE_TTL_SECONDS.scalper,
        () => buildResponse(timeframe, DEFAULT_STRATEGY_IDS),
      );

  if (requested === DEFAULT_STRATEGY_IDS || sameSet(requested, DEFAULT_STRATEGY_IDS)) {
    return fullResponse;
  }
  const allowed = new Set(requested);
  return {
    ...fullResponse,
    signals: fullResponse.signals.filter((s) => allowed.has(s.strategyId)),
  };
}

function sameSet<T>(a: ReadonlyArray<T>, b: ReadonlyArray<T>): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
}
