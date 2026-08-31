/**
 * Portfolio model — the single authoritative state of the simulated account.
 *
 * Tracks all accounting dimensions required for institutional-grade reporting:
 *   • Cash, equity, margin
 *   • Realised + unrealised P&L
 *   • Gross / net / sector exposure
 *   • Daily P&L for risk limits
 *   • Peak equity for drawdown calculation
 *
 * The Portfolio is mutated exclusively by:
 *   1. `applyFill()`    — on every FillEvent
 *   2. `markToMarket()` — on every MARKET_EVENT for open positions
 *   3. `onSessionOpen()`/ `onSessionClose()` — session bookkeeping
 *
 * All values in INR.
 */

import type { FillEvent } from "../events/fill-event";
import type { InstrumentId } from "../events/market-event";
import type { Position, PositionAttribution, CloseReason } from "./position";
import { openPosition, markPosition, closePosition, checkIntraBar } from "./position";
import { buildTrade } from "./trade";
import type { Trade } from "./trade";
import { makePositionId } from "./position";
import type { RiskSnapshot } from "../events/risk-event";

// ── Configuration ─────────────────────────────────────────────────────────────

export interface PortfolioConfig {
  /** Starting cash in INR. */
  initialCapital: number;
  /** Margin factor for F&O (e.g. 0.15 = 15% SPAN margin). */
  marginFactor: number;
  /** Maximum number of simultaneously open positions. */
  maxOpenPositions: number;
  /** Maximum gross exposure as a fraction of equity (e.g. 2.0 = 200%). */
  maxGrossExposure: number;
  /** Maximum single-symbol exposure as a fraction of equity. */
  maxSymbolExposure: number;
  /** Maximum sector exposure as a fraction of equity. */
  maxSectorExposure: number;
  /** Daily loss limit as a fraction of initial capital (e.g. 0.02 = 2%). */
  dailyLossLimitFraction: number;
}

export const DEFAULT_PORTFOLIO_CONFIG: PortfolioConfig = {
  initialCapital: 1_000_000,  // ₹10 lakh
  marginFactor: 0.15,
  maxOpenPositions: 10,
  maxGrossExposure: 2.0,
  maxSymbolExposure: 0.25,
  maxSectorExposure: 0.40,
  dailyLossLimitFraction: 0.02,
};

// ── Exposure snapshot ─────────────────────────────────────────────────────────

export interface ExposureBreakdown {
  /** Total long notional (INR). */
  longExposure: number;
  /** Total short notional (INR, positive number). */
  shortExposure: number;
  /** longExposure + shortExposure */
  grossExposure: number;
  /** longExposure − shortExposure */
  netExposure: number;
  /** Per-symbol long notional. */
  symbolExposure: Map<string, number>;
  /** Per-sector net notional. */
  sectorExposure: Map<string, number>;
}

// ── Equity curve point ────────────────────────────────────────────────────────

export interface EquityCurvePoint {
  timestampMs: number;
  barIndex: number;
  equity: number;
  cash: number;
  unrealisedPnl: number;
  realisedPnl: number;
  openPositions: number;
  dailyPnl: number;
}

// ── Portfolio class ───────────────────────────────────────────────────────────

export class Portfolio {
  readonly config: PortfolioConfig;

  // ── Core accounting ──
  cash: number;
  /** Locked margin for all open positions (INR). */
  marginUsed: number;

  /** Cumulative realised P&L since inception. */
  totalRealisedPnl: number;
  /** Sum of all commissions paid. */
  totalCommission: number;
  /** Unrealised P&L across all open positions. */
  totalUnrealisedPnl: number;

  // ── Session accounting ──
  /** Session-start equity (reset on session open). */
  sessionStartEquity: number;
  /** Today's realised P&L (reset on session open). */
  dailyPnl: number;

  // ── Drawdown tracking ──
  peakEquity: number;
  maxDrawdown: number;  // 0..1

