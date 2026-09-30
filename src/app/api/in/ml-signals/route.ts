/**
 * GET /api/in/ml-signals
 *
 * Serves LightGBM scoring snapshot + market context from ml-service2.0.
 *
 * Views:
 *   (default)                → latest signals, enriched with sector field
 *   ?view=history&date=...   → ForecastLedger records for a session date
 *   ?view=log&n=10           → last N autorun tick samples
 *   ?view=context            → NIFTY bias + sector movers + F&O gainers/losers
 */

import { NextRequest, NextResponse } from "next/server";

import {
  fetchMLLatestSignals,
  fetchMLSignalHistory,
  fetchMLAutorunLog,
  isMLServiceHealthy,
} from "@/lib/india/ml-client";
import { runScanner } from "@/services/india/scanner/engine";
import { getQuotes } from "@/lib/data-service/client";
import { cached } from "@/lib/redis";

export const dynamic = "force-dynamic";

// ── Inline sector map (avoids module tree-shaking issues in standalone builds) ─
// Mirrors src/lib/india/sectors.ts — update both when adding new symbols.
const SYMBOL_TO_SECTOR: Record<string, string> = {};
const SECTOR_MAP: Record<string, string[]> = {
  "Bank":         ["HDFCBANK","ICICIBANK","SBIN","KOTAKBANK","AXISBANK","INDUSINDBK","BANKBARODA","PNB","CANBK","UNIONBANK","INDIANB","BANKINDIA","FEDERALBNK","IDFCFIRSTB","BANDHANBNK","RBLBANK","YESBANK","AUBANK"],
  "PSU Bank":     ["SBIN","BANKBARODA","PNB","CANBK","UNIONBANK","INDIANB","BANKINDIA"],
  "IT":           ["TCS","INFY","WIPRO","HCLTECH","TECHM","LTM","MPHASIS","COFORGE","PERSISTENT","OFSS","TATAELXSI","KPITTECH"],
  "Auto":         ["MARUTI","TMPV","HYUNDAI","M&M","EICHERMOT","TVSMOTOR","BAJAJ-AUTO","HEROMOTOCO","ASHOKLEY","BHARATFORG","MOTHERSON","BOSCHLTD","SONACOMS","UNOMINDA","TIINDIA","FORCEMOT"],
  "Pharma":       ["SUNPHARMA","DRREDDY","CIPLA","DIVISLAB","LUPIN","AUROPHARMA","BIOCON","ALKEM","TORNTPHARM","MANKIND","ZYDUSLIFE","GLENMARK","LAURUSLABS","APOLLOHOSP","MAXHEALTH","FORTIS"],
  "FMCG":         ["HINDUNILVR","ITC","NESTLEIND","BRITANNIA","DABUR","GODREJCP","MARICO","COLPAL","TATACONSUM","UNITDSPR","VBL","PATANJALI","GODFRYPHLP"],
  "Metal":        ["TATASTEEL","JSWSTEEL","HINDALCO","JINDALSTEL","NMDC","NATIONALUM","VEDL","HINDZINC","SAIL","APLAPOLLO"],
  "Energy":       ["RELIANCE","ONGC","BPCL","HINDPETRO","IOC","OIL","GAIL","COALINDIA","PETRONET","NTPC","POWERGRID","TATAPOWER","ADANIPOWER","ADANIGREEN","JSWENERGY","NHPC","SUZLON","WAAREEENER","INOXWIND","PREMIERENE","IREDA","RECLTD","PFC","IEX"],
  "Realty":       ["DLF","LODHA","GODREJPROP","OBEROIRLTY","PHOENIXLTD","PRESTIGE"],
  "Fin Services": ["BAJFINANCE","BAJAJFINSV","BAJAJHLDNG","SHRIRAMFIN","CHOLAFIN","MUTHOOTFIN","MANAPPURAM","SBICARD","LICHSGFIN","PNBHOUSING","LTF","MFSL","HDFCAMC","HDFCLIFE","SBILIFE","ICICIPRULI","ICICIGI","LICI","NAM-INDIA","CAMS","KFINTECH","ANGELONE","MOTILALOFS","CDSL","BSE","MCX","360ONE","POLICYBZR","PAYTM","JIOFIN","ABCAPITAL"],
  "Infra":        ["LT","BHEL","SIEMENS","ABB","CUMMINSIND","CGPOWER","POWERINDIA","KAYNES","BEL","BDL","HAL","COCHINSHIP","MAZDOCK","IRFC","RVNL","NBCC","GMRAIRPORT","CONCOR","ADANIPORTS","ADANIENSOL","ADANIENT","POLYCAB","HAVELLS"],
};
// Build reverse lookup once at module load
for (const [sector, symbols] of Object.entries(SECTOR_MAP)) {
  for (const sym of symbols) {
    if (!(sym in SYMBOL_TO_SECTOR)) SYMBOL_TO_SECTOR[sym] = sector;
  }
}
function getSector(symbol: string): string {
  return SYMBOL_TO_SECTOR[symbol] ?? "Other";
}

const ML_SIGNALS_KEY = "ml:signals:latest:v2";  // v2 = includes sector
const ML_HISTORY_KEY = (date: string) => `ml:signals:history:${date}:v1`;
const ML_LOG_KEY     = "ml:signals:autorun-log:v1";
const ML_CTX_KEY     = "ml:signals:context:v1";
const TTL_SIGNALS    = 30;
const TTL_HISTORY    = 60;
const TTL_LOG        = 20;
const TTL_CTX        = 60;

// ── Context builder: calls scanner + data-service directly ─────────────────

