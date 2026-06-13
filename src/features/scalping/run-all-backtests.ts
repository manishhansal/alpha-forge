import "server-only";

import {
  backtestStrategy,
  type ScalpBacktestResult,
  type ScalpBacktestStats,
} from "@/features/scalping/backtest";
import {
  BACKTEST_INTERVAL_CONFIG,
  BACKTEST_INTERVAL_DEFAULT,
  type BacktestInterval,
} from "@/features/scalping/backtest-intervals";
import { SCALP_STRATEGY_MODULES } from "@/features/scalping/strategies";
import { SCALP_STRATEGY_CATALOG } from "@/features/scalping/strategies/catalog";
import {
  aggregateStats,
  scoreStrategy,
  type StrategyScoreBreakdown,
} from "@/features/scalping/strategy-score";
import type { ScalpStrategyId } from "@/features/scalping/types";
import { binanceServerAdapter } from "@/services/brokers/binance/adapter";
import { getServerBroker } from "@/services/brokers/registry";
import type { KlineInterval } from "@/services/binance/klines";
import type { ServerBrokerAdapter } from "@/services/brokers/server-types";
import type { KlineCandle, SymbolId } from "@/types/market";

// Re-export the client-safe interval surface so callers that still pull
// from this module keep working without needing to know about the split.
export {
  BACKTEST_INTERVAL_CONFIG,
  BACKTEST_INTERVAL_DEFAULT,
  BACKTEST_INTERVAL_OPTIONS,
  BACKTEST_INTERVAL,
  BACKTEST_PERIOD_YEARS,
  type BacktestInterval,
  type BacktestIntervalConfig,
} from "@/features/scalping/backtest-intervals";

/**
 * Multi-strategy historical backtest runner with selectable bar interval.
 *
 * Loads N candles for BTC / ETH / SOL once, then runs every registered
 * scalping strategy module across all three symbols with a fixed $10,000
 * starting equity and $10,000 per-trade notional. The aggregated per-strategy
 * stats feed the scoring engine to produce a 0-100 score, letter grade and
 * recommendation that the UI surfaces in the strategy picker.
 *
 * Why a per-interval period: Binance's REST API caps each request at 1000
 * candles, our paging helper allows up to 20 requests = 20k bars per symbol,
 * and the backtester itself starts to feel slow above ~12k bars per run.
 * So the lookback window adapts to the interval — short timeframes get a
 * short window (e.g. 1m / 7 days = 10k bars) and long timeframes get the
 * full multi-year history (4h / 5 years = ~11k bars). Every supported
 * interval lands in the same 1k-11k bar zone so the suite stays fast.
 *
 * The 10m interval isn't natively supported by Binance — we fetch 5m
 * candles and aggregate every two consecutive bars into one 10m bar.
 *
 * Why the broker fallback: Delta Exchange India (our default live broker)
 * only retains ~14 months of 4h candle history for the BTC/ETH/SOL perps,
 * and its `/v2/history/candles` returns an empty result for windows older
 * than that — which would silently kill the backtest. So historical replay
 * always tries the live broker first and **falls back to Binance** (full
 * multi-year spot history) whenever the active broker comes back short.
 * The live scalper still uses whatever broker is configured.
 *
 * Results are cached per `(broker, interval)` for `CACHE_TTL_MS` (24h) so
 * subsequent requests are instant. We deliberately DO NOT cache failure
 * cases (zero candles fetched from every source) so a flaky upstream
 * doesn't pin the dashboard in an empty state for the next 24h.
 */

export const BACKTEST_START_EQUITY = 10_000;
export const BACKTEST_NOTIONAL = 10_000;
export const BACKTEST_SYMBOLS: ReadonlyArray<SymbolId> = ["BTC", "ETH", "SOL"];

const DAY_MS = 24 * 60 * 60 * 1000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** Anything fewer than this many candles is treated as "no useful history". */
const MIN_USEFUL_CANDLES = 400;

