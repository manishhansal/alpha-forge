/**
 * portfolio-risk.ts — AlphaForge Portfolio Risk Engine v2
 *
 * The single entry point for ALL pre-trade risk evaluation. Every proposed
 * trade must pass through `PortfolioRiskEngine.evaluate()` before an order
 * is generated.
 *
 * Evaluation pipeline (in priority order):
 *   1. Kill switch     — HARD_KILL blocks immediately; SOFT_KILL applies size multiplier.
 *   2. Drawdown control — daily / max drawdown tiers reduce size or block entirely.
 *   3. VaR check       — block if portfolio VaR exceeds the configured limit.
 *   4. Exposure checks — gross, symbol, underlying, sector, strategy concentration.
 *   5. Correlated-long cluster — prevent piling into highly correlated names.
 *   6. Correlation risk  — penalise/reject when new trade is highly correlated to book.
 *   7. Risk budget      — per-trade / per-strategy / per-sector / portfolio open risk.
 *   8. Dynamic sizing   — confidence × vol × correlation × drawdown → final qty.
 *
 * The engine is stateful:
 *   - Maintains rolling price history for correlation matrix updates.
 *   - Maintains rolling daily P&L history for VaR.
 *   - Tracks drawdown via DrawdownTracker.
 *   - Holds the kill switch state.
 *
 * All monetary values in INR.
 */

import type { Position } from "../backtesting-v2/models/position";

// Sub-modules
import {
  calcExposureSnapshot,
  checkConcentration,
  checkCorrelatedLongCluster,
  toExposureFractions,
  type ExposureSnapshot,
  type ExposureLimits,
  DEFAULT_EXPOSURE_LIMITS,
} from "./exposure";

import {
  buildCorrelationMatrix,
  checkCorrelationRisk,
  updatePriceHistory,
  type CorrelationMatrix,
  type CorrelationConfig,
  DEFAULT_CORRELATION_CONFIG,
  type PriceHistory,
} from "./correlation";

import {
  computeVaR,
  checkVaRBreach,
  portfolioDailyVol,
  type VaRResult,
  type VaRConfig,
  DEFAULT_VAR_CONFIG,
} from "./var";

import {
  DrawdownTracker,
  checkDrawdown,
  type DrawdownState,
  type DrawdownCheck,
  type DrawdownConfig,
  DEFAULT_DRAWDOWN_CONFIG,
} from "./drawdown";

import {
  computePositionSize,
  type SizingConfig,
  type SizingResult,
  DEFAULT_SIZING_CONFIG,
} from "./position-sizing";

import {
  checkRiskBudget,
  computePortfolioRiskBudget,
  evaluateKillSwitch,
  createKillSwitch,
  type KillSwitch,
  type KillSwitchState,
  type RiskBudgetConfig,
  DEFAULT_RISK_BUDGET_CONFIG,
} from "./risk-limits";

// ── Engine config ─────────────────────────────────────────────────────────────

export interface PortfolioRiskConfig {
  exposure: ExposureLimits;
  correlation: CorrelationConfig;
  var: VaRConfig;
  drawdown: DrawdownConfig;
  sizing: SizingConfig;
  budget: RiskBudgetConfig;
}

export const DEFAULT_RISK_CONFIG: PortfolioRiskConfig = {
  exposure: DEFAULT_EXPOSURE_LIMITS,
  correlation: DEFAULT_CORRELATION_CONFIG,
  var: DEFAULT_VAR_CONFIG,
  drawdown: DEFAULT_DRAWDOWN_CONFIG,
  sizing: DEFAULT_SIZING_CONFIG,
  budget: DEFAULT_RISK_BUDGET_CONFIG,
};

// ── Evaluation request / result ───────────────────────────────────────────────

export interface TradeProposal {
  symbol: string;
  strategyId: string;
  direction: "LONG" | "SHORT";
  entryPrice: number;
  stopLoss: number;
  /** Target price (used for display/audit — not gating). */
  target: number;
  /** Current ATR of the instrument (INR). */
  atr: number;
  /** Lot size (shares per lot). 1 for equities. */
  lotSize: number;
  /** Model/signal confidence [0, 1]. */
  confidence: number;
}

