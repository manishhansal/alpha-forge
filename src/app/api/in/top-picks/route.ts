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
      if (!symbolSectorMap.has(t)) symbolSectorMap.set(t, sector);
    }
  }

  const symbols = [...symbolSectorMap.keys()];
  const yfSymbols = symbols.map((s) => `${s}.NS`);
  const quotes = await Promise.all(yfSymbols.map(safeQuote));

  // Build scored rows and filter:
  //  - must have a price
  //  - must be directional (BUY / STRONG BUY / SELL / STRONG SELL)
  //  - HOLD and N/A are noise; never actionable for a "tomorrow picks" board
  const ACTIONABLE: SignalLabel[] = ["STRONG BUY", "BUY", "SELL", "STRONG SELL"];
  const rows = symbols
    .map((sym, i) => buildRow(sym, symbolSectorMap.get(sym)!, quotes[i]))
    .filter((r) => r.price != null && ACTIONABLE.includes(r.signal as SignalLabel));

  /**
   * "Top gainer / loser" momentum score — mirrors how NSE's own gainers list
   * works: rank by absolute day % move, then break ties with relative volume
   * so institutional-volume moves rank above low-volume noise. Stocks likely
   * to appear in today's top-10 gainers/losers are exactly the ones whose
   * `|changePct|` × `relVol` product is largest.
   *
   * We keep the quant score as a secondary tiebreaker so a +3% move with
   * strong SMA / RSI alignment beats a raw momentum spike that has nothing
   * else going for it.
   */
  function momentumRank(r: (typeof rows)[0]): number {
    const absPct = Math.abs(r.changePct ?? 0);
    const vol = r.relativeVolume ?? 1.0;
    return absPct * Math.max(vol, 0.5);          // min vol factor 0.5 so no-vol rows aren't zeroed
  }

  // Split into gainers (bullish signals) and losers (bearish signals),
  // ranked within each group by momentum score descending.
  const gainers = rows
    .filter((r) => r.signal === "STRONG BUY" || r.signal === "BUY")
    .sort((a, b) => {
      const dm = momentumRank(b) - momentumRank(a);
      if (Math.abs(dm) > 0.01) return dm;
      return b.score - a.score;                  // quant-score tiebreak
    });

  const losers = rows
    .filter((r) => r.signal === "STRONG SELL" || r.signal === "SELL")
    .sort((a, b) => {
      const dm = momentumRank(b) - momentumRank(a);
      if (Math.abs(dm) > 0.01) return dm;
      return a.score - b.score;                  // more negative = stronger sell
    });

  // Interleave top gainers then top losers (gainers first, losers appended),
  // sliced to `limit`. A caller that wants only gainers can request
  // `?limit=5&side=gainers`; default returns the blended list.
  const side = searchParams.get("side");
  let merged: typeof rows;
  if (side === "gainers") {
    merged = gainers;
  } else if (side === "losers") {
    merged = losers;
  } else {
    // Default: top gainers followed by top losers, capped at limit each side
    // so the response is balanced rather than all-gainers on a bullish day.
    const half = Math.ceil(limit / 2);
    merged = [...gainers.slice(0, half), ...losers.slice(0, limit - half)];
  }

  const picks: TopPickRow[] = merged.slice(0, limit).map((r, i) => ({
    ...r,
    rank: i + 1,
  }));

  return NextResponse.json(
    { picks, universe: rows.length, fetchedAt: new Date().toISOString() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