export interface ScalpStrategyBacktestReport {
  strategyId: ScalpStrategyId;
  /** Per-symbol detailed result (with trade log + equity curve). */
  perSymbol: Array<ScalpBacktestResult & { symbol: SymbolId }>;
  /** Cross-symbol aggregate (trade counts + weighted means). */
  aggregate: ScalpBacktestStats;
  /** 0..100 score + grade + recommendation. */
  score: StrategyScoreBreakdown;
}

export interface ScalpBacktestSuite {
  generatedAt: number;
  /** Bar interval the suite ran on (e.g. `5m`, `4h`). */
  interval: BacktestInterval;
  /** Human-friendly label for the lookback window (e.g. `30 days`). */
  periodLabel: string;
  /** Lookback window in milliseconds. */
  periodMs: number;
  /** Legacy — kept so older consumers can still read "the 5-year suite".
   *  Equals `periodMs / (365 * 24h)` rounded for display. */
  periodYears: number;
  startEquity: number;
  notional: number;
  symbols: SymbolId[];
  /** Which broker actually supplied the candles — useful for debugging
   *  history-window mismatches. */
  candleSource: "active-broker" | "binance-fallback" | "mixed" | "none";
  /** Per-symbol meta so the UI can surface "BTC has 2,500 bars from Binance, ETH used Delta". */
  candleMeta: Array<{
    symbol: SymbolId;
    source: "active-broker" | "binance-fallback" | "none";
    /** Number of closed bars actually fed into the strategy runner. */
    bars: number;
    /** Earliest bar fed to the strategies. */
    fromMs: number;
    /** Latest bar fed to the strategies. */
    toMs: number;
  }>;
  reports: ScalpStrategyBacktestReport[];
}

interface CacheEntry {
  brokerId: string;
  interval: BacktestInterval;
  generatedAt: number;
  promise: Promise<ScalpBacktestSuite>;
}

/** Cache keyed by `${brokerId}:${interval}` so the Scalper page (4h) and
 *  the Strategy Backtest page (any interval) can coexist without thrashing
 *  each other's results. */
const cache = new Map<string, CacheEntry>();

function cacheKey(brokerId: string, interval: BacktestInterval): string {
  return `${brokerId}:${interval}`;
}

/**
 * Get the full backtest suite for `interval`, computing it on first call
 * and serving the cached result thereafter. Multiple concurrent callers
 * for the same `(broker, interval)` share the same in-flight promise so we
 * never run the suite twice.
 */
export function getStrategyBacktestSuite(opts?: {
  force?: boolean;
  interval?: BacktestInterval;
}): Promise<ScalpBacktestSuite> {
  const broker = getServerBroker();
  const interval = opts?.interval ?? BACKTEST_INTERVAL_DEFAULT;
  const key = cacheKey(broker.id, interval);
  const now = Date.now();
  const existing = cache.get(key);
  if (!opts?.force && existing && now - existing.generatedAt < CACHE_TTL_MS) {
    return existing.promise;
  }
  const promise = computeSuite(interval);
  const entry: CacheEntry = { brokerId: broker.id, interval, generatedAt: now, promise };
  cache.set(key, entry);
  // Drop the cache entry if the computation errors so the next call retries.
  promise.catch(() => {
    if (cache.get(key) === entry) cache.delete(key);
  });
  return promise;
}

