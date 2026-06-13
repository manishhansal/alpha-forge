import { NextResponse } from "next/server";

import {
  countPaperTrades,
  listOpenTrades,
  listPaperTrades,
} from "@/features/scalping/journal";
import {
  PAPER_TRADE_STATUSES,
  SCALP_STRATEGY_IDS,
  type PaperTradeStatus,
  type ScalpStrategyId,
  type ScalpTimeframe,
} from "@/features/scalping/types";
import type { SymbolId } from "@/types/market";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SYMBOLS: SymbolId[] = ["BTC", "ETH", "SOL"];
const TIMEFRAMES: ReadonlyArray<ScalpTimeframe> = ["1m", "5m", "15m"];

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const symbolParam = url.searchParams.get("symbol");
    const statusParam = url.searchParams.get("status");
    const strategiesParam = url.searchParams.get("strategies");
    const sourcesParam = url.searchParams.get("sources");
    const includeOpen = url.searchParams.get("open") === "1";
    // Clamp to a reasonable range so a malicious caller can't ask for a
    // 10k page or a negative offset.
    const rawLimit = Number(url.searchParams.get("limit") ?? 50);
    const rawOffset = Number(url.searchParams.get("offset") ?? 0);
    const limit = Number.isFinite(rawLimit)
      ? Math.min(Math.max(1, Math.trunc(rawLimit)), 200)
      : 50;
    const offset = Number.isFinite(rawOffset)
      ? Math.max(0, Math.trunc(rawOffset))
      : 0;

    const symbol = symbolParam && SYMBOLS.includes(symbolParam as SymbolId)
      ? (symbolParam as SymbolId)
      : undefined;
    const status = statusParam && PAPER_TRADE_STATUSES.includes(statusParam as PaperTradeStatus)
      ? (statusParam as PaperTradeStatus)
      : undefined;
    const strategyIds = parseStrategies(strategiesParam);
    const sources = parseSources(sourcesParam);

    const [items, openItems, total] = await Promise.all([
      listPaperTrades({ symbol, status, strategyIds, sources, limit, offset }),
      includeOpen ? listOpenTrades(undefined, strategyIds, sources) : Promise.resolve([]),
      countPaperTrades({ symbol, status, strategyIds, sources }),
    ]);

    return NextResponse.json({
      items,
      open: openItems,
      total,
      limit,
      offset,
    });
  } catch (err) {
    console.error("[/api/scalper/journal] error:", err);
    return NextResponse.json(
      { error: true, code: "JOURNAL_FAILED", message: (err as Error).message },
      { status: 500 },
    );
  }
}

function parseStrategies(raw: string | null): ScalpStrategyId[] | undefined {
  if (!raw) return undefined;
  const parts = raw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean) as ScalpStrategyId[];
  const valid = parts.filter((s) => SCALP_STRATEGY_IDS.includes(s));
  return valid.length > 0 ? valid : undefined;
}

/**
 * Parse the `sources=` query into validated `strategyId:timeframe` strings
 * that line up with the `PaperTrade.source` column. Anything malformed is
 * dropped silently — a malicious or stale picker shouldn't blow up the API.
 */
function parseSources(raw: string | null): string[] | undefined {
  if (!raw) return undefined;
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const valid: string[] = [];
  for (const p of parts) {
    const [idRaw, tfRaw] = p.split(":");
    if (!idRaw || !tfRaw) continue;
    const id = idRaw.toUpperCase() as ScalpStrategyId;
    const tf = tfRaw as ScalpTimeframe;
    if (!SCALP_STRATEGY_IDS.includes(id)) continue;
    if (!TIMEFRAMES.includes(tf)) continue;
    valid.push(`${id}:${tf}`);
  }
  return valid.length > 0 ? valid : undefined;
}
