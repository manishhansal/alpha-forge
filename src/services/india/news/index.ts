// India News service — powered by SentinelPulse.
//
// This module is the single server-side entrypoint for all news data. It
// translates SentinelPulse wire shapes into the AlphaForge domain types and
// memos results through the shared India cache so the dashboard never hammers
// the news service with concurrent requests.
//
// Data flow:
//   SentinelPulse /api/v1/news/latest  →  articles
//   SentinelPulse /api/v1/news/market/india  →  breadth + regime + hot events
//   → map to NewsItem / MarketSentiment
//   → cache.memo → NewsFeedResponse
//
// Resilient by design: if the market/india endpoint is unavailable the
// service still returns articles with a synthetic sentiment derived from the
// article-level scores. Never throws to the caller — returns an empty
// sentinel response instead.

import type {
  ArticleSentiment,
  MarketSentiment,
  NewsBreadth,
  NewsCategory,
  NewsImpact,
  NewsItem,
  NewsFeedResponse,
  NewsRegime,
  NewsSentimentLabel,
  NewsEventType,
} from "@/types/india/news";
import {
  fetchLatestArticles,
  fetchMarketIndia,
  SentinelPulseError,
  type SpArticle,
  type SpMarketIndiaResponse,
} from "./sentinel-client";
import { cache } from "../cache";

// ---------------------------------------------------------------------------
// Cache TTLs
// ---------------------------------------------------------------------------

/** Main article feed — short TTL to stay near real-time. */
const ARTICLES_TTL_MS = 90_000; // 90 s

/** Market breadth / regime — updated by SentinelPulse cron every 15 min. */
const MARKET_TTL_MS = 60_000; // 60 s

// ---------------------------------------------------------------------------
// Helpers: SentinelPulse → AlphaForge type mapping
// ---------------------------------------------------------------------------

/** Map an importance_score [0,1] to our 3-tier impact label. */
function importanceToImpact(score: number | undefined): NewsImpact {
  if (score === undefined || score === null) return "low";
  if (score >= 0.7) return "high";
  if (score >= 0.4) return "medium";
  return "low";
}

/** Map a numeric overall sentiment score to a label. */
function sentimentLabel(overall: number | null | undefined): NewsSentimentLabel {
  if (overall === null || overall === undefined) return "neutral";
  if (overall > 0.05) return "bullish";
  if (overall < -0.05) return "bearish";
  return "neutral";
}

/**
 * Derive a NewsCategory from the article's category tag.
 * SentinelPulse uses varied strings (e.g. "NIFTY50", "RBI", "SEBI"); we
 * treat anything not explicitly global as "india".
 */
function deriveCategory(raw: string | undefined): NewsCategory {
  if (!raw) return "india";
  const upper = raw.toUpperCase();
  const globalKeywords = ["GLOBAL", "WORLD", "USD", "FED", "FII_DII", "FOREX"];
  return globalKeywords.some((k) => upper.includes(k)) ? "global" : "india";
}

/**
 * Extract F&O symbol tags from primary_entities returned by SentinelPulse.
 * We treat all uppercase identifiers that look like NSE symbols as symbols
 * and separate known sector-ish strings as sectors.
 */
const SECTOR_TAGS = new Set([
  "BANKING",
  "IT",
  "PHARMA",
  "FMCG",
  "AUTO",
  "ENERGY",
  "METALS",
  "REALTY",
  "INFRA",
  "MEDIA",
  "TELECOM",
  "FINTECH",
]);

function extractSymbolsAndSectors(entities: string[] | undefined): {
  symbols: string[];
  sectors: string[];
} {
  if (!entities || entities.length === 0) return { symbols: [], sectors: [] };
  const symbols: string[] = [];
  const sectors: string[] = [];
  for (const e of entities) {
    if (SECTOR_TAGS.has(e.toUpperCase())) {
      sectors.push(e);
    } else {
      symbols.push(e);
    }
  }
  return { symbols, sectors };
}

