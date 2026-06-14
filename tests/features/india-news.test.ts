import { describe, expect, it } from "vitest";

import {
  computeMarketSentiment,
  enrichNewsItems,
  filterTopNews,
  scoreHeadlineSentiment,
  tagImpact,
} from "@/features/india/news/engine";
import type { NewsItem, RawNewsItem } from "@/types/india/news";

function raw(partial: Partial<RawNewsItem> & { title: string }): RawNewsItem {
  return {
    summary: "",
    link: `https://example.com/${encodeURIComponent(partial.title)}`,
    source: "Moneycontrol · Markets",
    publishedAt: "2026-06-15T03:00:00.000Z",
    category: "india",
    ...partial,
  };
}

describe("features/india/news/engine", () => {
  describe("scoreHeadlineSentiment", () => {
    it("reads a bullish headline as bullish with a positive score", () => {
      const s = scoreHeadlineSentiment(
        "Nifty surges to record high on a strong rally",
      );
      expect(s.label).toBe("bullish");
      expect(s.score).toBeGreaterThan(0);
    });

    it("reads a bearish headline as bearish with a negative score", () => {
      const s = scoreHeadlineSentiment(
        "Sensex crashes as stocks slump amid recession fears",
      );
      expect(s.label).toBe("bearish");
      expect(s.score).toBeLessThan(0);
    });

    it("reads a neutral headline as neutral with a zero score", () => {
      const s = scoreHeadlineSentiment("RBI keeps repo rate unchanged in review");
      expect(s.label).toBe("neutral");
      expect(s.score).toBe(0);
    });

    it("is case-insensitive and uses whole-word matching", () => {
      expect(scoreHeadlineSentiment("RALLY continues").score).toBeGreaterThan(0);
      // "rallying" should not match the "rally" keyword token by accident in a
      // way that flips an otherwise-neutral sentence — but a clear word should.
      expect(scoreHeadlineSentiment("markets steady").label).toBe("neutral");
    });
  });

  describe("tagImpact", () => {
    it("tags a specific F&O stock as high impact", () => {
      const t = tagImpact("RELIANCE jumps 5% after earnings beat");
      expect(t.symbols).toContain("RELIANCE");
      expect(t.impact).toBe("high");
    });

    it("tags an index underlying as high impact", () => {
      const t = tagImpact("Nifty hits a fresh record high");
      expect(t.symbols).toContain("NIFTY");
      expect(t.impact).toBe("high");
    });

    it("tags a sector mention as medium impact", () => {
      const t = tagImpact("IT sector under pressure on weak guidance");
      expect(t.sectors).toContain("IT");
      expect(t.impact).toBe("medium");
      expect(t.symbols).toHaveLength(0);
    });

    it("tags generic macro colour as low impact", () => {
      const t = tagImpact("Global cues remain mixed ahead of data");
      expect(t.impact).toBe("low");
      expect(t.symbols).toHaveLength(0);
      expect(t.sectors).toHaveLength(0);
    });
  });

  describe("enrichNewsItems", () => {
    it("maps raw items into enriched items with id, sentiment and impact", () => {
      const items = enrichNewsItems([
        raw({ title: "RELIANCE surges on strong rally" }),
      ]);
      expect(items).toHaveLength(1);
      const item = items[0];
      expect(item.id).toBeTruthy();
      expect(item.title).toBe("RELIANCE surges on strong rally");
      expect(item.sentiment.label).toBe("bullish");
      expect(item.impact).toBe("high");
      expect(item.symbols).toContain("RELIANCE");
      expect(item.category).toBe("india");
    });
  });

  describe("filterTopNews", () => {
    it("dedupes by title", () => {
      const items = enrichNewsItems([
        raw({ title: "RELIANCE surges on strong rally" }),
        raw({ title: "RELIANCE surges on strong rally" }),
      ]);
      const out = filterTopNews(items);
      expect(out).toHaveLength(1);
    });

    it("sorts high-impact items ahead of low-impact items", () => {
      const items = enrichNewsItems([
        raw({ title: "Global cues mixed ahead of data" }),
        raw({ title: "TCS rallies after earnings beat" }),
      ]);
      const out = filterTopNews(items);
      expect(out[0].impact).toBe("high");
    });

    it("drops items below minImpact and honours limit", () => {
      const items = enrichNewsItems([
        raw({ title: "HDFCBANK gains on upgrade" }),
        raw({ title: "Auto sector rallies on demand" }),
        raw({ title: "Global cues mixed ahead of data" }),
      ]);
      const out = filterTopNews(items, { minImpact: "medium", limit: 1 });
      expect(out).toHaveLength(1);
      expect(out.every((i) => i.impact !== "low")).toBe(true);
    });
  });

  describe("computeMarketSentiment", () => {
    it("returns a neutral, mid-risk read for an empty set", () => {
      const s = computeMarketSentiment([]);
      expect(s.label).toBe("neutral");
      expect(s.score).toBe(0);
      expect(s.riskRatio).toBe(50);
      expect(s.regime).toBe("mixed");
    });

    it("reads a bullish-heavy set as bullish and risk-on", () => {
      const items = enrichNewsItems([
        raw({ title: "RELIANCE surges to record high on strong rally" }),
        raw({ title: "TCS jumps after earnings beat and upgrade" }),
        raw({ title: "Nifty rallies as buying optimism lifts gains" }),
      ]);
      const s = computeMarketSentiment(items);
      expect(s.label).toBe("bullish");
      expect(s.score).toBeGreaterThan(0);
      expect(s.riskRatio).toBeGreaterThan(50);
      expect(s.regime).toBe("risk-on");
      expect(s.bullCount).toBeGreaterThan(s.bearCount);
    });

    it("reads a bearish, macro-risk-heavy set as risk-off", () => {
      const items = enrichNewsItems([
        raw({ title: "Sensex crashes as recession fears trigger selloff" }),
        raw({ title: "Nifty slumps amid war and inflation worries" }),
        raw({ title: "Bank stocks plunge on crisis and default fears" }),
      ]);
      const s = computeMarketSentiment(items);
      expect(s.label).toBe("bearish");
      expect(s.score).toBeLessThan(0);
      expect(s.riskRatio).toBeLessThan(50);
      expect(s.regime).toBe("risk-off");
      expect(s.headline).toBeTruthy();
    });

    it("keeps riskRatio within [0, 100]", () => {
      const items = enrichNewsItems([
        raw({ title: "war crisis crash recession default selloff plunge slump" }),
      ]);
      const s = computeMarketSentiment(items);
      expect(s.riskRatio).toBeGreaterThanOrEqual(0);
      expect(s.riskRatio).toBeLessThanOrEqual(100);
    });
  });
});

// Type-only guard so the test file is coupled to the public NewsItem shape.
const _typeGuard: NewsItem["impact"] = "high";
void _typeGuard;
