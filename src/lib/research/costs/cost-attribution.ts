/**
 * Phase 6 — Transaction Cost Attribution
 *
 * Every strategy's reported performance must be net of ALL costs.
 * Gross performance is not acceptable as evidence of edge.
 *
 * Cost model for Indian F&O (NSE):
 *   Brokerage:        ₹20 per executed order (Zerodha flat-fee model)
 *   STT:              0.0125% of premium on buy side (options); 0.0025% on futures
 *   SEBI turnover:    0.0001%
 *   Exchange charges: 0.053% (NSE options), 0.002% (NSE futures)
 *   GST:              18% of (brokerage + exchange charges)
 *   Stamp duty:       0.003% on buy side
 *   Slippage:         0.05% per side (half-spread estimate, default)
 *   Spread:           0.03% per side (bid-ask spread, liquid F&O)
 *   Market impact:    0 (ignored for small trades; add manually for large)
 *
 * Cost model for Crypto Perpetuals:
 *   Taker fee:        0.04% per side (Binance)
 *   Slippage:         0.04% per side (liquid perps)
 *   Spread:           0.02% per side
 *   Funding:          included in return (positive/negative)
 *
 * Cost Stress Testing:
 *   Run at 1×, 1.5×, 2×, 3× of baseline costs.
 *   Mark COST_FRAGILE if strategy becomes unprofitable at 2× costs.
 */

import type {
  CostBreakdown,
  CostStressResult,
  CostAttributionReport,
  PerformancePeriod,
  CostMultiplier,
} from "../types";
import type { AnalyzerTrade } from "../performance/strategy-performance-analyzer";
import { computePerformanceMetrics } from "../performance/strategy-performance-analyzer";

// ─── Cost Models ──────────────────────────────────────────────────────────────

export interface CostModelConfig {
  /** Fixed commission per round-trip (buy+sell) in currency units */
  fixedCommissionPerRT: number;
  /** Variable brokerage rate as fraction of notional (both sides) */
  variableBrokerageRate: number;
  /** Exchange + regulatory charges as fraction of notional */
  exchangeChargesRate: number;
  /** Tax rate on brokerage + exchange charges (e.g. GST = 0.18) */
  taxRate: number;
  /** STT/transaction tax as fraction of notional */
  sttRate: number;
  /** Stamp duty as fraction of notional (buy side only) */
  stampDutyRate: number;
  /** Slippage per side as fraction of price */
  slippagePerSide: number;
  /** Bid-ask spread per side as fraction of price */
  spreadPerSide: number;
  /** Market impact per side (0 for small trades) */
  marketImpactPerSide: number;
}

export const NSE_FNO_OPTIONS_COST_MODEL: CostModelConfig = {
  fixedCommissionPerRT: 40, // ₹20 buy + ₹20 sell (Zerodha)
  variableBrokerageRate: 0, // flat fee — no variable
  exchangeChargesRate: 0.00053, // NSE options charge
  taxRate: 0.18, // GST
  sttRate: 0.000125, // 0.0125% on premium buy
  stampDutyRate: 0.00003, // 0.003% buy side
  slippagePerSide: 0.0005, // 0.05% per side
  spreadPerSide: 0.0003, // 0.03% per side
  marketImpactPerSide: 0,
};

export const NSE_FNO_FUTURES_COST_MODEL: CostModelConfig = {
  fixedCommissionPerRT: 40,
  variableBrokerageRate: 0,
  exchangeChargesRate: 0.00002, // NSE futures
  taxRate: 0.18,
  sttRate: 0.000025, // 0.0025% futures
  stampDutyRate: 0.00003,
  slippagePerSide: 0.0004,
  spreadPerSide: 0.0002,
  marketImpactPerSide: 0,
};

export const CRYPTO_PERP_COST_MODEL: CostModelConfig = {
  fixedCommissionPerRT: 0,
  variableBrokerageRate: 0.0004 * 2, // 0.04% taker × 2 sides
  exchangeChargesRate: 0,
  taxRate: 0,
  sttRate: 0,
  stampDutyRate: 0,
  slippagePerSide: 0.0004,
  spreadPerSide: 0.0002,
  marketImpactPerSide: 0,
};

// ─── Cost Computation ─────────────────────────────────────────────────────────

/**
 * Compute the full cost breakdown for a set of trades using the provided model.
 *
 * @param trades        Trades with notionalValue populated
 * @param model         Cost model configuration
 * @param multiplier    Cost stress multiplier (1 = baseline, 2 = stressed)
 */
