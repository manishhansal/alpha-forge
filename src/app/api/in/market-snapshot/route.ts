import { NextResponse } from "next/server";
import { getQuotes, getHistorical, DataServiceUnavailableError } from "@/lib/data-service/client";
import { getSimulatedSnapshot } from "@/lib/data-service/simulated-india";
import { FNO_INDICES, SUPPLEMENTARY_INDICES } from "@/lib/india/fno-symbols";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// ---------------------------------------------------------------------------
// Symbol mappings
// ---------------------------------------------------------------------------
// data-service2.0 uses NSE trading / F&O underlying symbols (NIFTY, BANKNIFTY).
// The UI and the store key on the Yahoo-style symbol (^NSEI, ^NSEBANK) for
// chart/option-chain compatibility. We translate at this boundary.
// ---------------------------------------------------------------------------

const SECTORS: { name: string; symbol: string; dsSymbol: string }[] = [
  { name: "Bank",         symbol: "NSEBANK",    dsSymbol: "NSEBANK"    },
  { name: "IT",           symbol: "CNXIT",      dsSymbol: "CNXIT"      },
  { name: "Auto",         symbol: "CNXAUTO",    dsSymbol: "CNXAUTO"    },
  { name: "Pharma",       symbol: "CNXPHARMA",  dsSymbol: "CNXPHARMA"  },
  { name: "FMCG",         symbol: "CNXFMCG",    dsSymbol: "CNXFMCG"    },
  { name: "Metal",        symbol: "CNXMETAL",   dsSymbol: "CNXMETAL"   },
  { name: "Energy",       symbol: "CNXENERGY",  dsSymbol: "CNXENERGY"  },
  { name: "Realty",       symbol: "CNXREALTY",  dsSymbol: "CNXREALTY"  },
  { name: "Fin Services", symbol: "CNXFIN",     dsSymbol: "CNXFIN"     },
  { name: "Media",        symbol: "CNXMEDIA",   dsSymbol: "CNXMEDIA"   },
  { name: "PSU Bank",     symbol: "CNXPSUBANK", dsSymbol: "CNXPSUBANK" },
  { name: "Infra",        symbol: "CNXINFRA",   dsSymbol: "CNXINFRA"   },
];

// For FNO indices: send `underlying` (e.g. "NIFTY") to data-service2.0.
// For supplementary (SENSEX, VIX): try well-known NSE symbols.
const SUPPLEMENTARY_DS: Record<string, string> = {
  "^BSESN":    "SENSEX",
  "^INDIAVIX": "INDIAVIX",
};

// Historical fallback symbol override — used when the live-quote dsSymbol
// differs from what data-service2.0's historical endpoint accepts.
const HISTORICAL_OVERRIDE: Record<string, string> = {
  "^INDIAVIX": "^INDIAVIX",  // Yahoo-format works for historical but not quotes
};

type IndexDef = {
  name: string;
  /** Yahoo-style symbol used as the UI/store key */
  symbol: string;
  /** NSE symbol sent to data-service2.0 */
  dsSymbol: string;
  /** F&O underlying for option-chain lookups (null for supplementary) */
  underlying: string | null;
  /**
   * Symbol to use for historical close fallback.
   * When live quote is null, we fetch the last daily close from this symbol.
   * Uses the dsSymbol by default; can be overridden for indices where the
   * live-quote symbol differs from the historical lookup symbol.
   */
  historicalSymbol: string;
};

const ALL_INDEX_DEFS: IndexDef[] = [
  ...FNO_INDICES.map((idx) => ({
    name:            idx.name,
    symbol:          idx.symbol,
    dsSymbol:        idx.underlying,          // NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY
    underlying:      idx.underlying,
    historicalSymbol: idx.underlying,
  })),
  ...SUPPLEMENTARY_INDICES.map((idx) => ({
    name:            idx.name,
    symbol:          idx.symbol,
    dsSymbol:        SUPPLEMENTARY_DS[idx.symbol] ?? idx.symbol,
    underlying:      null,
    historicalSymbol: HISTORICAL_OVERRIDE[idx.symbol]
      ?? SUPPLEMENTARY_DS[idx.symbol]
      ?? "",
  })),
];

// ---------------------------------------------------------------------------
// Historical close fallback (market closed / provider down)
// ---------------------------------------------------------------------------