export type RiskDecision = "APPROVED" | "REJECTED";

export type RiskRejectReason =
  | "HARD_KILL"
  | "DRAWDOWN_HALT"
  | "VAR_BREACH"
  | "GROSS_EXPOSURE"
  | "SYMBOL_CONCENTRATION"
  | "UNDERLYING_CONCENTRATION"
  | "SECTOR_CONCENTRATION"
  | "STRATEGY_CONCENTRATION"
  | "CORRELATED_LONG_CLUSTER"
  | "CORRELATION_RISK"
  | "TRADE_RISK_BUDGET"
  | "STRATEGY_RISK_BUDGET"
  | "SECTOR_RISK_BUDGET"
  | "PORTFOLIO_RISK_BUDGET"
  | "ZERO_QTY";

export interface RiskEvaluationResult {
  decision: RiskDecision;
  rejectReason?: RiskRejectReason;
  rejectDetail?: string;

  /** Recommended position size. 0 if rejected or sizing fails. */
  recommendedQty: number;
  sizingResult: SizingResult;

  /** State snapshots for audit/logging. */
  snapshot: RiskStateSnapshot;
}

export interface RiskStateSnapshot {
  exposure: ExposureSnapshot;
  exposureFractions: ReturnType<typeof toExposureFractions>;
  drawdownState: DrawdownState;
  drawdownCheck: DrawdownCheck;
  varResult: VaRResult;
  killSwitchState: KillSwitchState;
  portfolioDailyVolFraction: number;
  maxPairwiseCorrelation: number;
  corrMatrixAge: number;  // bars since last correlation matrix rebuild
}

// ── Engine ────────────────────────────────────────────────────────────────────

export class PortfolioRiskEngine {
  readonly config: PortfolioRiskConfig;

  // ── Mutable state ──
  private _killSwitch: KillSwitch;
  private _drawdownTracker: DrawdownTracker;
  private _priceHistory: PriceHistory = new Map();
  private _dailyPnlHistory: number[] = [];
  private _corrMatrix: CorrelationMatrix | null = null;
  private _corrMatrixBarAge = 0;
  /**
   * How many bars between correlation matrix rebuilds.
   * Rebuilding every bar is expensive for large universes.
   */
  private readonly _corrRebuildEveryBars: number;

  constructor(
    initialEquity: number,
    config: Partial<PortfolioRiskConfig> = {},
    corrRebuildEveryBars = 5,
  ) {
    this.config = {
      exposure: { ...DEFAULT_EXPOSURE_LIMITS, ...config.exposure },
      correlation: { ...DEFAULT_CORRELATION_CONFIG, ...config.correlation },
      var: { ...DEFAULT_VAR_CONFIG, ...config.var },
      drawdown: { ...DEFAULT_DRAWDOWN_CONFIG, ...config.drawdown },
      sizing: { ...DEFAULT_SIZING_CONFIG, ...config.sizing },
      budget: { ...DEFAULT_RISK_BUDGET_CONFIG, ...config.budget },
    };
    this._killSwitch = createKillSwitch(this.config.budget.softKillDailyLossFraction);
    this._drawdownTracker = new DrawdownTracker(initialEquity, this.config.drawdown);
    this._corrRebuildEveryBars = corrRebuildEveryBars;
  }

  // ── State update hooks ────────────────────────────────────────────────────

  /** Call at the start of each trading session. */
  onSessionOpen(equity: number): void {
    this._drawdownTracker.onSessionOpen(equity);
  }