async function buildContext() {
  // Run scanner + NIFTY quote in parallel
  const [scannerRes, niftyQuotes] = await Promise.allSettled([
    runScanner("momentum", 200).catch(() => null),
    getQuotes(["NIFTY", "BANKNIFTY"], "NSE").catch(() => null),
  ]);
  const hits = (scannerRes.status === "fulfilled" ? scannerRes.value?.hits : null) ?? [];
  const quotes = (niftyQuotes.status === "fulfilled" ? niftyQuotes.value : null) ?? [];

  // ── NIFTY from direct data-service quote (most accurate) ────────────────
  const niftyQ = quotes[0];
  const niftyPrice = (niftyQ?.ltp && niftyQ.ltp > 0) ? niftyQ.ltp : null;
  const niftyChg   = niftyQ?.changePct ?? null;
  // Fallback: NIFTY from scanner hits if data-service quote unavailable
  const niftyHit   = hits.find(h => /^NIFTY(-EQ|-IDX)?$/.test(h.symbol));
  const nifty: { price: number | null; changePct: number | null } = {
    price:     niftyPrice ?? niftyHit?.price     ?? null,
    changePct: niftyChg   ?? niftyHit?.changePct ?? null,
  };

  // ── Sector performance: average changePct of stocks per sector ──────────
  const sectorTotals: Record<string, { sum: number; count: number }> = {};
  for (const h of hits) {
    if (h.changePct == null) continue;
    // Strip exchange suffix (e.g. "TCS-EQ" → "TCS", "RELIANCE-BE" → "RELIANCE")
    const cleanSym = h.symbol.replace(/-[A-Z]+$/, "");
    const sec = getSector(cleanSym);
    if (!sectorTotals[sec]) sectorTotals[sec] = { sum: 0, count: 0 };
    sectorTotals[sec].sum   += h.changePct;
    sectorTotals[sec].count += 1;
  }
  const sectors = Object.entries(sectorTotals)
    .filter(([name]) => name !== "Other")
    .map(([name, { sum, count }]) => ({
      name,
      changePct: Math.round((sum / count) * 100) / 100,
    }))
    .sort((a, b) => b.changePct - a.changePct);

  // ── Gainers / Losers — clean symbol names ────────────────────────────────
  const INDEX_SYMS = new Set(["NIFTY","BANKNIFTY","FINNIFTY","MIDCPNIFTY"]);
  const stockHits = hits.filter(h => {
    const clean = h.symbol.replace(/-[A-Z]+$/, "");
    return !INDEX_SYMS.has(clean);
  });
  const toMover = (h: typeof hits[0]) => ({
    symbol:    h.symbol.replace(/-[A-Z]+$/, ""),   // strip -EQ suffix
    price:     h.price     ?? 0,
    changePct: h.changePct ?? 0,
    volume:    h.volume    ?? undefined,
  });
  const gainers = stockHits
    .filter(h => h.kind === "GAINER" && h.price != null && h.changePct != null)
    .sort((a, b) => (b.changePct ?? 0) - (a.changePct ?? 0))
    .slice(0, 8).map(toMover);
  const losers = stockHits
    .filter(h => h.kind === "LOSER" && h.price != null && h.changePct != null)
    .sort((a, b) => (a.changePct ?? 0) - (b.changePct ?? 0))
    .slice(0, 8).map(toMover);

  return {
    snapshot:      { nifty, sectors },
    gainersLosers: { gainers, losers },
    generatedAt:   Date.now(),
  };
}

// ── Route handler ────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const view  = searchParams.get("view") ?? "latest";
  const date  = searchParams.get("date") ?? undefined;
  const lastN = Number(searchParams.get("n") ?? "10");

  // ── context view (NIFTY + sectors + gainers/losers) ───────────────────────
  if (view === "context") {
    const data = await cached(ML_CTX_KEY, TTL_CTX, () => buildContext());
    return NextResponse.json(data ?? { snapshot: null, gainersLosers: null });
  }

  // ── history view ──────────────────────────────────────────────────────────
  if (view === "history") {
    const key = ML_HISTORY_KEY(date ?? "today");
    const data = await cached(key, TTL_HISTORY, () => fetchMLSignalHistory(date));
    if (!data) {
      return NextResponse.json({ error: "ML service unavailable", records: [], n: 0 }, { status: 503 });
    }
    return NextResponse.json(data);
  }

  // ── autorun log view ──────────────────────────────────────────────────────
  if (view === "log") {
    const data = await cached(ML_LOG_KEY, TTL_LOG, () =>
      fetchMLAutorunLog(Math.min(lastN, 100)),
    );
    return NextResponse.json(data ?? { samples: [], n: 0 });
  }

  // ── latest signals (default) ──────────────────────────────────────────────
  const healthy = await isMLServiceHealthy();
  if (!healthy) {
    return NextResponse.json(
      {
        available: false, stale: true,
        message: "ML service is not reachable. Run `make session` to start the live session.",
        signals: [], n_scored: 0, n_long: 0, n_short: 0,
      },
      { status: 200 },
    );
  }

  const data = await cached(ML_SIGNALS_KEY, TTL_SIGNALS, () => fetchMLLatestSignals());

  if (!data) {
    return NextResponse.json(
      {
        available: false, stale: true,
        message: "No signal snapshot found. Run `make session` to start the live session.",
        signals: [], n_scored: 0, n_long: 0, n_short: 0,
      },
      { status: 200 },
    );
  }

  // Enrich every signal with its primary sector (inline map, no import issues)
  const enriched = {
    ...data,
    available: true,
    signals: (data.signals ?? []).map((sig) => ({
      ...sig,
      sector: getSector(sig.symbol),
    })),
  };

  return NextResponse.json(enriched);
}
