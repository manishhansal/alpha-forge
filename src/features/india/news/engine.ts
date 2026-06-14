// Pure, deterministic news-intelligence engine for the Indian-market News
// surface. No I/O — it takes raw RSS headlines (already parsed) and folds
// them into per-headline sentiment + F&O impact tags and an aggregate
// market sentiment + risk-on/risk-off ratio. Being pure keeps it trivially
// testable and identical on the server and (if ever needed) the client.

import {
  FNO_INDEX_UNDERLYINGS,
  FNO_STOCKS,
} from "@/lib/india/fno-symbols";
import type {
  MarketSentiment,
  NewsImpact,
  NewsItem,
  NewsRegime,
  NewsSentimentLabel,
  RawNewsItem,
} from "@/types/india/news";

// --- Lexicons ---------------------------------------------------------------

// Whole-word bullish / bearish tokens. Kept deliberately small and
// high-precision so the read stays explainable.
const BULL_LEXICON: readonly string[] = [
  "surge",
  "surges",
  "surged",
  "rally",
  "rallies",
  "rallied",
  "jump",
  "jumps",
  "jumped",
  "gain",
  "gains",
  "gained",
  "rise",
  "rises",
  "rose",
  "soar",
  "soars",
  "soared",
  "record",
  "high",
  "highs",
  "beat",
  "beats",
  "upgrade",
  "upgrades",
  "upgraded",
  "optimism",
  "bullish",
  "outperform",
  "inflow",
  "inflows",
  "buying",
  "profit",
  "growth",
  "strong",
  "boost",
  "boosts",
  "recovery",
  "rebound",
  "rebounds",
];

const BEAR_LEXICON: readonly string[] = [
  "crash",
  "crashes",
  "crashed",
  "slump",
  "slumps",
  "slumped",
  "plunge",
  "plunges",
  "plunged",
  "fall",
  "falls",
  "fell",
  "drop",
  "drops",
  "dropped",
  "slide",
  "slides",
  "tumble",
  "tumbles",
  "tumbled",
  "loss",
  "losses",
  "downgrade",
  "downgrades",
  "downgraded",
  "bearish",
  "selloff",
  "sell-off",
  "outflow",
  "outflows",
  "weak",
  "weakness",
  "fear",
  "fears",
  "recession",
  "crisis",
  "default",
  "fraud",
  "war",
  "slowdown",
  "cut",
  "cuts",
  "warning",
  "miss",
  "misses",
  "underperform",
];

// Macro-risk tokens nudge the aggregate read toward "risk-off" independent of
// the per-headline bull/bear count (a war headline is risk-off even if it
// contains no explicit "fall"-type word).
const MACRO_RISK_LEXICON: readonly string[] = [
  "war",
  "crisis",
  "recession",
  "inflation",
  "selloff",
  "sell-off",
  "crash",
  "default",
  "plunge",
  "slump",
  "tariff",
  "sanction",
  "sanctions",
  "geopolitical",
  "hike",
  "downgrade",
  "fear",
  "fears",
];

// Sector keyword -> canonical sector name (from lib/india/sectors.ts). Each
// keyword is matched whole-word, case-insensitive.
const SECTOR_KEYWORDS: ReadonlyArray<{ keyword: string; sector: string }> = [
  { keyword: "bank", sector: "Bank" },
  { keyword: "banks", sector: "Bank" },
  { keyword: "banking", sector: "Bank" },
  { keyword: "lender", sector: "Bank" },
  { keyword: "lenders", sector: "Bank" },
  { keyword: "psu bank", sector: "PSU Bank" },
  { keyword: "software", sector: "IT" },
  { keyword: "technology", sector: "IT" },
  { keyword: "it sector", sector: "IT" },
  { keyword: "it stocks", sector: "IT" },
  { keyword: "it shares", sector: "IT" },
  { keyword: "it firms", sector: "IT" },
  { keyword: "auto", sector: "Auto" },
  { keyword: "automobile", sector: "Auto" },
  { keyword: "automakers", sector: "Auto" },
  { keyword: "carmaker", sector: "Auto" },
  { keyword: "carmakers", sector: "Auto" },
  { keyword: "pharma", sector: "Pharma" },
  { keyword: "drugmaker", sector: "Pharma" },
  { keyword: "pharmaceutical", sector: "Pharma" },
  { keyword: "fmcg", sector: "FMCG" },
  { keyword: "metal", sector: "Metal" },
  { keyword: "metals", sector: "Metal" },
  { keyword: "steel", sector: "Metal" },
  { keyword: "mining", sector: "Metal" },
  { keyword: "energy", sector: "Energy" },
  { keyword: "power", sector: "Energy" },
  { keyword: "oil", sector: "Energy" },
  { keyword: "gas", sector: "Energy" },
  { keyword: "refiner", sector: "Energy" },
  { keyword: "realty", sector: "Realty" },
  { keyword: "real estate", sector: "Realty" },
  { keyword: "housing", sector: "Realty" },
  { keyword: "property", sector: "Realty" },
  { keyword: "nbfc", sector: "Fin Services" },
  { keyword: "insurance", sector: "Fin Services" },
  { keyword: "insurer", sector: "Fin Services" },
  { keyword: "broking", sector: "Fin Services" },
  { keyword: "financial services", sector: "Fin Services" },
  { keyword: "infra", sector: "Infra" },
  { keyword: "infrastructure", sector: "Infra" },
  { keyword: "capital goods", sector: "Infra" },
  { keyword: "defence", sector: "Infra" },
  { keyword: "defense", sector: "Infra" },
  { keyword: "media", sector: "Media" },
  { keyword: "broadcaster", sector: "Media" },
];

