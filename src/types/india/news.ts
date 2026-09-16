// Type pack for the Indian-market News surface — powered by SentinelPulse.
// SentinelPulse enriches raw articles through a multi-stage pipeline:
//   ingestion → normalise → dedup → entity-resolution → event-detection →
//   sentiment → importance → feature-engineering → optional embedding
// All scores are in [0, 1] unless otherwise noted.

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

/** Where the headline originates — domestic NSE-relevant vs global macro. */
export type NewsCategory = "india" | "global";

/** Per-headline directional read from the SentinelPulse sentiment engine. */
export type NewsSentimentLabel = "bullish" | "bearish" | "neutral";

/**
 * How much the event is likely to move the F&O tape:
 *  - `high`   — importance_score ≥ 0.7
 *  - `medium` — importance_score ∈ [0.4, 0.7)
 *  - `low`    — importance_score < 0.4
 */
export type NewsImpact = "high" | "medium" | "low";

/** Overall market regime derived from the breadth / sentiment mix. */
export type NewsRegime = "risk-on" | "risk-off" | "mixed";

// ---------------------------------------------------------------------------
// SentinelPulse event types
// ---------------------------------------------------------------------------

export type NewsEventType =
  | "CENTRAL_BANK_DECISION"
  | "MONETARY_POLICY"
  | "EARNINGS_RELEASE"
  | "EARNINGS_GROWTH"
  | "EARNINGS_MISS"
  | "MERGER_ACQUISITION"
  | "REGULATORY_ACTION"
  | "GEOPOLITICAL"
  | "MACROECONOMIC"
  | "SECTOR_NEWS"
  | "IPO"
  | "ANALYST_ACTION"
  | "INSIDER_TRADING"
  | "MANAGEMENT_CHANGE"
  | "PRODUCT_LAUNCH"
  | "LEGAL"
  | "GENERAL";

// ---------------------------------------------------------------------------
// Article — the normalised unit returned by /api/v1/news/latest
// ---------------------------------------------------------------------------

export type NewsSource = {
  name: string;
  /** Source reliability tier (1 = highest). */
  tier: number;
};

/** A single normalised and enriched article from SentinelPulse. */
export type NewsArticle = {
  /** Stable UUID assigned by SentinelPulse. */
  id: string;
  /** Source adapter identifier (e.g. "reuters", "economic-times"). */
  sourceId: string;
  title: string;
  /** Plain-text summary (HTML stripped by the pipeline). */
  summary: string;
  canonicalUrl: string;
  publishedAt: string;
  category: string;
  language: string;
  source: NewsSource;
  /** Duplicate cluster this article belongs to, if any. */
  clusterId: string | null;
  author: string | null;
};

// ---------------------------------------------------------------------------
// NewsItem — the enriched unit surfaced in the UI
// Maps to a SentinelPulse event with sentiment + impact data attached.
// ---------------------------------------------------------------------------

/**
 * Sentiment vector from SentinelPulse — multi-dimensional scores in [-1, 1].
 * `label` is derived from `overall` for display purposes.
 */
export type ArticleSentiment = {
  label: NewsSentimentLabel;
  /** Overall blended score. Positive = bullish, negative = bearish. */
  overall: number;
  market: number | null;
  company: number | null;
  macro: number | null;
  risk: number | null;
};

/** A single enriched news item, shaped for UI consumption. */
export type NewsItem = {
  /** SentinelPulse article UUID. */
  id: string;
  title: string;
  summary: string;
  /** Canonical URL for the "open in new tab" link. */
  link: string;
  /** Human-readable source label (e.g. "Reuters"). */
  source: string;
  /** ISO timestamp of publication. */
  publishedAt: string | null;
  /** Broad category tag (e.g. "india", "global"). */
  category: NewsCategory;
  /** SentinelPulse event type (e.g. "CENTRAL_BANK_DECISION"). */
  eventType: NewsEventType | null;
  sentiment: ArticleSentiment;
  impact: NewsImpact;
  /** importance_score in [0, 1] from SentinelPulse. */
  importanceScore: number;
  /** F&O underlyings / instruments mentioned (upper-case NSE symbols). */
  symbols: string[];
  /** Sector tags extracted by SentinelPulse entity resolution. */
  sectors: string[];
};

// ---------------------------------------------------------------------------
// MarketSentiment — aggregate read, populated by /api/v1/news/market/india
// ---------------------------------------------------------------------------

/**
 * Breadth snapshot from SentinelPulse — fraction of advancing/declining
 * articles in the rolling window.
 */
export type NewsBreadth = {
  advancingPct: number;
  decliningPct: number;
  neutralPct: number;
  netBreadth: number;
  highImportanceCount: number;
  windowMinutes: number;
};

/**
 * Aggregate market read folded from the impactful headline set.
 * Populated by SentinelPulse /api/v1/news/market/india and the regime cron.
 */
export type MarketSentiment = {
  label: NewsSentimentLabel;
  /** Net sentiment, -100 (max bearish) .. +100 (max bullish). */
  score: number;
  /** Risk appetite, 0 (full risk-off) .. 100 (full risk-on); 50 = neutral. */
  riskRatio: number;
  regime: NewsRegime;
  bullCount: number;
  bearCount: number;
  /** One-line human summary of the current read. */
  headline: string;
  /** Breadth snapshot, null when SentinelPulse breadth data is unavailable. */
  breadth: NewsBreadth | null;
  /** Regime confidence from SentinelPulse [0, 1]; null when unavailable. */
  confidence: number | null;
};

// ---------------------------------------------------------------------------
// API response shapes (what GET /api/in/news returns to the client)
// ---------------------------------------------------------------------------

/** Response shape served by GET /api/in/news */
export type NewsFeedResponse = {
  sentiment: MarketSentiment;
  items: NewsItem[];
  fetchedAt: string;
  /** Pagination cursor for the next page of articles (null = no more). */
  nextCursor: string | null;
  /** Total article count matching the current filter, if known. */
  total: number | null;
};

/** Response shape served by GET /api/in/news/regime */
export type NewsRegimeResponse = {
  asOf: string;
  nifty50: MarketRegimeData | null;
  banknifty: MarketRegimeData | null;
  broadMarket: MarketRegimeData | null;
  nextUpdateAt: string | null;
};

export type MarketRegimeData = {
  regime: "RISK_ON" | "RISK_OFF" | "NEUTRAL" | "CRISIS";
  confidence: number;
  since: string;
  breadthScore: number | null;
  volatilityPercentile: number | null;
};
