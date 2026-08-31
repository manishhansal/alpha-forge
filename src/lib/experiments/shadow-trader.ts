/**
 * shadow-trader.ts — Shadow Trading Engine
 *
 * Runs a strategy against real-time (or replayed) market data and
 * simulates the full execution lifecycle — signal → fill → position → P&L —
 * without ever touching a real or paper portfolio.
 *
 * Guarantees
 * ──────────
 * • NO real orders are generated (isReal is always false on every fill)
 * • NO paper portfolio is mutated
 * • Every action is recorded in an immutable append-only audit log
 * • Signals always carry full version provenance (strategyVersion,
 *   modelVersion, featureVersion, experimentId)
 *
 * Architecture
 * ────────────
 * ShadowTrader maintains its own isolated shadow portfolio (ShadowPortfolio)
 * that is completely separate from any production or paper portfolio.
 * It uses the same P&L arithmetic as the real Portfolio model so numbers
 * are directly comparable.
 *
 * Comparison targets
 * ──────────────────
 * Performance can be benchmarked against:
 *   1. Production strategy  — passed in as a benchmark equity curve
 *   2. Paper trading        — passed in via updateBenchmark()
 *   3. Index / buy-hold     — computed from market ticks
 */

import type { MarketTick, ExperimentSignal, SimulatedFill } from "./experiment-manager";
import type { VersionStamp } from "./strategy-version";

// ── Shadow position ────────────────────────────────────────────────────────────

export type PositionStatus = "OPEN" | "CLOSED";
export type CloseReason =
  | "TARGET_HIT"
  | "STOP_HIT"
  | "MANUAL_CLOSE"
  | "SESSION_END"
  | "EXPERIMENT_STOP"
  | "SUPERSEDED";

export interface ShadowPosition {
  readonly id: string;
  readonly experimentId: string;
  readonly armId: string;
  readonly versionStamp: VersionStamp;
  readonly symbol: string;
  readonly direction: "LONG" | "SHORT";
  /** Simulated entry price after slippage. */
  readonly entryPrice: number;
  readonly stopLoss: number;
  readonly target: number;
  readonly qty: number;
  readonly lotSize: number;
  /** Simulated commission at entry (INR). */
  readonly entryCommission: number;
  /** UTC ms when the position was opened. */
  readonly openedAtMs: number;
  /** Bar index at open. */
  readonly openBarIndex: number;
  /** Signal that caused this position to open. */
  readonly signalId: string;
  status: PositionStatus;
  /** Running unrealised P&L (INR). Updated on each tick. */
  unrealisedPnl: number;
  /** Locked in on close. */
  realisedPnl: number | null;
  /** UTC ms when the position was closed. */
  closedAtMs: number | null;
  closeBarIndex: number | null;
  closeReason: CloseReason | null;
  /** Exit price after slippage. */
  exitPrice: number | null;
}

// ── Closed shadow trade (immutable record) ─────────────────────────────────────

export interface ShadowTrade {
  readonly id: string;
  readonly positionId: string;
  readonly experimentId: string;
  readonly armId: string;
  readonly versionStamp: VersionStamp;
  readonly symbol: string;
  readonly direction: "LONG" | "SHORT";
  readonly entryPrice: number;
  readonly exitPrice: number;
  readonly qty: number;
  readonly lotSize: number;
  readonly grossPnl: number;
  readonly commission: number;
  readonly netPnl: number;
  /** Net P&L as fraction of entry notional. */
  readonly pnlPct: number;
  readonly openedAtMs: number;
  readonly closedAtMs: number;
  readonly barsHeld: number;
  readonly closeReason: CloseReason;
  readonly stopLoss: number;
  readonly target: number;
  readonly plannedRR: number;
  readonly actualRR: number;
}

// ── Shadow portfolio state ─────────────────────────────────────────────────────

