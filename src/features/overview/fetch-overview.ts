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
    const _futures = futuresRes.status === "fulfilled" ? futuresRes.value : [];

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

      // data-service2.0 returns price fields as strings (e.g. "78428.85000000").
      // Coerce to numbers so formatPrice() and Number.isFinite() work correctly.
      const toNum = (v: unknown): number => {
        const n = Number(v);
        return Number.isFinite(n) ? n : 0;
      };

      return {
        symbol,
        name: meta.name,
        price: toNum(t?.price ?? coinTicker?.price),
        change24h: toNum(t?.change),
        changePct24h: toNum(t?.changePct),
        high24h: toNum(t?.high ?? coinTicker?.price),
        low24h: toNum(t?.low ?? coinTicker?.price),
        volume24h: toNum(t?.volume),
        quoteVolume24h: toNum(t?.quoteVolume),
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
