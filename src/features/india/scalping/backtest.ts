import "server-only";

import { yahoo } from "@/services/india/yahoo";

import {
  backtestIndiaPriceStrategy,
  summariseTrades,
  summaryToScoreInput,
} from "@/features/india/scalping/backtest-core";
import {
  INDIA_PRICE_STRATEGY_MODULES,
  type IndiaPriceStrategyId,
} from "@/features/india/scalping/strategies/price-modules";
import {
  scoreIndiaStrategy,
  type IndiaStrategyScore,
} from "@/features/india/scalping/strategy-score";
import type { IndiaScalpStrategyId } from "@/features/india/scalping/types";
import type { Candle } from "@/types/india";

/**
 * 5-year OHLCV backtest runner for the three price-derivable India
 * strategies (Range Expansion / Momentum / Volume Breakout). The five
 * option-chain strategies have no historical data source, so they're
 * scored off the live paper-trade record instead (see `score-board.ts`).
 *
 * Candles are daily bars over ~5 years from Yahoo for a basket of liquid
 * F&O large-caps. Each module is replayed bar-by-bar across the whole
 * basket; the pooled trades are summarised and fed through the shared
 * `scoreIndiaStrategy` engine so a backtested score sits on the exact
 * same 0–100 scale as a paper-trade score.
 *
 * Results are cached in-process for 24h — the daily-bar suite barely
 * shifts intraday and the fetch (≈12 symbols × 5y) is the slow part.
 */

/** Liquid F&O large-caps with deep, clean Yahoo daily history. */
export const INDIA_BACKTEST_UNIVERSE: ReadonlyArray<string> = [
  "RELIANCE",
  "HDFCBANK",
  "ICICIBANK",
  "INFY",
  "TCS",
  "SBIN",
  "AXISBANK",
  "ITC",
  "LT",
  "KOTAKBANK",
  "HINDUNILVR",
  "BHARTIARTL",
];

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** Fewer than this many bars for a symbol → skip it (Yahoo came up short). */
const MIN_USEFUL_CANDLES = 400;

type BacktestScoreMap = Partial<Record<IndiaScalpStrategyId, IndiaStrategyScore>>;

interface CacheEntry {
  at: number;
  promise: Promise<BacktestScoreMap>;
}
let cacheEntry: CacheEntry | null = null;

/**
 * Get backtest-derived scores for the price strategies. Cached for 24h;
 * a failed run is not cached so the next caller retries.
 */
export function getIndiaBacktestScores(opts?: {
  force?: boolean;
}): Promise<BacktestScoreMap> {
  const now = Date.now();
  if (!opts?.force && cacheEntry && now - cacheEntry.at < CACHE_TTL_MS) {
    return cacheEntry.promise;
  }
  const entry: CacheEntry = { at: now, promise: computeBacktestScores() };
  cacheEntry = entry;
  entry.promise.catch(() => {
    if (cacheEntry === entry) cacheEntry = null;
  });
  return entry.promise;
}

async function computeBacktestScores(): Promise<BacktestScoreMap> {
  const loaded = await Promise.allSettled(
    INDIA_BACKTEST_UNIVERSE.map(async (symbol) => {
      const candles = await yahoo.getHistorical({
        symbol,
        interval: "1d",
        range: "5y",
      });
      // Drop the in-progress bar so we never open off an unclosed candle.
      const closed = candles.length > 1 ? candles.slice(0, -1) : candles;
      return { symbol, candles: closed };
    }),
  );

  const candleSets: Candle[][] = [];
  for (const r of loaded) {
    if (r.status === "fulfilled" && r.value.candles.length >= MIN_USEFUL_CANDLES) {
      candleSets.push(r.value.candles);
    } else if (r.status === "rejected") {
      console.warn("[india/backtest] candle fetch failed", r.reason);
    }
  }
  if (candleSets.length === 0) return {};

  const out: BacktestScoreMap = {};
  const ids = Object.keys(INDIA_PRICE_STRATEGY_MODULES) as IndiaPriceStrategyId[];
  for (const id of ids) {
    const mod = INDIA_PRICE_STRATEGY_MODULES[id];
    const pooled = candleSets.flatMap((candles) =>
      backtestIndiaPriceStrategy({ candles, mod }),
    );
    const summary = summariseTrades(pooled);
    const score = scoreIndiaStrategy(summaryToScoreInput(id, summary, "backtest"));
    if (score) out[id] = score;
  }
  return out;
}
