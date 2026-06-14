// Type pack for the Indian-market News surface — Moneycontrol (India) +
// global business RSS feeds, enriched with a deterministic bull/bear
// sentiment read and an F&O-stock / sector / index impact tag.

/** Where the headline originates — domestic NSE-relevant vs global macro. */
export type NewsCategory = "india" | "global";

/** Per-headline directional read from the deterministic lexicon engine. */
export type NewsSentimentLabel = "bullish" | "bearish" | "neutral";

/**
 * How much the headline is likely to move the F&O tape:
 *  - `high`   — names a specific F&O stock or index underlying
 *  - `medium` — names a sector (sector-wide move)
 *  - `low`    — general / macro colour, no direct F&O anchor
 */
export type NewsImpact = "high" | "medium" | "low";

/** Overall market regime derived from the impactful headline mix. */
export type NewsRegime = "risk-on" | "risk-off" | "mixed";

/** A single enriched news headline. */
export type NewsItem = {
  /** Stable id derived from the link/title so the client can key rows. */
  id: string;
  title: string;
  /** Plain-text summary (HTML + CDATA stripped). Empty string when absent. */
  summary: string;
  link: string;
  /** Human-readable feed source label (e.g. "Moneycontrol · Markets"). */
  source: string;
  /** ISO timestamp of publication, or null when the feed omits it. */
  publishedAt: string | null;
  category: NewsCategory;
  sentiment: {
    label: NewsSentimentLabel;
    /** Net lexicon score for this headline (bull hits − bear hits). */
    score: number;
  };
  impact: NewsImpact;
  /** Matched F&O underlyings (stocks + index names), upper-case. */
  symbols: string[];
  /** Matched sector names (from lib/india/sectors.ts). */
  sectors: string[];
};

/**
 * The raw shape produced by the RSS parser before enrichment. Sentiment /
 * impact / symbol tagging are layered on by the engine.
 */
export type RawNewsItem = {
  title: string;
  summary: string;
  link: string;
  source: string;
  publishedAt: string | null;
  category: NewsCategory;
};

/** Aggregate market read folded from the impactful headline set. */
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
};

/** Response shape served by GET /api/in/news. */
export type NewsFeedResponse = {
  sentiment: MarketSentiment;
  items: NewsItem[];
  fetchedAt: string;
};
