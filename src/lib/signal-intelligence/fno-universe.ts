/**
 * FNO Universe Service — Phase 3 & 4
 *
 * Canonical Indian F&O universe management and coverage monitoring.
 *
 * This is the single source of truth for:
 *   - Which instruments are in the F&O universe
 *   - Which category each instrument belongs to
 *   - Universe coverage per market session
 *
 * Design rules:
 *   1. Universe is derived from authoritative sources, not hardcoded.
 *   2. Every market session must report UniverseCoverageScore.
 *   3. A signal report is INVALID if universe coverage is unknown.
 *   4. Instruments must be trackable across their lifecycle.
 */

import { FNO_INDICES, FNO_STOCKS, FNO_INDEX_UNDERLYINGS } from "@/lib/india/fno-symbols";
import { SECTOR_STOCKS } from "@/lib/india/sectors";
import type { UniverseCoverageSnapshot } from "./types";

// ─── F&O Instrument Categories ────────────────────────────────────────────────

export type FNOInstrumentCategory =
  | "NIFTY"
  | "BANKNIFTY"
  | "FINNIFTY"
  | "MIDCPNIFTY"
  | "SENSEX"
  | "INDEX_FUTURE"
  | "STOCK_FUTURE"
  | "INDEX_OPTION"
  | "STOCK_OPTION"
  | "FNO_STOCK";

// ─── F&O Universe Instrument ──────────────────────────────────────────────────

export interface FNOUniverseInstrument {
  /** NSE trading symbol (no .NS suffix for equities; NSE token for derivatives) */
  symbol: string;
  /** Exchange */
  exchange: "NSE" | "NFO" | "BSE";
  /** Instrument segment */
  segment: "EQ" | "FO" | "IDX";
  /** Instrument category */
  category: FNOInstrumentCategory;
  /** Underlying symbol (for derivatives, same as symbol for equities/indices) */
  underlying: string;
  /** Yahoo Finance ticker for live price (null for pure derivatives) */
  yahooTicker: string | null;
  /** Whether this instrument is currently tradable */
  tradable: boolean;
  /** Whether this instrument has sufficient liquidity for trading */
  liquid: boolean;
  /** Whether this instrument is currently active in the universe */
  active: boolean;
  /** Whether this is a NIFTY/BANKNIFTY/FINNIFTY/MIDCPNIFTY index */
  index: boolean;
  /** Whether this is an index (vs stock) */
  isIndexUnderlying: boolean;
  /** NSE sector (from SECTOR_STOCKS) */
  sector: string | null;
  /** Lot size for F&O contracts */
  lotSize: number | null;
  /** Tick size in INR */
  tickSize: number;
}

// ─── Minimum liquidity / inclusion criteria ───────────────────────────────────

/**
 * Minimum requirements for a stock to be included in the active F&O universe.
 * These are conservative defaults; actual NSE eligibility criteria apply.
 */
const MIN_LIQUID_STOCK_REQUIREMENTS = {
  /** Minimum average daily traded value in INR crores */
  minAdtvCr: 100,
} as const;

// ─── Universe Builder ─────────────────────────────────────────────────────────

function buildUniverseInstruments(): FNOUniverseInstrument[] {
  const instruments: FNOUniverseInstrument[] = [];

  // ── F&O Indices ─────────────────────────────────────────────────────────
  for (const idx of FNO_INDICES) {
    let category: FNOInstrumentCategory;
    if (idx.underlying === "NIFTY") category = "NIFTY";
    else if (idx.underlying === "BANKNIFTY") category = "BANKNIFTY";
    else if (idx.underlying === "FINNIFTY") category = "FINNIFTY";
    else if (idx.underlying === "MIDCPNIFTY") category = "MIDCPNIFTY";
    else category = "NIFTY"; // fallback

    instruments.push({
      symbol: idx.underlying,
      exchange: "NSE",
      segment: "IDX",
      category,
      underlying: idx.underlying,
      yahooTicker: idx.symbol,
      tradable: false, // indices are not directly tradable — futures/options are
      liquid: true,
      active: true,
      index: true,
      isIndexUnderlying: true,
      sector: null,
      lotSize: null,
      tickSize: 0.05,
    });
  }

  // ── F&O Stocks ──────────────────────────────────────────────────────────
  // Build sector lookup
  const symbolToSectors: Record<string, string[]> = {};
  for (const [sector, symbols] of Object.entries(SECTOR_STOCKS)) {
    for (const sym of symbols) {
      (symbolToSectors[sym] ??= []).push(sector);
    }
  }

  for (const sym of FNO_STOCKS) {
    const sectors = symbolToSectors[sym] ?? [];
    instruments.push({
      symbol: sym,
      exchange: "NSE",
      segment: "EQ",
      category: "FNO_STOCK",
      underlying: sym,
      yahooTicker: `${sym}.NS`,
      tradable: true,
      liquid: true, // assume liquid unless overridden by live data
      active: true,
      index: false,
      isIndexUnderlying: false,
      sector: sectors[0] ?? null,
      lotSize: null, // populated by live instrument master when available
      tickSize: 0.05,
    });
  }

  return instruments;
}

