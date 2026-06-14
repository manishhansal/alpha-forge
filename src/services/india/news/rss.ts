// Dependency-free RSS / Atom-ish parser. Moneycontrol (and most Indian
// business feeds) publish RSS 2.0 with CDATA-wrapped titles + HTML in the
// description, so we extract <item> blocks and clean each field. Kept pure so
// it's unit-testable without any network.

import type { NewsCategory, RawNewsItem } from "@/types/india/news";

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function stripCdata(s: string): string {
  const m = s.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  return m ? m[1] : s;
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function clean(raw: string | null): string {
  if (!raw) return "";
  return decodeEntities(stripHtml(stripCdata(raw))).trim();
}

function extractTag(block: string, tag: string): string | null {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i");
  const m = block.match(re);
  return m ? m[1] : null;
}

function toIso(pubDate: string | null): string | null {
  if (!pubDate) return null;
  const cleaned = clean(pubDate);
  if (!cleaned) return null;
  const t = Date.parse(cleaned);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString();
}

/**
 * Parse an RSS/XML document into raw news items. Malformed input or a feed
 * with no <item> blocks yields an empty array (never throws), so the service
 * layer can `Promise.allSettled` across feeds and tolerate partial failures.
 */
export function parseRss(
  xml: string,
  source: string,
  category: NewsCategory,
): RawNewsItem[] {
  if (!xml || typeof xml !== "string") return [];

  const blocks = xml.match(/<item\b[\s\S]*?<\/item>/gi);
  if (!blocks) return [];

  const out: RawNewsItem[] = [];
  for (const block of blocks) {
    const title = clean(extractTag(block, "title"));
    const link = clean(extractTag(block, "link"));
    if (!title || !link) continue;
    out.push({
      title,
      link,
      summary: clean(extractTag(block, "description")),
      source,
      publishedAt: toIso(extractTag(block, "pubDate")),
      category,
    });
  }
  return out;
}
