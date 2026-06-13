import "server-only";

import { CACHE_TTL_SECONDS, REDIS_KEYS } from "@/lib/constants";
import { cached } from "@/lib/redis";
import { fetchFearGreed } from "@/services/altme/fearGreed";
import { getFuturesOverview } from "@/features/futures/aggregate";
import { computeSentiment } from "@/features/sentiment/engine";
import type { SentimentResult } from "@/types/market";

export async function getSentiment(): Promise<SentimentResult> {
  return cached(REDIS_KEYS.sentiment, CACHE_TTL_SECONDS.sentiment, async () => {
    const [fgRes, futuresRes] = await Promise.allSettled([
      fetchFearGreed(1),
      getFuturesOverview(),
    ]);

    const fearGreedValue =
      fgRes.status === "fulfilled" && fgRes.value[0] ? fgRes.value[0].value : null;
    const futures = futuresRes.status === "fulfilled" ? futuresRes.value.symbols : [];
    const tickers24h = futuresRes.status === "fulfilled" ? futuresRes.value.tickers24h : [];

    return computeSentiment({ fearGreedValue, futures, tickers24h });
  });
}