export interface ShadowPortfolioState {
  /** Starting capital (notional, INR). */
  initialCapital: number;
  /** Cash remaining. */
  cash: number;
  /** Sum of unrealised P&L across all open positions. */
  unrealisedPnl: number;
  /** Cumulative realised P&L. */
  realisedPnl: number;
  /** Total commission paid. */
  totalCommission: number;
  /** Peak equity for drawdown tracking. */
  peakEquity: number;
  /** Current max drawdown (0..1). */
  maxDrawdown: number;
  /** Number of currently open shadow positions. */
  openPositions: number;
}

// ── Equity curve point ─────────────────────────────────────────────────────────

export interface ShadowEquityPoint {
  timestampMs: number;
  barIndex: number;
  equity: number;
  unrealisedPnl: number;
  realisedPnl: number;
  openPositions: number;
  drawdown: number;
}

// ── Benchmark data point ───────────────────────────────────────────────────────

export interface BenchmarkPoint {
  timestampMs: number;
  /** Equity or index level at this time. */
  value: number;
  /** Source label (e.g. "production", "paper", "NIFTY50"). */
  source: string;
}

// ── Audit log entry ────────────────────────────────────────────────────────────

export type AuditEventType =
  | "SIGNAL_RECEIVED"
  | "POSITION_OPENED"
  | "POSITION_CLOSED"
  | "FILL_SIMULATED"
  | "TICK_PROCESSED"
  | "BENCHMARK_UPDATED";

export interface AuditLogEntry {
  readonly id: string;
  readonly timestampMs: number;
  readonly type: AuditEventType;
  readonly experimentId: string;
  readonly armId: string;
  readonly detail: string;
  readonly payload?: Record<string, unknown>;
}

// ── Configuration ──────────────────────────────────────────────────────────────

export interface ShadowTraderConfig {
  /** Starting notional capital in INR. Default: 1_000_000 (₹10 lakh). */
  initialCapital?: number;
  /** Lot size for the instruments being traded. Default: 1 (equities). */
  lotSize?: number;
  /**
   * Simulated slippage as a fraction of price (e.g. 0.0005 = 0.05%).
   * Applied symmetrically on entry and exit. Default: 0.0005.
   */
  slippageFraction?: number;
  /**
   * Simulated commission per trade as a fraction of notional.
   * Default: 0.0003 (0.03% — approximate NSE cash equity brokerage).
   */
  commissionFraction?: number;
  /**
   * Maximum number of concurrent open shadow positions.
   * Default: 5.
   */
  maxOpenPositions?: number;
  /**
   * Whether to enforce intra-bar SL/TP checks using bar high/low.
   * Default: true.
   */
  intraBarChecks?: boolean;
}

const DEFAULT_CONFIG: Required<ShadowTraderConfig> = {
  initialCapital: 1_000_000,
  lotSize: 1,
  slippageFraction: 0.0005,
  commissionFraction: 0.0003,
  maxOpenPositions: 5,
  intraBarChecks: true,
};

// ── ShadowTrader ───────────────────────────────────────────────────────────────

export class ShadowTrader {
  readonly experimentId: string;
  readonly armId: string;
  readonly config: Required<ShadowTraderConfig>;

  // ── Mutable shadow state ──────────────────────────────────────────────
  private readonly _portfolio: ShadowPortfolioState;
  private readonly _openPositions = new Map<string, ShadowPosition>();
  private readonly _closedTrades: ShadowTrade[] = [];
  private readonly _equityCurve: ShadowEquityPoint[] = [];
  private readonly _simulatedFills: SimulatedFill[] = [];
  private readonly _auditLog: AuditLogEntry[] = [];
  private readonly _benchmarkPoints: BenchmarkPoint[] = [];

  private _barIndex = 0;
  private _posCounter = 0;
  private _auditCounter = 0;

