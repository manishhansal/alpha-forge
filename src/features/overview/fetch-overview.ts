import "server-only";

import { CACHE_TTL_SECONDS, REDIS_KEYS, TRACKED_SYMBOLS } from "@/lib/constants";
import { cached } from "@/lib/redis";
import { getServerBroker } from "@/services/brokers/registry";
import { fetchGlobalMarket, fetchTrackedCoinsMarket } from "@/services/coingecko/rest";
import type { MarketOverviewEntry, MarketOverviewResponse, SymbolId } from "@/types/market";

export async function getMarketOverview(): Promise<MarketOverviewResponse> {
  return cached(REDIS_KEYS.marketOverview, CACHE_TTL_SECONDS.marketOverview, async () => {
    const broker = getServerBroker();
    const spotPairs = TRACKED_SYMBOLS.map((s) => broker.pairs.spot[s.id]);

    const [tickers, global, coins] = await Promise.allSettled([
      broker.fetch24hrTickers(spotPairs),
      fetchGlobalMarket(),
      fetchTrackedCoinsMarket(),
    ]);

    if (tickers.status !== "fulfilled") {
      throw new Error(`${broker.displayName} ticker failed: ${tickers.reason}`);
    }

    const tickerBySymbol = new Map(tickers.value.map((t) => [t.pair, t]));
    const coinsByCoingecko = new Map(
      coins.status === "fulfilled" ? coins.value.map((c) => [c.coingeckoId, c]) : [],
    );
    const globalData =
      global.status === "fulfilled"
        ? global.value
        : { totalMarketCap: 0, totalVolume24h: 0, btcDominance: 0, ethDominance: 0 };

    const entries: MarketOverviewEntry[] = TRACKED_SYMBOLS.map((meta) => {
      const t = tickerBySymbol.get(broker.pairs.spot[meta.id]);
      const c = coinsByCoingecko.get(meta.coingeckoId);
      const marketCap = c?.marketCap ?? 0;
      const symbol: SymbolId = meta.id;
      const dominance =
        meta.id === "BTC"
          ? globalData.btcDominance
          : meta.id === "ETH"
            ? globalData.ethDominance
            : globalData.totalMarketCap > 0
              ? (marketCap / globalData.totalMarketCap) * 100
              : 0;

      return {
        symbol,
        name: meta.name,
        price: t?.price ?? 0,
        change24h: t?.change ?? 0,
        changePct24h: t?.changePct ?? 0,
        high24h: t?.high ?? 0,
        low24h: t?.low ?? 0,
        volume24h: t?.volume ?? 0,
        quoteVolume24h: t?.quoteVolume ?? 0,
        updatedAt: t?.ts ?? Date.now(),
        marketCap,
        dominance,
      };
    });

    return {
      generatedAt: Date.now(),
      totalMarketCap: globalData.totalMarketCap,
      totalVolume24h: globalData.totalVolume24h,
      btcDominance: globalData.btcDominance,
      ethDominance: globalData.ethDominance,
      entries,
    };
  });
}
