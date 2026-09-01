/**
 * API Route: Sector Stocks
 *
 * Returns live quote data for all stocks in a given NSE sector.
 *
 * GET /api/in/sector-stocks?sector=Bank
 *
 * Data source: canonical MarketDataRegistry (registry.getQuotes()).
 * Previously this used `new YahooFinance()` directly — MIGRATED in Phase 2.
 */

import { NextResponse } from "next/server";

import { registry, bootstrapRegistry } from "@/lib/market-data/registry";
import type { MDQuote } from "@/lib/market-data/types";
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

async function computeRow(
  symbol: string,
  q: MDQuote | null,
): Promise<StockRow> {
  // MDQuote provides: ltp, changePct, prevClose, high, low, weekHigh52, weekLow52
  // It does NOT carry SMA50/SMA200/targetMean — those require historical data.
  const price: number | null = q?.ltp ?? null;
  const changePct: number | null = q?.changePct ?? null;
  const prevClose: number | null = q?.prevClose ?? null;
  const high52w: number | null = q?.weekHigh52 ?? null;
  const low52w: number | null = q?.weekLow52 ?? null;

  // SMA and analyst targets not available from single quote; null until
  // enriched from historical service (future enhancement).
  const sma50: number | null = null;
  const sma200: number | null = null;
  const targetMean: number | null = null;

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
    shortName: q?.name ?? null,
    price,
    changePct,
    prevClose,
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

export async function GET(req: Request) {
  await bootstrapRegistry();

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

  // Canonical path: batch quote via registry (Angel One → Upstox → Yahoo failover).
  let mdQuotes: Array<MDQuote | null>;
  try {
    mdQuotes = await registry.getQuotes(tickers);
  } catch {
    mdQuotes = tickers.map(() => null);
  }

  const rows: StockRow[] = await Promise.all(
    tickers.map((t, i) => computeRow(t, mdQuotes[i])),
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
