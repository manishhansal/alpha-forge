/**
 * PerformanceReport — the top-level analytics output for a backtest run.
 *
 * Aggregates all required metrics from the spec:
 *   CAGR, Sharpe, Sortino, Calmar, MaxDrawdown, AvgDrawdown,
 *   WinRate, ProfitFactor, Expectancy, PayoffRatio, SQN,
 *   UlcerIndex, VaR (95%), CVaR (95%)
 *
 * Plus NSE-specific stats: session count, expiry trades, F&O specific fields.
 *
 * `buildPerformanceReport()` is the single entry-point. Pass it the
 * Portfolio and the list of closed trades after a run completes.
 */

import type { Trade } from "../models/trade";
import type { Portfolio, EquityCurvePoint } from "../models/portfolio";
import {
  cagr, sharpeRatio, sortinoRatio, calmarRatio, profitFactor,
  expectancy, payoffRatio, sqn, ulcerIndex, historicalVaR, cvar,
  winRate, maxConsecutive, calcDrawdown, mean, stddev,
  TRADING_DAYS_PER_YEAR,
} from "./metrics";

// ── Report shape ──────────────────────────────────────────────────────────────

export interface PerformanceReport {
  // ── Run summary ────────────────────────────────────────────────────────
  startTimestampMs: number;
  endTimestampMs: number;
  tradingDays: number;
  totalBars: number;

  // ── Capital ────────────────────────────────────────────────────────────
  initialCapital: number;
  finalEquity: number;
  totalReturnPct: number;
  totalReturnINR: number;

  // ── Return metrics ─────────────────────────────────────────────────────
  /** Compound Annual Growth Rate (fraction). */
  cagr: number;
  cagrPct: number;
  /** Annualised Sharpe Ratio. */
  sharpe: number;
  /** Annualised Sortino Ratio. */
  sortino: number;
  /** CAGR / MaxDrawdown. */
  calmar: number;

  // ── Drawdown ───────────────────────────────────────────────────────────
  maxDrawdownPct: number;
  maxDrawdownINR: number;
  avgDrawdownPct: number;
  ulcerIndex: number;

  // ── Trade statistics ───────────────────────────────────────────────────
  totalTrades: number;
  wins: number;
  losses: number;
  breakEven: number;
  winRate: number;
  /** Average win as % of entry notional. */
  avgWinPct: number;
  /** Average loss as % of entry notional (positive number). */
  avgLossPct: number;
  largestWinPct: number;
  largestLossPct: number;
  /** Average bars held per trade. */
  avgBarsHeld: number;
  maxWinStreak: number;
  maxLossStreak: number;

  // ── Risk/reward ────────────────────────────────────────────────────────
  profitFactor: number;
  expectancyINR: number;
  expectancyPct: number;
  payoffRatio: number;
  /** System Quality Number (Van Tharp). */
  sqn: number;

  // ── Tail risk ──────────────────────────────────────────────────────────
  /** 95% historical VaR (per-trade loss, positive number). */
  var95: number;
  /** 95% CVaR / Expected Shortfall. */
  cvar95: number;

  // ── NSE session stats ──────────────────────────────────────────────────
  tradedSessions: number;
  totalCommissionINR: number;
  commissionDragPct: number;
  expiryDayTrades: number;
  sessionCloseTrades: number;

  // ── Benchmark comparison (if provided) ────────────────────────────────
  benchmarkReturnPct: number | null;
  alphaVsBenchmark: number | null;

  // ── Per-strategy breakdown ─────────────────────────────────────────────
  byStrategy: StrategyBreakdown[];

  // ── Per-regime breakdown ───────────────────────────────────────────────
  byRegime: RegimeBreakdown[];
}

export interface StrategyBreakdown {
  strategyId: string;
  trades: number;
  wins: number;
  winRate: number;
  netPnlINR: number;
  netPnlPct: number;
  sharpe: number;
  profitFactor: number;
  avgBarsHeld: number;
}

export interface RegimeBreakdown {
  regime: string;
  trades: number;
  winRate: number;
  netPnlINR: number;
  avgPnlPct: number;
}

// ── Builder ───────────────────────────────────────────────────────────────────

export interface ReportInput {
  trades: Trade[];
  portfolio: Portfolio;
  totalBarsProcessed: number;
  benchmarkReturnPct?: number | null;
}