function mapArticleToNewsItem(article: SpArticle): NewsItem {
  const overall = article.sentiment?.overall ?? null;
  const label = sentimentLabel(overall);

  const sentiment: ArticleSentiment = {
    label,
    overall: overall ?? 0,
    market: article.sentiment?.market ?? null,
    company: article.sentiment?.company ?? null,
    macro: article.sentiment?.macro ?? null,
    risk: article.sentiment?.risk ?? null,
  };

  const impact = importanceToImpact(article.importance_score);
  const { symbols, sectors } = extractSymbolsAndSectors(article.primary_entities);

  return {
    id: article.id,
    title: article.title,
    summary: article.summary ?? "",
    link: article.canonicalUrl,
    source: article.source?.name ?? article.sourceId ?? "Unknown",
    publishedAt: article.publishedAt ?? null,
    category: deriveCategory(article.category),
    eventType: (article.event_type as NewsEventType | undefined) ?? null,
    sentiment,
    impact,
    importanceScore: article.importance_score ?? 0,
    symbols,
    sectors,
  };
}

// ---------------------------------------------------------------------------
// Market sentiment computation
// ---------------------------------------------------------------------------

/** Build a synthetic MarketSentiment from article-level scores when the
 *  /market/india endpoint has no regime data. */
function synthesiseSentiment(items: NewsItem[]): MarketSentiment {
  if (items.length === 0) {
    return {
      label: "neutral",
      score: 0,
      riskRatio: 50,
      regime: "mixed",
      bullCount: 0,
      bearCount: 0,
      headline: "No market-moving headlines right now.",
      breadth: null,
      confidence: null,
    };
  }

  let weightedSum = 0;
  let totalWeight = 0;
  let bull = 0;
  let bear = 0;

  const impactWeight: Record<NewsImpact, number> = { high: 3, medium: 2, low: 1 };

  for (const item of items) {
    const w = impactWeight[item.impact];
    weightedSum += item.sentiment.overall * w;
    totalWeight += w;
    if (item.sentiment.label === "bullish") bull++;
    else if (item.sentiment.label === "bearish") bear++;
  }

  const avg = totalWeight > 0 ? weightedSum / totalWeight : 0;
  const score = Math.max(-100, Math.min(100, Math.round(avg * 100)));
  const label = sentimentLabel(avg);
  const riskRatio = Math.max(0, Math.min(100, Math.round(50 + score / 2)));

  const regime: NewsRegime =
    label === "bullish"
      ? riskRatio >= 45
        ? "risk-on"
        : "mixed"
      : label === "bearish"
        ? riskRatio <= 55
          ? "risk-off"
          : "mixed"
        : riskRatio >= 60
          ? "risk-on"
          : riskRatio <= 40
            ? "risk-off"
            : "mixed";

  const tone =
    label === "bullish"
      ? "Headlines skew bullish"
      : label === "bearish"
        ? "Headlines skew bearish"
        : "Headlines are mixed";

  const riskText =
    regime === "risk-on"
      ? "risk-on tape"
      : regime === "risk-off"
        ? "risk-off tape"
        : "balanced risk";

  return {
    label,
    score,
    riskRatio,
    regime,
    bullCount: bull,
    bearCount: bear,
    headline: `${tone} — ${riskText} (${bull} bullish / ${bear} bearish).`,
    breadth: null,
    confidence: null,
  };
}

