import "server-only";

import { CACHE_TTL_SECONDS, REDIS_KEYS, TRACKED_SYMBOLS } from "@/lib/constants";
import { cached } from "@/lib/redis";
import { getServerBroker } from "@/services/brokers/registry";
import type {
  NormalizedFuturesTicker,
  NormalizedTicker,
} from "@/services/brokers/types";
import type { ServerBrokerAdapter } from "@/services/brokers/server-types";
import type {
  FuturesOverviewResponse,
  FuturesSymbolView,
  FuturesTickerSummary,
  SymbolId,
  TopMover,
} from "@/types/market";

async function buildSymbolView(
  broker: ServerBrokerAdapter,
  symbol: SymbolId,
  brokerPair: string,
): Promise<FuturesSymbolView> {
  const [premiumRes, oiHistRes, lsRes] = await Promise.allSettled([
    broker.fetchPremiumIndex(brokerPair),
    broker.fetchOpenInterestHistory(brokerPair, "5m", 13),
    broker.fetchLongShortRatio(brokerPair, "5m", 1),
  ]);

  const premium = premiumRes.status === "fulfilled" ? premiumRes.value : null;
  const oiHist = oiHistRes.status === "fulfilled" ? oiHistRes.value : [];
  const ls = lsRes.status === "fulfilled" ? lsRes.value[0] ?? null : null;

  const latest = oiHist.at(-1);
  const hourAgo = oiHist.at(0);
  const oiChangePct1h =
    latest && hourAgo && hourAgo.openInterest > 0
      ? ((latest.openInterest - hourAgo.openInterest) / hourAgo.openInterest) * 100
      : 0;

  const markPrice = premium?.markPrice ?? 0;
  const openInterest = latest?.openInterest ?? 0;
  // Brokers that don't expose USD notional on their OI history endpoint
  // (Delta India is the canonical example) come through with `notionalUsd: 0`.
  // Fall back to `openInterest * markPrice`, which is correct when the broker
  // reports OI in base-asset units (BTC / ETH / SOL). Binance USDT-M futures
  // also report `sumOpenInterest` in base units so the fallback is safe even
  // when `notionalUsd` happens to drop to 0 for a single bar.
  const reportedNotional = latest?.notionalUsd ?? 0;
  const openInterestNotionalUsd =
    reportedNotional > 0 ? reportedNotional : openInterest * markPrice;

  return {
    symbol,
    markPrice,
    fundingRate: premium?.fundingRate ?? 0,
    fundingRateAnnualized: premium?.fundingRateAnnualized ?? 0,
    nextFundingTime: premium?.nextFundingTime ?? 0,
    openInterest,
    openInterestNotionalUsd,
    oiChangePct1h,
    longShortRatio: ls?.longShortRatio ?? 0,
    longAccount: ls?.longAccount ?? 0,
    shortAccount: ls?.shortAccount ?? 0,
  };
}

function toTickerSummary(
  symbol: SymbolId,
  pair: string,
  t: NormalizedTicker | undefined,
  fallbackPrice: number,
): FuturesTickerSummary {
  if (!t) {
    return {
      symbol,
      pair,
      price: fallbackPrice,
      changePct24h: 0,
      high24h: fallbackPrice,
      low24h: fallbackPrice,
      quoteVolume24h: 0,
    };
  }
  return {
    symbol,
    pair,
    price: t.price || fallbackPrice,
    changePct24h: t.changePct,
    high24h: t.high || fallbackPrice,
    low24h: t.low || fallbackPrice,
    quoteVolume24h: t.quoteVolume,
  };
}

/**
 * Lightweight 24h ticker snapshot for the futures price bar — one REST call
 * to the active broker (no funding / OI / long-short fan-out). Bypasses the
 * Redis cache because the route's intended use is a 2–3 s client poll where
 * 15-second staleness would defeat the point.
 */
export async function getFuturesTickers(): Promise<FuturesTickerSummary[]> {
  const broker = getServerBroker();
  const trackedPairs = TRACKED_SYMBOLS.map((s) => broker.pairs.futures[s.id]);
  const tickers = await broker.fetch24hrTickers(trackedPairs).catch(() => []);
  const byPair = new Map(tickers.map((t) => [t.pair, t]));
  return TRACKED_SYMBOLS.map((meta, idx) =>
    toTickerSummary(meta.id, trackedPairs[idx], byPair.get(trackedPairs[idx]), 0),
  );
}

function pickTopMovers(
  tickers: NormalizedFuturesTicker[],
  count = 5,
): { gainers: TopMover[]; losers: TopMover[] } {
  const filtered = tickers.filter((t) => t.quoteVolume > 5_000_000);
  const sortedDesc = [...filtered].sort((a, b) => b.changePct - a.changePct);
  return {
    gainers: sortedDesc.slice(0, count).map(toTopMover),
    losers: sortedDesc.slice(-count).reverse().map(toTopMover),
  };
}

function toTopMover(t: NormalizedFuturesTicker): TopMover {
  return { symbol: t.pair, price: t.price, changePct: t.changePct, quoteVolume: t.quoteVolume };
}

export async function getFuturesOverview(): Promise<FuturesOverviewResponse> {
  return cached(REDIS_KEYS.futuresOverview, CACHE_TTL_SECONDS.futuresOverview, async () => {
    const broker = getServerBroker();
    const trackedPairs = TRACKED_SYMBOLS.map((s) => broker.pairs.futures[s.id]);
    const symbolViewsPromise = Promise.all(
      TRACKED_SYMBOLS.map((s) => buildSymbolView(broker, s.id, broker.pairs.futures[s.id])),
    );
    const tickersPromise = broker.fetchAllFuturesTickers().catch(() => []);
    const tracked24hPromise = broker.fetch24hrTickers(trackedPairs).catch(() => []);
    const [symbols, tickers, tracked24h] = await Promise.all([
      symbolViewsPromise,
      tickersPromise,
      tracked24hPromise,
    ]);
    const { gainers, losers } = pickTopMovers(tickers);
    const trackedByPair = new Map(tracked24h.map((t) => [t.pair, t]));
    const tickers24h = TRACKED_SYMBOLS.map((meta, idx) =>
      toTickerSummary(
        meta.id,
        trackedPairs[idx],
        trackedByPair.get(trackedPairs[idx]),
        symbols[idx]?.markPrice ?? 0,
      ),
    );
    return {
      generatedAt: Date.now(),
      symbols,
      tickers24h,
      topGainers: gainers,
      topLosers: losers,
    };
  });
}