  constructor(
    experimentId: string,
    armId: string,
    config: ShadowTraderConfig = {},
  ) {
    this.experimentId = experimentId;
    this.armId = armId;
    this.config = { ...DEFAULT_CONFIG, ...config };

    this._portfolio = {
      initialCapital: this.config.initialCapital,
      cash: this.config.initialCapital,
      unrealisedPnl: 0,
      realisedPnl: 0,
      totalCommission: 0,
      peakEquity: this.config.initialCapital,
      maxDrawdown: 0,
      openPositions: 0,
    };
  }

  // ── Primary feed: process a market tick ───────────────────────────────

  /**
   * Feed a market tick into the shadow trader.
   *
   * This method:
   *   1. Updates unrealised P&L on all open positions.
   *   2. Checks intra-bar SL/TP triggers (if enabled).
   *   3. Records an equity curve point.
   *   4. Appends a TICK_PROCESSED audit entry.
   *
   * Signal ingestion is done separately via `ingestSignal()`. The caller
   * (ExperimentManager) controls the order: tick → signal → tick → …
   */
  processTick(tick: MarketTick): void {
    this._barIndex = tick.barIndex;

    // Update unrealised P&L for all open positions
    for (const pos of this._openPositions.values()) {
      if (pos.symbol !== tick.symbol) continue;
      pos.unrealisedPnl = this._calcUnrealisedPnl(pos, tick.close);

      // Intra-bar SL/TP check using bar high/low
      if (this.config.intraBarChecks) {
        this._checkIntraBarExits(pos, tick);
      }
    }

    this._updatePortfolioUnrealised();
    this._recordEquityPoint(tick.timestampMs);

    this._audit("TICK_PROCESSED", `bar=${tick.barIndex} symbol=${tick.symbol} close=${tick.close}`, {
      barIndex: tick.barIndex,
      symbol: tick.symbol,
      close: tick.close,
    });
  }

  /**
   * Ingest a signal from the strategy and open a shadow position if valid.
   *
   * Hard rules (never violated):
   *  • No real order is generated
   *  • No paper portfolio is touched
   *  • isReal is always false on every SimulatedFill produced
   *  • Positions beyond maxOpenPositions are silently skipped
   */
  ingestSignal(signal: ExperimentSignal): SimulatedFill | null {
    // Guard: only accept signals for this experiment/arm
    if (
      signal.experimentId !== this.experimentId ||
      signal.armId !== this.armId
    ) {
      return null;
    }

    // Guard: shadow mode — signal must never have been acted on
    if (signal.acted) {
      this._audit(
        "SIGNAL_RECEIVED",
        `REJECTED acted=true signalId=${signal.id}`,
        { signalId: signal.id, reason: "acted_signal_rejected_in_shadow" },
      );
      return null;
    }

    // Guard: position limit
    if (this._openPositions.size >= this.config.maxOpenPositions) {
      this._audit(
        "SIGNAL_RECEIVED",
        `SKIPPED max_positions=${this.config.maxOpenPositions} signalId=${signal.id}`,
        { signalId: signal.id, reason: "max_positions_reached" },
      );
      return null;
    }

    // Guard: already have a position in this symbol
    const existing = this._findOpenPositionForSymbol(signal.symbol);
    if (existing) {
      this._audit(
        "SIGNAL_RECEIVED",
        `SKIPPED already_open symbol=${signal.symbol} signalId=${signal.id}`,
        { signalId: signal.id, reason: "existing_position" },
      );
      return null;
    }

    this._audit("SIGNAL_RECEIVED", `ACCEPTED signalId=${signal.id} dir=${signal.direction}`, {
      signalId: signal.id,
      direction: signal.direction,
      confidence: signal.confidence,
    });

    // Simulate slippage on entry
    const entrySlippage =
      signal.entryPrice * this.config.slippageFraction;
    const entryPrice =
      signal.direction === "LONG"
        ? signal.entryPrice + entrySlippage
        : signal.entryPrice - entrySlippage;

    // Simulate commission
    const notional = entryPrice * this.config.lotSize;
    const commission = notional * this.config.commissionFraction;

    // Deduct from shadow cash
    const costBasis = notional + commission;
    this._portfolio.cash -= costBasis;
    this._portfolio.totalCommission += commission;

    // Create shadow position
    const posId = this._makePosId();
    const position: ShadowPosition = {
      id: posId,
      experimentId: this.experimentId,
      armId: this.armId,
      versionStamp: { ...signal.versionStamp },
      symbol: signal.symbol,
      direction: signal.direction === "FLAT" ? "LONG" : signal.direction,
      entryPrice,
      stopLoss: signal.stopLoss,
      target: signal.target,
      qty: 1, // unit qty — sized by notional via lotSize
      lotSize: this.config.lotSize,
      entryCommission: commission,
      openedAtMs: signal.timestampMs,
      openBarIndex: this._barIndex,
      signalId: signal.id,
      status: "OPEN",
      unrealisedPnl: 0,
      realisedPnl: null,
      closedAtMs: null,
      closeBarIndex: null,
      closeReason: null,
      exitPrice: null,
    };

    this._openPositions.set(posId, position);
    this._portfolio.openPositions = this._openPositions.size;

    this._audit("POSITION_OPENED", `pos=${posId} entry=${entryPrice.toFixed(2)} sl=${signal.stopLoss} tp=${signal.target}`, {
      positionId: posId,
      entryPrice,
      stopLoss: signal.stopLoss,
      target: signal.target,
    });

    // Produce simulated fill — isReal is ALWAYS false
    const fill: SimulatedFill = {
      signalId: signal.id,
      experimentId: this.experimentId,
      armId: this.armId,
      timestampMs: signal.timestampMs,
      symbol: signal.symbol,
      direction: signal.direction === "FLAT" ? "LONG" : signal.direction,
      entryPrice,
      qty: 1,
      commission,
      slippage: entrySlippage,
      isReal: false,
    };

    this._simulatedFills.push(fill);

    this._audit("FILL_SIMULATED", `signalId=${signal.id} fillPrice=${entryPrice.toFixed(2)} isReal=false`, {
      signalId: signal.id,
      fillPrice: entryPrice,
      isReal: false,
    });

    return fill;
  }

