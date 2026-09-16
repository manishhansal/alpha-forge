// India News service — powered by SentinelPulse.
//
// Data flow:
//   SentinelPulse /api/v1/news/market/india  →  articles + breadth + regime
//   → text-based sentiment scoring (SP enrichment lives on events, not articles)
//   → map to NewsItem / MarketSentiment
//   → cache.memo → NewsFeedResponse
//
// Note on enrichment: /news/latest and /news/market/india return normalised
// articles. The ML sentiment/importance/entity fields live on event records
// (joined via the pipeline workers). Since those fields are absent from the
// article-level responses, we derive sentiment from title+summary text and
// importance from a simple heuristic so the UI always shows real headlines.

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
  fetchMarketIndia,
  SentinelPulseError,
  type SpArticle,
  type SpMarketIndiaResponse,
} from "./sentinel-client";
import { cache } from "../cache";

// ---------------------------------------------------------------------------
// Cache TTLs
// ---------------------------------------------------------------------------

const ARTICLES_TTL_MS = 90_000; // 90 s
const MARKET_TTL_MS = 60_000;   // 60 s

// ---------------------------------------------------------------------------
// Text-based sentiment scoring
// (SP enrichment lives on events, not on article-level responses)
// ---------------------------------------------------------------------------

const BULL_TOKENS = [
  "surge", "surges", "surged", "rally", "rallies", "rallied",
  "jump", "jumps", "jumped", "gain", "gains", "gained",
  "rise", "rises", "rose", "soar", "soars", "soared",
  "record", "high", "highs", "beat", "beats", "upgrade", "upgrades", "upgraded",
  "optimism", "bullish", "outperform", "inflow", "inflows", "buying",
  "profit", "growth", "strong", "boost", "boosts", "recovery", "rebound", "rebounds",
];

const BEAR_TOKENS = [
  "crash", "crashes", "crashed", "slump", "slumps", "slumped",
  "plunge", "plunges", "plunged", "fall", "falls", "fell",
  "drop", "drops", "dropped", "slide", "slides", "tumble", "tumbles", "tumbled",
  "loss", "losses", "downgrade", "downgrades", "downgraded",
  "bearish", "selloff", "sell-off", "outflow", "outflows",
  "weak", "weakness", "fear", "fears", "recession", "crisis",
  "default", "fraud", "war", "slowdown", "cut", "cuts",
  "warning", "miss", "misses", "underperform",
];

function countWord(text: string, word: string): number {
  const re = new RegExp(`\\b${word}\\b`, "gi");
  return (text.match(re) ?? []).length;
}

