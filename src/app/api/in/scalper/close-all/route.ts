import { NextResponse } from "next/server";
import { getPrisma } from "@/lib/prisma";
import { yahoo } from "@/services/india/yahoo";
import { isNseMarketOpenIST } from "@/lib/india/market-hours";
import { indiaPnlPercent } from "@/features/india/scalping/paper-trader-core";

export const dynamic = "force-dynamic";
export const runtime  = "nodejs";

/**
 * POST /api/in/scalper/close-all
 *
 * Force-closes every OPEN India paper trade immediately. Used when:
 *   - The worker isn't running and EOD square-off didn't fire
 *   - The market is closed and stale open positions need clearing
 *   - The user wants to manually reset all positions
 *
 * Fetches the latest Yahoo price for each symbol; falls back to entry
 * price (0 P&L) when the quote is unavailable.
 */
export async function POST() {
  try {
    const db  = getPrisma();
    const now = new Date();

    const openTrades = await db.paperTrade.findMany({
      where: { status: "OPEN", source: { startsWith: "in:" } },
      select: {
        id: true, symbol: true, direction: true,
        entry: true, notional: true,
      },
    });

    if (openTrades.length === 0) {
      return NextResponse.json({ closed: 0, message: "No open trades to close." });
    }

    // Batch-fetch prices
    const symbols   = [...new Set(openTrades.map((t) => t.symbol))];
    const priceMap  = new Map<string, number>();
    try {
      const quotes = await yahoo.getQuotes(symbols);
      for (const q of quotes) {
        const sym = q.symbol.replace(/\.NS$/i, "").toUpperCase();
        if (q.price != null && Number.isFinite(q.price)) priceMap.set(sym, q.price);
      }
    } catch { /* fail-soft — use entry price */ }

    const market     = isNseMarketOpenIST(now);
    // Use EXPIRED for off-hours close, WIN/LOSS for market-hours close
    const getStatus = (pnlPct: number): "WIN" | "LOSS" | "EXPIRED" => {
      if (!market) return "EXPIRED";
      return pnlPct >= 0 ? "WIN" : "LOSS";
    };

    let closed = 0;
    for (const t of openTrades) {
      const sym       = t.symbol.replace(/\.NS$/i, "").toUpperCase();
      const exitPrice = priceMap.get(sym) ?? t.entry;
      const isLong    = t.direction === "LONG";
      const pnlPct    = indiaPnlPercent(t.entry, exitPrice, isLong);
      const pnlUsd    = (pnlPct / 100) * t.notional;

      await db.paperTrade.update({
        where: { id: t.id },
        data:  {
          status:     getStatus(pnlPct),
          exitPrice,
          pnlPct,
          pnlUsd,
          closedAt:   now,
        },
      });
      closed++;
    }

    return NextResponse.json({
      closed,
      message: `Closed ${closed} open trade${closed !== 1 ? "s" : ""}.`,
    });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}