  /**
   * Feed a new bar's close prices for all tracked symbols.
   * Call once per bar, after mark-to-market.
   */
  onBarClose(
    prices: Map<string, number>,
    equity: number,
    dailyPnl: number,
    barIndex: number,
  ): void {
    // Update price history for each symbol
    for (const [symbol, price] of prices) {
      updatePriceHistory(this._priceHistory, symbol, price, this.config.var.maxWindow + 1);
    }

    // Update drawdown
    this._drawdownTracker.update(equity);

    // Evaluate kill switch (auto-escalation)
    this._killSwitch = evaluateKillSwitch(
      this._killSwitch,
      dailyPnl,
      equity,
      this.config.budget,
    );

    // Rolling daily P&L for VaR (only append once per session / day)
    // Caller should pass the *final* daily P&L at session close.

    // Age the correlation matrix
    this._corrMatrixBarAge++;

    // Rebuild correlation matrix on schedule
    if (
      this._corrMatrixBarAge >= this._corrRebuildEveryBars ||
      this._corrMatrix === null
    ) {
      this._rebuildCorrMatrix();
      this._corrMatrixBarAge = 0;
    }
  }

  /**
   * Append a closed-session's daily P&L to the VaR history.
   * Call once per session close with the day's net P&L.
   */
  onSessionClose(dailyPnl: number): void {
    this._dailyPnlHistory.push(dailyPnl);
    // Cap to rolling window
    if (this._dailyPnlHistory.length > this.config.var.maxWindow) {
      this._dailyPnlHistory.shift();
    }
  }

  // ── Manual kill switch controls ───────────────────────────────────────────

  activateSoftKill(reason: string): void {
    this._killSwitch = {
      ...this._killSwitch,
      state: "SOFT_KILL",
      activatedAtMs: Date.now(),
      reason,
    };
  }

  activateHardKill(reason: string): void {
    this._killSwitch = {
      ...this._killSwitch,
      state: "HARD_KILL",
      activatedAtMs: Date.now(),
      reason,
    };
  }

  /** Manual reset — should be audited/logged by caller. */
  resetKillSwitch(): void {
    this._killSwitch = {
      ...this._killSwitch,
      state: "NONE",
      activatedAtMs: null,
      reason: null,
    };
  }

  get killSwitchState(): KillSwitchState {
    return this._killSwitch.state;
  }

  // ── Core evaluation ───────────────────────────────────────────────────────