async function computeSuite(interval: BacktestInterval): Promise<ScalpBacktestSuite> {
  const activeBroker = getServerBroker();
  const config = BACKTEST_INTERVAL_CONFIG[interval];
  const endMs = Date.now();
  const startMs = endMs - config.periodMs;

  // Load candles for every symbol in parallel. Try the active broker first
  // for live-data parity; fall back to Binance whenever it returns fewer
  // than `MIN_USEFUL_CANDLES` bars (Delta India for example only stores
  // ~14 months of 4h history). The fallback always uses Binance's USDT
  // perp/spot since the historical depth is essentially unlimited.
  const candleEntries = await Promise.all(
    BACKTEST_SYMBOLS.map(async (symbol) =>
      loadCandlesForSymbol(symbol, activeBroker, config.fetchInterval, startMs, endMs),
    ),
  );

  const candleMap = new Map<SymbolId, KlineCandle[]>();
  for (const entry of candleEntries) {
    // For 10m we fetched 5m bars; collapse them into 10m bars before the
    // strategies see them.
    const candles = config.aggregateEvery
      ? aggregateCandles(entry.candles, config.aggregateEvery)
      : entry.candles;
    candleMap.set(entry.symbol, candles);
  }

  const candleMeta = BACKTEST_SYMBOLS.map((symbol) => {
    const entry = candleEntries.find((e) => e.symbol === symbol);
    const candles = candleMap.get(symbol) ?? [];
    return {
      symbol,
      source: entry?.source ?? ("none" as const),
      bars: candles.length,
      fromMs: candles[0]?.closeTime ?? 0,
      toMs: candles[candles.length - 1]?.closeTime ?? 0,
    };
  });

  // If literally every symbol failed to produce candles, fail fast so the
  // caller can retry rather than caching a useless empty payload for 24h.
  const totalBars = candleMeta.reduce((s, m) => s + m.bars, 0);
  if (totalBars === 0) {
    throw new Error(
      `Strategy backtest aborted: no candles returned from active broker or Binance fallback for any of ${BACKTEST_SYMBOLS.join(", ")}.`,
    );
  }

  const sources = new Set(candleMeta.filter((m) => m.bars > 0).map((m) => m.source));
  const candleSource: ScalpBacktestSuite["candleSource"] =
    sources.size === 0
      ? "none"
      : sources.size > 1
        ? "mixed"
        : ([...sources][0] as "active-broker" | "binance-fallback");

  const reports: ScalpStrategyBacktestReport[] = [];
  for (const meta of SCALP_STRATEGY_CATALOG) {
    const mod = SCALP_STRATEGY_MODULES[meta.id];
    if (!mod) continue;

    const perSymbol: Array<ScalpBacktestResult & { symbol: SymbolId }> = [];
    for (const symbol of BACKTEST_SYMBOLS) {
      const candles = candleMap.get(symbol) ?? [];
      // Drop the in-progress bar so the engine never opens a signal off an
      // unclosed candle.
      const closed = candles.length > 1 ? candles.slice(0, -1) : candles;
      const result = backtestStrategy({
        mod,
        symbol,
        interval,
        candles: closed,
        startEquity: BACKTEST_START_EQUITY,
        notional: BACKTEST_NOTIONAL,
        maxHoldBars: 48,
      });
      perSymbol.push({ ...result, symbol });
    }

    const aggregate =
      aggregateStats(perSymbol.map((r) => r.stats)) ?? {
        strategyId: meta.id,
        symbol: "BTC",
        interval,
        startTs: 0,
        endTs: 0,
        startEquity: BACKTEST_START_EQUITY * BACKTEST_SYMBOLS.length,
        endEquity: BACKTEST_START_EQUITY * BACKTEST_SYMBOLS.length,
        totalReturnPct: 0,
        buyHoldReturnPct: 0,
        totalTrades: 0,
        wins: 0,
        losses: 0,
        expired: 0,
        winRate: 0,
        profitFactor: 0,
        avgWinPct: 0,
        avgLossPct: 0,
        largestWinPct: 0,
        largestLossPct: 0,
        maxDrawdownPct: 0,
        sharpe: 0,
        avgBarsHeld: 0,
        totalPnlUsd: 0,
        barsScanned: 0,
      };
    const score = scoreStrategy(aggregate);

    reports.push({ strategyId: meta.id, perSymbol, aggregate, score });
  }

  return {
    generatedAt: Date.now(),
    interval,
    periodLabel: config.periodLabel,
    periodMs: config.periodMs,
    periodYears: Math.max(
      1,
      Math.round((config.periodMs / (365 * DAY_MS)) * 10) / 10,
    ),
    startEquity: BACKTEST_START_EQUITY,
    notional: BACKTEST_NOTIONAL,
    symbols: [...BACKTEST_SYMBOLS],
    candleSource,
    candleMeta,
    reports,
  };
}

