// RSS feed catalogue for the Indian-market News surface. Defaults ship a set
// of Moneycontrol India feeds plus a global business feed. The list is
// overridable at deploy time via the INDIA_NEWS_FEEDS env var (a
// comma-separated list of `url|source|category` triples) so URLs can be tuned
// without a code change.

import type { NewsCategory } from "@/types/india/news";

export type NewsFeed = {
  url: string;
  source: string;
  category: NewsCategory;
};

// NOTE on Moneycontrol: their legacy `/rss/*.xml` feeds are deprecated and
// serve stale (multi-year-old) snapshots, so they can't be the source of
// "latest" news. We lead with Economic Times market feeds (verified fresh,
// minute-level updates) for the domestic F&O tape and keep two Moneycontrol
// feeds as best-effort extras — the recency filter in the service drops any
// stale items regardless of source.
const DEFAULT_FEEDS: NewsFeed[] = [
  {
    url: "https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms",
    source: "Economic Times · Markets",
    category: "india",
  },
  {
    url: "https://economictimes.indiatimes.com/markets/stocks/rssfeeds/2146842.cms",
    source: "Economic Times · Stocks",
    category: "india",
  },
  {
    url: "https://economictimes.indiatimes.com/news/economy/rssfeeds/1373380680.cms",
    source: "Economic Times · Economy",
    category: "india",
  },
  // Moneycontrol best-effort (often stale; recency filter removes old items).
  {
    url: "https://www.moneycontrol.com/rss/business.xml",
    source: "Moneycontrol · Business",
    category: "india",
  },
  {
    url: "https://www.moneycontrol.com/rss/marketreports.xml",
    source: "Moneycontrol · Markets",
    category: "india",
  },
  // Global macro / business — affects FII flows, commodities and risk appetite.
  {
    url: "https://feeds.content.dowjones.io/public/rss/RSSWorldNews",
    source: "WSJ · World",
    category: "global",
  },
  {
    url: "https://feeds.content.dowjones.io/public/rss/RSSMarketsMain",
    source: "WSJ · Markets",
    category: "global",
  },
];

function parseEnvFeeds(raw: string | undefined): NewsFeed[] | null {
  if (!raw) return null;
  const feeds: NewsFeed[] = [];
  for (const entry of raw.split(",")) {
    const parts = entry.split("|").map((p) => p.trim());
    const [url, source, category] = parts;
    if (!url) continue;
    feeds.push({
      url,
      source: source || url,
      category: category === "global" ? "global" : "india",
    });
  }
  return feeds.length > 0 ? feeds : null;
}

/** Resolve the active feed list (env override, else defaults). */
export function getNewsFeeds(): NewsFeed[] {
  return parseEnvFeeds(process.env.INDIA_NEWS_FEEDS) ?? DEFAULT_FEEDS;
}