  /**
   * Manually close a shadow position (e.g. at session end or experiment stop).
   */
  closePosition(
    positionId: string,
    exitPrice: number,
    reason: CloseReason,
    timestampMs?: number,
  ): ShadowTrade | null {
    const pos = this._openPositions.get(positionId);
    if (!pos || pos.status !== "OPEN") return null;

    const ts = timestampMs ?? Date.now();
    return this._closePosition(pos, exitPrice, reason, ts, this._barIndex);
  }

  /**
   * Close all open positions at the given price — used for session-end
   * or experiment-stop sweeps.
   */
  closeAllPositions(
    exitPriceBySymbol: Map<string, number>,
    reason: CloseReason,
    timestampMs?: number,
  ): ShadowTrade[] {
    const closed: ShadowTrade[] = [];
    const ts = timestampMs ?? Date.now();

    for (const pos of Array.from(this._openPositions.values())) {
      if (pos.status !== "OPEN") continue;
      const price = exitPriceBySymbol.get(pos.symbol);
      if (price === undefined) continue;
      const trade = this._closePosition(pos, price, reason, ts, this._barIndex);
      if (trade) closed.push(trade);
    }

    return closed;
  }

  // ── Benchmark tracking ─────────────────────────────────────────────────

  /**
   * Record a benchmark equity / index value for later comparison.
   * Call this once per tick alongside `processTick()`.
   */
  updateBenchmark(value: number, source: string, timestampMs: number): void {
    this._benchmarkPoints.push({ timestampMs, value, source });
    this._audit("BENCHMARK_UPDATED", `source=${source} value=${value}`, { source, value });
  }

  // ── Accessors ──────────────────────────────────────────────────────────

  get portfolioState(): Readonly<ShadowPortfolioState> {
    return { ...this._portfolio };
  }

