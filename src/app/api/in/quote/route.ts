import { NextResponse } from "next/server";
import { getQuotes, DataServiceUnavailableError } from "@/lib/data-service/client";

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
    return NextResponse.json(
      {
        quotes,
        source: "data-service2",
        sources: ["data-service2"],
        fetchedAt: new Date().toISOString(),
      },
      { headers: { "Cache-Control": "public, s-maxage=5, stale-while-revalidate=10" } },
    );
  } catch (err) {
    if (err instanceof DataServiceUnavailableError) {
      return NextResponse.json(
        { error: "DATA_SERVICE_UNAVAILABLE", quotes: [] },
        { status: 503 },
      );
    }
    return NextResponse.json(
      { error: (err as Error).message, quotes: [] },
      { status: 502 },
    );
  }
}
