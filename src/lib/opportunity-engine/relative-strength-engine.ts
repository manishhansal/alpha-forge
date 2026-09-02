/**
 * RelativeStrengthEngine + SectorContextEngine
 *
 * Cross-sectional analysis for Indian F&O universe.
 *
 * RelativeStrengthEngine:
 *   - Stock vs NIFTY (risk-adjusted outperformance)
 *   - Stock vs sector ETF / sector proxy
 *   - Stock vs BANKNIFTY (for banking stocks)
 *   - Cross-sectional momentum rank
 *   - Volume rank
 *
 * SectorContextEngine:
 *   - Sector trend, momentum, breadth
 *   - Sector classification: STRONGLY_SUPPORTIVE → STRONGLY_CONTRADICTORY
 *
 * A stock with strong relative strength across multiple dimensions deserves
 * a higher opportunity score than an isolated technical pattern.
 * A stock fighting its sector should be penalized unless the strategy
 * historically demonstrates alpha in that situation.
 *
 * This module is I/O-free.
 */

import type { SectorContextClassification } from "./types";

// ─── India Sector Map ────────────────────────────────────────────────────────

/** NSE F&O sector classification */
export const INDIA_SECTOR_MAP: Record<string, string> = {
  // Banking
  HDFCBANK: "BANKING", ICICIBANK: "BANKING", KOTAKBANK: "BANKING",
  AXISBANK: "BANKING", SBIN: "BANKING", BANKBARODA: "BANKING",
  INDUSINDBK: "BANKING", FEDERALBNK: "BANKING", IDFCFIRSTB: "BANKING",
  BANDHANBNK: "BANKING", RBLBANK: "BANKING",

  // IT
  TCS: "IT", INFY: "IT", WIPRO: "IT", HCLTECH: "IT", TECHM: "IT",
  LTIM: "IT", MPHASIS: "IT", PERSISTENT: "IT", COFORGE: "IT",

  // NBFC / Financial
  BAJFINANCE: "NBFC", BAJAJFINSV: "NBFC", MUTHOOTFIN: "NBFC",
  CHOLAFIN: "NBFC", M_MFIN: "NBFC",

  // Auto
  MARUTI: "AUTO", TATAMOTORS: "AUTO", M_M: "AUTO", BAJAJ_AUTO: "AUTO",
  HEROMOTOCO: "AUTO", EICHERMOT: "AUTO", ASHOKLEY: "AUTO",

  // Pharma
  SUNPHARMA: "PHARMA", DRREDDY: "PHARMA", CIPLA: "PHARMA",
  DIVISLAB: "PHARMA", BIOCON: "PHARMA", LUPIN: "PHARMA",

  // FMCG
  HINDUNILVR: "FMCG", ITC: "FMCG", NESTLEIND: "FMCG",
  BRITANNIA: "FMCG", DABUR: "FMCG", MARICO: "FMCG",

  // Metal
  TATASTEEL: "METAL", JSWSTEEL: "METAL", HINDALCO: "METAL",
  VEDL: "METAL", SAIL: "METAL", NMDC: "METAL",

  // Oil & Gas
  RELIANCE: "OIL_GAS", ONGC: "OIL_GAS", BPCL: "OIL_GAS",
  IOC: "OIL_GAS", GAIL: "OIL_GAS", PETRONET: "OIL_GAS",

  // Infra / Capital Goods
  LT: "INFRA", ADANIENT: "INFRA", ADANIPORTS: "INFRA", SIEMENS: "INFRA",
  ABB: "INFRA", BEL: "INFRA",

  // Telecom
  BHARTIARTL: "TELECOM",

  // Cement
  ULTRACEMCO: "CEMENT", SHREECEM: "CEMENT", AMBUJACEM: "CEMENT",

  // Power
  NTPC: "POWER", POWERGRID: "POWER", TATAPOWER: "POWER",

  // Insurance
  SBILIFE: "INSURANCE", HDFCLIFE: "INSURANCE", ICICIlombard: "INSURANCE",

  // Indices
  NIFTY: "INDEX", BANKNIFTY: "INDEX", FINNIFTY: "INDEX",
  MIDCPNIFTY: "INDEX",
};

