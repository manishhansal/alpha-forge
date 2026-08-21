/**
 * API Route: Top 5 Stocks for Tomorrow
 *
 * After market close, surfaces the five highest-conviction NSE F&O stocks
 * for the next trading session. Scores every stock in the SECTOR_STOCKS
 * universe using the same 8-factor quant model as the sector-stocks route,
 * then returns the top-N sorted by score descending.
 *
 * GET /api/in/top-picks?limit=5
 *
 * This route is intentionally lightweight — it re-uses computeScore /
 * classifySignal from the shared signals service and does not require the
 * ML service to be running (graceful fallback to the heuristic model).
 */

import { NextResponse } from "next/server";
import YahooFinance from "yahoo-finance2";

import { SECTOR_STOCKS } from "@/lib/india/sectors";
import {
  classifySignal,
  computeScore,
  type SignalLabel,
} from "@/services/india/signals/score";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const yahooFinance = new YahooFinance();

// ─── Types ────────────────────────────────────────────────────────────────────

type YfRichQuote = {
  regularMarketPrice?: number | null;
  regularMarketChangePercent?: number | null;
  regularMarketPreviousClose?: number | null;
  fiftyDayAverage?: number | null;
  twoHundredDayAverage?: number | null;
  fiftyTwoWeekHigh?: number | null;
  fiftyTwoWeekLow?: number | null;
  targetMeanPrice?: number | null;
  shortName?: string | null;
  longName?: string | null;
  averageDailyVolume3Month?: number | null;
  regularMarketVolume?: number | null;
};

export type TopPickRow = {
  rank: number;
  symbol: string;
  shortName: string | null;
  sector: string;
  price: number | null;
  changePct: number | null;
  score: number;
  signal: SignalLabel;
  upsidePct: number | null;
  fromSma50Pct: number | null;
  /** Relative volume vs 3-month average (1.0 = average). */
  relativeVolume: number | null;
  /** Analyst mean target price. */
  targetMean: number | null;
};

type TopPicksResponse = {
  picks: TopPickRow[];
  universe: number;
  fetchedAt: string;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function safeQuote(yfSymbol: string): Promise<YfRichQuote | null> {
  try {
    return (await yahooFinance.quote(yfSymbol)) as unknown as YfRichQuote;
  } catch {
    return null;
  }
}

function buildRow(
  symbol: string,
  sector: string,
  q: YfRichQuote | null,
): Omit<TopPickRow, "rank"> {
  const price = q?.regularMarketPrice ?? null;
  const sma50 = q?.fiftyDayAverage ?? null;
  const sma200 = q?.twoHundredDayAverage ?? null;
  const high52w = q?.fiftyTwoWeekHigh ?? null;
  const targetMean = q?.targetMeanPrice ?? null;
  const changePct = q?.regularMarketChangePercent ?? null;

  const score = computeScore({ price, sma50, sma200, changePct, targetMean });
  const signal: SignalLabel = price == null ? "N/A" : classifySignal(score);

  const upsidePct =
    price && (targetMean || high52w)
      ? ((Math.max(targetMean ?? 0, high52w ?? 0) - price) / price) * 100
      : null;

  const fromSma50Pct =
    price && sma50 ? ((price - sma50) / sma50) * 100 : null;

  const avgVol = q?.averageDailyVolume3Month ?? null;
  const todayVol = q?.regularMarketVolume ?? null;
  const relativeVolume =
    avgVol && avgVol > 0 && todayVol != null ? todayVol / avgVol : null;

  return {
    symbol,
    sector,
    shortName: q?.shortName ?? q?.longName ?? null,
    price,
    changePct,
    score,
    signal,
    upsidePct,
    fromSma50Pct,
    relativeVolume,
    targetMean,
  };
}

// ─── Route ────────────────────────────────────────────────────────────────────

export async function GET(req: Request): Promise<NextResponse<TopPicksResponse>> {
  const { searchParams } = new URL(req.url);
  const limit = Math.min(20, Math.max(1, Number(searchParams.get("limit") ?? 5)));

  // Flatten all sectors into a deduplicated symbol → primary-sector map.
  const symbolSectorMap = new Map<string, string>();
  for (const [sector, tickers] of Object.entries(SECTOR_STOCKS)) {
    for (const t of tickers) {
      // First sector wins — keeps a consistent primary label per symbol.
      if (!symbolSectorMap.has(t)) {
        symbolSectorMap.set(t, sector);
      }
    }
  }

  const symbols = [...symbolSectorMap.keys()];

  // Fetch all quotes concurrently (yahoo-finance2 handles per-symbol).
  const yfSymbols = symbols.map((s) => `${s}.NS`);
  const quotes = await Promise.all(yfSymbols.map(safeQuote));

  // Build scored rows and filter out any with no price data.
  const rows = symbols
    .map((sym, i) =>
      buildRow(sym, symbolSectorMap.get(sym)!, quotes[i]),
    )
    .filter((r) => r.price != null && r.signal !== "N/A");

  // Sort by score descending, then by upside% as a tiebreaker.
  rows.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (b.upsidePct ?? 0) - (a.upsidePct ?? 0);
  });

  const picks: TopPickRow[] = rows.slice(0, limit).map((r, i) => ({
    ...r,
    rank: i + 1,
  }));

  return NextResponse.json(
    { picks, universe: rows.length, fetchedAt: new Date().toISOString() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
