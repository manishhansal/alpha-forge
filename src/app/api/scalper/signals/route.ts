import { NextResponse } from "next/server";

import { CACHE_TTL_SECONDS } from "@/lib/constants";
import { getScalpSignals } from "@/features/scalping/fetch-signals";
import {
  SCALP_STRATEGY_IDS,
  type ScalpStrategyId,
  type ScalpTimeframe,
} from "@/features/scalping/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ALLOWED: ScalpTimeframe[] = ["1m", "5m", "15m"];

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const tfParam = url.searchParams.get("timeframe") ?? "5m";
    const timeframe = (ALLOWED.includes(tfParam as ScalpTimeframe)
      ? tfParam
      : "5m") as ScalpTimeframe;

    const strategiesParam = url.searchParams.get("strategies");
    const strategies = parseStrategies(strategiesParam);

    const data = await getScalpSignals({ timeframe, strategies });
    return NextResponse.json(data, {
      headers: {
        "Cache-Control": `public, s-maxage=${CACHE_TTL_SECONDS.scalper}, stale-while-revalidate=30`,
      },
    });
  } catch (err) {
    console.error("[/api/scalper/signals] error:", err);
    return NextResponse.json(
      { error: true, code: "SCALPER_FAILED", message: (err as Error).message },
      { status: 502 },
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
