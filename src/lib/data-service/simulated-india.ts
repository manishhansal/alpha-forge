/**
 * simulated-india.ts — Simulated / demo data for Indian Market.
 *
 * Used as a fallback when data-service2.0 market-data endpoints are
 * unavailable or hanging (e.g. no upstream provider configured in dev).
 *
 * All values are realistic as of a typical NSE session. They are NOT live
 * prices — the UI renders a "SIMULATED" badge when this module is active.
 *
 * Usage: import { getSimulatedSnapshot, getSimulatedNiftyBias } from "./simulated-india"
 */

import type { MarketQuote, OHLCVCandle } from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Add ±jitter% of base to keep repeated calls looking slightly different. */
function jitter(base: number, pct = 0.003): number {
  return +(base * (1 + (Math.random() - 0.5) * 2 * pct)).toFixed(2);
}

// NOTE: intentionally not a module-level constant — every call gets the
// current timestamp so simulated quotes are never falsely flagged as stale.
function now(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Index baselines (realistic NSE/BSE levels)
// ---------------------------------------------------------------------------

const INDEX_BASELINES: Record<
  string,
  { name: string; price: number; changePct: number }
> = {
  // FNO indices (Yahoo-style symbols used internally)
  "^NSEI":     { name: "NIFTY 50",      price: 25388.90,  changePct: -0.41 },
  "^NSEBANK":  { name: "BANK NIFTY",    price: 51772.40,  changePct:  0.22 },
  "^CNXFIN":   { name: "FIN NIFTY",     price: 23510.65,  changePct:  0.08 },
  "^NSEMDCP50":{ name: "MIDCAP NIFTY",  price: 13125.30,  changePct: -0.15 },
  // Supplementary
  "^BSESN":    { name: "SENSEX",        price: 83184.75,  changePct: -0.38 },
  "^INDIAVIX": { name: "INDIA VIX",     price:   14.32,   changePct:  3.20 },
  // NSE sector indices (used by market-snapshot)
  "NSEBANK":   { name: "Bank",          price: 51772.40,  changePct:  0.22 },
  "CNXIT":     { name: "IT",            price: 40231.15,  changePct: -0.55 },
  "CNXAUTO":   { name: "Auto",          price: 24875.60,  changePct:  0.61 },
  "CNXPHARMA": { name: "Pharma",        price: 21340.80,  changePct:  1.08 },
  "CNXFMCG":   { name: "FMCG",          price: 56320.45,  changePct: -0.18 },
  "CNXMETAL":  { name: "Metal",         price: 10124.70,  changePct:  1.45 },
  "CNXENERGY": { name: "Energy",        price: 40812.35,  changePct: -0.32 },
  "CNXREALTY": { name: "Realty",        price:  1042.80,  changePct:  2.10 },
  "CNXFIN":    { name: "Fin Services",  price: 23510.65,  changePct:  0.08 },
  "CNXMEDIA":  { name: "Media",         price:  2218.40,  changePct: -0.74 },
  "CNXPSUBANK":{ name: "PSU Bank",      price:  6432.15,  changePct:  0.90 },
  "CNXINFRA":  { name: "Infra",         price: 10328.55,  changePct:  0.35 },
};

// ---------------------------------------------------------------------------
// Top FNO stock baselines (subset for scanner simulation)
// ---------------------------------------------------------------------------

const STOCK_BASELINES: Array<{
  symbol: string;
  price: number;
  changePct: number;
}> = [
  { symbol: "RELIANCE",    price: 2987.50,  changePct:  0.82 },
  { symbol: "HDFCBANK",    price: 1748.35,  changePct:  0.41 },
  { symbol: "ICICIBANK",   price: 1358.90,  changePct:  0.95 },
  { symbol: "INFY",        price: 1920.15,  changePct: -0.63 },
  { symbol: "TCS",         price: 4312.80,  changePct: -0.28 },
  { symbol: "BHARTIARTL",  price: 1712.40,  changePct:  1.34 },
  { symbol: "SBIN",        price:  812.65,  changePct:  1.12 },
  { symbol: "AXISBANK",    price: 1241.75,  changePct:  0.76 },
  { symbol: "LT",          price: 3620.40,  changePct:  0.58 },
  { symbol: "KOTAKBANK",   price: 1882.30,  changePct: -0.22 },
  { symbol: "HINDUNILVR",  price: 2651.45,  changePct: -0.45 },
  { symbol: "ITC",         price:  487.80,  changePct:  0.38 },
  { symbol: "SUNPHARMA",   price: 1912.60,  changePct:  1.22 },
  { symbol: "WIPRO",       price:  564.25,  changePct: -0.91 },
  { symbol: "ADANIENT",    price: 3241.70,  changePct:  2.35 },
  { symbol: "MARUTI",      price:13120.50,  changePct:  0.47 },
  { symbol: "BAJFINANCE",  price: 7892.30,  changePct: -0.34 },
  { symbol: "ONGC",        price:  312.45,  changePct:  0.68 },
  { symbol: "NTPC",        price:  412.70,  changePct:  0.55 },
  { symbol: "POWERGRID",   price:  348.90,  changePct:  0.72 },
  { symbol: "TATAMOTORS",  price:  982.40,  changePct:  1.87 },
  { symbol: "TATASTEEL",   price:  164.75,  changePct:  2.10 },
  { symbol: "HINDALCO",    price:  691.30,  changePct:  1.55 },
  { symbol: "JSWSTEEL",    price:  978.20,  changePct:  1.34 },
  { symbol: "ULTRACEMCO",  price:11230.60,  changePct: -0.18 },
  { symbol: "ASIANPAINT",  price: 3012.45,  changePct: -0.92 },
  { symbol: "DMART",       price: 4812.30,  changePct: -0.35 },
  { symbol: "HCLTECH",     price: 1845.60,  changePct: -0.48 },
  { symbol: "TECHM",       price: 1621.40,  changePct: -0.72 },
  { symbol: "INDUSINDBK",  price: 1421.75,  changePct: -0.88 },
];

// ---------------------------------------------------------------------------
// Simulated MarketQuote factory
// ---------------------------------------------------------------------------

function makeSimulatedQuote(symbol: string): MarketQuote {
  const baseline = INDEX_BASELINES[symbol] ?? STOCK_BASELINES.find((s) => s.symbol === symbol);
  const price = baseline ? jitter(baseline.price) : jitter(1000);
  const changePct = baseline?.changePct ?? (Math.random() - 0.5) * 4;
  const prevClose = +(price / (1 + changePct / 100)).toFixed(2);
  const change = +(price - prevClose).toFixed(2);

  return {
    instrumentId: symbol,
    symbol,
    name: (baseline as { name?: string } | undefined)?.name ?? symbol,
    exchange: "NSE",
    ltp: price,
    open: jitter(prevClose),
    high: jitter(price * 1.008),
    low: jitter(price * 0.992),
    prevClose,
    change,
    changePct: +changePct.toFixed(2),
    volume: Math.floor(Math.random() * 5_000_000) + 500_000,
    oi: Math.floor(Math.random() * 2_000_000) + 100_000,
    tradedValue: null,
    bid: jitter(price * 0.9998),
    ask: jitter(price * 1.0002),
    weekHigh52: jitter(price * 1.18),
    weekLow52: jitter(price * 0.82),
    marketStatus: "REGULAR",
    lastTradeTime: now(),
    dataAsOf: now(),
    fetchedAt: now(),
    provider: "SIMULATED",
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Shape returned by /api/in/market-snapshot on the happy path. */
export interface SimulatedSnapshot {
  indices: Array<{
    name: string;
    symbol: string;
    price: number | null;
    changePct: number | null;
    change: number | null;
    open: number | null;
    high: number | null;
    low: number | null;
    volume: number | null;
    oi: number | null;
    prevClose: number | null;
  }>;
  sectors: Array<{
    name: string;
    symbol: string;
    price: number | null;
    changePct: number | null;
  }>;
  source: string;
  fetchedAt: string;
  simulated: true;
}

const FNO_INDEX_DEFS = [
  { name: "NIFTY 50",     symbol: "^NSEI" },
  { name: "BANK NIFTY",   symbol: "^NSEBANK" },
  { name: "FIN NIFTY",    symbol: "^CNXFIN" },
  { name: "MIDCAP NIFTY", symbol: "^NSEMDCP50" },
  { name: "SENSEX",       symbol: "^BSESN" },
  { name: "INDIA VIX",    symbol: "^INDIAVIX" },
];

const SECTOR_DEFS = [
  { name: "Bank",         symbol: "NSEBANK" },
  { name: "IT",           symbol: "CNXIT" },
  { name: "Auto",         symbol: "CNXAUTO" },
  { name: "Pharma",       symbol: "CNXPHARMA" },
  { name: "FMCG",         symbol: "CNXFMCG" },
  { name: "Metal",        symbol: "CNXMETAL" },
  { name: "Energy",       symbol: "CNXENERGY" },
  { name: "Realty",       symbol: "CNXREALTY" },
  { name: "Fin Services", symbol: "CNXFIN" },
  { name: "Media",        symbol: "CNXMEDIA" },
  { name: "PSU Bank",     symbol: "CNXPSUBANK" },
  { name: "Infra",        symbol: "CNXINFRA" },
];

/** Simulated market snapshot (indices + sectors). */
export function getSimulatedSnapshot(): SimulatedSnapshot {
  const indices = FNO_INDEX_DEFS.map(({ name, symbol }) => {
    const q = makeSimulatedQuote(symbol);
    return {
      name,
      symbol,
      price: q.ltp,
      changePct: q.changePct,
      change: q.change,
      open: q.open,
      high: q.high,
      low: q.low,
      volume: q.volume,
      oi: q.oi,
      prevClose: q.prevClose,
    };
  });

  const sectors = SECTOR_DEFS.map(({ name, symbol }) => {
    const q = makeSimulatedQuote(symbol);
    return { name, symbol, price: q.ltp, changePct: q.changePct };
  });

  return {
    indices,
    sectors,
    source: "SIMULATED",
    fetchedAt: new Date().toISOString(),
    simulated: true,
  };
}

/** Simulated NIFTY 50 bias for /api/in/nifty-bias. */
export function getSimulatedNiftyBias(): { bias: string; price: string; simulated: true } {
  const { price, changePct } = INDEX_BASELINES["^NSEI"]!;
  const live = jitter(price);
  const bias = changePct >= 0 ? "BULLISH" : "BEARISH";
  return { bias, price: live.toFixed(2), simulated: true };
}

/** Simulated quote(s) for /api/in/quote. */
export function getSimulatedQuotes(symbols: string[]): MarketQuote[] {
  return symbols.map(makeSimulatedQuote);
}

/** Simulated single quote. */
export function getSimulatedQuote(symbol: string): MarketQuote {
  return makeSimulatedQuote(symbol);
}

/** Simulated OHLCV candles (90 days of daily candles). */
export function getSimulatedCandles(symbol: string, days = 90): OHLCVCandle[] {
  const baseline = INDEX_BASELINES[symbol] ?? STOCK_BASELINES.find((s) => s.symbol === symbol);
  let price = baseline ? baseline.price : 1000;
  const candles: OHLCVCandle[] = [];
  const now = Date.now();

  for (let i = days; i >= 0; i--) {
    const t = Math.floor((now - i * 86_400_000) / 1000);
    const open = jitter(price, 0.005);
    const drift = (Math.random() - 0.48) * 0.012;
    const close = +(price * (1 + drift)).toFixed(2);
    const high = Math.max(open, close) * (1 + Math.random() * 0.005);
    const low = Math.min(open, close) * (1 - Math.random() * 0.005);
    candles.push({
      time: t,
      open: +open.toFixed(2),
      high: +high.toFixed(2),
      low: +low.toFixed(2),
      close,
      volume: Math.floor(Math.random() * 5_000_000) + 200_000,
    });
    price = close;
  }
  return candles;
}

/** Simulated scanner hits for a given type (used by scanner engine fallback). */
export function getSimulatedScannerHits(
  type: string,
  limit = 25,
): Array<{ symbol: string; price: number; changePct: number; volume: number; metric: number; kind: string }> {
  const sorted = [...STOCK_BASELINES].sort(() => Math.random() - 0.5);
  return sorted.slice(0, limit).map((s) => {
    const price = jitter(s.price);
    let metric = Math.abs(s.changePct);
    let kind = s.changePct >= 0 ? "GAINER" : "LOSER";

    if (type === "oi-buildup") {
      metric = Math.floor(Math.random() * 500_000) + 50_000;
      kind = s.changePct >= 0 ? "LONG_BUILDUP" : "SHORT_BUILDUP";
    } else if (type === "volume-breakout") {
      metric = +(1.5 + Math.random() * 3).toFixed(2);
      kind = "VOLUME_SPIKE";
    } else if (type === "pcr") {
      metric = +(0.5 + Math.random() * 1.5).toFixed(3);
      kind = metric > 1 ? "BULLISH" : "BEARISH";
    } else if (type === "iv-spike") {
      metric = +(10 + Math.random() * 30).toFixed(2);
      kind = "IV_SPIKE";
    } else if (type === "range-expansion") {
      metric = +(1.2 + Math.random() * 2).toFixed(2);
      kind = "RANGE_EXPANSION";
    }

    return {
      symbol: s.symbol,
      price,
      changePct: +jitter(s.changePct, 0.1).toFixed(2),
      volume: Math.floor(Math.random() * 3_000_000) + 100_000,
      metric,
      kind,
    };
  });
}
