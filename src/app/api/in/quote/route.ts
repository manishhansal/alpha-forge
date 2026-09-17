import { NextResponse } from "next/server";
import { getQuotes, DataServiceUnavailableError } from "@/lib/data-service/client";
import { getSimulatedQuotes } from "@/lib/data-service/simulated-india";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** GET /api/in/quote?symbols=RELIANCE,TCS,NIFTY */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const raw = searchParams.get("symbols") ?? "";
  const symbols = raw
    .split(",")
    .map((s) => s.trim().replace(/^\^/, "")) // strip ^NSEI → NIFTY convention
    .filter(Boolean);

  if (symbols.length === 0) {
    return NextResponse.json({ quotes: [] });
  }

  try {
    const quotes = await getQuotes(symbols, "NSE");
    // If all quotes came back with zero/null ltp, fall back to simulated
    const validQuotes = quotes.filter((q): q is NonNullable<typeof q> => q != null && (q.ltp ?? 0) > 0);
    if (validQuotes.length === 0) {
      const simulated = getSimulatedQuotes(symbols);
      return NextResponse.json(
        { quotes: simulated, source: "SIMULATED", sources: ["SIMULATED"], fetchedAt: new Date().toISOString(), simulated: true },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.json(
      {
        quotes,
        source: "data-service2",
        sources: ["data-service2"],
        fetchedAt: new Date().toISOString(),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    if (err instanceof DataServiceUnavailableError) {
      const quotes = getSimulatedQuotes(symbols);
      return NextResponse.json(
        { quotes, source: "SIMULATED", sources: ["SIMULATED"], fetchedAt: new Date().toISOString(), simulated: true },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.json(
      { error: (err as Error).message, quotes: [] },
      { status: 502 },
    );
  }
}