  // ── Positions & trades ──
  private readonly _openPositions = new Map<string, Position>();
  private readonly _closedTrades: Trade[] = [];

  // ── Equity curve ──
  private readonly _equityCurve: EquityCurvePoint[] = [];

  constructor(config: Partial<PortfolioConfig> = {}) {
    this.config = { ...DEFAULT_PORTFOLIO_CONFIG, ...config };
    this.cash = this.config.initialCapital;
    this.marginUsed = 0;
    this.totalRealisedPnl = 0;
    this.totalCommission = 0;
    this.totalUnrealisedPnl = 0;
    this.sessionStartEquity = this.config.initialCapital;
    this.dailyPnl = 0;
    this.peakEquity = this.config.initialCapital;
    this.maxDrawdown = 0;
  }

  // ── Derived metrics ──────────────────────────────────────────────────────

  /** Total portfolio equity = cash + unrealised. */
  get equity(): number {
    return this.cash + this.totalUnrealisedPnl;
  }

  get marginAvailable(): number {
    return Math.max(0, this.cash - this.marginUsed);
  }

  get openPositionCount(): number {
    return this._openPositions.size;
  }

  get marginUtilisation(): number {
    return this.cash > 0 ? this.marginUsed / this.cash : 0;
  }

  get currentDrawdown(): number {
    const eq = this.equity;
    if (this.peakEquity <= 0) return 0;
    return Math.max(0, (this.peakEquity - eq) / this.peakEquity);
  }

  // ── Position access ───────────────────────────────────────────────────────

  openPositions(): Position[] {
    return Array.from(this._openPositions.values());
  }

  getPosition(positionId: string): Position | undefined {
    return this._openPositions.get(positionId);
  }

  positionForSymbol(symbol: string): Position | undefined {
    for (const pos of this._openPositions.values()) {
      if (pos.instrument.symbol === symbol) return pos;
    }
    return undefined;
  }

  closedTrades(): Trade[] {
    return this._closedTrades;
  }

  equityCurve(): EquityCurvePoint[] {
    return this._equityCurve;
  }

  // ── Session hooks ─────────────────────────────────────────────────────────

  onSessionOpen(timestampMs: number): void {
    this.sessionStartEquity = this.equity;
    this.dailyPnl = 0;
  }

  onSessionClose(_timestampMs: number): void {
    // Daily P&L is already up to date — nothing extra needed here.
    // Callers may force-close positions before calling this.
  }

  // ── Core mutation: open a position ───────────────────────────────────────

  openPositionFromFill(
    fill: FillEvent,
    opts: {
      stopLoss: number;
      target: number;
      attribution: PositionAttribution;
      sectorHint?: string;
    },
  ): Position {
    const notional = fill.qty * fill.fillPrice * fill.instrument.lotSize;
    const marginReserved = notional * this.config.marginFactor;

    const pos = openPosition(fill, {
      stopLoss: opts.stopLoss,
      target: opts.target,
      marginReserved,
      attribution: opts.attribution,
    });

    // Deduct margin from cash
    this.cash -= marginReserved;
    this.marginUsed += marginReserved;
    this.totalCommission += fill.commission;

    // Commission is paid from cash
    this.cash -= fill.commission;

    this._openPositions.set(pos.id, pos);
    return pos;
  }

  // ── Core mutation: close a position ──────────────────────────────────────

