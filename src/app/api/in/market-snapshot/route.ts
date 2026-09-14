import { NextResponse } from "next/server";
import { getQuotes, DataServiceUnavailableError } from "@/lib/data-service/client";
import { FNO_INDICES, SUPPLEMENTARY_INDICES } from "@/lib/india/fno-symbols";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const SECTORS: { name: string; symbol: string }[] = [
  { name: "Bank", symbol: "NSEBANK" },
  { name: "IT", symbol: "CNXIT" },
  { name: "Auto", symbol: "CNXAUTO" },
  { name: "Pharma", symbol: "CNXPHARMA" },
  { name: "FMCG", symbol: "CNXFMCG" },
  { name: "Metal", symbol: "CNXMETAL" },
  { name: "Energy", symbol: "CNXENERGY" },
  { name: "Realty", symbol: "CNXREALTY" },
  { name: "Fin Services", symbol: "CNXFIN" },
  { name: "Media", symbol: "CNXMEDIA" },
  { name: "PSU Bank", symbol: "CNXPSUBANK" },
  { name: "Infra", symbol: "CNXINFRA" },
];

const ALL_INDICES = [...FNO_INDICES, ...SUPPLEMENTARY_INDICES];

export async function GET() {
  const indexSyms = ALL_INDICES.map((i) => i.symbol);
  const sectorSyms = SECTORS.map((s) => s.symbol);
  const allSyms = [...new Set([...indexSyms, ...sectorSyms])];

  try {
    const allQuotes = await getQuotes(allSyms, "NSE");
    const quoteMap = new Map(
      allSyms.map((sym, i) => [sym, allQuotes[i] ?? null]),
    );

    const indexQuotes = indexSyms.map((sym) => {
      const q = quoteMap.get(sym);
      return {
        symbol: sym,
        ltp: q?.ltp ?? null,
        changePct: q?.changePct ?? null,
        change: q?.change ?? null,
        open: q?.open ?? null,
        high: q?.high ?? null,
        low: q?.low ?? null,
        volume: q?.volume ?? null,
        oi: q?.oi ?? null,
      };
    });

    const sectorQuotes = SECTORS.map((s) => {
      const q = quoteMap.get(s.symbol);
      return {
        name: s.name,
        symbol: s.symbol,
        ltp: q?.ltp ?? null,
        changePct: q?.changePct ?? null,
      };
    });

    return NextResponse.json(
      {
        indices: indexQuotes,
        sectors: sectorQuotes,
        source: "data-service2",
        fetchedAt: new Date().toISOString(),
      },
      { headers: { "Cache-Control": "public, s-maxage=15, stale-while-revalidate=30" } },
    );
  } catch (err) {
    if (err instanceof DataServiceUnavailableError) {
      return NextResponse.json(
        { error: "DATA_SERVICE_UNAVAILABLE", indices: [], sectors: [] },
        { status: 503 },
      );
    }
    return NextResponse.json(
      { error: (err as Error).message, indices: [], sectors: [] },
      { status: 502 },
    );
  }
}
