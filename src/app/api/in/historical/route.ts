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
    { headers: { "Cache-Control": "no-store" } },
  );
}
