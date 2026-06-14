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

const DEFAULT_FEEDS: NewsFeed[] = [
  {
    url: "https://www.moneycontrol.com/rss/MCtopnews.xml",
    source: "Moneycontrol · Top News",
    category: "india",
  },
  {
    url: "https://www.moneycontrol.com/rss/marketreports.xml",
    source: "Moneycontrol · Markets",
    category: "india",
  },
  {
    url: "https://www.moneycontrol.com/rss/business.xml",
    source: "Moneycontrol · Business",
    category: "india",
  },
  {
    url: "https://www.moneycontrol.com/rss/economy.xml",
    source: "Moneycontrol · Economy",
    category: "india",
  },
  {
    url: "https://www.moneycontrol.com/rss/results.xml",
    source: "Moneycontrol · Results",
    category: "india",
  },
  // Global macro / business — affects FII flows, commodities and risk appetite.
  {
    url: "https://feeds.content.dowjones.io/public/rss/RSSWorldNews",
    source: "WSJ · World",
    category: "global",
  },
  {
    url: "https://www.cnbc.com/id/100727362/device/rss/rss.html",
    source: "CNBC · World Markets",
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