// Index name -> canonical underlying, including common spelling variants.
const INDEX_ALIASES: ReadonlyArray<{ alias: string; underlying: string }> = [
  { alias: "bank nifty", underlying: "BANKNIFTY" },
  { alias: "banknifty", underlying: "BANKNIFTY" },
  { alias: "nifty bank", underlying: "BANKNIFTY" },
  { alias: "fin nifty", underlying: "FINNIFTY" },
  { alias: "finnifty", underlying: "FINNIFTY" },
  { alias: "midcap nifty", underlying: "MIDCPNIFTY" },
  { alias: "midcpnifty", underlying: "MIDCPNIFTY" },
  { alias: "nifty", underlying: "NIFTY" },
  { alias: "sensex", underlying: "SENSEX" },
];

// Two-char tickers and a handful of common English words collide too easily
// with normal prose, so we skip them in the symbol matcher (the index aliases
// and 3+ char tickers carry the high-impact signal).
const SYMBOL_DENYLIST = new Set<string>(["OIL", "GAIL", "ABB", "BSE", "MCX"]);

const MATCHABLE_SYMBOLS: readonly string[] = FNO_STOCKS.filter(
  (s) => s.length >= 3 && !SYMBOL_DENYLIST.has(s),
);

// --- Helpers ----------------------------------------------------------------

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countWholeWord(haystackLower: string, tokenLower: string): number {
  const re = new RegExp(`\\b${escapeRegExp(tokenLower)}\\b`, "g");
  const m = haystackLower.match(re);
  return m ? m.length : 0;
}

function hasPhrase(haystackLower: string, phraseLower: string): boolean {
  // Whole-word for single tokens; substring-with-boundaries for phrases.
  const re = new RegExp(
    `(?:^|[^a-z0-9])${escapeRegExp(phraseLower)}(?:[^a-z0-9]|$)`,
  );
  return re.test(haystackLower);
}

/** Match an upper-case ticker against the original (upper-cased) text. */
function hasTicker(haystackUpper: string, ticker: string): boolean {
  const re = new RegExp(
    `(?:^|[^A-Z0-9&-])${escapeRegExp(ticker)}(?:[^A-Z0-9&-]|$)`,
  );
  return re.test(haystackUpper);
}

// --- Public API -------------------------------------------------------------

/** Net bull/bear lexicon read for a single headline. */
export function scoreHeadlineSentiment(text: string): {
  label: NewsSentimentLabel;
  score: number;
} {
  const lower = (text ?? "").toLowerCase();
  let bull = 0;
  let bear = 0;
  for (const t of BULL_LEXICON) bull += countWholeWord(lower, t);
  for (const t of BEAR_LEXICON) bear += countWholeWord(lower, t);
  const score = bull - bear;
  const label: NewsSentimentLabel =
    score > 0 ? "bullish" : score < 0 ? "bearish" : "neutral";
  return { label, score };
}

/** Tag a headline with F&O symbols / sectors and an impact level. */
export function tagImpact(text: string): {
  symbols: string[];
  sectors: string[];
  impact: NewsImpact;
} {
  const upper = (text ?? "").toUpperCase();
  const lower = (text ?? "").toLowerCase();

  const symbols = new Set<string>();

  for (const { alias, underlying } of INDEX_ALIASES) {
    if (hasPhrase(lower, alias)) symbols.add(underlying);
  }
  for (const u of FNO_INDEX_UNDERLYINGS) {
    if (hasTicker(upper, u)) symbols.add(u);
  }
  for (const sym of MATCHABLE_SYMBOLS) {
    if (hasTicker(upper, sym)) symbols.add(sym);
  }

  const sectors = new Set<string>();
  for (const { keyword, sector } of SECTOR_KEYWORDS) {
    if (hasPhrase(lower, keyword)) sectors.add(sector);
  }

  const impact: NewsImpact =
    symbols.size > 0 ? "high" : sectors.size > 0 ? "medium" : "low";

  return { symbols: [...symbols], sectors: [...sectors], impact };
}

