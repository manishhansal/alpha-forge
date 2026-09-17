import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { NewsFeedResponse } from "@/types/india/news";

// ---------------------------------------------------------------------------
// Stub SentinelPulse client methods so tests never hit the network.
//
// NOTE: The service reads articles from fetchMarketIndia().articles (not
// fetchLatestArticles). All article fixtures are delivered via marketIndia.
// ---------------------------------------------------------------------------

const fetchMarketIndiaMock = vi.fn();

vi.mock("@/services/india/news/sentinel-client", () => ({
  // fetchLatestArticles is no longer called by the service — stub it as a
  // no-op to satisfy any lingering imports without breaking tests.
  fetchLatestArticles: vi.fn().mockResolvedValue({ articles: [], nextCursor: null, total: 0 }),
  fetchMarketIndia: (...args: unknown[]) => fetchMarketIndiaMock(...args),
  SentinelPulseError: class SentinelPulseError extends Error {
    statusCode: number | null;
    code: string | null;
    constructor(msg: string, statusCode: number | null = null, code: string | null = null) {
      super(msg);
      this.name = "SentinelPulseError";
      this.statusCode = statusCode;
      this.code = code;
    }
  },
}));

// Stub cache.memo to pass through (no caching in tests)
vi.mock("@/services/india/cache", () => ({
  cache: {
    memo: (_key: string, _ttl: number, loader: () => unknown) => loader(),
  },
}));

import { getIndiaNews } from "@/services/india/news";

// ---------------------------------------------------------------------------
// Helpers — build a market/india response with embedded articles
// ---------------------------------------------------------------------------

function spArticle(overrides: Record<string, unknown> = {}) {
  return {
    id: "art_001",
    sourceId: "reuters",
    title: "RBI holds repo rate at 6.5%",
    summary: "The RBI MPC voted 4-2 to hold the repo rate.",
    canonicalUrl: "https://reuters.com/rbi-rate-hold",
    publishedAt: "2026-09-16T08:00:00.000Z",
    category: "RBI",
    language: "en",
    source: { name: "Reuters", tier: 1 },
    clusterId: null,
    author: null,
    importance_score: 0.87,
    event_type: "CENTRAL_BANK_DECISION",
    primary_entities: ["NIFTY50", "BANKNIFTY", "HDFCBANK"],
    sentiment: { overall: -0.08, market: -0.1, company: null, macro: -0.15, risk: 0.18 },
    ...overrides,
  };
}

