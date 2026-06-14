import { NextResponse } from "next/server";
import { pickBrokerChain } from "@/services/india/broker/factory";
import { resolveQuotes } from "@/services/india/resolve";
import { getActiveSelections } from "@/features/settings/active-sources";
import type { DataSourceId } from "@/features/settings/data-sources-shared";
import {
  FNO_INDICES,
  SUPPLEMENTARY_INDICES,
} from "@/lib/india/fno-symbols";
import type { IndexQuote, Snapshot } from "@/types/india";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// NSE Sectoral indices on Yahoo Finance (only the ones with a heatmap tile).
const SECTORS: { name: string; symbol: string }[] = [
  { name: "Bank", symbol: "^NSEBANK" },
  { name: "IT", symbol: "^CNXIT" },
  { name: "Auto", symbol: "^CNXAUTO" },
  { name: "Pharma", symbol: "^CNXPHARMA" },
  { name: "FMCG", symbol: "^CNXFMCG" },
  { name: "Metal", symbol: "^CNXMETAL" },
  { name: "Energy", symbol: "^CNXENERGY" },
  { name: "Realty", symbol: "^CNXREALTY" },
  { name: "Fin Services", symbol: "^CNXFIN" },
  { name: "Media", symbol: "^CNXMEDIA" },
  { name: "PSU Bank", symbol: "^CNXPSUBANK" },
  { name: "Infra", symbol: "^CNXINFRA" },
];

const ALL_INDICES = [...FNO_INDICES, ...SUPPLEMENTARY_INDICES];

export async function GET() {
  const selections = await getActiveSelections();
  const chain = pickBrokerChain(selections.india.selected);

  const indexSyms = ALL_INDICES.map((i) => i.symbol);
  const sectorSyms = SECTORS.map((s) => s.symbol);

  const [indexRes, sectorRes] = await Promise.all([
    resolveQuotes(chain, indexSyms),
    resolveQuotes(chain, sectorSyms),
  ]);
  const indexQuotes = indexRes.quotes;
  const sectorQuotes = sectorRes.quotes;

  const sources: DataSourceId[] = [];
  for (const s of [...indexRes.sources, ...sectorRes.sources]) {
    if (!sources.includes(s)) sources.push(s);
  }

  const indices: IndexQuote[] = ALL_INDICES.map((m, i) => {
    const q = indexQuotes[i];
    return {
      ...q,
      name: m.name,
      symbol: m.symbol,
    };
  });

  const sectors: IndexQuote[] = SECTORS.map((m, i) => {
    const q = sectorQuotes[i];
    return {
      ...q,
      name: m.name,
      symbol: m.symbol,
    };
  });

  const snapshot: Snapshot = {
    indices,
    sectors,
    fetchedAt: new Date().toISOString(),
    source: (chain[0]?.id ?? "yahoo") as DataSourceId,
    sources,
  };

  return NextResponse.json(snapshot, {
    headers: { "Cache-Control": "no-store" },
  });
}