function makeId(item: RawNewsItem): string {
  const basis = item.link || item.title;
  let hash = 0;
  for (let i = 0; i < basis.length; i++) {
    hash = (hash * 31 + basis.charCodeAt(i)) | 0;
  }
  return `news_${(hash >>> 0).toString(36)}`;
}

/** Enrich raw RSS items with sentiment + impact tagging. */
export function enrichNewsItems(items: RawNewsItem[]): NewsItem[] {
  return items.map((it) => {
    const sentiment = scoreHeadlineSentiment(`${it.title} ${it.summary}`);
    const { symbols, sectors, impact } = tagImpact(`${it.title} ${it.summary}`);
    return {
      id: makeId(it),
      title: it.title,
      summary: it.summary,
      link: it.link,
      source: it.source,
      publishedAt: it.publishedAt,
      category: it.category,
      sentiment,
      impact,
      symbols,
      sectors,
    };
  });
}

const IMPACT_RANK: Record<NewsImpact, number> = { high: 3, medium: 2, low: 1 };

/**
 * Keep the most market-relevant headlines: dedupe by title, optionally drop
 * everything below `minImpact`, sort high-impact + most-recent first, and cap
 * to `limit`.
 */
export function filterTopNews(
  items: NewsItem[],
  opts: { minImpact?: NewsImpact; limit?: number } = {},
): NewsItem[] {
  const { minImpact = "low", limit } = opts;
  const minRank = IMPACT_RANK[minImpact];

  const seen = new Set<string>();
  const deduped: NewsItem[] = [];
  for (const it of items) {
    const key = it.title.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (IMPACT_RANK[it.impact] < minRank) continue;
    deduped.push(it);
  }

  deduped.sort((a, b) => {
    const ir = IMPACT_RANK[b.impact] - IMPACT_RANK[a.impact];
    if (ir !== 0) return ir;
    const at = a.publishedAt ? Date.parse(a.publishedAt) : 0;
    const bt = b.publishedAt ? Date.parse(b.publishedAt) : 0;
    return bt - at;
  });

  return typeof limit === "number" ? deduped.slice(0, Math.max(0, limit)) : deduped;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Fold the enriched set into an aggregate market sentiment + risk ratio. */
export function computeMarketSentiment(items: NewsItem[]): MarketSentiment {
  if (items.length === 0) {
    return {
      label: "neutral",
      score: 0,
      riskRatio: 50,
      regime: "mixed",
      bullCount: 0,
      bearCount: 0,
      headline: "No market-moving headlines right now.",
    };
  }

  let weighted = 0;
  let totalWeight = 0;
  let bullCount = 0;
  let bearCount = 0;
  let macroHits = 0;

  for (const it of items) {
    const w = IMPACT_RANK[it.impact];
    weighted += it.sentiment.score * w;
    totalWeight += w;
    if (it.sentiment.label === "bullish") bullCount++;
    else if (it.sentiment.label === "bearish") bearCount++;

    const lower = `${it.title} ${it.summary}`.toLowerCase();
    for (const t of MACRO_RISK_LEXICON) macroHits += countWholeWord(lower, t);
  }

  // Average net sentiment per weight unit, scaled to a -100..100 band.
  const avg = totalWeight > 0 ? weighted / totalWeight : 0;
  const score = clamp(Math.round(avg * 25), -100, 100);

  const label: NewsSentimentLabel =
    score > 5 ? "bullish" : score < -5 ? "bearish" : "neutral";

  const macroPenalty = Math.min(20, macroHits * 3);
  const riskRatio = clamp(Math.round(50 + score / 2 - macroPenalty), 0, 100);

  const regime: NewsRegime =
    riskRatio >= 60 ? "risk-on" : riskRatio <= 40 ? "risk-off" : "mixed";

  const headline = buildHeadline(label, regime, bullCount, bearCount);

  return { label, score, riskRatio, regime, bullCount, bearCount, headline };
}

function buildHeadline(
  label: NewsSentimentLabel,
  regime: NewsRegime,
  bull: number,
  bear: number,
): string {
  const tone =
    label === "bullish"
      ? "Headlines skew bullish"
      : label === "bearish"
        ? "Headlines skew bearish"
        : "Headlines are mixed";
  const risk =
    regime === "risk-on"
      ? "risk-on tape"
      : regime === "risk-off"
        ? "risk-off tape"
        : "balanced risk";
  return `${tone} — ${risk} (${bull} bullish / ${bear} bearish).`;
}