function scoreText(text: string): { label: NewsSentimentLabel; overall: number } {
  let bull = 0;
  let bear = 0;
  for (const t of BULL_TOKENS) bull += countWord(text, t);
  for (const t of BEAR_TOKENS) bear += countWord(text, t);
  const raw = bull - bear;
  const overall = Math.max(-1, Math.min(1, raw * 0.15)); // normalise to [-1, 1]
  const label: NewsSentimentLabel =
    raw > 0 ? "bullish" : raw < 0 ? "bearish" : "neutral";
  return { label, overall };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sentimentLabel(overall: number | null | undefined): NewsSentimentLabel {
  if (overall === null || overall === undefined) return "neutral";
  if (overall > 0.05) return "bullish";
  if (overall < -0.05) return "bearish";
  return "neutral";
}

const GLOBAL_KEYWORDS = ["GLOBAL", "WORLD", "USD", "FED", "FOREX", "FII_DII"];

function deriveCategory(raw: string | undefined): NewsCategory {
  if (!raw) return "india";
  const upper = raw.toUpperCase();
  return GLOBAL_KEYWORDS.some((k) => upper.includes(k)) ? "global" : "india";
}

const HIGH_IMPACT_KEYWORDS = [
  "nifty", "sensex", "banknifty", "reliance", "tcs", "hdfc", "infosys",
  "rbi", "sebi", "fed", "rate", "repo", "policy", "result", "earning",
  "quarterly", "ipo", "merger", "acquisition",
];

function deriveImportance(article: SpArticle): number {
  const text = `${article.title} ${article.summary ?? ""}`.toLowerCase();
  const tier = article.source?.tier ?? 2;
  const tierScore = tier === 1 ? 0.55 : 0.35;
  const keywordHits = HIGH_IMPACT_KEYWORDS.filter((k) => text.includes(k)).length;
  return Math.min(0.95, tierScore + Math.min(0.4, keywordHits * 0.08));
}

function importanceToImpact(score: number): NewsImpact {
  if (score >= 0.7) return "high";
  if (score >= 0.4) return "medium";
  return "low";
}

const SECTOR_TAGS = new Set([
  "BANKING", "IT", "PHARMA", "FMCG", "AUTO", "ENERGY",
  "METALS", "REALTY", "INFRA", "MEDIA", "TELECOM", "FINTECH",
]);

const KNOWN_SYMBOLS = [
  "NIFTY50", "NIFTY", "SENSEX", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY",
  "RELIANCE", "TCS", "HDFCBANK", "INFY", "ICICIBANK", "WIPRO", "HDFC",
  "AXISBANK", "KOTAKBANK", "BHARTIARTL", "ITC", "LT", "SBIN", "ONGC",
  "TATAMOTORS", "TATASTEEL", "ADANIENT", "ADANIPORTS", "SUNPHARMA",
  "DRREDDY", "CIPLA", "DIVISLAB", "HINDUNILVR", "BAJFINANCE", "BAJAJFINSV",
];

function extractSymbolsAndSectors(
  entities: string[] | undefined,
  text: string,
): { symbols: string[]; sectors: string[] } {
  const symbols = new Set<string>();
  const sectors = new Set<string>();

  if (entities?.length) {
    for (const e of entities) {
      if (SECTOR_TAGS.has(e.toUpperCase())) sectors.add(e);
      else symbols.add(e);
    }
    return { symbols: [...symbols], sectors: [...sectors] };
  }

  const upper = text.toUpperCase();
  for (const sym of KNOWN_SYMBOLS) {
    const re = new RegExp(`(?:^|[^A-Z0-9])${sym}(?:[^A-Z0-9]|$)`);
    if (re.test(upper)) symbols.add(sym);
  }

  return { symbols: [...symbols], sectors: [] };
}

/** Strip HTML tags, truncate long summaries. */
function cleanSummary(raw: string): string {
  return raw
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

// ---------------------------------------------------------------------------
// Article → NewsItem mapping
// ---------------------------------------------------------------------------

function mapArticleToNewsItem(article: SpArticle): NewsItem {
  const text = `${article.title} ${article.summary ?? ""}`;

  // Use SP sentiment if present, otherwise score from text
  const spOverall = article.sentiment?.overall;
  const scored =
    spOverall !== null && spOverall !== undefined
      ? { label: sentimentLabel(spOverall), overall: spOverall }
      : scoreText(text);

  const sentiment: ArticleSentiment = {
    label: scored.label,
    overall: scored.overall,
    market: article.sentiment?.market ?? null,
    company: article.sentiment?.company ?? null,
    macro: article.sentiment?.macro ?? null,
    risk: article.sentiment?.risk ?? null,
  };

  const importanceScore =
    typeof article.importance_score === "number"
      ? article.importance_score
      : deriveImportance(article);

  const { symbols, sectors } = extractSymbolsAndSectors(
    article.primary_entities,
    text,
  );

  return {
    id: article.id,
    title: article.title,
    summary: cleanSummary(article.summary ?? ""),
    link: article.canonicalUrl,
    source: article.source?.name ?? article.sourceId ?? "Unknown",
    publishedAt: article.publishedAt ?? null,
    category: deriveCategory(article.category),
    eventType: (article.event_type as NewsEventType | undefined) ?? null,
    sentiment,
    impact: importanceToImpact(importanceScore),
    importanceScore,
    symbols,
    sectors,
  };
}

// ---------------------------------------------------------------------------
// Market sentiment computation
// ---------------------------------------------------------------------------

function synthesiseSentiment(items: NewsItem[]): MarketSentiment {
  if (items.length === 0) {
    return {
      label: "neutral", score: 0, riskRatio: 50, regime: "mixed",
      bullCount: 0, bearCount: 0,
      headline: "No market-moving headlines right now.",
      breadth: null, confidence: null,
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
      ? riskRatio >= 45 ? "risk-on" : "mixed"
      : label === "bearish"
        ? riskRatio <= 55 ? "risk-off" : "mixed"
        : riskRatio >= 60 ? "risk-on" : riskRatio <= 40 ? "risk-off" : "mixed";

  const tone =
    label === "bullish" ? "Headlines skew bullish"
    : label === "bearish" ? "Headlines skew bearish"
    : "Headlines are mixed";
  const riskText =
    regime === "risk-on" ? "risk-on tape"
    : regime === "risk-off" ? "risk-off tape"
    : "balanced risk";

  return {
    label, score, riskRatio, regime,
    bullCount: bull, bearCount: bear,
    headline: `${tone} — ${riskText} (${bull} bullish / ${bear} bearish).`,
    breadth: null, confidence: null,
  };
}

function mapMarketIndia(
  sp: SpMarketIndiaResponse,
  items: NewsItem[],
): MarketSentiment {
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

  const base = synthesiseSentiment(items);
  const regime = sp.regime;
  if (!regime) return { ...base, breadth };

  type RegimeEntry = { regime?: string; confidence?: number };
  const spRegimeStr =
    (regime as Record<string, RegimeEntry | undefined>).nifty50?.regime ??
    (regime as Record<string, RegimeEntry | undefined>).broad_market?.regime;

  const regimeMapped: NewsRegime =
    spRegimeStr === "RISK_ON" ? "risk-on"
    : spRegimeStr === "RISK_OFF" || spRegimeStr === "CRISIS" ? "risk-off"
    : base.regime;

  const confidence =
    (regime as Record<string, RegimeEntry | undefined>).nifty50?.confidence ??
    (regime as Record<string, RegimeEntry | undefined>).broad_market?.confidence ??
    null;

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
  category?: NewsCategory | "all";
  limit?: number;
  cursor?: string;
  asset_id?: string;
  min_importance?: number;
  event_type?: string;
};

const EMPTY_RESPONSE: NewsFeedResponse = {
  sentiment: {
    label: "neutral", score: 0, riskRatio: 50, regime: "mixed",
    bullCount: 0, bearCount: 0,
    headline: "News service temporarily unavailable.",
    breadth: null, confidence: null,
  },
  items: [],
  fetchedAt: new Date().toISOString(),
  nextCursor: null,
  total: null,
};

export async function getIndiaNews(
  opts: GetIndiaNewsOptions = {},
): Promise<NewsFeedResponse> {
  const { category = "all", limit = 40 } = opts;

  const cacheKey = [
    "sp:news2",
    category,
    opts.asset_id ?? "",
    opts.min_importance ?? "",
    opts.event_type ?? "",
    opts.cursor ?? "",
  ].join(":");

  try {
    return await cache.memo(cacheKey, ARTICLES_TTL_MS, async () => {
      // /news/market/india returns the richest article set (recent + curated)
      const marketData = await cache.memo(
        "sp:market:india",
        MARKET_TTL_MS,
        fetchMarketIndia,
      );

      // The /news/market/india response includes an `articles` array in practice
      type MarketWithArticles = SpMarketIndiaResponse & { articles?: SpArticle[] };
      const rawArticles: SpArticle[] =
        (marketData as MarketWithArticles | null)?.articles ?? [];

      // Map all articles — scoring sentiment from text when SP fields absent
      let allItems: NewsItem[] = rawArticles.map(mapArticleToNewsItem);

      // Apply optional filters
      if (opts.min_importance !== undefined) {
        allItems = allItems.filter((i) => i.importanceScore >= opts.min_importance!);
      }
      if (opts.event_type) {
        allItems = allItems.filter((i) => i.eventType === opts.event_type);
      }

      // Sentiment computed across the full set for a stable market read
      const sentiment =
        marketData !== null
          ? mapMarketIndia(marketData as SpMarketIndiaResponse, allItems)
          : synthesiseSentiment(allItems);

      // Category filter applied after sentiment
      const filtered =
        category === "all"
          ? allItems
          : allItems.filter((i) => i.category === category);

      // Sort by importance then recency
      filtered.sort((a, b) => {
        const id = b.importanceScore - a.importanceScore;
        if (Math.abs(id) > 0.05) return id;
        const at = a.publishedAt ? Date.parse(a.publishedAt) : 0;
        const bt = b.publishedAt ? Date.parse(b.publishedAt) : 0;
        return bt - at;
      });

      return {
        sentiment,
        items: filtered.slice(0, Math.max(1, limit)),
        fetchedAt: new Date().toISOString(),
        nextCursor: null,
        total: filtered.length,
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