/** Map SentinelPulse market/india response to MarketSentiment. */
function mapMarketIndia(
  sp: SpMarketIndiaResponse,
  items: NewsItem[],
): MarketSentiment {
  // Use breadth/regime data from SentinelPulse when available, otherwise fall
  // back to synthesising from article scores.
  const breadth: NewsBreadth | null = sp.breadth
    ? {
        advancingPct: sp.breadth.advancing_articles_pct,
        decliningPct: sp.breadth.declining_articles_pct,
        neutralPct: sp.breadth.neutral_articles_pct,
        netBreadth: sp.breadth.net_breadth,
        highImportanceCount: sp.breadth.high_importance_count,
        windowMinutes: sp.breadth.window_minutes,
      }
    : null;

  const regime = sp.regime;
  if (!regime) return { ...synthesiseSentiment(items), breadth };

  // Map SentinelPulse RISK_ON/RISK_OFF/NEUTRAL/CRISIS → our regime
  const spRegimeStr =
    regime.nifty50?.regime ??
    regime.broad_market?.regime ??
    (regime as { nifty50?: string }).nifty50;

  const regimeMapped: NewsRegime =
    spRegimeStr === "RISK_ON"
      ? "risk-on"
      : spRegimeStr === "RISK_OFF" || spRegimeStr === "CRISIS"
        ? "risk-off"
        : "mixed";

  const confidence =
    regime.nifty50?.confidence ?? regime.broad_market?.confidence ?? null;

  const base = synthesiseSentiment(items);

  return {
    ...base,
    regime: regimeMapped,
    breadth,
    confidence: typeof confidence === "number" ? confidence : null,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type GetIndiaNewsOptions = {
  /** Filter to a specific category, or "all" (default). */
  category?: NewsCategory | "all";
  /** Max items returned. Default 40. */
  limit?: number;
  /** Pagination cursor from a previous response. */
  cursor?: string;
  /** Filter to articles linked to a specific NSE instrument. */
  asset_id?: string;
  /** Minimum importance score [0, 1]. Default 0. */
  min_importance?: number;
  /** Filter by SentinelPulse event type. */
  event_type?: string;
};

async function loadArticles(opts: GetIndiaNewsOptions) {
  const params: Parameters<typeof fetchLatestArticles>[0] = {
    limit: Math.min(100, Math.max(1, opts.limit ?? 40)),
  };
  if (opts.cursor) params.cursor = opts.cursor;
  if (opts.asset_id) params.asset_id = opts.asset_id;
  if (opts.min_importance !== undefined) params.min_importance = opts.min_importance;
  if (opts.event_type) params.event_type = opts.event_type;
  // Don't pass category to SP; we filter client-side so the sentiment is
  // always computed across the full tape regardless of the selected category.

  return fetchLatestArticles(params);
}

const EMPTY_RESPONSE: NewsFeedResponse = {
  sentiment: {
    label: "neutral",
    score: 0,
    riskRatio: 50,
    regime: "mixed",
    bullCount: 0,
    bearCount: 0,
    headline: "News service temporarily unavailable.",
    breadth: null,
    confidence: null,
  },
  items: [],
  fetchedAt: new Date().toISOString(),
  nextCursor: null,
  total: null,
};

/**
 * Build the full news response for the given options.
 * Sentiment is always computed across the full impactful set so the market
 * read is stable regardless of which category is active in the UI.
 */
export async function getIndiaNews(
  opts: GetIndiaNewsOptions = {},
): Promise<NewsFeedResponse> {
  const { category = "all", limit = 40 } = opts;

  // Cache key encodes the filterable dimensions that affect the payload.
  const cacheKey = [
    "sp:news",
    category,
    opts.asset_id ?? "",
    opts.min_importance ?? "",
    opts.event_type ?? "",
    opts.cursor ?? "",
  ].join(":");

  try {
    return await cache.memo(cacheKey, ARTICLES_TTL_MS, async () => {
      // Fetch articles and market data in parallel.
      const [articlesResult, marketData] = await Promise.allSettled([
        loadArticles({ ...opts, limit }),
        cache.memo("sp:market:india", MARKET_TTL_MS, fetchMarketIndia),
      ]);

      const { articles, nextCursor, total } =
        articlesResult.status === "fulfilled"
          ? articlesResult.value
          : { articles: [], nextCursor: null, total: null };

      const spMarket =
        marketData.status === "fulfilled" ? marketData.value : null;

      // Map all articles to NewsItem
      let items: NewsItem[] = articles.map(mapArticleToNewsItem);

      // Apply category filter after mapping (so sentiment uses the full set)
      const allItems = items;
      if (category !== "all") {
        items = items.filter((i) => i.category === category);
      }

      // Compute sentiment from the full set (before category filter)
      const sentiment =
        spMarket !== null
          ? mapMarketIndia(spMarket, allItems)
          : synthesiseSentiment(allItems);

      return {
        sentiment,
        items,
        fetchedAt: new Date().toISOString(),
        nextCursor,
        total,
      };
    });
  } catch (err: unknown) {
    const msg =
      err instanceof SentinelPulseError
        ? err.message
        : err instanceof Error
          ? err.message
          : "Unknown news service error";
    console.error("[india/news] getIndiaNews failed:", msg);
    return { ...EMPTY_RESPONSE, fetchedAt: new Date().toISOString() };
  }
}
