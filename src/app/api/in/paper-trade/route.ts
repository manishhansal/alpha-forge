import { NextResponse } from "next/server";
import { getPrisma } from "@/lib/prisma";
import { isNseMarketOpenIST } from "@/lib/india/market-hours";
import { buildIndiaTradeSource } from "@/features/india/scalping/types";
import type { IndiaScalpStrategyId } from "@/features/india/scalping/strategies/catalog";
import { isIndiaScalpStrategyId } from "@/features/india/scalping/strategies/catalog";
import { isExpiryCooldownIST } from "@/features/india/scalping/paper-trader-core";

export const dynamic = "force-dynamic";
export const runtime  = "nodejs";

/**
 * POST /api/in/paper-trade
 *
 * Universal "paper trade this signal" endpoint. Accepts signals from any
 * India surface (Daily Picks, AI Signals, Scanner, FnO Trend Scanner) and
 * converts them into a PaperTrade row.
 *
 * Body (JSON):
 * {
 *   strategyId:  "DAILY_PICK" | "AI_SIGNAL" | "SCANNER_HIT" | "FNO_TREND" | …
 *   symbol:      string   // NSE ticker, no .NS suffix
 *   symbolName?: string
 *   direction:   "LONG" | "SHORT"
 *   entry:       number   // ₹ suggested entry
 *   stopLoss:    number   // ₹ stop loss
 *   target:      number   // ₹ TP1
 *   riskReward?: number   // defaults to |target-entry| / |stopLoss-entry|
 *   atr?:        number   // ATR(14) used for the levels
 *   confidence?: number   // [0,1]
 *   rationale?:  string[]
 *   extras?:     Record<string, unknown>
 * }
 *
 * Guards:
 *   - Market must be open (09:15–15:30 IST, Mon–Fri) — all trades are intraday
 *   - Expiry cooldown (Thursday ≥ 14:30 IST) blocks new entries
 *   - Duplicate check: same symbol+source opened within the last 5 minutes
 *   - Already-open check: same symbol+source still OPEN
 */
export async function POST(req: Request) {
  try {
    const now = new Date();

    // ── Market-hours guard ────────────────────────────────────────────────
    if (!isNseMarketOpenIST(now)) {
      return NextResponse.json(
        { error: "Market is closed. All paper trades are intraday only (09:15–15:30 IST)." },
        { status: 409 },
      );
    }

    // ── Expiry cooldown ───────────────────────────────────────────────────
    if (isExpiryCooldownIST(now)) {
      return NextResponse.json(
        { error: "Expiry cooldown active (Thursday ≥ 14:30 IST). No new directional entries." },
        { status: 409 },
      );
    }

    const body = (await req.json()) as {
      strategyId:   string;
      symbol:       string;
      symbolName?:  string;
      direction:    string;
      entry:        number;
      stopLoss:     number;
      target:       number;
      riskReward?:  number;
      atr?:         number;
      confidence?:  number;
      rationale?:   string[];
      extras?:      Record<string, unknown>;
    };

    // ── Validation ────────────────────────────────────────────────────────
    const { strategyId, symbol, direction, entry, stopLoss, target } = body;

    if (!strategyId || !isIndiaScalpStrategyId(strategyId)) {
      return NextResponse.json({ error: `Unknown strategyId "${strategyId}"` }, { status: 400 });
    }
    if (!symbol?.trim()) {
      return NextResponse.json({ error: "symbol is required" }, { status: 400 });
    }
    if (direction !== "LONG" && direction !== "SHORT") {
      return NextResponse.json({ error: "direction must be LONG or SHORT" }, { status: 400 });
    }
    if (!Number.isFinite(entry) || entry <= 0) {
      return NextResponse.json({ error: "entry must be a positive number" }, { status: 400 });
    }
    if (!Number.isFinite(stopLoss) || stopLoss <= 0) {
      return NextResponse.json({ error: "stopLoss must be a positive number" }, { status: 400 });
    }
    if (!Number.isFinite(target) || target <= 0) {
      return NextResponse.json({ error: "target must be a positive number" }, { status: 400 });
    }

    const cleanSymbol = symbol.trim().toUpperCase().replace(/\.NS$/i, "");
    const source      = buildIndiaTradeSource(strategyId as IndiaScalpStrategyId, "1d");
    const riskReward  = body.riskReward ??
      (Math.abs(target - entry) / Math.abs(stopLoss - entry) || 1);

    const db = getPrisma();

    // ── Duplicate / already-open checks ──────────────────────────────────
    const existingOpen = await db.paperTrade.findFirst({
      where: { symbol: cleanSymbol, status: "OPEN", source },
      select: { id: true },
    });
    if (existingOpen) {
      return NextResponse.json(
        { error: `Already have an open ${strategyId} trade on ${cleanSymbol}.`, tradeId: existingOpen.id },
        { status: 409 },
      );
    }

    const fiveMinAgo = new Date(now.getTime() - 5 * 60_000);
    const dup = await db.paperTrade.findFirst({
      where: {
        symbol: cleanSymbol,
        source,
        openedAt: { gte: fiveMinAgo },
      },
      select: { id: true },
    });
    if (dup) {
      return NextResponse.json(
        { error: `Duplicate signal — same trade opened in the last 5 minutes.`, tradeId: dup.id },
        { status: 409 },
      );
    }

    // ── Create the trade ──────────────────────────────────────────────────
    const trade = await db.paperTrade.create({
      data: {
        symbol:    cleanSymbol,
        direction: direction as "LONG" | "SHORT",
        status:    "OPEN",
        source,
        rationale: body.rationale ?? [],
        meta: {
          strategyId,
          symbolName:   body.symbolName ?? cleanSymbol,
          confidence:   body.confidence ?? null,
          triggeredAt:  now.getTime(),
          triggeredAtPrice: entry,
          confirmed:    true,
          atrSized:     (body.atr ?? 0) > 0,
          extras:       (body.extras as Record<string, string | number | boolean | null> | null) ?? null,
        },
        notional:   100_000,       // ₹1L cosmetic notional
        entry,
        stopLoss,
        target,
        riskReward,
        atr:        body.atr ?? 0,
        openedAt:   now,
      },
      select: { id: true },
    });

    return NextResponse.json({ opened: true, tradeId: trade.id }, { status: 201 });

  } catch (err) {
    console.error("[/api/in/paper-trade] error:", err);
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}
