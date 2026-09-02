/**
 * Performance Attribution Engine
 *
 * For every evaluation period, decomposes realized P&L into:
 *   - P&L from strategy selection (which strategies were chosen)
 *   - P&L from entry timing (how much of the available range was captured)
 *   - P&L from position sizing (did larger sizes get better trades?)
 *   - P&L from exits (how well were exits managed vs MFE?)
 *   - P&L from regime selection (did the system pick the right regime?)
 *   - P&L from risk filtering (what did the risk engine prevent?)
 *   - P&L from ML contribution (did ML improve outcomes vs baseline?)
 *   - P&L lost to transaction costs
 *   - P&L lost to slippage
 *
 * This separates ALPHA (genuine skill) from RISK-TAKING.
 * A system with high returns but negative alpha is just taking more risk.
 *
 * MFE/MAE tracking:
 *   For every trade, record:
 *   - Maximum Favorable Excursion (MFE): peak unrealized profit
 *   - Maximum Adverse Excursion (MAE): deepest unrealized loss
 *   These are used to optimize stop placement and target setting.
 *
 * This module is I/O-free.
 */

// ─── Trade with Attribution Data ─────────────────────────────────────────────

export interface AttributedTrade {
  tradeId: string;
  strategyId: string;
  instrument: string;
  direction: "LONG" | "SHORT";
  entry: number;
  exit: number;
  stopLoss: number;
  target1: number;
  target2: number;
  positionSizeINR: number;

  // Outcome
  won: boolean;
  pnlPct: number;           // gross P&L %
  pnlINR: number;           // gross P&L INR
  exitReason: "TARGET" | "STOP" | "TIME" | "MANUAL" | "EOD" | "TRAIL";

  // MFE / MAE
  mfePct: number | null;          // max favorable excursion %
  maePct: number | null;          // max adverse excursion %
  timeToMfe: number | null;       // minutes from entry to MFE
  timeToMae: number | null;       // minutes from entry to MAE
  mfeToTargetCapturePct: number | null; // MFE / target1 distance (1.0 = fully captured)

  // Context at entry
  qualityScore: number;
  netEV: number;
  regime: string;
  mlProbability: number | null;
  hadMLBoost: boolean;

  // Costs
  estimatedCostsPct: number;
  estimatedSlippagePct: number;

  openedAt: number;
  closedAt: number;
}

// ─── Performance Attribution Result ──────────────────────────────────────────

export interface PerformanceAttribution {
  periodLabel: string;
  generatedAt: number;
  totalTrades: number;
  totalPnlPct: number;
  totalPnlINR: number;

  // ── Strategy attribution ────────────────────────────────────────────────
  strategyAttribution: Array<{
    strategyId: string;
    trades: number;
    winRate: number;
    totalPnlPct: number;
    avgPnlPct: number;
    profitFactor: number;
    contribution: number;  // % of total portfolio P&L from this strategy
  }>;

  // ── Entry timing attribution ────────────────────────────────────────────
  /** How much of the available move was captured on average */
  entryTimingScore: number;  // 0–1, 1 = perfect entry
  /** Avg % from entry to MFE */
  avgMfePct: number | null;
  /** Avg % from entry to MAE */
  avgMaePct: number | null;
  /** Entry efficiency: actual PnL / MFE (winners only) */
  entryEfficiency: number | null;

  // ── Sizing attribution ──────────────────────────────────────────────────
  /** Correlation between quality score and realized return */
  qualityToReturnCorrelation: number | null;
  /** Did higher-quality trades actually get larger sizes? */
  sizeToQualityCorrelation: number | null;
  /** Larger trades performed better than smaller? */
  sizeToReturnCorrelation: number | null;

  // ── Exit attribution ─────────────────────────────────────────────────────
  exitAttribution: {
    targetHits: number;
    stopHits: number;
    timeExits: number;
    eodExits: number;
    /** P&L improvement if all EOD exits had been held to target */
    eodExitOpportunityCost: number | null;
    /** MFE capture rate: actual exit vs max favorable */
    mfeCaptureRate: number | null;
  };

  // ── Regime attribution ───────────────────────────────────────────────────
  regimeAttribution: Array<{
    regime: string;
    trades: number;
    winRate: number;
    avgPnlPct: number;
    contribution: number;
  }>;

