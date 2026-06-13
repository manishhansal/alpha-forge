import { NextResponse } from "next/server";
import { pickBroker } from "@/services/india/broker/factory";
import { getActiveSelections } from "@/features/settings/active-sources";
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
  const broker = pickBroker(selections.india.selected);

  const indexSyms = ALL_INDICES.map((i) => i.symbol);
  const sectorSyms = SECTORS.map((s) => s.symbol);

  const [indexQuotes, sectorQuotes] = await Promise.all([
    broker.getQuotes(indexSyms),
    broker.getQuotes(sectorSyms),
  ]);

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

  const snapshot: Snapshot & { source: string } = {
    indices,
    sectors,
    fetchedAt: new Date().toISOString(),
    source: broker.id,
  };

  return NextResponse.json(snapshot, {
    headers: { "Cache-Control": "no-store" },
  });
}
