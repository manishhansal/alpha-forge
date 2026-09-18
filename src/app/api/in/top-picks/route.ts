/**
 * API Route: Top 5 Stocks for Tomorrow
 *
 * Surfaces the highest-conviction NSE F&O stocks using data from data-service2.0.
 * GET /api/in/top-picks?limit=5
 */
import { NextResponse } from "next/server";
import { getQuotes, DataServiceUnavailableError } from "@/lib/data-service/client";
import type { MarketQuote } from "@/lib/data-service/types";
import { SECTOR_STOCKS } from "@/lib/india/sectors";
import {
  classifySignal,
  computeScore,
  type SignalLabel,
} from "@/services/india/signals/score";

export const dynamic = "force-dynamic";
export const revalidate = 0;

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
  relativeVolume: number | null;
  targetMean: number | null;
};

type TopPicksResponse = {
  picks: TopPickRow[];
  universe: number;
  fetchedAt: string;
};

function buildRow(
  symbol: string,
  sector: string,
  q: MarketQuote | null,
): Omit<TopPickRow, "rank"> {
  const price = q?.ltp ?? null;
  const changePct = q?.changePct ?? null;
  const score = computeScore({ price, sma50: null, sma200: null, changePct, targetMean: null });
  const signal: SignalLabel = price == null ? "N/A" : classifySignal(score);
  const upsidePct: number | null = null;
  return {
    symbol,
    sector,
    shortName: null,
    price,
    changePct,
    score,
    signal,
    upsidePct,
    fromSma50Pct: null,
    relativeVolume: null,
    targetMean: null,
  };
}

export async function GET(req: Request): Promise<NextResponse<TopPicksResponse | { error: string }>> {
  const { searchParams } = new URL(req.url);
  const limit = Math.min(20, Math.max(1, Number(searchParams.get("limit") ?? 5)));

  const symbolSectorMap = new Map<string, string>();
  for (const [sector, tickers] of Object.entries(SECTOR_STOCKS)) {
    for (const t of tickers) {
      if (!symbolSectorMap.has(t)) symbolSectorMap.set(t, sector);
    }
  }
  const symbols = [...symbolSectorMap.keys()];

  let quotes: Array<MarketQuote | null>;
  try {
    quotes = await getQuotes(symbols, "NSE");
  } catch (err) {
    if (err instanceof DataServiceUnavailableError) {
      return NextResponse.json(
        { error: "DATA_SERVICE_UNAVAILABLE" },
        { status: 503 },
      );
    }
    quotes = symbols.map(() => null);
  }

  const ACTIONABLE: SignalLabel[] = ["STRONG BUY", "BUY", "SELL", "STRONG SELL"];
  const rows = symbols
    .map((sym, i) => buildRow(sym, symbolSectorMap.get(sym)!, quotes[i]))
    .filter((r) => r.price != null && ACTIONABLE.includes(r.signal as SignalLabel));

  const gainers = rows
    .filter((r) => r.signal === "STRONG BUY" || r.signal === "BUY")
    .sort((a, b) => b.score - a.score);
  const losers = rows
    .filter((r) => r.signal === "STRONG SELL" || r.signal === "SELL")
    .sort((a, b) => a.score - b.score);

  const side = searchParams.get("side");
  let merged: typeof rows;
  if (side === "gainers") {
    merged = gainers;
  } else if (side === "losers") {
    merged = losers;
  } else {
    const half = Math.ceil(limit / 2);
    merged = [...gainers.slice(0, half), ...losers.slice(0, limit - half)];
  }

  const picks: TopPickRow[] = merged.slice(0, limit).map((r, i) => ({
    ...r,
    rank: i + 1,
  }));

  return NextResponse.json(
    { picks, universe: rows.length, fetchedAt: new Date().toISOString() },
    { headers: { "Cache-Control": "public, s-maxage=15" } },
  );
}