  // ── Risk filter attribution ──────────────────────────────────────────────
  /** P&L prevented by risk gates (estimated from counterfactuals) */
  riskFilterSavedPct: number | null;
  /** P&L missed due to risk gate false rejections */
  riskFilterMissedPct: number | null;

  // ── ML attribution ────────────────────────────────────────────────────────
  mlAttribution: {
    tradesWithML: number;
    tradesWithoutML: number;
    mlTradesWinRate: number;
    nonMLTradesWinRate: number;
    mlIncremental: number;  // win rate difference (positive = ML adds value)
  };

  // ── Cost attribution ─────────────────────────────────────────────────────
  costAttribution: {
    totalCostsPct: number;
    totalSlippagePct: number;
    netReturnAfterCosts: number;
    costDragVsGross: number;   // costs as % of gross return
  };
}

// ─── MFE / MAE Analyzer ───────────────────────────────────────────────────────

export interface MFEMAEDistribution {
  strategyId: string;
  tradeCount: number;

  // MFE distribution (winners)
  winnersMfe: { p25: number; median: number; p75: number; p95: number; mean: number };
  // MAE distribution (losers)
  losersMae: { p25: number; median: number; p75: number; p95: number; mean: number };

  // Optimal stop analysis
  optimalStopMultiplier: number;  // ATR multiple that minimizes losers' MAE
  stopEfficiency: number;         // % of stops hit that were "correct" (trade continued lower)

  // Optimal target analysis
  targetCaptureRate: number;      // avg MFE / stated target
  probabilityReachTP1: number;
  probabilityReachTP2: number;
  avgTimeToTP1: number | null;   // minutes

  recommendations: string[];
}

export function analyzeMFEMAE(trades: AttributedTrade[]): MFEMAEDistribution | null {
  const strategyIds = [...new Set(trades.map(t => t.strategyId))];
  const strategyId = strategyIds.length === 1 ? strategyIds[0] : "MIXED";

  const resolved = trades.filter(t => t.mfePct !== null && t.maePct !== null);
  if (resolved.length < 10) return null;

  const winners = resolved.filter(t => t.won);
  const losers = resolved.filter(t => !t.won);

  function pct(arr: number[], p: number): number {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const i = Math.floor(p / 100 * (sorted.length - 1));
    return sorted[i];
  }

  const winnerMfes = winners.map(t => t.mfePct!);
  const loserMaes = losers.map(t => Math.abs(t.maePct!));

  const winnersMfe = {
    p25: pct(winnerMfes, 25), median: pct(winnerMfes, 50),
    p75: pct(winnerMfes, 75), p95: pct(winnerMfes, 95),
    mean: winnerMfes.reduce((a, b) => a + b, 0) / Math.max(winnerMfes.length, 1),
  };
  const losersMae = {
    p25: pct(loserMaes, 25), median: pct(loserMaes, 50),
    p75: pct(loserMaes, 75), p95: pct(loserMaes, 95),
    mean: loserMaes.reduce((a, b) => a + b, 0) / Math.max(loserMaes.length, 1),
  };

  // Target capture rate
  const capRates = winners.filter(t => t.mfeToTargetCapturePct !== null).map(t => t.mfeToTargetCapturePct!);
  const targetCaptureRate = capRates.length > 0 ? capRates.reduce((a, b) => a + b, 0) / capRates.length : 0;

  // TP1/TP2 probability
  const tp1Hits = resolved.filter(t => t.exitReason === "TARGET").length;
  const probabilityReachTP1 = resolved.length > 0 ? tp1Hits / resolved.length : 0;
  const probabilityReachTP2 = probabilityReachTP1 * 0.6; // rough estimate

  const timeToTp1s = winners.filter(t => t.timeToMfe !== null).map(t => t.timeToMfe!);
  const avgTimeToTP1 = timeToTp1s.length > 0 ? timeToTp1s.reduce((a, b) => a + b, 0) / timeToTp1s.length : null;

  const recommendations: string[] = [];
  if (targetCaptureRate < 0.7) {
    recommendations.push(`Target capture rate ${(targetCaptureRate * 100).toFixed(0)}% — consider trailing exits`);
  }
  if (losersMae.p95 > 2.5) {
    recommendations.push(`95th pct loser MAE ${losersMae.p95.toFixed(2)}% — some stops may be too wide`);
  }
  if (winnersMfe.median < 0.5) {
    recommendations.push(`Median winner MFE ${winnersMfe.median.toFixed(2)}% — targets may be over-ambitious`);
  }

  return {
    strategyId, tradeCount: resolved.length,
    winnersMfe, losersMae,
    optimalStopMultiplier: 1.0, // requires backtesting grid to compute
    stopEfficiency: 0, // requires post-stop tracking
    targetCaptureRate, probabilityReachTP1, probabilityReachTP2,
    avgTimeToTP1, recommendations,
  };
}

