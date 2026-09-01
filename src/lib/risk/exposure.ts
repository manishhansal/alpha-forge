/**
 * exposure.ts — Portfolio Exposure Calculator
 *
 * Computes gross, net, long, short exposure and concentration metrics
 * (per symbol, sector, strategy, underlying) for pre-trade risk evaluation.
 *
 * All monetary values in INR.
 */

import type { Position } from "../backtesting-v2/models/position";
import { SECTOR_STOCKS } from "../india/sectors";

// ── Sector lookup (symbol → sector) ─────────────────────────────────────────

/** Reverse map: symbol → sector name, built once from SECTOR_STOCKS. */
const _symbolToSector = new Map<string, string>();
for (const [sector, symbols] of Object.entries(SECTOR_STOCKS)) {
  for (const sym of symbols) {
    // A symbol may appear in multiple sectors; first-wins for primary sector.
    if (!_symbolToSector.has(sym)) {
      _symbolToSector.set(sym, sector);
    }
  }
}

export function getSector(symbol: string): string {
  return _symbolToSector.get(symbol) ?? "UNKNOWN";
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface ExposureSnapshot {
  /** Sum of all long notionals (INR). */
  longExposure: number;
  /** Sum of all short notionals (INR, positive number). */
  shortExposure: number;
  /** longExposure + shortExposure */
  grossExposure: number;
  /** longExposure − shortExposure */
  netExposure: number;

  /** Per-symbol total notional (direction-signed). */
  symbolExposure: Map<string, number>;
  /** Per-sector net notional (direction-signed). */
  sectorExposure: Map<string, number>;
  /** Per-strategy net notional (direction-signed). */
  strategyExposure: Map<string, number>;
  /** Per-underlying gross notional (absolute, merges cash + F&O on same name). */
  underlyingExposure: Map<string, number>;
}

export interface ConcentrationCheck {
  breached: boolean;
  reason?: string;
  /** Fraction that would breach (0..1), or current fraction if no new trade. */
  fraction: number;
  limit: number;
}

export interface ExposureLimits {
  /** Max gross exposure as multiple of equity. Default 2.0 */
  maxGrossExposureMultiple: number;
  /** Max single-symbol notional as fraction of equity. Default 0.25 */
  maxSymbolFraction: number;
  /** Max single-sector net notional as fraction of equity. Default 0.40 */
  maxSectorFraction: number;
  /** Max single-strategy net notional as fraction of equity. Default 0.50 */
  maxStrategyFraction: number;
  /** Max single-underlying gross notional as fraction of equity. Default 0.30 */
  maxUnderlyingFraction: number;
  /**
   * Max number of long positions in a strongly correlated cluster (e.g. PSU Banks).
   * Prevents piling into highly co-moving names in the same sector.
   * Default 3
   */
  maxCorrelatedLongs: number;
}

export const DEFAULT_EXPOSURE_LIMITS: ExposureLimits = {
  maxGrossExposureMultiple: 2.0,
  maxSymbolFraction: 0.25,
  maxSectorFraction: 0.40,
  maxStrategyFraction: 0.50,
  maxUnderlyingFraction: 0.30,
  maxCorrelatedLongs: 3,
};

// ── Core exposure calculator ─────────────────────────────────────────────────

/**
 * Derive the "underlying" ticker from an NSE/NFO symbol.
 * e.g. "HDFCBANK28MAY25FUT" → "HDFCBANK", "NIFTY" → "NIFTY"
 */
export function resolveUnderlying(symbol: string): string {
  // F&O symbols follow the pattern: UNDERLYING + DDMMMYY + [FUT|CE|PE|XXXCE|XXXPE]
  // Simplistic: strip trailing date/type suffix (7+ chars starting with digit)
  const match = symbol.match(/^([A-Z&-]+)(\d{2}[A-Z]{3}\d{2}|[A-Z]*\d)/);
  return match ? match[1] : symbol;
}

/**
 * Calculate a full exposure snapshot from the set of open positions.
 */
export function calcExposureSnapshot(positions: Position[]): ExposureSnapshot {
  let longExposure = 0;
  let shortExposure = 0;
  const symbolExposure = new Map<string, number>();
  const sectorExposure = new Map<string, number>();
  const strategyExposure = new Map<string, number>();
  const underlyingExposure = new Map<string, number>();

  for (const pos of positions) {
    if (pos.status !== "OPEN") continue;

    const notional = pos.qty * pos.avgEntryPrice * pos.instrument.lotSize;
    const sign = pos.direction === "LONG" ? 1 : -1;
    const signedNotional = sign * notional;

    // Long / short split
    if (pos.direction === "LONG") {
      longExposure += notional;
    } else {
      shortExposure += notional;
    }

    // Per-symbol (direction-signed)
    const sym = pos.instrument.symbol;
    symbolExposure.set(sym, (symbolExposure.get(sym) ?? 0) + signedNotional);

    // Per-sector (direction-signed)
    const sector = getSector(sym);
    sectorExposure.set(sector, (sectorExposure.get(sector) ?? 0) + signedNotional);

    // Per-strategy (direction-signed)
    const strat = pos.attribution.strategyId;
    strategyExposure.set(strat, (strategyExposure.get(strat) ?? 0) + signedNotional);

    // Per-underlying (gross — absolute, merges cash + derivative legs)
    const underlying = resolveUnderlying(sym);
    underlyingExposure.set(
      underlying,
      (underlyingExposure.get(underlying) ?? 0) + notional,
    );
  }

  return {
    longExposure,
    shortExposure,
    grossExposure: longExposure + shortExposure,
    netExposure: longExposure - shortExposure,
    symbolExposure,
    sectorExposure,
    strategyExposure,
    underlyingExposure,
  };
}

// ── Pre-trade concentration checks ──────────────────────────────────────────

export interface ProposedTrade {
  symbol: string;
  strategyId: string;
  direction: "LONG" | "SHORT";
  /** Proposed notional (INR) of the new trade. */
  notional: number;
}

/**
 * Check whether opening a new trade breaches any concentration limit.
 * Returns the first breach encountered (checks in priority order).
 */
export function checkConcentration(
  current: ExposureSnapshot,
  proposed: ProposedTrade,
  equity: number,
  limits: ExposureLimits = DEFAULT_EXPOSURE_LIMITS,
): ConcentrationCheck {
  const { symbol, strategyId, direction, notional } = proposed;
  const sign = direction === "LONG" ? 1 : -1;

  // 1. Gross exposure
  const newGross = current.grossExposure + notional;
  const grossLimit = equity * limits.maxGrossExposureMultiple;
  if (newGross > grossLimit) {
    return {
      breached: true,
      reason: `Gross exposure ₹${newGross.toFixed(0)} would exceed ${limits.maxGrossExposureMultiple}× equity (₹${grossLimit.toFixed(0)})`,
      fraction: newGross / equity,
      limit: limits.maxGrossExposureMultiple,
    };
  }

  // 2. Symbol concentration
  const currentSymbolExp = Math.abs(current.symbolExposure.get(symbol) ?? 0);
  const newSymbolExp = currentSymbolExp + notional;
  const symbolLimit = equity * limits.maxSymbolFraction;
  if (newSymbolExp > symbolLimit) {
    return {
      breached: true,
      reason: `Symbol ${symbol} exposure ₹${newSymbolExp.toFixed(0)} would exceed ${(limits.maxSymbolFraction * 100).toFixed(0)}% of equity`,
      fraction: newSymbolExp / equity,
      limit: limits.maxSymbolFraction,
    };
  }

  // 3. Underlying concentration (merges cash + F&O)
  const underlying = resolveUnderlying(symbol);
  const currentUnderlyingExp = current.underlyingExposure.get(underlying) ?? 0;
  const newUnderlyingExp = currentUnderlyingExp + notional;
  const underlyingLimit = equity * limits.maxUnderlyingFraction;
  if (newUnderlyingExp > underlyingLimit) {
    return {
      breached: true,
      reason: `Underlying ${underlying} gross exposure ₹${newUnderlyingExp.toFixed(0)} would exceed ${(limits.maxUnderlyingFraction * 100).toFixed(0)}% of equity`,
      fraction: newUnderlyingExp / equity,
      limit: limits.maxUnderlyingFraction,
    };
  }

  // 4. Sector concentration
  const sector = getSector(symbol);
  const currentSectorExp = current.sectorExposure.get(sector) ?? 0;
  const newSectorExp = currentSectorExp + sign * notional;
  const sectorLimit = equity * limits.maxSectorFraction;
  if (Math.abs(newSectorExp) > sectorLimit) {
    return {
      breached: true,
      reason: `Sector ${sector} net exposure ₹${Math.abs(newSectorExp).toFixed(0)} would exceed ${(limits.maxSectorFraction * 100).toFixed(0)}% of equity`,
      fraction: Math.abs(newSectorExp) / equity,
      limit: limits.maxSectorFraction,
    };
  }

  // 5. Strategy concentration
  const currentStratExp = current.strategyExposure.get(strategyId) ?? 0;
  const newStratExp = currentStratExp + sign * notional;
  const stratLimit = equity * limits.maxStrategyFraction;
  if (Math.abs(newStratExp) > stratLimit) {
    return {
      breached: true,
      reason: `Strategy ${strategyId} net exposure ₹${Math.abs(newStratExp).toFixed(0)} would exceed ${(limits.maxStrategyFraction * 100).toFixed(0)}% of equity`,
      fraction: Math.abs(newStratExp) / equity,
      limit: limits.maxStrategyFraction,
    };
  }

  return {
    breached: false,
    fraction: newGross / equity,
    limit: limits.maxGrossExposureMultiple,
  };
}

// ── Correlated-long cluster check ────────────────────────────────────────────

/**
 * Count how many open LONG positions belong to the same sector as `symbol`.
 * Used to prevent accumulating too many highly-correlated longs
 * (e.g. HDFCBANK + ICICIBANK + SBIN all long simultaneously in the Bank sector).
 */
export function countSectorLongs(
  positions: Position[],
  sector: string,
): number {
  return positions.filter(
    (p) =>
      p.status === "OPEN" &&
      p.direction === "LONG" &&
      getSector(p.instrument.symbol) === sector,
  ).length;
}

/**
 * Returns true if adding a new LONG in `symbol` would exceed the correlated-long limit.
 */
export function checkCorrelatedLongCluster(
  positions: Position[],
  symbol: string,
  limits: ExposureLimits = DEFAULT_EXPOSURE_LIMITS,
): ConcentrationCheck {
  const sector = getSector(symbol);
  if (sector === "UNKNOWN") {
    return { breached: false, fraction: 0, limit: limits.maxCorrelatedLongs };
  }

  const current = countSectorLongs(positions, sector);
  if (current >= limits.maxCorrelatedLongs) {
    return {
      breached: true,
      reason: `Already have ${current} long positions in sector ${sector} — correlated-long limit is ${limits.maxCorrelatedLongs}`,
      fraction: current,
      limit: limits.maxCorrelatedLongs,
    };
  }

  return {
    breached: false,
    fraction: current,
    limit: limits.maxCorrelatedLongs,
  };
}

// ── Exposure as fractions of equity ─────────────────────────────────────────

export interface ExposureFractions {
  grossFraction: number;
  netFraction: number;
  longFraction: number;
  shortFraction: number;
}

export function toExposureFractions(
  snap: ExposureSnapshot,
  equity: number,
): ExposureFractions {
  if (equity <= 0) {
    return { grossFraction: 0, netFraction: 0, longFraction: 0, shortFraction: 0 };
  }
  return {
    grossFraction: snap.grossExposure / equity,
    netFraction: snap.netExposure / equity,
    longFraction: snap.longExposure / equity,
    shortFraction: snap.shortExposure / equity,
  };
}