export function buildPerformanceReport(input: ReportInput): PerformanceReport {
  const { trades, portfolio, totalBarsProcessed } = input;
  const curve = portfolio.equityCurve();

  // ── Timestamps ────────────────────────────────────────────────────────
  const startMs = curve.length > 0 ? curve[0].timestampMs : 0;
  const endMs = curve.length > 0 ? curve[curve.length - 1].timestampMs : 0;
  const tradingDays = totalBarsProcessed > 0
    ? Math.ceil(totalBarsProcessed / 390) // ~390 1-min bars per NSE session
    : Math.max(1, Math.round((endMs - startMs) / (24 * 60 * 60 * 1000) * (252 / 365)));

  // ── P&L series ────────────────────────────────────────────────────────
  const pnls = trades.map((t) => t.netPnl);
  const pnlPcts = trades.map((t) => t.pnlPct / 100); // as fractions
  const initialCap = portfolio.config.initialCapital;
  const finalEq = portfolio.equity;

  // ── Drawdown ──────────────────────────────────────────────────────────
  const equityValues = curve.map((p) => p.equity);
  const dd = calcDrawdown(equityValues.length > 0 ? equityValues : [initialCap, finalEq]);

  // ── Return metrics ────────────────────────────────────────────────────
  const totalReturnPct = initialCap > 0 ? ((finalEq - initialCap) / initialCap) * 100 : 0;
  const cagrVal = cagr(initialCap, finalEq, tradingDays);
  const sharpe = sharpeRatio(pnlPcts);
  const sortino = sortinoRatio(pnlPcts);
  const calmar = calmarRatio(cagrVal, dd.maxDrawdown);

  // ── Trade stats ────────────────────────────────────────────────────────
  const wins = trades.filter((t) => t.netPnl > 0);
  const losses = trades.filter((t) => t.netPnl < 0);
  const breakEvenCount = trades.filter((t) => t.netPnl === 0).length;
  const wr = winRate(pnls);
  const winPcts = wins.map((t) => t.pnlPct);
  const lossPcts = losses.map((t) => Math.abs(t.pnlPct));
  const avgWinPct = winPcts.length > 0 ? mean(winPcts) : 0;
  const avgLossPct = lossPcts.length > 0 ? mean(lossPcts) : 0;
  const largestWinPct = winPcts.length > 0 ? Math.max(...winPcts) : 0;
  const largestLossPct = lossPcts.length > 0 ? Math.max(...lossPcts) : 0;
  const avgBarsHeld = trades.length > 0 ? mean(trades.map((t) => t.barsHeld)) : 0;
  const { maxWinStreak, maxLossStreak } = maxConsecutive(trades.map((t) => t.netPnl > 0));

  // ── Risk/reward ────────────────────────────────────────────────────────
  const pf = profitFactor(pnls);
  const expINR = expectancy(pnls);
  const expPct = expectancy(pnlPcts) * 100;
  const pr = payoffRatio(pnls);

  // R-multiples for SQN (actual pnl / initial risk based on stop distance)
  const rMultiples = trades
    .filter((t) => t.stopLoss > 0 && t.entryPrice > 0)
    .map((t) => {
      const riskPerUnit = Math.abs(t.entryPrice - t.stopLoss);
      const riskINR = riskPerUnit * t.qty * t.instrument.lotSize;
      return riskINR > 0 ? t.netPnl / riskINR : 0;
    });
  const sqnVal = sqn(rMultiples);

  // ── Tail risk ──────────────────────────────────────────────────────────
  const var95 = historicalVaR(pnlPcts) * initialCap; // convert to INR
  const cvar95 = cvar(pnlPcts) * initialCap;
  const ulcer = ulcerIndex(equityValues.length > 0 ? equityValues : [initialCap]);

  // ── Commission drag ────────────────────────────────────────────────────
  const totalCommission = portfolio.totalCommission;
  const commDrag = initialCap > 0 ? (totalCommission / initialCap) * 100 : 0;

  // ── NSE-specific ───────────────────────────────────────────────────────
  const expiryTrades = trades.filter((t) => t.closeReason === "EXPIRY").length;
  const sessionCloseTrades = trades.filter((t) => t.closeReason === "SESSION_CLOSE").length;
  const tradedSessions = countSessions(curve);

  // ── Per-strategy breakdown ─────────────────────────────────────────────
  const byStrategy = buildStrategyBreakdown(trades);
  const byRegime = buildRegimeBreakdown(trades);

  // ── Benchmark ─────────────────────────────────────────────────────────
  const benchmarkReturnPct = input.benchmarkReturnPct ?? null;
  const alphaVsBenchmark =
    benchmarkReturnPct !== null ? totalReturnPct - benchmarkReturnPct : null;

  return {
    startTimestampMs: startMs,
    endTimestampMs: endMs,
    tradingDays,
    totalBars: totalBarsProcessed,
    initialCapital: initialCap,
    finalEquity: finalEq,
    totalReturnPct,
    totalReturnINR: finalEq - initialCap,
    cagr: cagrVal,
    cagrPct: cagrVal * 100,
    sharpe,
    sortino,
    calmar,
    maxDrawdownPct: dd.maxDrawdown * 100,
    maxDrawdownINR: dd.peak - dd.trough,
    avgDrawdownPct: dd.avgDrawdown * 100,
    ulcerIndex: ulcer,
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    breakEven: breakEvenCount,
    winRate: wr,
    avgWinPct,
    avgLossPct,
    largestWinPct,
    largestLossPct,
    avgBarsHeld,
    maxWinStreak,
    maxLossStreak,
    profitFactor: pf,
    expectancyINR: expINR,
    expectancyPct: expPct,
    payoffRatio: pr,
    sqn: sqnVal,
    var95,
    cvar95,
    tradedSessions,
    totalCommissionINR: totalCommission,
    commissionDragPct: commDrag,
    expiryDayTrades: expiryTrades,
    sessionCloseTrades,
    benchmarkReturnPct,
    alphaVsBenchmark,
    byStrategy,
    byRegime,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function countSessions(curve: EquityCurvePoint[]): number {
  const dates = new Set<string>();
  for (const pt of curve) {
    const d = new Date(pt.timestampMs + 5.5 * 3600_000);
    dates.add(`${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`);
  }
  return dates.size;
}

function buildStrategyBreakdown(trades: Trade[]): StrategyBreakdown[] {
  const groups = new Map<string, Trade[]>();
  for (const t of trades) {
    const arr = groups.get(t.strategyId) ?? [];
    arr.push(t);
    groups.set(t.strategyId, arr);
  }
  return Array.from(groups.entries()).map(([strategyId, ts]) => {
    const wins = ts.filter((t) => t.netPnl > 0).length;
    const pnls = ts.map((t) => t.netPnl);
    const pnlPcts = ts.map((t) => t.pnlPct / 100);
    const netPnlINR = pnls.reduce((a, b) => a + b, 0);
    const entryNotional = ts.reduce(
      (a, t) => a + t.entryPrice * t.qty * t.instrument.lotSize,
      0,
    );
    return {
      strategyId,
      trades: ts.length,
      wins,
      winRate: ts.length > 0 ? wins / ts.length : 0,
      netPnlINR,
      netPnlPct: entryNotional > 0 ? (netPnlINR / entryNotional) * 100 : 0,
      sharpe: sharpeRatio(pnlPcts),
      profitFactor: profitFactor(pnls),
      avgBarsHeld: ts.length > 0 ? mean(ts.map((t) => t.barsHeld)) : 0,
    };
  });
}

function buildRegimeBreakdown(trades: Trade[]): RegimeBreakdown[] {
  const groups = new Map<string, Trade[]>();
  for (const t of trades) {
    const arr = groups.get(t.marketRegime) ?? [];
    arr.push(t);
    groups.set(t.marketRegime, arr);
  }
  return Array.from(groups.entries()).map(([regime, ts]) => {
    const wins = ts.filter((t) => t.netPnl > 0).length;
    const pnls = ts.map((t) => t.netPnl);
    return {
      regime,
      trades: ts.length,
      winRate: ts.length > 0 ? wins / ts.length : 0,
      netPnlINR: pnls.reduce((a, b) => a + b, 0),
      avgPnlPct: ts.length > 0 ? mean(ts.map((t) => t.pnlPct)) : 0,
    };
  });
}