export function computeCostBreakdown(
  trades: AnalyzerTrade[],
  model: CostModelConfig,
  multiplier: CostMultiplier = 1,
): CostBreakdown {
  if (trades.length === 0) {
    return {
      grossPnl: 0, brokerage: 0, exchangeCharges: 0, taxes: 0,
      slippage: 0, spread: 0, marketImpact: 0, totalCost: 0, netPnl: 0,
      costTurnoverRatio: 0,
    };
  }

  let grossPnl = 0;
  let totalNotional = 0;
  let brokerage = 0;
  let exchangeCharges = 0;
  let stt = 0;
  let stampDuty = 0;
  let slippage = 0;
  let spread = 0;
  let marketImpact = 0;

  for (const trade of trades) {
    const notional = trade.notionalValue;
    totalNotional += notional * 2; // round-trip turnover

    // Gross P&L from return
    grossPnl += trade.returnPct * notional;

    // Fixed brokerage per round-trip
    brokerage += model.fixedCommissionPerRT;
    // Variable brokerage on notional
    brokerage += model.variableBrokerageRate * notional;
    // Exchange charges
    exchangeCharges += model.exchangeChargesRate * notional * 2;
    // STT (buy side only)
    stt += model.sttRate * notional;
    // Stamp duty (buy side only)
    stampDuty += model.stampDutyRate * notional;
    // Slippage (both sides)
    slippage += model.slippagePerSide * notional * 2;
    // Spread (both sides)
    spread += model.spreadPerSide * notional * 2;
    // Market impact (both sides)
    marketImpact += model.marketImpactPerSide * notional * 2;
  }

  // GST on brokerage + exchange charges
  const taxes = model.taxRate * (brokerage + exchangeCharges) + stt + stampDuty;
  const totalBrokerage = brokerage;
  const totalExchangeCharges = exchangeCharges;

  // Apply multiplier to variable costs (brokerage fixed component stays fixed)
  const m = multiplier;
  const totalCost =
    totalBrokerage * m +
    totalExchangeCharges * m +
    taxes * m +
    slippage * m +
    spread * m +
    marketImpact * m;

  const netPnl = grossPnl - totalCost;
  const costTurnoverRatio = totalNotional > 0 ? totalCost / totalNotional : 0;

  return {
    grossPnl,
    brokerage: totalBrokerage * m,
    exchangeCharges: totalExchangeCharges * m,
    taxes: taxes * m,
    slippage: slippage * m,
    spread: spread * m,
    marketImpact: marketImpact * m,
    totalCost,
    netPnl,
    costTurnoverRatio,
  };
}

/**
 * Build a full cost attribution report with stress testing.
 * The report includes baseline costs and 1.5×/2×/3× stress scenarios.
 */
export function buildCostAttributionReport(
  strategyId: string,
  period: PerformancePeriod,
  trades: AnalyzerTrade[],
  model: CostModelConfig,
  annualFactor: number = 252,
  riskFreeRate: number = 0.065,
): CostAttributionReport {
  const MULTIPLIERS: CostMultiplier[] = [1, 1.5, 2, 3];

  const stressTests: CostStressResult[] = MULTIPLIERS.map((m) => {
    const costs = computeCostBreakdown(trades, model, m);

    // Build net-return trades for metrics computation
    const netTrades: AnalyzerTrade[] = trades.map((t) => {
      const grossPnl = t.returnPct * t.notionalValue;
      // Distribute total costs proportionally to each trade's notional weight
      const tradeCostFraction = t.notionalValue / Math.max(trades.reduce((s, x) => s + x.notionalValue, 0), 1);
      const tradeCost = costs.totalCost * tradeCostFraction;
      const netPnl = grossPnl - tradeCost;
      const netReturn = t.notionalValue > 0 ? netPnl / t.notionalValue : 0;
      return { returnPct: netReturn, holdBars: t.holdBars, notionalValue: t.notionalValue };
    });

    const netMetrics = computePerformanceMetrics(netTrades, period, annualFactor, riskFreeRate);

    return {
      multiplier: m,
      costBreakdown: costs,
      netSharpe: netMetrics.sharpe,
      netExpectancy: netMetrics.expectancy,
      profitable: netMetrics.totalReturn > 0,
    };
  });

  const baseline = stressTests.find((s) => s.multiplier === 1)!.costBreakdown;

  // COST_FRAGILE: unprofitable at 2× costs
  const at2x = stressTests.find((s) => s.multiplier === 2)!;
  const costFragile = !at2x.profitable;

  // Break-even cost multiple (smallest m at which strategy is unprofitable)
  let breakEvenMultiple = Infinity;
  for (const s of stressTests) {
    if (!s.profitable && s.multiplier < breakEvenMultiple) {
      breakEvenMultiple = s.multiplier;
    }
  }
  if (breakEvenMultiple === Infinity) breakEvenMultiple = 3; // survives all stress levels

  return {
    strategyId,
    period,
    tradeCount: trades.length,
    baseline,
    stressTests,
    costFragile,
    breakEvenCostMultiple: breakEvenMultiple,
    computedAt: new Date().toISOString(),
  };
}
