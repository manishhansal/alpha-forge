// Server entrypoint for the Indian-market News surface. Fans out across the
// configured RSS feeds (Moneycontrol India + global business), parses each,
// enriches with the deterministic sentiment / impact engine, filters to the
// market-moving set, and folds an aggregate market sentiment + risk ratio.
//
// Resilient by design: feeds are fetched with a hard timeout and a browser-
// like UA, and a failing feed is skipped (Promise.allSettled) rather than
// failing the whole response. Cached via the shared India cache facade.

import {
  computeMarketSentiment,
  enrichNewsItems,
  filterTopNews,
} from "@/features/india/news/engine";
import type {
  NewsCategory,
  NewsFeedResponse,
  RawNewsItem,
} from "@/types/india/news";
import { cache } from "../cache";
import { getNewsFeeds, type NewsFeed } from "./feeds";
import { parseRss } from "./rss";

const FETCH_TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 5 * 60_000;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

async function fetchFeed(feed: NewsFeed): Promise<RawNewsItem[]> {
  const res = await fetch(feed.url, {
    headers: {
      "User-Agent": UA,
      Accept: "application/rss+xml, application/xml, text/xml, */*",
      "Accept-Language": "en-US,en;q=0.9",
    },
    cache: "no-store",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${feed.url}`);
  const xml = await res.text();
  return parseRss(xml, feed.source, feed.category);
}

export type GetIndiaNewsOptions = {
  /** Restrict to a single category, or "all" (default). */
  category?: NewsCategory | "all";
  /** Max items returned after ranking. Default 40. */
  limit?: number;
};

async function loadAllNews(): Promise<RawNewsItem[]> {
  const feeds = getNewsFeeds();
  const results = await Promise.allSettled(feeds.map(fetchFeed));
  const items: RawNewsItem[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") items.push(...r.value);
  }
  return items;
}

/**
 * Build the full News response. The aggregate sentiment is always computed
 * from the impactful India + global set (so the risk read reflects the whole
 * tape); the returned `items` are then filtered to the requested category.
 */
export async function getIndiaNews(
  opts: GetIndiaNewsOptions = {},
): Promise<NewsFeedResponse> {
  const { category = "all", limit = 40 } = opts;

  const raw = await cache.memo("news:raw", CACHE_TTL_MS, loadAllNews);

  const enriched = enrichNewsItems(raw);

  // Aggregate risk read is computed across the impactful headlines from every
  // category before we slice to the requested view.
  const impactful = filterTopNews(enriched, { minImpact: "low" });
  const sentiment = computeMarketSentiment(
    filterTopNews(enriched, { minImpact: "medium" }),
  );

  const scoped =
    category === "all"
      ? impactful
      : impactful.filter((i) => i.category === category);

  const items = scoped.slice(0, Math.max(1, limit));

  return {
    sentiment,
    items,
    fetchedAt: new Date().toISOString(),
  };
}
