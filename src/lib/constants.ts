import type { SymbolId, TrackedSymbol } from "@/types/market";

export const TRACKED_SYMBOLS: readonly TrackedSymbol[] = [
  {
    id: "BTC",
    name: "Bitcoin",
    binanceSpot: "BTCUSDT",
    binanceFutures: "BTCUSDT",
    coingeckoId: "bitcoin",
    color: "var(--color-btc)",
    brokers: {
      binance: { spot: "BTCUSDT", futures: "BTCUSDT" },
      delta: { spot: "BTCUSD", futures: "BTCUSD" },
    },
  },
  {
    id: "ETH",
    name: "Ethereum",
    binanceSpot: "ETHUSDT",
    binanceFutures: "ETHUSDT",
    coingeckoId: "ethereum",
    color: "var(--color-eth)",
    brokers: {
      binance: { spot: "ETHUSDT", futures: "ETHUSDT" },
      delta: { spot: "ETHUSD", futures: "ETHUSD" },
    },
  },
  {
    id: "SOL",
    name: "Solana",
    binanceSpot: "SOLUSDT",
    binanceFutures: "SOLUSDT",
    coingeckoId: "solana",
    color: "var(--color-sol)",
    brokers: {
      binance: { spot: "SOLUSDT", futures: "SOLUSDT" },
      delta: { spot: "SOLUSD", futures: "SOLUSD" },
    },
  },
] as const;

/**
 * Lookup the tracked metadata by Binance futures pair. Kept for legacy code
 * paths (alerts, worker liquidation envelope decoding) but new code should
 * prefer `brokerPairToSymbolId(brokerId, pair)` below which is broker-aware.
 */
export const SYMBOLS_BY_BINANCE: Record<string, TrackedSymbol> = TRACKED_SYMBOLS.reduce(
  (acc, s) => {
    acc[s.binanceSpot] = s;
    return acc;
  },
  {} as Record<string, TrackedSymbol>,
);

/**
 * Reverse map: a broker-native pair (e.g. `BTCUSD`) back to our generic
 * `SymbolId`. Returns null when the pair isn't one we track on that broker.
 */
export function brokerPairToSymbolId(
  brokerId: "binance" | "delta",
  pair: string,
): SymbolId | null {
  for (const meta of TRACKED_SYMBOLS) {
    const cfg = meta.brokers[brokerId];
    if (cfg.spot === pair || cfg.futures === pair) return meta.id;
  }
  return null;
}

export const REDIS_KEYS = {
  marketOverview: "market:overview:v2",
  fearGreed: "sentiment:fearGreed:v1",
  sentiment: "sentiment:engine:v1",
  futuresOverview: "futures:overview:v2",
  funding: (symbol: string) => `futures:funding:${symbol}:v1`,
  openInterest: (symbol: string) => `futures:oi:${symbol}:v1`,
  topMovers: "futures:topMovers:v1",
  optionsOverview: (currency: string) => `options:overview:${currency}:v1`,
  klines: (symbol: string, interval: string) => `klines:${symbol}:${interval}:v1`,
  signals: "signals:engine:v1",
  // Rolling buffer of recent liquidation events per Binance futures symbol.
  // Sorted set; score = event timestamp (ms); member = JSON event payload.
  liquidationBuffer: (binanceFuturesSymbol: string) => `liq:rolling:${binanceFuturesSymbol}:v1`,
  // Last-trigger timestamp for an alert (cooldown gating).
  alertCooldown: (alertId: string) => `alert:cooldown:${alertId}:v1`,
  // Scalper engine cached snapshot per timeframe.
  scalper: {
    signals: "scalper:signals:v1",
  },
  // Last paper-trade signature per symbol+timeframe — used to dedupe trades
  // when the worker re-runs the engine on the same closed bar.
  scalperLastTrade: (symbol: string, timeframe: string) =>
    `scalper:lastTrade:${symbol}:${timeframe}:v1`,
} as const;

/** Window used by both the signal engine and the LIQUIDATION_SURGE alert. */
export const LIQUIDATION_WINDOW_MS = 5 * 60 * 1000;
/** TTL on the rolling-buffer key as a safety net if the worker dies. */
export const LIQUIDATION_BUFFER_TTL_SECONDS = 30 * 60;

export const CACHE_TTL_SECONDS = {
  marketOverview: 15,
  fearGreed: 60 * 5,
  sentiment: 30,
  futuresOverview: 15,
  funding: 30,
  openInterest: 30,
  topMovers: 15,
  optionsOverview: 60,
  klines: 60,
  signals: 30,
  scalper: 20,
} as const;