// ─── Canonical Universe ───────────────────────────────────────────────────────

/**
 * Build the canonical F&O universe snapshot.
 * This is the reference list against which coverage is measured.
 *
 * In production, this should be augmented with live instrument master data
 * from the exchange provider. The static list here covers the known F&O
 * eligible stocks derived from NSE's F&O segment.
 */
function buildCanonicalUniverse(): FNOUniverse {
  const instruments = buildUniverseInstruments();
  const byCategory = new Map<FNOInstrumentCategory, FNOUniverseInstrument[]>();
  for (const inst of instruments) {
    if (!byCategory.has(inst.category)) byCategory.set(inst.category, []);
    byCategory.get(inst.category)!.push(inst);
  }

  return {
    instruments,
    byCategory,
    bySymbol: new Map(instruments.map((i) => [i.symbol, i])),
    totalCount: instruments.length,
    activeCount: instruments.filter((i) => i.active).length,
    indexCount: instruments.filter((i) => i.isIndexUnderlying).length,
    stockCount: instruments.filter((i) => !i.isIndexUnderlying && i.category === "FNO_STOCK").length,
    builtAt: Date.now(),
  };
}

export interface FNOUniverse {
  instruments: FNOUniverseInstrument[];
  byCategory: Map<FNOInstrumentCategory, FNOUniverseInstrument[]>;
  bySymbol: Map<string, FNOUniverseInstrument>;
  totalCount: number;
  activeCount: number;
  indexCount: number;
  stockCount: number;
  builtAt: number;
}

// ─── FNO Universe Service ─────────────────────────────────────────────────────

class FNOUniverseServiceImpl {
  private universe: FNOUniverse;
  private readonly REBUILD_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

  constructor() {
    this.universe = buildCanonicalUniverse();
  }

  /**
   * Get the full F&O universe. Rebuilds if stale (> 1 hour old).
   */
  getUniverse(): FNOUniverse {
    if (Date.now() - this.universe.builtAt > this.REBUILD_INTERVAL_MS) {
      this.universe = buildCanonicalUniverse();
    }
    return this.universe;
  }

  /**
   * Get all instruments in a specific category.
   */
  getByCategory(category: FNOInstrumentCategory): FNOUniverseInstrument[] {
    return this.getUniverse().byCategory.get(category) ?? [];
  }

  /**
   * Get instrument metadata by symbol.
   */
  getInstrument(symbol: string): FNOUniverseInstrument | null {
    return this.getUniverse().bySymbol.get(symbol) ?? null;
  }

  /**
   * Get all F&O stock symbols (no index underlyings).
   */
  getFNOStockSymbols(): string[] {
    return this.getByCategory("FNO_STOCK").map((i) => i.symbol);
  }

  /**
   * Get all F&O index underlyings.
   */
  getIndexUnderlyings(): string[] {
    return this.getUniverse()
      .instruments.filter((i) => i.isIndexUnderlying)
      .map((i) => i.symbol);
  }

  /**
   * Total expected instruments in the universe (indices + stocks).
   */
  getTotalExpected(): number {
    return this.getUniverse().activeCount;
  }

  /**
   * Determine the category of a symbol.
   */
  getCategoryForSymbol(symbol: string): FNOInstrumentCategory | null {
    return this.getInstrument(symbol)?.category ?? null;
  }

  /**
   * Check if a symbol is part of the F&O universe.
   */
  isInUniverse(symbol: string): boolean {
    return this.getUniverse().bySymbol.has(symbol);
  }

  /**
   * Get all sectors and their F&O constituent symbols.
   */
  getSectorMap(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const inst of this.getByCategory("FNO_STOCK")) {
      if (inst.sector) {
        (out[inst.sector] ??= []).push(inst.symbol);
      }
    }
    return out;
  }

  /**
   * Universe summary for health reporting.
   */
  getSummary(): {
    total: number;
    indices: number;
    stocks: number;
    byCategory: Record<string, number>;
    builtAt: number;
  } {
    const u = this.getUniverse();
    const byCategory: Record<string, number> = {};
    for (const [cat, insts] of u.byCategory.entries()) {
      byCategory[cat] = insts.length;
    }
    return {
      total: u.activeCount,
      indices: u.indexCount,
      stocks: u.stockCount,
      byCategory,
      builtAt: u.builtAt,
    };
  }
}