  get equity(): number {
    return this._portfolio.cash + this._portfolio.unrealisedPnl;
  }

  openPositions(): ShadowPosition[] {
    return Array.from(this._openPositions.values());
  }

  closedTrades(): ShadowTrade[] {
    return [...this._closedTrades];
  }

  equityCurve(): ShadowEquityPoint[] {
    return [...this._equityCurve];
  }

  simulatedFills(): SimulatedFill[] {
    return [...this._simulatedFills];
  }

  auditLog(): AuditLogEntry[] {
    return [...this._auditLog];
  }

  benchmarkPoints(): BenchmarkPoint[] {
    return [...this._benchmarkPoints];
  }

  /**
   * Summary metrics for dashboard/comparison use.
   */
  summary(): ShadowSummary {
    const trades = this._closedTrades;
    const pnls = trades.map((t) => t.netPnl);
    const returns = trades.map((t) => t.pnlPct);
    const wins = pnls.filter((p) => p > 0).length;
    const losses = pnls.filter((p) => p < 0).length;

    const totalNetPnl = pnls.reduce((a, b) => a + b, 0);
    const winRate = trades.length > 0 ? wins / trades.length : 0;

    const avgReturn = returns.length > 0
      ? returns.reduce((a, b) => a + b, 0) / returns.length
      : 0;

    const grossWin = pnls.filter((p) => p > 0).reduce((a, b) => a + b, 0);
    const grossLoss = Math.abs(pnls.filter((p) => p < 0).reduce((a, b) => a + b, 0));
    const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;

    // Sharpe from per-trade returns (annualised at 252 trading days)
    const sharpe = calcSharpe(returns);

    // Drawdown from equity curve
    const equityValues = this._equityCurve.map((p) => p.equity);
    const maxDrawdown = calcMaxDrawdown(equityValues);

    return {
      experimentId: this.experimentId,
      armId: this.armId,
      totalTrades: trades.length,
      openPositions: this._openPositions.size,
      wins,
      losses,
      winRate,
      totalNetPnlINR: totalNetPnl,
      avgReturnPct: avgReturn * 100,
      profitFactor,
      sharpe,
      maxDrawdownPct: maxDrawdown * 100,
      initialCapital: this.config.initialCapital,
      currentEquity: this.equity,
      totalReturnPct:
        ((this.equity - this.config.initialCapital) / this.config.initialCapital) * 100,
      totalCommissionINR: this._portfolio.totalCommission,
      equityCurvePoints: this._equityCurve.length,
      benchmarkPoints: this._benchmarkPoints.length,
      lastUpdatedAtMs: this._equityCurve.length > 0
        ? this._equityCurve[this._equityCurve.length - 1].timestampMs
        : null,
    };
  }

  // ── Private helpers ────────────────────────────────────────────────────

  private _checkIntraBarExits(pos: ShadowPosition, tick: MarketTick): void {
    if (pos.symbol !== tick.symbol || pos.status !== "OPEN") return;

    if (pos.direction === "LONG") {
      // Stop hit: bar low touched the stop
      if (tick.low <= pos.stopLoss) {
        this._closePosition(pos, pos.stopLoss, "STOP_HIT", tick.timestampMs, tick.barIndex);
        return;
      }
      // Target hit: bar high reached the target
      if (tick.high >= pos.target) {
        this._closePosition(pos, pos.target, "TARGET_HIT", tick.timestampMs, tick.barIndex);
      }
    } else {
      // SHORT
      // Stop hit: bar high touched the stop
      if (tick.high >= pos.stopLoss) {
        this._closePosition(pos, pos.stopLoss, "STOP_HIT", tick.timestampMs, tick.barIndex);
        return;
      }
      // Target hit: bar low reached the target
      if (tick.low <= pos.target) {
        this._closePosition(pos, pos.target, "TARGET_HIT", tick.timestampMs, tick.barIndex);
      }
    }
  }

