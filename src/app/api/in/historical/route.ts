import { NextResponse } from "next/server";
import { pickBrokerChain } from "@/services/india/broker/factory";
import { resolveHistorical } from "@/services/india/resolve";
import { getActiveSelections } from "@/features/settings/active-sources";
import type { Interval } from "@/types/india";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const INTERVALS: Interval[] = ["1m", "5m", "15m", "30m", "1h", "1d", "1w"];

/** GET /api/in/historical?symbol=RELIANCE&interval=1d&range=6mo */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const symbol = searchParams.get("symbol") ?? "";
  const interval = (searchParams.get("interval") ?? "1d") as Interval;
  const range = searchParams.get("range") ?? "6mo";

  if (!symbol) {
    return NextResponse.json({ error: "symbol is required" }, { status: 400 });
  }
  if (!INTERVALS.includes(interval)) {
    return NextResponse.json(
      { error: `Invalid interval "${interval}"`, valid: INTERVALS },
      { status: 400 },
    );
  }

  const selections = await getActiveSelections();
  const chain = pickBrokerChain(selections.india.selected);
  const { candles, source } = await resolveHistorical(chain, {
    symbol,
    interval,
    range,
  });
  return NextResponse.json(
    { symbol, interval, range, candles, source: source ?? chain[0]?.id ?? "yahoo" },
    {
      // Historical candles are immutable for past intervals and change only
      // once per candle close for live intervals. Cache by interval:
      //   1m/5m/15m/30m: 30s (intraday, changes frequently)
      //   1h/1d/1w: 5 minutes (longer candles, much less frequent updates)
      headers: {
        "Cache-Control": interval === "1d" || interval === "1h" || interval === "1w"
          ? "public, s-maxage=300, stale-while-revalidate=600"
          : "public, s-maxage=30, stale-while-revalidate=60",
      },
    },
  );
}
