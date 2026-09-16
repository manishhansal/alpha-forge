import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { NewsFeedResponse } from "@/types/india/news";

// ---------------------------------------------------------------------------
// Stub SentinelPulse client methods so tests never hit the network.
// ---------------------------------------------------------------------------

const fetchLatestMock = vi.fn();
const fetchMarketIndiaMock = vi.fn();

vi.mock("@/services/india/news/sentinel-client", () => ({
  fetchLatestArticles: (...args: unknown[]) => fetchLatestMock(...args),
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
// Sample data fixtures
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

function latestResult(articles: ReturnType<typeof spArticle>[]) {
  return { articles, nextCursor: null, total: articles.length };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("services/india/news — getIndiaNews", () => {
  beforeEach(() => {
    fetchLatestMock.mockReset();
    fetchMarketIndiaMock.mockReset();
    // Default: market endpoint unavailable (no breadth/regime)
    fetchMarketIndiaMock.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("maps SentinelPulse articles to NewsItem shape", async () => {
    fetchLatestMock.mockResolvedValue(latestResult([spArticle()]));
    const result: NewsFeedResponse = await getIndiaNews({ limit: 10 });

    expect(result.items).toHaveLength(1);
    const item = result.items[0];
    expect(item.id).toBe("art_001");
    expect(item.title).toBe("RBI holds repo rate at 6.5%");
    expect(item.link).toBe("https://reuters.com/rbi-rate-hold");
    expect(item.source).toBe("Reuters");
    expect(item.eventType).toBe("CENTRAL_BANK_DECISION");
    expect(item.importanceScore).toBe(0.87);
    expect(item.impact).toBe("high"); // importance >= 0.7
    expect(item.symbols).toContain("NIFTY50");
    expect(item.symbols).toContain("BANKNIFTY");
  });

  it("derives sentiment label from overall score", async () => {
    fetchLatestMock.mockResolvedValue(
      latestResult([
        spArticle({ sentiment: { overall: 0.6, market: null, company: null, macro: null, risk: null } }),
        spArticle({ id: "art_002", sentiment: { overall: -0.3, market: null, company: null, macro: null, risk: null } }),
        spArticle({ id: "art_003", sentiment: { overall: 0.01, market: null, company: null, macro: null, risk: null } }),
      ]),
    );
    const result = await getIndiaNews();
    const labels = result.items.map((i) => i.sentiment.label);
    expect(labels).toContain("bullish");
    expect(labels).toContain("bearish");
    expect(labels).toContain("neutral");
  });

  it("maps importance_score to correct impact tiers", async () => {
    fetchLatestMock.mockResolvedValue(
      latestResult([
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
    fetchLatestMock.mockResolvedValue(
      latestResult([
        spArticle({ id: "india_art", category: "RBI" }),
        spArticle({ id: "global_art", category: "GLOBAL" }),
      ]),
    );
    const result = await getIndiaNews({ category: "india" });
    expect(result.items.map((i) => i.id)).toContain("india_art");
    expect(result.items.map((i) => i.id)).not.toContain("global_art");
  });

  it("returns all items when category is 'all'", async () => {
    fetchLatestMock.mockResolvedValue(
      latestResult([
        spArticle({ id: "a", category: "RBI" }),
        spArticle({ id: "b", category: "GLOBAL" }),
      ]),
    );
    const result = await getIndiaNews({ category: "all" });
    expect(result.items).toHaveLength(2);
  });

  it("synthesises sentiment from article scores when market/india is unavailable", async () => {
    fetchLatestMock.mockResolvedValue(
      latestResult([
        spArticle({ id: "bull", importance_score: 0.8, sentiment: { overall: 0.7, market: null, company: null, macro: null, risk: null } }),
        spArticle({ id: "bear", importance_score: 0.3, sentiment: { overall: -0.2, market: null, company: null, macro: null, risk: null } }),
      ]),
    );
    fetchMarketIndiaMock.mockResolvedValue(null);
    const result = await getIndiaNews();
    // Bullish article has higher importance weight, net should be bullish
    expect(result.sentiment.label).toBe("bullish");
    expect(result.sentiment.score).toBeGreaterThan(0);
    expect(result.sentiment.breadth).toBeNull();
    expect(result.sentiment.confidence).toBeNull();
  });

  it("includes breadth data when market/india is available", async () => {
    fetchLatestMock.mockResolvedValue(latestResult([spArticle()]));
    fetchMarketIndiaMock.mockResolvedValue({
      as_of: "2026-09-16T09:00:00.000Z",
      breadth: {
        advancing_articles_pct: 54.2,
        declining_articles_pct: 31.8,
        neutral_articles_pct: 14.0,
        net_breadth: 0.224,
        high_importance_count: 5,
        window_minutes: 60,
      },
      regime: null,
      hot_events: [],
    });
    const result = await getIndiaNews();
    expect(result.sentiment.breadth).not.toBeNull();
    expect(result.sentiment.breadth?.netBreadth).toBe(0.224);
    expect(result.sentiment.breadth?.highImportanceCount).toBe(5);
  });

  it("returns an empty sentinel response when SentinelPulse is unreachable", async () => {
    fetchLatestMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await getIndiaNews();
    expect(result.items).toHaveLength(0);
    expect(result.sentiment.label).toBe("neutral");
    expect(result.sentiment.score).toBe(0);
    // Either the "no headlines" or "unavailable" message is acceptable
    expect(result.sentiment.headline).toBeTruthy();
  });

  it("includes nextCursor and total from the SentinelPulse response", async () => {
    fetchLatestMock.mockResolvedValue({
      articles: [spArticle()],
      nextCursor: "cursor_xyz",
      total: 150,
    });
    const result = await getIndiaNews();
    expect(result.nextCursor).toBe("cursor_xyz");
    expect(result.total).toBe(150);
  });
});