// ─── Return Series ────────────────────────────────────────────────────────────

export interface ReturnSeries {
  symbol: string;
  returns: number[];   // daily % returns, most recent last
  avgVolume20d: number | null;
  currentVolume: number | null;
}

// ─── Relative Strength Result ─────────────────────────────────────────────────

export interface RelativeStrengthResult {
  symbol: string;
  sector: string | null;

  /** Excess return vs NIFTY over lookback periods */
  vsNifty: {
    return5d: number | null;
    return10d: number | null;
    return20d: number | null;
    score: number;           // [-1, 1] composite
  };

  /** Excess return vs sector (if sector proxy available) */
  vsSector: {
    return5d: number | null;
    return20d: number | null;
    score: number;           // [-1, 1] composite
  };

  /** Cross-sectional momentum rank [0, 100] */
  momentumRank: number;

  /** Volume rank [0, 100] */
  volumeRank: number;

  /** Overall relative strength score [-1, 1] */
  compositeScore: number;

  /** Direction: is the stock outperforming (LONG) or underperforming (SHORT) */
  strengthDirection: "OUTPERFORMING" | "UNDERPERFORMING" | "NEUTRAL";

  reasons: string[];
}

// ─── Sector Context Result ────────────────────────────────────────────────────

export interface SectorContextResult {
  sector: string;
  sectorTrend: "BULL" | "BEAR" | "NEUTRAL" | "UNKNOWN";
  sectorMomentum: number;      // 5d sector return %
  sectorBreadth: number;       // [0, 1] fraction of sector stocks advancing
  sectorRelativeStrength: number; // sector return vs NIFTY return
  sectorVolume: number;        // sector RVOL vs 20d avg
  classification: SectorContextClassification;
  sectorLeader: string | null; // strongest stock in sector
  reasons: string[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function excessReturn(
  returns: number[],
  benchmark: number[],
  lookback: number,
): number | null {
  if (returns.length < lookback || benchmark.length < lookback) return null;
  const stockRet = returns.slice(-lookback).reduce((a, b) => a + b, 0);
  const benchRet = benchmark.slice(-lookback).reduce((a, b) => a + b, 0);
  return stockRet - benchRet;
}

function percentileRank(values: number[], current: number): number {
  if (values.length === 0) return 50;
  return (values.filter(v => v < current).length / values.length) * 100;
}

// ─── Relative Strength Engine ─────────────────────────────────────────────────

/**
 * Compute relative strength for a single stock vs NIFTY and its sector.
 */
export function computeRelativeStrength(
  symbol: string,
  stockReturns: ReturnSeries,
  niftyReturns: ReturnSeries,
  sectorReturns: ReturnSeries | null,
  allUniverseReturns: ReturnSeries[],
): RelativeStrengthResult {
  const reasons: string[] = [];
  const sector = INDIA_SECTOR_MAP[symbol] ?? null;

  // vs NIFTY
  const vsNifty5d = excessReturn(stockReturns.returns, niftyReturns.returns, 5);
  const vsNifty10d = excessReturn(stockReturns.returns, niftyReturns.returns, 10);
  const vsNifty20d = excessReturn(stockReturns.returns, niftyReturns.returns, 20);

  let vsNiftyScore = 0;
  if (vsNifty5d !== null) vsNiftyScore += Math.min(1, Math.max(-1, vsNifty5d / 3)) * 0.5;
  if (vsNifty20d !== null) vsNiftyScore += Math.min(1, Math.max(-1, vsNifty20d / 5)) * 0.5;

  if (vsNifty5d !== null) {
    reasons.push(`vs NIFTY 5d: ${vsNifty5d > 0 ? "+" : ""}${vsNifty5d.toFixed(1)}%`);
  }

  // vs Sector
  let vsSector5d: number | null = null;
  let vsSector20d: number | null = null;
  let vsSectorScore = 0;

  if (sectorReturns) {
    vsSector5d = excessReturn(stockReturns.returns, sectorReturns.returns, 5);
    vsSector20d = excessReturn(stockReturns.returns, sectorReturns.returns, 20);
    if (vsSector5d !== null) vsSectorScore += Math.min(1, Math.max(-1, vsSector5d / 2)) * 0.5;
    if (vsSector20d !== null) vsSectorScore += Math.min(1, Math.max(-1, vsSector20d / 4)) * 0.5;
    if (vsSector5d !== null) {
      reasons.push(`vs sector 5d: ${vsSector5d > 0 ? "+" : ""}${vsSector5d.toFixed(1)}%`);
    }
  }

  // Momentum rank: 20d return vs universe
  const stockRet20 = stockReturns.returns.length >= 20
    ? stockReturns.returns.slice(-20).reduce((a, b) => a + b, 0)
    : 0;
  const universeRets20 = allUniverseReturns
    .filter(r => r.returns.length >= 20)
    .map(r => r.returns.slice(-20).reduce((a, b) => a + b, 0));
  const momentumRank = percentileRank(universeRets20, stockRet20);

  // Volume rank
  const currentVol = stockReturns.currentVolume ?? 0;
  const universeVols = allUniverseReturns
    .filter(r => r.currentVolume !== null)
    .map(r => r.currentVolume!);
  const volumeRank = percentileRank(universeVols, currentVol);

  // Composite score: weight vs NIFTY > vs sector > cross-sectional rank
  const compositeScore = Math.max(-1, Math.min(1,
    vsNiftyScore * 0.5 +
    (sectorReturns ? vsSectorScore * 0.3 : vsNiftyScore * 0.3) +
    ((momentumRank - 50) / 50) * 0.2,
  ));

  const strengthDirection: RelativeStrengthResult["strengthDirection"] =
    compositeScore > 0.2 ? "OUTPERFORMING" :
    compositeScore < -0.2 ? "UNDERPERFORMING" : "NEUTRAL";

  if (momentumRank > 70) reasons.push(`Momentum rank: ${momentumRank.toFixed(0)}th pct (top ${(100 - momentumRank).toFixed(0)}%)`);
  if (momentumRank < 30) reasons.push(`Momentum rank: ${momentumRank.toFixed(0)}th pct (laggard)`);

  return {
    symbol,
    sector,
    vsNifty: { return5d: vsNifty5d, return10d: vsNifty10d, return20d: vsNifty20d, score: vsNiftyScore },
    vsSector: { return5d: vsSector5d, return20d: vsSector20d, score: vsSectorScore },
    momentumRank,
    volumeRank,
    compositeScore,
    strengthDirection,
    reasons,
  };
}

// ─── Sector Context Engine ────────────────────────────────────────────────────

/**
 * Evaluate sector context for a given stock.
 * Used to determine whether the sector is supportive or contradictory.
 */
export function evaluateSectorContext(
  sector: string,
  sectorStockReturns: ReturnSeries[],
  niftyReturn5d: number,
): SectorContextResult {
  const reasons: string[] = [];

  if (sectorStockReturns.length === 0) {
    return {
      sector,
      sectorTrend: "UNKNOWN",
      sectorMomentum: 0,
      sectorBreadth: 0.5,
      sectorRelativeStrength: 0,
      sectorVolume: 1,
      classification: "UNKNOWN",
      sectorLeader: null,
      reasons: ["No sector stocks available"],
    };
  }

  // Sector 5d return = median of member stock 5d returns
  const returns5d = sectorStockReturns
    .filter(r => r.returns.length >= 5)
    .map(r => r.returns.slice(-5).reduce((a, b) => a + b, 0));
  returns5d.sort((a, b) => a - b);
  const sectorMomentum = returns5d.length > 0
    ? returns5d[Math.floor(returns5d.length / 2)]
    : 0;

  // Breadth: fraction advancing (5d return > 0)
  const advancing = returns5d.filter(r => r > 0).length;
  const sectorBreadth = returns5d.length > 0 ? advancing / returns5d.length : 0.5;

  // Relative strength vs NIFTY
  const sectorRelativeStrength = sectorMomentum - niftyReturn5d;

  // Sector volume
  const vols = sectorStockReturns.filter(r => r.avgVolume20d && r.currentVolume)
    .map(r => r.currentVolume! / r.avgVolume20d!);
  const sectorVolume = vols.length > 0 ? vols.reduce((a, b) => a + b, 0) / vols.length : 1;

  // Sector trend
  const sectorTrend: SectorContextResult["sectorTrend"] =
    sectorMomentum > 1.5 && sectorBreadth > 0.65 ? "BULL" :
    sectorMomentum < -1.5 && sectorBreadth < 0.35 ? "BEAR" :
    sectorMomentum > 0.3 ? "BULL" :
    sectorMomentum < -0.3 ? "BEAR" : "NEUTRAL";

  // Sector leader
  const stocksWithReturns = sectorStockReturns
    .filter(r => r.returns.length >= 5)
    .map(r => ({ symbol: r.symbol, ret5d: r.returns.slice(-5).reduce((a, b) => a + b, 0) }))
    .sort((a, b) => b.ret5d - a.ret5d);
  const sectorLeader = stocksWithReturns.length > 0 ? stocksWithReturns[0].symbol : null;

  // Classification
  let classification: SectorContextClassification;
  if (sectorTrend === "BULL" && sectorBreadth > 0.65 && sectorRelativeStrength > 1.0) {
    classification = "STRONGLY_SUPPORTIVE";
    reasons.push(`Sector ${sector}: strong bull, ${(sectorBreadth * 100).toFixed(0)}% advancing`);
  } else if (sectorTrend === "BULL" && sectorBreadth > 0.5) {
    classification = "SUPPORTIVE";
    reasons.push(`Sector ${sector}: bullish, ${(sectorBreadth * 100).toFixed(0)}% advancing`);
  } else if (sectorTrend === "BEAR" && sectorBreadth < 0.35 && sectorRelativeStrength < -1.0) {
    classification = "STRONGLY_CONTRADICTORY";
    reasons.push(`Sector ${sector}: strong bear, only ${(sectorBreadth * 100).toFixed(0)}% advancing`);
  } else if (sectorTrend === "BEAR") {
    classification = "CONTRADICTORY";
    reasons.push(`Sector ${sector}: bearish trend, ${(sectorBreadth * 100).toFixed(0)}% advancing`);
  } else {
    classification = "NEUTRAL";
    reasons.push(`Sector ${sector}: neutral, mixed breadth`);
  }

  return {
    sector,
    sectorTrend,
    sectorMomentum,
    sectorBreadth,
    sectorRelativeStrength,
    sectorVolume,
    classification,
    sectorLeader,
    reasons,
  };
}

/**
 * Convert sector classification to a directional score [-1, 1].
 * Used in OpportunityScoreVector.sectorScore for LONG trades.
 * Invert for SHORT trades.
 */
export function sectorClassificationToScore(
  classification: SectorContextClassification,
  direction: "LONG" | "SHORT",
): number {
  const raw =
    classification === "STRONGLY_SUPPORTIVE" ? 0.9 :
    classification === "SUPPORTIVE" ? 0.6 :
    classification === "NEUTRAL" ? 0 :
    classification === "CONTRADICTORY" ? -0.5 :
    classification === "STRONGLY_CONTRADICTORY" ? -0.85 : 0;
  return direction === "LONG" ? raw : -raw;
}
