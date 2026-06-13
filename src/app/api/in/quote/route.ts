import { NextResponse } from "next/server";
import { pickBroker } from "@/services/india/broker/factory";
import { getActiveSelections } from "@/features/settings/active-sources";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** GET /api/in/quote?symbols=RELIANCE,TCS,^NSEI */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const raw = searchParams.get("symbols") ?? "";
  const symbols = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (symbols.length === 0) {
    return NextResponse.json({ quotes: [] });
  }

  const selections = await getActiveSelections();
  const broker = pickBroker(selections.india.selected);
  const quotes = await broker.getQuotes(symbols);
  return NextResponse.json(
    {
      quotes,
      source: broker.id,
      fetchedAt: new Date().toISOString(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
