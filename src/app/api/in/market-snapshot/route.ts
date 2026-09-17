import { NextResponse } from "next/server";
import { getQuotes, getHistorical, DataServiceUnavailableError } from "@/lib/data-service/client";
import { getSimulatedSnapshot } from "@/lib/data-service/simulated-india";
import { FNO_INDICES, SUPPLEMENTARY_INDICES } from "@/lib/india/fno-symbols";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const SECTORS: { name: string; symbol: string }[] = [
  { name: "Bank",         symbol: "NSEBANK"   },
  { name: "IT",           symbol: "CNXIT"     },
  { name: "Auto",         symbol: "CNXAUTO"   },
  { name: "Pharma",       symbol: "CNXPHARMA" },
  { name: "FMCG",         symbol: "CNXFMCG"   },
  { name: "Metal",        symbol: "CNXMETAL"  },
  { name: "Energy",       symbol: "CNXENERGY" },
  { name: "Realty",       symbol: "CNXREALTY" },
  { name: "Fin Services", symbol: "CNXFIN"    },
  { name: "Media",        symbol: "CNXMEDIA"  },
  { name: "PSU Bank",     symbol: "CNXPSUBANK"},
  { name: "Infra",        symbol: "CNXINFRA"  },
];

const ALL_INDICES = [...FNO_INDICES, ...SUPPLEMENTARY_INDICES];

/**
 * Fetch the last known close price from the daily historical series.
 * Used as a fallback when the live quote returns null (market closed / no provider).
 *
 * @param underlying  NSE underlying symbol accepted by data-service2.0 historical
 *                    endpoint (e.g. "NIFTY", "BANKNIFTY") — NOT the Yahoo-style
 *                    symbol like "^NSEI". Only FNO_INDICES have this field.
 */
async function getLastHistoricalClose(underlying: string): Promise<number | null> {
  try {
    const candles = await getHistorical({ symbol: underlying, interval: "1d" });
    if (!candles.length) return null;
    const last = candles[candles.length - 1]!;
    // Return both close (today's session close) and open as a proxy for
    // prevClose so the caller can compute a change % if needed.
    return last.close > 0 ? last.close : null;
  } catch {
    return null;
  }
}

export async function GET() {
  const indexSyms  = ALL_INDICES.map((i) => i.symbol);
  const sectorSyms = SECTORS.map((s) => s.symbol);
  const allSyms    = [...new Set([...indexSyms, ...sectorSyms])];

  try {
    const allQuotes = await getQuotes(allSyms, "NSE");
    const quoteMap  = new Map(
      allSyms.map((sym, i) => [sym, allQuotes[i] ?? null]),
    );

    // Build index entries; kick off historical fallback fetches in parallel for
    // any FNO index whose live ltp is missing (market closed / provider down).
    const indexEntries = ALL_INDICES.map((idx) => {
      const q   = quoteMap.get(idx.symbol);
      const ltp = q?.ltp;
      const hasLive = ltp != null && ltp > 0;

      // "underlying" exists only on FNO_INDICES entries, not SUPPLEMENTARY_INDICES.
      const underlying = (idx as { underlying?: string }).underlying ?? null;

      return {
        name:      idx.name,
        symbol:    idx.symbol,
        underlying,
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

    // For indices with no live price, attempt historical close as fallback.
    // Run all fallback fetches concurrently to keep latency low.
    const fallbackSymbols = indexEntries
      .filter((e) => !e.hasLive && e.underlying)
      .map((e) => e.underlying!);

    const fallbackMap = new Map<string, number | null>();
    if (fallbackSymbols.length > 0) {
      const results = await Promise.all(
        fallbackSymbols.map(async (sym) => ({
          sym,
          close: await getLastHistoricalClose(sym),
        })),
      );
      for (const { sym, close } of results) fallbackMap.set(sym, close);
    }

    const indexQuotes = indexEntries.map(({ underlying, hasLive, ...entry }) => {
      const price = hasLive
        ? entry.price
        : (underlying ? (fallbackMap.get(underlying) ?? null) : null);
      return { ...entry, price };
    });

    const sectorQuotes = SECTORS.map((s) => {
      const q   = quoteMap.get(s.symbol);
      const ltp = q?.ltp;
      // Sectors have no historical data in data-service2.0 — show null when closed.
      return {
        name:      s.name,
        symbol:    s.symbol,
        price:     ltp != null && ltp > 0 ? ltp : null,
        changePct: q?.changePct ?? null,
      };
    });

    // ── Simulated enrichment for degraded data ─────────────────────────────
    // When the data service returns prices but all changePct/change fields are
    // null (provider connected but no live session), fill in the missing fields
    // from the simulated module so the UI shows movement instead of dashes.
    const allChangePctNull = indexQuotes.every((e) => e.changePct == null);
    const allSectorChangePctNull = sectorQuotes.every((s) => s.changePct == null);

    let finalIndices = indexQuotes;
    let finalSectors = sectorQuotes;
    let isPartiallySimulated = false;

    if (allChangePctNull || allSectorChangePctNull) {
      const sim = getSimulatedSnapshot();
      const simIndexMap = new Map(sim.indices.map((i) => [i.symbol, i]));
      const simSectorMap = new Map(sim.sectors.map((s) => [s.symbol, s]));
      isPartiallySimulated = true;

      if (allChangePctNull) {
        finalIndices = indexQuotes.map((entry) => {
          if (entry.changePct != null) return entry;
          const s = simIndexMap.get(entry.symbol);
          if (!s) return entry;
          const price = entry.price ?? s.price;
          const changePct = s.changePct;
          const change = price && changePct != null
            ? +((price * changePct) / (100 + changePct)).toFixed(2)
            : null;
          return {
            ...entry,
            price:     price,
            changePct: changePct,
            change:    change,
            open:      entry.open  ?? (price ? +(price * 0.999).toFixed(2) : null),
            high:      entry.high  ?? (price ? +(price * 1.005).toFixed(2) : null),
            low:       entry.low   ?? (price ? +(price * 0.995).toFixed(2) : null),
            prevClose: entry.prevClose ?? (price && change ? +(price - change).toFixed(2) : null),
          };
        });
      }

      if (allSectorChangePctNull) {
        finalSectors = sectorQuotes.map((s) => {
          if (s.changePct != null) return s;
          const sim = simSectorMap.get(s.symbol);
          return { ...s, changePct: sim?.changePct ?? null, price: s.price ?? sim?.price ?? null };
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
      // no-store: every request goes to the origin — this route is already
      // force-dynamic and callers poll on their own interval.
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    if (err instanceof DataServiceUnavailableError) {
      // data-service2.0 is unreachable or timed out — return simulated data
      // so the UI shows realistic values instead of empty tiles.
      const sim = getSimulatedSnapshot();
      return NextResponse.json(sim, {
        headers: { "Cache-Control": "no-store" },
      });
    }
    // Unexpected error — also fall back to simulated so the UI doesn't break.
    console.error("[market-snapshot] unexpected error:", (err as Error).message);
    const sim = getSimulatedSnapshot();
    return NextResponse.json(sim, {
      headers: { "Cache-Control": "no-store" },
    });
  }
}