/** Wrap articles in a /news/market/india-style response. */
function marketIndia(
  articles: ReturnType<typeof spArticle>[],
  extra: Record<string, unknown> = {},
) {
  return {
    as_of: "2026-09-16T09:00:00.000Z",
    articles,
    breadth: null,
    regime: null,
    hot_events: [],
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("services/india/news — getIndiaNews", () => {
  beforeEach(() => {
    fetchMarketIndiaMock.mockReset();
    // Default: returns an empty article list with no breadth/regime
    fetchMarketIndiaMock.mockResolvedValue(marketIndia([]));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("maps SentinelPulse articles to NewsItem shape", async () => {
    fetchMarketIndiaMock.mockResolvedValue(marketIndia([spArticle()]));
    const result: NewsFeedResponse = await getIndiaNews({ limit: 10 });

    expect(result.items).toHaveLength(1);
    const item = result.items[0];
    expect(item.id).toBe("art_001");
    expect(item.title).toBe("RBI holds repo rate at 6.5%");
    expect(item.link).toBe("https://reuters.com/rbi-rate-hold");
    expect(item.source).toBe("Reuters");
    expect(item.eventType).toBe("CENTRAL_BANK_DECISION");
    expect(item.importanceScore).toBe(0.87);
    expect(item.impact).toBe("high"); // importance_score >= 0.7
    expect(item.symbols).toContain("NIFTY50");
    expect(item.symbols).toContain("BANKNIFTY");
  });

  it("derives sentiment label from overall score", async () => {
    fetchMarketIndiaMock.mockResolvedValue(
      marketIndia([
        spArticle({ id: "bull", sentiment: { overall: 0.6, market: null, company: null, macro: null, risk: null } }),
        spArticle({ id: "bear", sentiment: { overall: -0.3, market: null, company: null, macro: null, risk: null } }),
        spArticle({ id: "neut", sentiment: { overall: 0.01, market: null, company: null, macro: null, risk: null } }),
      ]),
    );
    const result = await getIndiaNews();
    const labels = result.items.map((i) => i.sentiment.label);
    expect(labels).toContain("bullish");
    expect(labels).toContain("bearish");
    expect(labels).toContain("neutral");
  });

  it("maps importance_score to correct impact tiers", async () => {
    fetchMarketIndiaMock.mockResolvedValue(
      marketIndia([
        spArticle({ id: "a1", importance_score: 0.75 }),
        spArticle({ id: "a2", importance_score: 0.5 }),
        spArticle({ id: "a3", importance_score: 0.2 }),
      ]),
    );
    const result = await getIndiaNews();
    const impactById = Object.fromEntries(result.items.map((i) => [i.id, i.impact]));
    expect(impactById["a1"]).toBe("high");
    expect(impactById["a2"]).toBe("medium");
    expect(impactById["a3"]).toBe("low");
  });

  it("filters items to the requested category", async () => {
    fetchMarketIndiaMock.mockResolvedValue(
      marketIndia([
        spArticle({ id: "india_art", category: "RBI" }),
        spArticle({ id: "global_art", category: "GLOBAL" }),
      ]),
    );
    const result = await getIndiaNews({ category: "india" });
    expect(result.items.map((i) => i.id)).toContain("india_art");
    expect(result.items.map((i) => i.id)).not.toContain("global_art");
  });

  it("returns all items when category is 'all'", async () => {
    fetchMarketIndiaMock.mockResolvedValue(
      marketIndia([
        spArticle({ id: "a", category: "RBI" }),
        spArticle({ id: "b", category: "GLOBAL" }),
      ]),
    );
    const result = await getIndiaNews({ category: "all" });
    expect(result.items).toHaveLength(2);
  });

  it("synthesises sentiment from article scores when market/india has no regime", async () => {
    fetchMarketIndiaMock.mockResolvedValue(
      marketIndia([
        spArticle({ id: "bull", importance_score: 0.8, sentiment: { overall: 0.7, market: null, company: null, macro: null, risk: null } }),
        spArticle({ id: "bear", importance_score: 0.3, sentiment: { overall: -0.2, market: null, company: null, macro: null, risk: null } }),
      ]),
    );
    const result = await getIndiaNews();
    // Bullish article has higher importance weight → net should be bullish
    expect(result.sentiment.label).toBe("bullish");
    expect(result.sentiment.score).toBeGreaterThan(0);
    expect(result.sentiment.breadth).toBeNull();
    expect(result.sentiment.confidence).toBeNull();
  });

  it("includes breadth data when market/india returns breadth", async () => {
    fetchMarketIndiaMock.mockResolvedValue(
      marketIndia([spArticle()], {
        breadth: {
          advancing_articles_pct: 54.2,
          declining_articles_pct: 31.8,
          neutral_articles_pct: 14.0,
          net_breadth: 0.224,
          high_importance_count: 5,
          window_minutes: 60,
        },
      }),
    );
    const result = await getIndiaNews();
    expect(result.sentiment.breadth).not.toBeNull();
    expect(result.sentiment.breadth?.netBreadth).toBe(0.224);
    expect(result.sentiment.breadth?.highImportanceCount).toBe(5);
  });

  it("returns an empty sentinel response when SentinelPulse is unreachable", async () => {
    fetchMarketIndiaMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await getIndiaNews();
    expect(result.items).toHaveLength(0);
    expect(result.sentiment.label).toBe("neutral");
    expect(result.sentiment.score).toBe(0);
    expect(result.sentiment.headline).toBeTruthy();
  });

  it("filters out test.sentinelpulse.internal articles", async () => {
    fetchMarketIndiaMock.mockResolvedValue(
      marketIndia([
        spArticle({ id: "real", canonicalUrl: "https://economictimes.indiatimes.com/real-article" }),
        spArticle({ id: "test", canonicalUrl: "https://test.sentinelpulse.internal/articles/pipeline-123" }),
      ]),
    );
    const result = await getIndiaNews();
    expect(result.items.map((i) => i.id)).toContain("real");
    expect(result.items.map((i) => i.id)).not.toContain("test");
  });

  it("total reflects the count of real articles after filtering", async () => {
    fetchMarketIndiaMock.mockResolvedValue(
      marketIndia([
        spArticle({ id: "a" }),
        spArticle({ id: "b" }),
        spArticle({ id: "c" }),
      ]),
    );
    const result = await getIndiaNews({ limit: 100 });
    expect(result.total).toBe(3);
  });
});