  private _closePosition(
    pos: ShadowPosition,
    exitPrice: number,
    reason: CloseReason,
    timestampMs: number,
    barIndex: number,
  ): ShadowTrade {
    // Simulate exit slippage (adverse)
    const exitSlippage = exitPrice * this.config.slippageFraction;
    const actualExit =
      pos.direction === "LONG"
        ? exitPrice - exitSlippage   // worse than quoted on long exit
        : exitPrice + exitSlippage;  // worse than quoted on short exit

    const exitCommission =
      actualExit * pos.lotSize * this.config.commissionFraction;

    const dir = pos.direction === "LONG" ? 1 : -1;
    const grossPnl = dir * (actualExit - pos.entryPrice) * pos.qty * pos.lotSize;
    const totalCommission = pos.entryCommission + exitCommission;
    const netPnl = grossPnl - totalCommission;
    const entryNotional = pos.entryPrice * pos.qty * pos.lotSize;
    const pnlPct = entryNotional > 0 ? netPnl / entryNotional : 0;

    const riskDist = Math.abs(pos.stopLoss - pos.entryPrice);
    const rewardDist = Math.abs(pos.target - pos.entryPrice);
    const plannedRR = riskDist > 0 ? rewardDist / riskDist : 0;
    const actualRR =
      riskDist > 0
        ? (dir * (actualExit - pos.entryPrice)) / riskDist
        : 0;

    // Mutate position state
    pos.status = "CLOSED";
    pos.realisedPnl = netPnl;
    pos.closedAtMs = timestampMs;
    pos.closeBarIndex = barIndex;
    pos.closeReason = reason;
    pos.exitPrice = actualExit;
    pos.unrealisedPnl = 0;

    // Update shadow portfolio
    const notional = pos.entryPrice * pos.qty * pos.lotSize;
    this._portfolio.cash += notional + netPnl + pos.entryCommission - exitCommission;
    this._portfolio.realisedPnl += netPnl;
    this._portfolio.totalCommission += exitCommission;
    this._openPositions.delete(pos.id);
    this._portfolio.openPositions = this._openPositions.size;

    // Update peak and max drawdown
    const eq = this.equity;
    if (eq > this._portfolio.peakEquity) {
      this._portfolio.peakEquity = eq;
    }
    const dd =
      this._portfolio.peakEquity > 0
        ? Math.max(0, (this._portfolio.peakEquity - eq) / this._portfolio.peakEquity)
        : 0;
    if (dd > this._portfolio.maxDrawdown) {
      this._portfolio.maxDrawdown = dd;
    }

    // Build immutable trade record
    const trade: ShadowTrade = {
      id: pos.id,
      positionId: pos.id,
      experimentId: pos.experimentId,
      armId: pos.armId,
      versionStamp: pos.versionStamp,
      symbol: pos.symbol,
      direction: pos.direction,
      entryPrice: pos.entryPrice,
      exitPrice: actualExit,
      qty: pos.qty,
      lotSize: pos.lotSize,
      grossPnl,
      commission: totalCommission,
      netPnl,
      pnlPct,
      openedAtMs: pos.openedAtMs,
      closedAtMs: timestampMs,
      barsHeld: barIndex - pos.openBarIndex,
      closeReason: reason,
      stopLoss: pos.stopLoss,
      target: pos.target,
      plannedRR,
      actualRR,
    };

    this._closedTrades.push(trade);

    this._audit(
      "POSITION_CLOSED",
      `pos=${pos.id} reason=${reason} exit=${actualExit.toFixed(2)} pnl=${netPnl.toFixed(2)}`,
      { positionId: pos.id, reason, exitPrice: actualExit, netPnl },
    );

    return trade;
  }

  private _calcUnrealisedPnl(pos: ShadowPosition, markPrice: number): number {
    const dir = pos.direction === "LONG" ? 1 : -1;
    return dir * (markPrice - pos.entryPrice) * pos.qty * pos.lotSize;
  }