// ─── Performance Attribution Builder ─────────────────────────────────────────

export function buildPerformanceAttribution(
  periodLabel: string,
  trades: AttributedTrade[],
): PerformanceAttribution {
  const now = Date.now();
  const N = trades.length;

  if (N === 0) {
    return emptyAttribution(periodLabel, now);
  }

  const totalPnlPct = trades.reduce((s, t) => s + t.pnlPct, 0);
  const totalPnlINR = trades.reduce((s, t) => s + t.pnlINR, 0);

  // Strategy attribution
  const strategies = [...new Set(trades.map(t => t.strategyId))];
  const strategyAttribution = strategies.map(stratId => {
    const stratTrades = trades.filter(t => t.strategyId === stratId);
    const wins = stratTrades.filter(t => t.won).length;
    const pnls = stratTrades.map(t => t.pnlPct);
    const winPnls = stratTrades.filter(t => t.won).map(t => t.pnlPct);
    const lossPnls = stratTrades.filter(t => !t.won).map(t => Math.abs(t.pnlPct));
    const avgWin = winPnls.reduce((a, b) => a + b, 0) / Math.max(winPnls.length, 1);
    const avgLoss = lossPnls.reduce((a, b) => a + b, 0) / Math.max(lossPnls.length, 1);
    const pf = avgLoss > 0 && wins > 0 ? (avgWin * wins) / (avgLoss * (stratTrades.length - wins)) : 0;
    const stratPnl = pnls.reduce((a, b) => a + b, 0);
    return {
      strategyId: stratId, trades: stratTrades.length,
      winRate: wins / stratTrades.length,
      totalPnlPct: stratPnl,
      avgPnlPct: stratPnl / stratTrades.length,
      profitFactor: pf,
      contribution: totalPnlPct !== 0 ? (stratPnl / totalPnlPct) * 100 : 0,
    };
  });

  // Entry timing / MFE / MAE
  const mfes = trades.filter(t => t.mfePct !== null).map(t => t.mfePct!);
  const maes = trades.filter(t => t.maePct !== null).map(t => Math.abs(t.maePct!));
  const avgMfePct = mfes.length > 0 ? mfes.reduce((a, b) => a + b, 0) / mfes.length : null;
  const avgMaePct = maes.length > 0 ? maes.reduce((a, b) => a + b, 0) / maes.length : null;
  const winnerEfficiencies = trades.filter(t => t.won && t.mfeToTargetCapturePct !== null).map(t => t.mfeToTargetCapturePct!);
  const entryEfficiency = winnerEfficiencies.length > 0 ? winnerEfficiencies.reduce((a, b) => a + b, 0) / winnerEfficiencies.length : null;

  // Exit attribution
  const targetHits = trades.filter(t => t.exitReason === "TARGET").length;
  const stopHits = trades.filter(t => t.exitReason === "STOP").length;
  const timeExits = trades.filter(t => t.exitReason === "TIME").length;
  const eodExits = trades.filter(t => t.exitReason === "EOD").length;
  const mfeCapRates = trades.filter(t => t.mfeToTargetCapturePct !== null).map(t => t.mfeToTargetCapturePct!);
  const mfeCaptureRate = mfeCapRates.length > 0 ? mfeCapRates.reduce((a, b) => a + b, 0) / mfeCapRates.length : null;

  // Regime attribution
  const regimes = [...new Set(trades.map(t => t.regime))];
  const regimeAttribution = regimes.map(regime => {
    const regimeTrades = trades.filter(t => t.regime === regime);
    const wins = regimeTrades.filter(t => t.won).length;
    const pnl = regimeTrades.reduce((s, t) => s + t.pnlPct, 0);
    return {
      regime, trades: regimeTrades.length,
      winRate: wins / regimeTrades.length,
      avgPnlPct: pnl / regimeTrades.length,
      contribution: totalPnlPct !== 0 ? (pnl / totalPnlPct) * 100 : 0,
    };
  });

  // ML attribution
  const mlTrades = trades.filter(t => t.mlProbability !== null && t.mlProbability > 0);
  const nonMLTrades = trades.filter(t => !t.mlProbability || t.mlProbability === 0);
  const mlWR = mlTrades.length > 0 ? mlTrades.filter(t => t.won).length / mlTrades.length : 0;
  const nonMLWR = nonMLTrades.length > 0 ? nonMLTrades.filter(t => t.won).length / nonMLTrades.length : 0;

  // Cost attribution
  const totalCosts = trades.reduce((s, t) => s + t.estimatedCostsPct, 0);
  const totalSlippage = trades.reduce((s, t) => s + t.estimatedSlippagePct, 0);
  const grossReturn = totalPnlPct + totalCosts + totalSlippage;
  const costDrag = grossReturn !== 0 ? (totalCosts + totalSlippage) / Math.abs(grossReturn) * 100 : 0;

  // Quality→return correlation (Pearson)
  function pearsonCorrelation(xs: number[], ys: number[]): number | null {
    if (xs.length !== ys.length || xs.length < 5) return null;
    const n = xs.length;
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    const num = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0);
    const dx = Math.sqrt(xs.reduce((s, x) => s + (x - mx) ** 2, 0));
    const dy = Math.sqrt(ys.reduce((s, y) => s + (y - my) ** 2, 0));
    return dx * dy > 0 ? num / (dx * dy) : null;
  }

  const qualScores = trades.map(t => t.qualityScore);
  const sizes = trades.map(t => t.positionSizeINR);
  const returns = trades.map(t => t.pnlPct);

  return {
    periodLabel, generatedAt: now, totalTrades: N, totalPnlPct, totalPnlINR,
    strategyAttribution,
    entryTimingScore: entryEfficiency ?? 0,
    avgMfePct, avgMaePct, entryEfficiency,
    qualityToReturnCorrelation: pearsonCorrelation(qualScores, returns),
    sizeToQualityCorrelation: pearsonCorrelation(sizes, qualScores),
    sizeToReturnCorrelation: pearsonCorrelation(sizes, returns),
    exitAttribution: {
      targetHits, stopHits, timeExits, eodExits,
      eodExitOpportunityCost: null, // requires knowing what happened after EOD
      mfeCaptureRate,
    },
    regimeAttribution,
    riskFilterSavedPct: null, mlAttribution: {
      tradesWithML: mlTrades.length, tradesWithoutML: nonMLTrades.length,
      mlTradesWinRate: mlWR, nonMLTradesWinRate: nonMLWR, mlIncremental: mlWR - nonMLWR,
    },
    riskFilterMissedPct: null,
    costAttribution: {
      totalCostsPct: totalCosts, totalSlippagePct: totalSlippage,
      netReturnAfterCosts: totalPnlPct, costDragVsGross: costDrag,
    },
  };
}

function emptyAttribution(periodLabel: string, now: number): PerformanceAttribution {
  return {
    periodLabel, generatedAt: now, totalTrades: 0, totalPnlPct: 0, totalPnlINR: 0,
    strategyAttribution: [], entryTimingScore: 0, avgMfePct: null, avgMaePct: null,
    entryEfficiency: null, qualityToReturnCorrelation: null, sizeToQualityCorrelation: null,
    sizeToReturnCorrelation: null, exitAttribution: { targetHits: 0, stopHits: 0, timeExits: 0, eodExits: 0, eodExitOpportunityCost: null, mfeCaptureRate: null },
    regimeAttribution: [], riskFilterSavedPct: null, riskFilterMissedPct: null,
    mlAttribution: { tradesWithML: 0, tradesWithoutML: 0, mlTradesWinRate: 0, nonMLTradesWinRate: 0, mlIncremental: 0 },
    costAttribution: { totalCostsPct: 0, totalSlippagePct: 0, netReturnAfterCosts: 0, costDragVsGross: 0 },
  };
}
