import { NextResponse } from "next/server";
import YahooFinance from "yahoo-finance2";
import { SECTOR_STOCKS } from "@/lib/india/sectors";
import {
  classifySignal,
  computeScore,
  type SignalLabel,
} from "@/services/india/signals/score";
import {
  ensureSnapshotterStarted,
  recordSignalObservation,
} from "@/services/india/signals/snapshotter";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const yahooFinance = new YahooFinance();

// Boot the per-symbol snapshot loop the first time this module is imported.
// Idempotent — guarded by a globalThis flag in the snapshotter.
ensureSnapshotterStarted();

type StockRow = {
  symbol: string;
  shortName: string | null;
  price: number | null;
  changePct: number | null;
  prevClose: number | null;
  sma50: number | null;
  sma200: number | null;
  high52w: number | null;
  low52w: number | null;
  targetMean: number | null;
  fromSma50Pct: number | null;
  upsidePct: number | null;
  downsidePct: number | null;
  signal: SignalLabel;
  score: number;
  /** Unix ms when this signal was first observed (server-tracked, not local). */
  signalSince: number | null;
};

// Subset of `yahoo-finance2`'s rich quote shape that we read here.
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
};

async function computeRow(
  symbol: string,
  q: YfRichQuote | null,
): Promise<StockRow> {
  const price: number | null = q?.regularMarketPrice ?? null;
  const sma50: number | null = q?.fiftyDayAverage ?? null;
  const sma200: number | null = q?.twoHundredDayAverage ?? null;
  const high52w: number | null = q?.fiftyTwoWeekHigh ?? null;
  const low52w: number | null = q?.fiftyTwoWeekLow ?? null;
  const targetMean: number | null = q?.targetMeanPrice ?? null;
  const changePct: number | null = q?.regularMarketChangePercent ?? null;

  const score = computeScore({
    price,
    sma50,
    sma200,
    changePct,
    targetMean,
  });
  const signal: SignalLabel = price == null ? "N/A" : classifySignal(score);

  let signalSince: number | null = null;
  if (signal !== "N/A") {
    try {
      const rec = await recordSignalObservation(symbol, signal, score);
      signalSince = rec?.since ?? null;
    } catch (e) {
      console.error(`india.sector-stocks: signal log failed for ${symbol}:`, e);
    }
  }

  const upsidePct =
    price && (targetMean || high52w)
      ? ((Math.max(targetMean ?? 0, high52w ?? 0) - price) / price) * 100
      : null;

  const downsidePct =
    price && low52w ? ((price - low52w) / price) * 100 : null;

  const fromSma50Pct =
    price && sma50 ? ((price - sma50) / sma50) * 100 : null;

  return {
    symbol,
    shortName: q?.shortName ?? q?.longName ?? null,
    price,
    changePct,
    prevClose: q?.regularMarketPreviousClose ?? null,
    sma50,
    sma200,
    high52w,
    low52w,
    targetMean,
    fromSma50Pct,
    upsidePct,
    downsidePct,
    signal,
    score,
    signalSince,
  };
}

async function safeQuote(yfSymbol: string): Promise<YfRichQuote | null> {
  try {
    return (await yahooFinance.quote(yfSymbol)) as unknown as YfRichQuote;
  } catch (e) {
    console.error(
      `india.sector-stocks: quote failed for ${yfSymbol}:`,
      (e as Error)?.message,
    );
    return null;
  }
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const sector = searchParams.get("sector") ?? "";

  const tickers = SECTOR_STOCKS[sector];
  if (!tickers) {
    return NextResponse.json(
      {
        error: `Unknown sector: ${sector}`,
        available: Object.keys(SECTOR_STOCKS),
      },
      { status: 400 },
    );
  }

  if (tickers.length === 0) {
    return NextResponse.json({
      sector,
      rows: [],
      fetchedAt: new Date().toISOString(),
    });
  }

  const yfSymbols = tickers.map((t) => `${t}.NS`);
  const quotes = await Promise.all(yfSymbols.map(safeQuote));

  const rows: StockRow[] = await Promise.all(
    tickers.map((t, i) => computeRow(t, quotes[i])),
  );

  rows.sort((a, b) => {
    if (a.changePct == null && b.changePct == null) return 0;
    if (a.changePct == null) return 1;
    if (b.changePct == null) return -1;
    return b.changePct - a.changePct;
  });

  return NextResponse.json({
    sector,
    rows,
    fetchedAt: new Date().toISOString(),
  });
}