  private _updatePortfolioUnrealised(): void {
    let total = 0;
    for (const pos of this._openPositions.values()) {
      total += pos.unrealisedPnl;
    }
    this._portfolio.unrealisedPnl = total;

    // Update peak equity and drawdown
    const eq = this.equity;
    if (eq > this._portfolio.peakEquity) {
      this._portfolio.peakEquity = eq;
    }
    const dd =
      this._portfolio.peakEquity > 0
        ? Math.max(0, (this._portfolio.peakEquity - eq) / this._portfolio.peakEquity)
        : 0;
    if (dd > this._portfolio.maxDrawdown) {
      this._portfolio.maxDrawdown = dd;
    }
  }

  private _recordEquityPoint(timestampMs: number): void {
    const eq = this.equity;
    const dd =
      this._portfolio.peakEquity > 0
        ? Math.max(0, (this._portfolio.peakEquity - eq) / this._portfolio.peakEquity)
        : 0;

    this._equityCurve.push({
      timestampMs,
      barIndex: this._barIndex,
      equity: eq,
      unrealisedPnl: this._portfolio.unrealisedPnl,
      realisedPnl: this._portfolio.realisedPnl,
      openPositions: this._openPositions.size,
      drawdown: dd,
    });
  }

  private _findOpenPositionForSymbol(symbol: string): ShadowPosition | undefined {
    for (const pos of this._openPositions.values()) {
      if (pos.symbol === symbol && pos.status === "OPEN") return pos;
    }
    return undefined;
  }

  private _makePosId(): string {
    return `spos_${this.experimentId.slice(-6)}_${this.armId.slice(0, 6)}_${(++this._posCounter)
      .toString(36)
      .padStart(5, "0")}`;
  }

  private _audit(
    type: AuditEventType,
    detail: string,
    payload?: Record<string, unknown>,
  ): void {
    this._auditLog.push({
      id: `audit_${(++this._auditCounter).toString(36).padStart(8, "0")}`,
      timestampMs: Date.now(),
      type,
      experimentId: this.experimentId,
      armId: this.armId,
      detail,
      payload,
    });
  }
}

// ── Summary type ───────────────────────────────────────────────────────────────

export interface ShadowSummary {
  experimentId: string;
  armId: string;
  totalTrades: number;
  openPositions: number;
  wins: number;
  losses: number;
  winRate: number;
  totalNetPnlINR: number;
  avgReturnPct: number;
  profitFactor: number;
  sharpe: number;
  maxDrawdownPct: number;
  initialCapital: number;
  currentEquity: number;
  totalReturnPct: number;
  totalCommissionINR: number;
  equityCurvePoints: number;
  benchmarkPoints: number;
  lastUpdatedAtMs: number | null;
}

// ── Pure metric helpers (no external dep) ──────────────────────────────────────

const TRADING_DAYS_PER_YEAR = 252;
const RISK_FREE_RATE = 0.065; // India 10Y G-Sec

function calcSharpe(returns: number[]): number {
  if (returns.length < 2) return 0;
  const rfPerTrade = RISK_FREE_RATE / TRADING_DAYS_PER_YEAR;
  const excess = returns.map((r) => r - rfPerTrade);
  const mean = excess.reduce((a, b) => a + b, 0) / excess.length;
  const variance =
    excess.reduce((acc, r) => acc + (r - mean) ** 2, 0) / excess.length;
  const stddev = Math.sqrt(variance);
  if (stddev === 0) return 0;
  return (mean / stddev) * Math.sqrt(TRADING_DAYS_PER_YEAR);
}

function calcMaxDrawdown(equityValues: number[]): number {
  if (equityValues.length === 0) return 0;
  let peak = equityValues[0];
  let maxDD = 0;
  for (const v of equityValues) {
    if (v > peak) peak = v;
    const dd = peak > 0 ? (peak - v) / peak : 0;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}