async function getLastHistoricalClose(underlying: string): Promise<number | null> {
  try {
    const candles = await getHistorical({ symbol: underlying, interval: "1d" });
    if (!candles.length) return null;
    const last = candles[candles.length - 1]!;
    return last.close > 0 ? last.close : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function GET() {
  // Build the de-duplicated list of DS symbols to request
  const indexDsSyms  = ALL_INDEX_DEFS.map((d) => d.dsSymbol);
  const sectorDsSyms = SECTORS.map((s) => s.dsSymbol);
  const allDsSyms    = [...new Set([...indexDsSyms, ...sectorDsSyms])];

  try {
    // Single batch call to data-service2.0 — up to 200 symbols, one request
    const allQuotes = await getQuotes(allDsSyms, "NSE");
    const quoteMap  = new Map(
      allDsSyms.map((sym, i) => [sym, allQuotes[i] ?? null]),
    );

    // ── Index entries ──────────────────────────────────────────────────────
    const indexEntries = ALL_INDEX_DEFS.map((def) => {
      const q      = quoteMap.get(def.dsSymbol);
      const ltp    = q?.ltp;
      const hasLive = ltp != null && ltp > 0;
      return {
        name:             def.name,
        symbol:           def.symbol,        // Yahoo key retained for UI
        dsSymbol:         def.dsSymbol,
        underlying:       def.underlying,
        historicalSymbol: def.historicalSymbol,
        hasLive,
        price:     hasLive ? ltp : null,
        changePct: q?.changePct ?? null,
        change:    q?.change    ?? null,
        open:      q?.open      ?? null,
        high:      q?.high      ?? null,
        low:       q?.low       ?? null,
        volume:    q?.volume    ?? null,
        oi:        q?.oi        ?? null,
        prevClose: q?.prevClose ?? null,
      };
    });

    // ── Historical close fallback for missing index prices ─────────────────
    // Runs for any index whose live quote returned null — whether an FNO index
    // (FINNIFTY, MIDCPNIFTY) or a supplementary index (SENSEX).
    // Uses the last daily candle close from Yahoo Finance via data-service2.0.
    const fallbackDefs = indexEntries.filter(
      (e) => !e.hasLive && e.historicalSymbol,
    );
    const fallbackMap  = new Map<string, number | null>();
    if (fallbackDefs.length > 0) {
      const results = await Promise.all(
        fallbackDefs.map(async (d) => ({
          sym:   d.historicalSymbol,
          close: await getLastHistoricalClose(d.historicalSymbol),
        })),
      );
      for (const { sym, close } of results) fallbackMap.set(sym, close);
    }

    const indexQuotes = indexEntries.map(({ dsSymbol: _ds, underlying, hasLive, historicalSymbol, ...entry }) => {
      const price = hasLive
        ? entry.price
        : (fallbackMap.get(historicalSymbol) ?? null);
      return { ...entry, price };
    });

    // ── Sector quotes ──────────────────────────────────────────────────────
    const sectorQuotes = SECTORS.map((s) => {
      const q   = quoteMap.get(s.dsSymbol);
      const ltp = q?.ltp;
      return {
        name:      s.name,
        symbol:    s.symbol,
        price:     ltp != null && ltp > 0 ? ltp : null,
        changePct: q?.changePct ?? null,
      };
    });

    // ── Simulated enrichment for degraded data ─────────────────────────────
    // When data-service2.0 is connected but the provider has no live session
    // (e.g. pre-market, post-close), all changePct fields come back null.
    // Fill them in from the simulated module so the UI shows movement.
    const allChangePctNull      = indexQuotes.every((e) => e.changePct == null);
    const allSectorChangePctNull = sectorQuotes.every((s) => s.changePct == null);

    let finalIndices = indexQuotes;
    let finalSectors = sectorQuotes;
    let isPartiallySimulated = false;

    if (allChangePctNull || allSectorChangePctNull) {
      const sim          = getSimulatedSnapshot();
      const simIndexMap  = new Map(sim.indices.map((i) => [i.symbol, i]));
      const simSectorMap = new Map(sim.sectors.map((s) => [s.symbol, s]));
      isPartiallySimulated = true;

      if (allChangePctNull) {
        finalIndices = indexQuotes.map((entry) => {
          if (entry.changePct != null) return entry;
          const s = simIndexMap.get(entry.symbol);
          if (!s) return entry;
          const price     = entry.price ?? s.price;
          const changePct = s.changePct;
          const change    = price && changePct != null
            ? +((price * changePct) / (100 + changePct)).toFixed(2)
            : null;
          return {
            ...entry,
            price,
            changePct,
            change,
            open:      entry.open      ?? (price ? +(price * 0.999).toFixed(2) : null),
            high:      entry.high      ?? (price ? +(price * 1.005).toFixed(2) : null),
            low:       entry.low       ?? (price ? +(price * 0.995).toFixed(2) : null),
            prevClose: entry.prevClose ?? (price && change ? +(price - change).toFixed(2) : null),
          };
        });
      }

      if (allSectorChangePctNull) {
        finalSectors = sectorQuotes.map((s) => {
          if (s.changePct != null) return s;
          const sim = simSectorMap.get(s.symbol);
          return {
            ...s,
            changePct: sim?.changePct ?? null,
            price:     s.price ?? sim?.price ?? null,
          };
        });
      }
    }

    return NextResponse.json(
      {
        indices:   finalIndices,
        sectors:   finalSectors,
        source:    "data-service2",
        fetchedAt: new Date().toISOString(),
        ...(isPartiallySimulated && { simulated: true }),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    if (err instanceof DataServiceUnavailableError) {
      const sim = getSimulatedSnapshot();
      return NextResponse.json(sim, { headers: { "Cache-Control": "no-store" } });
    }
    console.error("[market-snapshot] unexpected error:", (err as Error).message);
    const sim = getSimulatedSnapshot();
    return NextResponse.json(sim, { headers: { "Cache-Control": "no-store" } });
  }
}
