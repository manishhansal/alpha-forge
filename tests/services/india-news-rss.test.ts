import { describe, expect, it } from "vitest";

import { parseRss } from "@/services/india/news/rss";

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Moneycontrol Markets</title>
    <item>
      <title><![CDATA[RELIANCE surges 5% on earnings beat]]></title>
      <link>https://www.moneycontrol.com/news/reliance-1.html</link>
      <description><![CDATA[<p>Shares of <b>RELIANCE</b> jumped after results.</p>]]></description>
      <pubDate>Sun, 15 Jun 2026 08:30:00 +0530</pubDate>
    </item>
    <item>
      <title>Nifty ends flat</title>
      <link>https://www.moneycontrol.com/news/nifty-2.html</link>
      <description>Markets closed little changed.</description>
      <pubDate>Sun, 15 Jun 2026 09:00:00 +0530</pubDate>
    </item>
  </channel>
</rss>`;

describe("services/india/news/rss — parseRss", () => {
  it("parses items with title, link, summary, pubDate", () => {
    const items = parseRss(SAMPLE, "Moneycontrol · Markets", "india");
    expect(items).toHaveLength(2);
    const first = items[0];
    expect(first.title).toBe("RELIANCE surges 5% on earnings beat");
    expect(first.link).toBe("https://www.moneycontrol.com/news/reliance-1.html");
    expect(first.source).toBe("Moneycontrol · Markets");
    expect(first.category).toBe("india");
    expect(first.publishedAt).not.toBeNull();
  });

  it("strips CDATA and HTML tags from the summary", () => {
    const items = parseRss(SAMPLE, "Moneycontrol · Markets", "india");
    const first = items[0];
    expect(first.summary).not.toContain("<");
    expect(first.summary).toContain("RELIANCE");
    expect(first.summary).toContain("jumped");
  });

  it("normalises pubDate into an ISO string", () => {
    const items = parseRss(SAMPLE, "Moneycontrol · Markets", "india");
    expect(() => new Date(items[0].publishedAt as string).toISOString()).not.toThrow();
    expect(items[0].publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("returns an empty array for malformed / empty XML", () => {
    expect(parseRss("", "x", "india")).toEqual([]);
    expect(parseRss("not xml at all", "x", "india")).toEqual([]);
    expect(parseRss("<rss><channel></channel></rss>", "x", "india")).toEqual([]);
  });

  it("skips items without a title or link", () => {
    const xml = `<rss><channel>
      <item><link>https://x.com/a</link></item>
      <item><title>Has title only</title></item>
      <item><title>Good</title><link>https://x.com/good</link></item>
    </channel></rss>`;
    const items = parseRss(xml, "x", "global");
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("Good");
    expect(items[0].category).toBe("global");
  });
});