interface SymbolCandleLoad {
  symbol: SymbolId;
  candles: KlineCandle[];
  source: "active-broker" | "binance-fallback" | "none";
}

/**
 * Fetch candles for `symbol` over `[startMs, endMs]`. Tries the live broker
 * first so users see the same price tape they trade against; falls back to
 * Binance when the active broker comes back short on history.
 */
async function loadCandlesForSymbol(
  symbol: SymbolId,
  activeBroker: ServerBrokerAdapter,
  fetchInterval: KlineInterval,
  startMs: number,
  endMs: number,
): Promise<SymbolCandleLoad> {
  const pair = activeBroker.pairs.spot[symbol];
  let activeCandles: KlineCandle[] = [];
  if (pair) {
    try {
      activeCandles = await activeBroker.fetchKlinesRange(
        pair,
        fetchInterval,
        startMs,
        endMs,
      );
    } catch (err) {
      console.warn(
        `[strategy-backtest] active broker (${activeBroker.id}) kline fetch failed for ${pair} ${fetchInterval}:`,
        (err as Error).message,
      );
    }
  }

  if (activeCandles.length >= MIN_USEFUL_CANDLES) {
    return { symbol, candles: activeCandles, source: "active-broker" };
  }

  // Active broker came up short. Try Binance directly — `binanceServerAdapter`
  // is its own thing so this works even when Binance isn't the active broker.
  const fallbackPair = binanceServerAdapter.pairs.spot[symbol];
  if (fallbackPair && activeBroker.id !== "binance") {
    try {
      const fallbackCandles = await binanceServerAdapter.fetchKlinesRange(
        fallbackPair,
        fetchInterval,
        startMs,
        endMs,
      );
      if (fallbackCandles.length > activeCandles.length) {
        console.info(
          `[strategy-backtest] using Binance fallback for ${symbol} ${fetchInterval} (active broker returned ${activeCandles.length} bars, Binance returned ${fallbackCandles.length})`,
        );
        return { symbol, candles: fallbackCandles, source: "binance-fallback" };
      }
    } catch (err) {
      console.warn(
        `[strategy-backtest] Binance fallback fetch failed for ${fallbackPair} ${fetchInterval}:`,
        (err as Error).message,
      );
    }
  }

  if (activeCandles.length > 0) {
    return { symbol, candles: activeCandles, source: "active-broker" };
  }
  return { symbol, candles: [], source: "none" };
}

/**
 * Roll up every `groupSize` consecutive candles into a single combined bar.
 * Open = first.open, Close = last.close, High/Low = group extremes, Volume
 * is summed. Used to synthesize a `10m` series from native `5m` candles
 * (Binance doesn't ship a 10m interval).
 */
function aggregateCandles(candles: KlineCandle[], groupSize: number): KlineCandle[] {
  if (groupSize <= 1) return candles;
  const out: KlineCandle[] = [];
  for (let i = 0; i + groupSize <= candles.length; i += groupSize) {
    const slice = candles.slice(i, i + groupSize);
    const first = slice[0];
    const last = slice[slice.length - 1];
    let high = first.high;
    let low = first.low;
    let volume = 0;
    for (const c of slice) {
      if (c.high > high) high = c.high;
      if (c.low < low) low = c.low;
      volume += c.volume;
    }
    out.push({
      openTime: first.openTime,
      open: first.open,
      high,
      low,
      close: last.close,
      volume,
      closeTime: last.closeTime,
    });
  }
  return out;
}
