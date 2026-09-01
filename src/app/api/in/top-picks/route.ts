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

export const dynamic = "force-dynamic";
export const revalidate = 0;

// ─── Types ────────────────────────────────────────────────────────────────────

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
  /** Relative volume — not available from canonical MDQuote; null until enriched. */
  relativeVolume: number | null;
  /** Analyst mean target price — not in MDQuote; null until enriched. */
  targetMean: number | null;
};

type TopPicksResponse = {
  picks: TopPickRow[];
  universe: number;
  fetchedAt: string;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildRow(
  symbol: string,
  sector: string,
  q: MDQuote | null,
): Omit<TopPickRow, "rank"> {
  const price = q?.ltp ?? null;
  const changePct = q?.changePct ?? null;
  const high52w = q?.weekHigh52 ?? null;
  // MDQuote does not carry SMA50 / targetMean — we fall back to directional
  // change-based scoring for the canonical path. For richer scoring the
  // india-builder.ts pipeline (which fetches historical data) should be used.
  const sma50: number | null = null;
  const sma200: number | null = null;
  const targetMean: number | null = null;

  const score = computeScore({ price, sma50, sma200, changePct, targetMean });
  const signal: SignalLabel = price == null ? "N/A" : classifySignal(score);

  const upsidePct =
    price && high52w && high52w > price
      ? ((high52w - price) / price) * 100
      : null;

  // SMA50 not in MDQuote; fromSma50Pct unavailable on this path
  const fromSma50Pct: number | null = null;
  // volume relative to avg — MDQuote has only current volume, no 3-month avg
  const relativeVolume: number | null = null;

  return {
    symbol,
    sector,
    shortName: q?.name ?? null,
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
  await bootstrapRegistry();

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

  // Canonical path: batch quote via registry (Angel One → Upstox → Yahoo failover).
  // The registry applies health checks, circuit breakers, and normalization.
  let quotes: Array<MDQuote | null>;
  try {
    quotes = await registry.getQuotes(symbols);
  } catch {
    quotes = symbols.map(() => null);
  }

  // Build scored rows and filter:
  //  - must have a price
  //  - must be directional (BUY / STRONG BUY / SELL / STRONG SELL)
  const ACTIONABLE: SignalLabel[] = ["STRONG BUY", "BUY", "SELL", "STRONG SELL"];
  const rows = symbols
    .map((sym, i) => buildRow(sym, symbolSectorMap.get(sym)!, quotes[i]))
    .filter((r) => r.price != null && ACTIONABLE.includes(r.signal as SignalLabel));

  function momentumRank(r: (typeof rows)[0]): number {
    const absPct = Math.abs(r.changePct ?? 0);
    const vol = r.relativeVolume ?? 1.0;
    return absPct * Math.max(vol, 0.5);
  }

  const gainers = rows
    .filter((r) => r.signal === "STRONG BUY" || r.signal === "BUY")
    .sort((a, b) => {
      const dm = momentumRank(b) - momentumRank(a);
      if (Math.abs(dm) > 0.01) return dm;
      return b.score - a.score;
    });

  const losers = rows
    .filter((r) => r.signal === "STRONG SELL" || r.signal === "SELL")
    .sort((a, b) => {
      const dm = momentumRank(b) - momentumRank(a);
      if (Math.abs(dm) > 0.01) return dm;
      return a.score - b.score;
    });

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
    { headers: { "Cache-Control": "no-store" } },
  );
}