  closePositionFromFill(
    positionId: string,
    fill: FillEvent,
    reason: CloseReason,
    opts: { entryAtr?: number | null; mae?: number | null; mfe?: number | null } = {},
  ): Trade {
    const pos = this._openPositions.get(positionId);
    if (!pos) throw new Error(`Position ${positionId} not found`);

    closePosition(pos, fill, reason);

    // Release margin
    this.cash += pos.marginReserved;
    this.marginUsed -= pos.marginReserved;

    // Book realised P&L and commission
    this.totalRealisedPnl += pos.realisedPnl;
    this.totalCommission += fill.commission;
    this.dailyPnl += pos.realisedPnl;
    this.cash -= fill.commission;
    this.cash += pos.realisedPnl;

    // Remove from open set
    this._openPositions.delete(positionId);

    // Update drawdown
    const eq = this.equity;
    if (eq > this.peakEquity) this.peakEquity = eq;
    const dd = this.currentDrawdown;
    if (dd > this.maxDrawdown) this.maxDrawdown = dd;

    // Build and store trade record
    const trade = buildTrade(pos, opts);
    this._closedTrades.push(trade);
    return trade;
  }

  // ── Core mutation: mark all open positions to market ─────────────────────

  markToMarket(prices: Map<string, number>): void {
    let totalUnrealised = 0;
    for (const pos of this._openPositions.values()) {
      const price = prices.get(pos.instrument.symbol);
      if (price !== undefined) {
        markPosition(pos, price);
      }
      totalUnrealised += pos.unrealisedPnl;
    }
    this.totalUnrealisedPnl = totalUnrealised;

    // Update peak and drawdown
    const eq = this.equity;
    if (eq > this.peakEquity) this.peakEquity = eq;
    const dd = this.currentDrawdown;
    if (dd > this.maxDrawdown) this.maxDrawdown = dd;
  }

  // ── Equity curve snapshot ─────────────────────────────────────────────────

  snapshotEquity(timestampMs: number, barIndex: number): void {
    this._equityCurve.push({
      timestampMs,
      barIndex,
      equity: this.equity,
      cash: this.cash,
      unrealisedPnl: this.totalUnrealisedPnl,
      realisedPnl: this.totalRealisedPnl,
      openPositions: this.openPositionCount,
      dailyPnl: this.dailyPnl,
    });
  }

  // ── Exposure calculation ──────────────────────────────────────────────────

  calcExposure(sectorMap?: Map<string, string>): ExposureBreakdown {
    let longExposure = 0;
    let shortExposure = 0;
    const symbolExposure = new Map<string, number>();
    const sectorExposure = new Map<string, number>();

    for (const pos of this._openPositions.values()) {
      const notional = pos.qty * pos.avgEntryPrice * pos.instrument.lotSize;
      if (pos.direction === "LONG") {
        longExposure += notional;
      } else {
        shortExposure += notional;
      }

      const sym = pos.instrument.symbol;
      symbolExposure.set(sym, (symbolExposure.get(sym) ?? 0) + notional);

      if (sectorMap) {
        const sector = sectorMap.get(sym) ?? "UNKNOWN";
        const dirMult = pos.direction === "LONG" ? 1 : -1;
        sectorExposure.set(
          sector,
          (sectorExposure.get(sector) ?? 0) + dirMult * notional,
        );
      }
    }

    return {
      longExposure,
      shortExposure,
      grossExposure: longExposure + shortExposure,
      netExposure: longExposure - shortExposure,
      symbolExposure,
      sectorExposure,
    };
  }

  // ── Risk snapshot (for RiskCheckEvent) ───────────────────────────────────

  riskSnapshot(): RiskSnapshot {
    return {
      equity: this.equity,
      availableCash: this.marginAvailable,
      marginUsed: this.marginUsed,
      openPositions: this.openPositionCount,
      currentDrawdown: this.currentDrawdown,
      dailyPnl: this.dailyPnl,
      marginUtilisation: this.marginUtilisation,
    };
  }

  // ── Capital exhaustion check ──────────────────────────────────────────────

  canAfford(notional: number): boolean {
    const required = notional * this.config.marginFactor;
    return this.marginAvailable >= required;
  }

  isDailyLossLimitHit(): boolean {
    const limit = this.config.initialCapital * this.config.dailyLossLimitFraction;
    return this.dailyPnl < -limit;
  }

  isMaxDrawdownHit(threshold: number): boolean {
    return this.currentDrawdown >= threshold;
  }
}