  /**
   * Evaluate a proposed trade. This is the primary pre-trade gate.
   *
   * @param proposal   The trade to evaluate.
   * @param positions  All currently open positions.
   * @param equity     Current portfolio equity (INR).
   * @param dailyPnl   Today's running P&L (INR).
   */
  evaluate(
    proposal: TradeProposal,
    positions: Position[],
    equity: number,
    dailyPnl: number,
  ): RiskEvaluationResult {
    // ── Compute shared state ────────────────────────────────────────────────
    const exposureSnap = calcExposureSnapshot(positions);
    const exposureFractions = toExposureFractions(exposureSnap, equity);
    const drawdownState = this._drawdownTracker.update(equity);
    const drawdownCheck = checkDrawdown(drawdownState, this.config.drawdown);
    const varResult = computeVaR(this._dailyPnlHistory, this.config.var);
    const portfolioDailyVolFraction = portfolioDailyVol(
      this._dailyPnlHistory,
      equity,
      20,
    );
    const openPositionsForCorr = positions
      .filter((p) => p.status === "OPEN")
      .map((p) => ({ symbol: p.instrument.symbol, direction: p.direction }));

    // Find max pairwise correlation with existing same-dir positions
    let maxPairwiseCorrelation = 0;
    if (this._corrMatrix) {
      for (const op of openPositionsForCorr) {
        if (op.direction !== proposal.direction) continue;
        const { matrix, symbols } = this._corrMatrix;
        const i = symbols.indexOf(proposal.symbol);
        const j = symbols.indexOf(op.symbol);
        if (i !== -1 && j !== -1) {
          maxPairwiseCorrelation = Math.max(
            maxPairwiseCorrelation,
            Math.abs(matrix[i][j]),
          );
        }
      }
    }

    const snapshot: RiskStateSnapshot = {
      exposure: exposureSnap,
      exposureFractions,
      drawdownState,
      drawdownCheck,
      varResult,
      killSwitchState: this._killSwitch.state,
      portfolioDailyVolFraction,
      maxPairwiseCorrelation,
      corrMatrixAge: this._corrMatrixBarAge,  // bars since last correlation matrix rebuild
    };

    // Helper: build rejected result
    const reject = (
      reason: RiskRejectReason,
      detail: string,
    ): RiskEvaluationResult => ({
      decision: "REJECTED",
      rejectReason: reason,
      rejectDetail: detail,
      recommendedQty: 0,
      sizingResult: {
        qty: 0,
        notional: 0,
        baseQty: 0,
        confidenceFactor: 0,
        volFactor: 0,
        correlationFactor: 0,
        drawdownFactor: 0,
        combinedMultiplier: 0,
        zeroReason: detail,
      },
      snapshot,
    });

    // ── 1. Hard kill switch ─────────────────────────────────────────────────
    if (this._killSwitch.state === "HARD_KILL") {
      return reject(
        "HARD_KILL",
        `HARD KILL active since ${this._killSwitch.activatedAtMs ? new Date(this._killSwitch.activatedAtMs).toISOString() : "unknown"}: ${this._killSwitch.reason ?? ""}`,
      );
    }

    // ── 2. Drawdown halt ────────────────────────────────────────────────────
    if (drawdownCheck.blocked) {
      return reject("DRAWDOWN_HALT", drawdownCheck.reason!);
    }

    // ── 3. VaR breach ───────────────────────────────────────────────────────
    const varBreach = checkVaRBreach(varResult, equity, this.config.var);
    if (varBreach.breached) {
      return reject("VAR_BREACH", varBreach.reason!);
    }

    // ── 4. Exposure / concentration ─────────────────────────────────────────
    const proposedNotional = proposal.lotSize * proposal.entryPrice;
    // (Will be scaled later by sizing, but we gate on 1-lot notional here to
    //  catch cases where even 1 lot is too large.)

    const concCheck = checkConcentration(
      exposureSnap,
      {
        symbol: proposal.symbol,
        strategyId: proposal.strategyId,
        direction: proposal.direction,
        notional: proposedNotional,
      },
      equity,
      this.config.exposure,
    );

    if (concCheck.breached) {
      // Map concentration reason to specific rejection code
      const detail = concCheck.reason!;
      let reason: RiskRejectReason = "GROSS_EXPOSURE";
      if (detail.includes("Symbol")) reason = "SYMBOL_CONCENTRATION";
      else if (detail.includes("Underlying")) reason = "UNDERLYING_CONCENTRATION";
      else if (detail.includes("Sector")) reason = "SECTOR_CONCENTRATION";
      else if (detail.includes("Strategy")) reason = "STRATEGY_CONCENTRATION";
      return reject(reason, detail);
    }

    // ── 5. Correlated-long cluster (sector-level) ───────────────────────────
    if (proposal.direction === "LONG") {
      const clusterCheck = checkCorrelatedLongCluster(
        positions,
        proposal.symbol,
        this.config.exposure,
      );
      if (clusterCheck.breached) {
        return reject("CORRELATED_LONG_CLUSTER", clusterCheck.reason!);
      }
    }

    // ── 6. Pairwise correlation risk ────────────────────────────────────────
    if (this._corrMatrix) {
      const corrCheck = checkCorrelationRisk(
        proposal.symbol,
        proposal.direction,
        openPositionsForCorr,
        this._corrMatrix,
        this.config.correlation,
      );
      if (corrCheck.breached) {
        return reject("CORRELATION_RISK", corrCheck.reason!);
      }
    }

    // ── 7. Risk budget ──────────────────────────────────────────────────────
    const budget = computePortfolioRiskBudget(positions);
    const tradeRisk =
      Math.abs(proposal.entryPrice - proposal.stopLoss) * proposal.lotSize;
    // (Per 1 lot — will be multiplied by final qty for budget check)

    const budgetCheck = checkRiskBudget(
      {
        symbol: proposal.symbol,
        strategyId: proposal.strategyId,
        tradeRisk,
      },
      budget,
      equity,
      this._killSwitch,
      this.config.budget,
    );

    if (!budgetCheck.approved) {
      const breachMap: Record<string, RiskRejectReason> = {
        TRADE: "TRADE_RISK_BUDGET",
        STRATEGY: "STRATEGY_RISK_BUDGET",
        SECTOR: "SECTOR_RISK_BUDGET",
        PORTFOLIO: "PORTFOLIO_RISK_BUDGET",
      };
      const reason = (breachMap[budgetCheck.breachedLevel ?? ""] ??
        "PORTFOLIO_RISK_BUDGET") as RiskRejectReason;
      return reject(reason, budgetCheck.reason!);
    }

    // ── 8. Dynamic position sizing ──────────────────────────────────────────
    const sizingResult = computePositionSize(
      {
        entryPrice: proposal.entryPrice,
        stopLoss: proposal.stopLoss,
        atr: proposal.atr,
        lotSize: proposal.lotSize,
        confidence: proposal.confidence,
        equity,
        portfolioDailyVolFraction,
        maxPairwiseCorrelation,
        drawdownCheck,
      },
      this.config.sizing,
    );

    // Apply soft-kill multiplier on top of other factors
    let finalQty = sizingResult.qty;
    if (this._killSwitch.state === "SOFT_KILL") {
      finalQty = Math.max(1, Math.floor(finalQty * budgetCheck.killSwitchMultiplier));
    }

    if (finalQty === 0) {
      return reject(
        "ZERO_QTY",
        sizingResult.zeroReason ?? "Position sizing produced 0 qty",
      );
    }

    return {
      decision: "APPROVED",
      recommendedQty: finalQty,
      sizingResult: { ...sizingResult, qty: finalQty },
      snapshot,
    };
  }

