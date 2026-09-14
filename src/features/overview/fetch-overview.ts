import "server-only";

import { CACHE_TTL_SECONDS, REDIS_KEYS, TRACKED_SYMBOLS } from "@/lib/constants";
import { cached } from "@/lib/redis";
import { getServerBroker } from "@/services/brokers/registry";
import { getCryptoTicker, getFuturesOverview } from "@/lib/data-service/client";
import type { MarketOverviewEntry, MarketOverviewResponse, SymbolId } from "@/types/market";

export async function getMarketOverview(): Promise<MarketOverviewResponse> {
  return cached(REDIS_KEYS.marketOverview, CACHE_TTL_SECONDS.marketOverview, async () => {
    const broker = getServerBroker();
    const spotPairs = TRACKED_SYMBOLS.map((s) => broker.pairs.spot[s.id]);

    const [tickers, futuresRes] = await Promise.allSettled([
      broker.fetch24hrTickers(spotPairs),
      getFuturesOverview(),
    ]);

    if (tickers.status !== "fulfilled") {
      throw new Error(`${broker.displayName} ticker failed: ${tickers.reason}`);
    }

    const tickerBySymbol = new Map(tickers.value.map((t) => [t.pair, t]));
    const futures = futuresRes.status === "fulfilled" ? futuresRes.value : [];

    // Build a simple global data structure from futures
    const globalData = {
      totalMarketCap: 0,
      totalVolume24h: 0,
      btcDominance: 0,
      ethDominance: 0,
    };

    // Fetch individual crypto tickers for market cap data
    const coinResults = await Promise.allSettled(
      TRACKED_SYMBOLS.map((meta) => getCryptoTicker(meta.id)),
    );

    const entries: MarketOverviewEntry[] = TRACKED_SYMBOLS.map((meta, idx) => {
      const t = tickerBySymbol.get(broker.pairs.spot[meta.id]);
      const coinTicker = coinResults[idx]?.status === "fulfilled" ? coinResults[idx].value : null;
      const marketCap = 0; // getCryptoTicker doesn't return market cap
      const symbol: SymbolId = meta.id;
      const dominance = 0; // no market cap data available

      return {
        symbol,
        name: meta.name,
        price: t?.price ?? coinTicker?.price ?? 0,
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

    // Compute global totals from accumulated data
    globalData.totalMarketCap = entries.reduce((s, e) => s + (e.marketCap ?? 0), 0);
    globalData.totalVolume24h = entries.reduce((s, e) => s + (e.quoteVolume24h ?? 0), 0);

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
