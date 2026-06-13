import { NextResponse } from "next/server";

import {
  countIndiaPaperTrades,
  listIndiaOpenTrades,
  listIndiaPaperTrades,
} from "@/features/india/scalping/journal";
import {
  INDIA_SCALP_STRATEGY_IDS,
  type IndiaScalpStrategyId,
} from "@/features/india/scalping/strategies/catalog";
import {
  INDIA_PAPER_TRADE_STATUSES,
  INDIA_SCALP_TIMEFRAMES,
  type IndiaPaperTradeStatus,
  type IndiaScalpTimeframe,
} from "@/features/india/scalping/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/in/scalper/journal?symbol=NIFTY&status=OPEN&sources=in:MOMENTUM:5m&limit=10&offset=0&open=1
 *
 * Mirror of `/api/scalper/journal` for India F&O paper trades. The
 * underlying `PaperTrade` Postgres table is shared with crypto — every
 * read is scoped to rows whose `source` starts with `in:` so the two
 * markets never bleed into each other in the journal UI.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const symbolParam = url.searchParams.get("symbol");
    const statusParam = url.searchParams.get("status");
    const strategiesParam = url.searchParams.get("strategies");
    const sourcesParam = url.searchParams.get("sources");
    const includeOpen = url.searchParams.get("open") === "1";
    const rawLimit = Number(url.searchParams.get("limit") ?? 50);
    const rawOffset = Number(url.searchParams.get("offset") ?? 0);
    const limit = Number.isFinite(rawLimit)
      ? Math.min(Math.max(1, Math.trunc(rawLimit)), 200)
      : 50;
    const offset = Number.isFinite(rawOffset)
      ? Math.max(0, Math.trunc(rawOffset))
      : 0;

    // India symbols are open-ended (NIFTY, BANKNIFTY, RELIANCE, …) so
    // we accept any non-empty string after trimming. Server-side
    // `where` still pins to India-prefixed sources so a junk symbol
    // simply matches nothing — no auth issues.
    const symbol = symbolParam?.trim() ? symbolParam.trim() : undefined;
    const status =
      statusParam &&
      INDIA_PAPER_TRADE_STATUSES.includes(statusParam as IndiaPaperTradeStatus)
        ? (statusParam as IndiaPaperTradeStatus)
        : undefined;
    const strategyIds = parseStrategies(strategiesParam);
    const sources = parseSources(sourcesParam);

    const [items, openItems, total] = await Promise.all([
      listIndiaPaperTrades({
        symbol,
        status,
        strategyIds,
        sources,
        limit,
        offset,
      }),
      includeOpen
        ? listIndiaOpenTrades(undefined, strategyIds, sources)
        : Promise.resolve([]),
      countIndiaPaperTrades({ symbol, status, strategyIds, sources }),
    ]);

    return NextResponse.json({
      items,
      open: openItems,
      total,
      limit,
      offset,
    });
  } catch (err) {
    console.error("[/api/in/scalper/journal] error:", err);
    return NextResponse.json(
      {
        error: true,
        code: "INDIA_JOURNAL_FAILED",
        message: (err as Error).message,
      },
      { status: 500 },
    );
  }
}

function parseStrategies(
  raw: string | null,
): IndiaScalpStrategyId[] | undefined {
  if (!raw) return undefined;
  const parts = raw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean) as IndiaScalpStrategyId[];
  const valid = parts.filter((s) => INDIA_SCALP_STRATEGY_IDS.includes(s));
  return valid.length > 0 ? valid : undefined;
}

/**
 * Parse the `sources=` query into validated `in:<id>:<tf>` strings.
 * Anything malformed OR missing the `in:` prefix is dropped — keeps the
 * two markets fully isolated even when a caller hand-rolls the URL.
 */
function parseSources(raw: string | null): string[] | undefined {
  if (!raw) return undefined;
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const valid: string[] = [];
  for (const p of parts) {
    if (!p.startsWith("in:")) continue;
    const [, idRaw, tfRaw] = p.split(":");
    if (!idRaw || !tfRaw) continue;
    const id = idRaw.toUpperCase() as IndiaScalpStrategyId;
    const tf = tfRaw as IndiaScalpTimeframe;
    if (!INDIA_SCALP_STRATEGY_IDS.includes(id)) continue;
    if (!INDIA_SCALP_TIMEFRAMES.includes(tf)) continue;
    valid.push(`in:${id}:${tf}`);
  }
  return valid.length > 0 ? valid : undefined;
}