/** Singleton F&O universe service */
export const FNOUniverseService = new FNOUniverseServiceImpl();

// ─── Universe Coverage Score ──────────────────────────────────────────────────

/**
 * Minimum coverage score below which a signal session report is invalid.
 * If less than 80% of expected instruments were scanned, the session data
 * is unreliable.
 */
export const MIN_VALID_COVERAGE = 0.8;

/**
 * Build a UniverseCoverageSnapshot for a given market session.
 *
 * @param sessionDate - IST date YYYY-MM-DD
 * @param scannedSymbols - symbols that were actually fetched and evaluated
 * @param dataAvailableSymbols - symbols for which data was available (but maybe not all fields)
 * @param dataCompleteSymbols - symbols with all required data fields
 * @param strategyEvaluatedSymbols - symbols evaluated by at least one strategy
 * @param paperEligibleSymbols - symbols that passed risk/quality gate
 * @param exclusions - per-symbol exclusion reasons
 */
export function buildUniverseCoverageSnapshot(
  sessionDate: string,
  scannedSymbols: string[],
  dataAvailableSymbols: string[],
  dataCompleteSymbols: string[],
  strategyEvaluatedSymbols: string[],
  paperEligibleSymbols: string[],
  exclusions: Array<{ instrument: string; reason: string }>,
): UniverseCoverageSnapshot {
  const universe = FNOUniverseService.getUniverse();
  const expected = universe.activeCount;

  const scanned = scannedSymbols.length;
  const available = dataAvailableSymbols.length;
  const complete = dataCompleteSymbols.length;
  const partial = available - complete;
  const missing = Math.max(0, expected - available);
  const evaluated = strategyEvaluatedSymbols.length;
  const paperEligible = paperEligibleSymbols.length;
  const excluded = exclusions.length;

  const coverageScore = expected > 0 ? evaluated / expected : 0;
  const isValid = coverageScore >= MIN_VALID_COVERAGE;

  return {
    sessionDate,
    capturedAtMs: Date.now(),
    expectedInstruments: expected,
    availableInstruments: available,
    scannedInstruments: scanned,
    dataCompleteInstruments: complete,
    dataPartialInstruments: Math.max(0, partial),
    dataMissingInstruments: missing,
    strategyEvaluatedInstruments: evaluated,
    paperEligibleInstruments: paperEligible,
    excludedInstruments: excluded,
    exclusionReasons: exclusions,
    coverageScore,
    isValid,
    minValidCoverage: MIN_VALID_COVERAGE,
  };
}

/**
 * Quick coverage summary string for logging.
 * Example: "Coverage: 498/506 (98.4%) — VALID"
 */
export function formatCoverageSummary(snap: UniverseCoverageSnapshot): string {
  const pct = (snap.coverageScore * 100).toFixed(1);
  const validity = snap.isValid ? "VALID" : "INVALID";
  return (
    `Coverage: ${snap.strategyEvaluatedInstruments}/${snap.expectedInstruments} ` +
    `(${pct}%) — ${validity} | ` +
    `data-complete=${snap.dataCompleteInstruments} ` +
    `partial=${snap.dataPartialInstruments} ` +
    `missing=${snap.dataMissingInstruments}`
  );
}

/**
 * Build a minimal snapshot for when coverage data is unavailable.
 * This explicitly marks the report as invalid.
 */
export function buildUnavailableCoverageSnapshot(
  sessionDate: string,
  reason: string,
): UniverseCoverageSnapshot {
  const expected = FNOUniverseService.getTotalExpected();
  return {
    sessionDate,
    capturedAtMs: Date.now(),
    expectedInstruments: expected,
    availableInstruments: 0,
    scannedInstruments: 0,
    dataCompleteInstruments: 0,
    dataPartialInstruments: 0,
    dataMissingInstruments: expected,
    strategyEvaluatedInstruments: 0,
    paperEligibleInstruments: 0,
    excludedInstruments: expected,
    exclusionReasons: [{ instrument: "ALL", reason }],
    coverageScore: 0,
    isValid: false,
    minValidCoverage: MIN_VALID_COVERAGE,
  };
}
