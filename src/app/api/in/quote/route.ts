import { NextResponse } from "next/server";
import { pickBrokerChain } from "@/services/india/broker/factory";
import { resolveQuotes } from "@/services/india/resolve";
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
  const chain = pickBrokerChain(selections.india.selected);
  const { quotes, sources } = await resolveQuotes(chain, symbols);
  return NextResponse.json(
    {
      quotes,
      // `source` = the user's primary selected source; `sources` = the
      // distinct upstreams that actually produced data (true provenance).
      source: chain[0]?.id ?? "yahoo",
      sources,
      fetchedAt: new Date().toISOString(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
