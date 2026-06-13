import { NextResponse } from "next/server";

import { getIndiaScalpSignals } from "@/features/india/scalping/fetch-signals";
import {
  INDIA_SCALP_STRATEGY_IDS,
  type IndiaScalpStrategyId,
} from "@/features/india/scalping/strategies/catalog";
import type { IndiaScalpTimeframe } from "@/features/india/scalping/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ALLOWED_TIMEFRAMES: IndiaScalpTimeframe[] = ["1m", "5m", "15m"];

/**
 * GET /api/in/scalper/signals?timeframe=5m&strategies=MOMENTUM,VOLUME_BREAKOUT
 *
 * India mirror of `/api/scalper/signals` — same response shape, same
 * query parameters, India-scoped strategies + symbols. The shared client
 * components on the strategies page consume this so the user gets
 * structural parity with the crypto Strategies page.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const tfParam = url.searchParams.get("timeframe") ?? "5m";
    const timeframe = (
      ALLOWED_TIMEFRAMES.includes(tfParam as IndiaScalpTimeframe)
        ? tfParam
        : "5m"
    ) as IndiaScalpTimeframe;

    const strategiesParam = url.searchParams.get("strategies");
    const strategies = parseStrategies(strategiesParam);

    const data = await getIndiaScalpSignals({ timeframe, strategies });
    return NextResponse.json(data, {
      headers: {
        // Scanner responses already have their own short TTL upstream;
        // expose a small s-maxage so a fan-out of polling clients still
        // shares the same generation per second.
        "Cache-Control": "public, s-maxage=15, stale-while-revalidate=30",
      },
    });
  } catch (err) {
    console.error("[/api/in/scalper/signals] error:", err);
    return NextResponse.json(
      {
        error: true,
        code: "INDIA_SCALPER_FAILED",
        message: (err as Error).message,
      },
      { status: 502 },
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