  // ── Read-only state accessors ─────────────────────────────────────────────

  get corrMatrix(): CorrelationMatrix | null {
    return this._corrMatrix;
  }

  get dailyPnlHistory(): ReadonlyArray<number> {
    return this._dailyPnlHistory;
  }

  get priceHistory(): PriceHistory {
    return this._priceHistory;
  }

  currentDrawdownState(equity: number): DrawdownState {
    return this._drawdownTracker.update(equity);
  }

  currentVaR(): VaRResult {
    return computeVaR(this._dailyPnlHistory, this.config.var);
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  private _rebuildCorrMatrix(): void {
    const symbols = Array.from(this._priceHistory.keys());
    if (symbols.length < 2) {
      this._corrMatrix = null;
      return;
    }
    this._corrMatrix = buildCorrelationMatrix(
      symbols,
      this._priceHistory,
      this.config.correlation,
      Date.now(),
    );
  }
}

// ── Convenience factory ───────────────────────────────────────────────────────

/**
 * Create a PortfolioRiskEngine with default configuration,
 * optionally overriding specific sub-module configs.
 */
export function createRiskEngine(
  initialEquity: number,
  overrides: Partial<PortfolioRiskConfig> = {},
): PortfolioRiskEngine {
  return new PortfolioRiskEngine(initialEquity, overrides);
}

// ── Re-exports for consumers ──────────────────────────────────────────────────

export type {
  ExposureSnapshot,
  ExposureLimits,
  DrawdownState,
  DrawdownCheck,
  VaRResult,
  KillSwitch,
  KillSwitchState,
  SizingResult,
  CorrelationMatrix,
};

export {
  DEFAULT_EXPOSURE_LIMITS,
  DEFAULT_CORRELATION_CONFIG,
  DEFAULT_VAR_CONFIG,
  DEFAULT_DRAWDOWN_CONFIG,
  DEFAULT_SIZING_CONFIG,
  DEFAULT_RISK_BUDGET_CONFIG,
};
