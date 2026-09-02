/**
 * Paper Trading Fidelity Engine — Phases 37–40
 *
 * Phase 37: Realistic paper execution model (spread, slippage, latency,
 *           partial fills, market order impact, EOD square-off).
 * Phase 38: Signal → Paper funnel tracker (opportunities → signals →
 *           qualified → risk approved → paper orders → filled → winners/losers).
 * Phase 39: Today's Signal Audit Mode (TODAY_SIGNAL_AUDIT_MODE).
 * Phase 40: Research / Live / Paper isolation enforcement.
 *
 * Key rules:
 *   - Paper fill ≠ candle close. Realistic execution must be modelled.
 *   - Every stage of the funnel must be counted and reported.
 *   - BACKTEST / RESEARCH / SHADOW / PAPER / LIVE datasets must NEVER mix.
 */

import type { TodaySignalAuditReport, UniverseCoverageSnapshot } from "./types";
import type { SignalSourceType } from "./types";

// ─── Execution Mode Isolation ─────────────────────────────────────────────────

/**
 * Execution modes. These must NEVER mix results in any report or metric.
 * Promotion between modes requires explicit evidence gates.
 */
export type ExecutionMode =
  | "BACKTEST"   // Historical simulation — no live data, no live decisions
  | "RESEARCH"   // Research / experimental — separate dataset, no production impact
  | "SHADOW"     // Silent live run — signals computed but NOT paper-traded
  | "PAPER"      // Paper trading — DB-only trades, no broker calls
  | "LIVE";      // Live trading — real broker orders (requires LIVE_TRADING_ENABLED=true)

/**
 * Assert that a given execution mode is NOT mixing with another.
 * Throws if the isolation contract is violated.
 */
export function assertExecutionModeIsolation(
  requestedMode: ExecutionMode,
  contextMode: ExecutionMode,
  context: string,
): void {
  if (requestedMode !== contextMode) {
    throw new Error(
      `[ExecutionIsolation] Mode mismatch in ${context}: ` +
        `requested=${requestedMode} but context=${contextMode}. ` +
        `BACKTEST/RESEARCH/SHADOW/PAPER/LIVE results must never mix.`,
    );
  }
}

/**
 * Check whether a mode can produce paper trades.
 * BACKTEST and RESEARCH never open real paper trades.
 */
export function canProducePaperTrades(mode: ExecutionMode): boolean {
  return mode === "PAPER" || mode === "LIVE";
}

/**
 * Check whether a mode can produce live orders.
 * Only LIVE mode with LIVE_TRADING_ENABLED=true.
 */
export function canProduceLiveOrders(mode: ExecutionMode): boolean {
  if (mode !== "LIVE") return false;
  return process.env.LIVE_TRADING_ENABLED === "true";
}

// ─── Paper Execution Model ────────────────────────────────────────────────────

/**
 * Realistic paper execution parameters.
 * These model the difference between signal price and actual fill.
 */
export interface PaperExecutionParams {
  /** Entry signal price (mid-price) */
  signalPrice: number;
  /** Bid-ask spread at signal time (₹) — null if unavailable */
  bidAskSpread: number | null;
  /** Estimated market order impact (% of price) */
  marketImpactPct: number;
  /** Latency from signal detection to order placement (ms) */
  latencyMs: number;
  /** Whether to use limit order (fill at signal price) or market order */
  orderType: "LIMIT" | "MARKET";
  /** Price change during latency period (₹) */
  priceChangeDuringLatency: number | null;
  /** Whether partial fill is possible (lot size constraints) */
  allowPartialFill: boolean;
  /** IST minutes from midnight — for EOD square-off detection */
  istMinutes: number;
}

export interface PaperFillResult {
  /** Filled price — may differ from signal price */
  fillPrice: number;
  /** Whether the order was filled */
  filled: boolean;
  /** If not filled, reason */
  notFilledReason: string | null;
  /** Total cost of fill (spread + market impact + slippage) as % */
  totalCostPct: number;
  /** Estimated slippage from signal price */
  slippagePct: number;
  /** Whether this is an EOD forced close */
  isEodSquareOff: boolean;
  /** Execution quality assessment */
  executionQuality: "REALISTIC" | "OPTIMISTIC" | "PESSIMISTIC";
  reasons: string[];
}

/**
 * Compute a realistic paper fill price.
 *
 * Rules:
 *   - Market orders: fill at mid + half spread + market impact
 *   - Limit orders: fill at signal price if within bid/ask, else miss
 *   - EOD square-off: fill at last traded price (approximated by close)
 *   - Latency: price may move during order placement delay
 */
export function computePaperFill(params: PaperExecutionParams): PaperFillResult {
  const reasons: string[] = [];
  let fillPrice = params.signalPrice;
  let filled = true;
  let notFilledReason: string | null = null;
  let slippagePct = 0;
  const isEodSquareOff = params.istMinutes >= 15 * 60 + 28;

  if (isEodSquareOff) {
    // EOD square-off: use signal price (represents last traded price approximation)
    reasons.push("EOD square-off: filled at approximate last traded price");
    return {
      fillPrice,
      filled: true,
      notFilledReason: null,
      totalCostPct: 0.05, // minimal EOD slippage
      slippagePct: 0.05,
      isEodSquareOff: true,
      executionQuality: "OPTIMISTIC",
      reasons,
    };
  }

  // Apply latency price drift
  if (params.priceChangeDuringLatency !== null && params.latencyMs > 0) {
    fillPrice += params.priceChangeDuringLatency;
    if (Math.abs(params.priceChangeDuringLatency) > 0) {
      reasons.push(`Latency drift: ${params.priceChangeDuringLatency > 0 ? "+" : ""}${params.priceChangeDuringLatency.toFixed(2)}₹ in ${params.latencyMs}ms`);
    }
  }

  // Spread cost
  const spreadCost = params.bidAskSpread !== null ? params.bidAskSpread / 2 : params.signalPrice * 0.0003;
  const spreadPct = (spreadCost / params.signalPrice) * 100;

  if (params.orderType === "MARKET") {
    // Market order: fill at ask (for BUY) = mid + half spread + market impact
    const marketImpact = params.signalPrice * params.marketImpactPct / 100;
    fillPrice += spreadCost + marketImpact;
    slippagePct = spreadPct + params.marketImpactPct;
    reasons.push(`Market order: +${spreadPct.toFixed(3)}% spread + ${params.marketImpactPct.toFixed(3)}% impact`);
  } else {
    // Limit order: may not fill if price moved away
    const maxSlippage = spreadCost * 1.5;
    if (Math.abs(fillPrice - params.signalPrice) > maxSlippage) {
      filled = false;
      notFilledReason = `Limit order missed: price moved ${(Math.abs(fillPrice - params.signalPrice)).toFixed(2)}₹ beyond limit`;
      reasons.push(notFilledReason);
    } else {
      // Filled at signal price (limit order)
      fillPrice = params.signalPrice;
      slippagePct = 0;
      reasons.push("Limit order filled at signal price");
    }
  }

  const BASE_COST_PCT = 0.05; // NSE F&O round-trip base cost
  const totalCostPct = BASE_COST_PCT + slippagePct;

  const executionQuality: PaperFillResult["executionQuality"] =
    slippagePct < 0.05 ? "REALISTIC" :
    slippagePct < 0.15 ? "REALISTIC" :
    slippagePct < 0.30 ? "PESSIMISTIC" : "PESSIMISTIC";

  return {
    fillPrice,
    filled,
    notFilledReason,
    totalCostPct,
    slippagePct,
    isEodSquareOff,
    executionQuality,
    reasons,
  };
}

// ─── Signal → Paper Funnel — Phase 38 ────────────────────────────────────────

export type FunnelStage =
  | "OPPORTUNITIES_DETECTED"
  | "SIGNALS_GENERATED"
  | "SIGNALS_QUALIFIED"
  | "RISK_APPROVED"
  | "PAPER_ORDERS_PLACED"
  | "PAPER_ORDERS_FILLED"
  | "WINNERS"
  | "LOSERS";

export interface FunnelStageCount {
  stage: FunnelStage;
  count: number;
  /** Pass rate vs previous stage [0, 1] */
  passRate: number;
  /** Edge gained or lost vs previous stage (precision delta) */
  edgeDelta: number | null;
  notes: string;
}

export interface SignalPaperFunnel {
  strategyId: string;
  stages: FunnelStageCount[];
  bottleneck: FunnelStage | null;
  bottleneckDescription: string;
  /** Win rate from filled orders */
  paperWinRate: number | null;
  /** P&L from paper trades */
  paperPnlPct: number | null;
}

/**
 * Build a signal-to-paper funnel from raw counts.
 * This identifies where AlphaForge is losing opportunities.
 */
export function buildSignalPaperFunnel(
  strategyId: string,
  opportunitiesDetected: number,
  signalsGenerated: number,
  signalsQualified: number,
  riskApproved: number,
  paperOrdersPlaced: number,
  paperOrdersFilled: number,
  winners: number,
  losers: number,
  winnerPnls: number[],
  loserPnls: number[],
): SignalPaperFunnel {
  const safeRate = (num: number, den: number) => (den > 0 ? num / den : 0);

  const stages: FunnelStageCount[] = [
    {
      stage: "OPPORTUNITIES_DETECTED",
      count: opportunitiesDetected,
      passRate: 1,
      edgeDelta: null,
      notes: "Raw market opportunities (independent estimate)",
    },
    {
      stage: "SIGNALS_GENERATED",
      count: signalsGenerated,
      passRate: safeRate(signalsGenerated, opportunitiesDetected),
      edgeDelta: null,
      notes: "Signals actually generated by strategy engine",
    },
    {
      stage: "SIGNALS_QUALIFIED",
      count: signalsQualified,
      passRate: safeRate(signalsQualified, signalsGenerated),
      edgeDelta: null,
      notes: "Passed validation (data quality, structure, minimum confidence)",
    },
    {
      stage: "RISK_APPROVED",
      count: riskApproved,
      passRate: safeRate(riskApproved, signalsQualified),
      edgeDelta: null,
      notes: "Passed pre-trade risk gate (drawdown, exposure, correlation)",
    },
    {
      stage: "PAPER_ORDERS_PLACED",
      count: paperOrdersPlaced,
      passRate: safeRate(paperOrdersPlaced, riskApproved),
      edgeDelta: null,
      notes: "Paper trade orders placed in DB",
    },
    {
      stage: "PAPER_ORDERS_FILLED",
      count: paperOrdersFilled,
      passRate: safeRate(paperOrdersFilled, paperOrdersPlaced),
      edgeDelta: null,
      notes: "Orders filled at realistic execution prices",
    },
    {
      stage: "WINNERS",
      count: winners,
      passRate: safeRate(winners, paperOrdersFilled),
      edgeDelta: null,
      notes: "Target reached before stop",
    },
    {
      stage: "LOSERS",
      count: losers,
      passRate: safeRate(losers, paperOrdersFilled),
      edgeDelta: null,
      notes: "Stop hit before target",
    },
  ];

  // Find bottleneck: stage with largest absolute drop in pass rate
  let bottleneck: FunnelStage | null = null;
  let maxDrop = 0;
  for (let i = 1; i < stages.length - 1; i++) {
    const drop = 1 - stages[i].passRate;
    if (drop > maxDrop && stages[i - 1].count > 0) {
      maxDrop = drop;
      bottleneck = stages[i].stage;
    }
  }

  const paperWinRate = paperOrdersFilled > 0 ? safeRate(winners, winners + losers) : null;
  const avgWin = winnerPnls.length > 0 ? winnerPnls.reduce((a, b) => a + b, 0) / winnerPnls.length : 0;
  const avgLoss = loserPnls.length > 0 ? loserPnls.reduce((a, b) => a + b, 0) / loserPnls.length : 0;
  const paperPnlPct =
    paperOrdersFilled > 0
      ? (winners * avgWin + losers * avgLoss) / paperOrdersFilled
      : null;

  const bottleneckDescription =
    bottleneck === null
      ? "No single bottleneck — funnel is well-balanced"
      : `Most opportunities lost at ${bottleneck}: ${(maxDrop * 100).toFixed(1)}% drop-off`;

  return {
    strategyId,
    stages,
    bottleneck,
    bottleneckDescription,
    paperWinRate,
    paperPnlPct,
  };
}

// ─── Today Signal Audit Mode — Phase 39 ──────────────────────────────────────

/**
 * Build a TodaySignalAuditReport from per-session data.
 *
 * This is the reusable daily report structure. Run it every trading day
 * to get a complete audit of:
 *   - Universe coverage
 *   - Signals detected and qualified
 *   - Risk approvals
 *   - Paper trades
 *   - P&L
 *   - ML contribution
 *   - Execution quality
 */
export function buildTodaySignalAuditReport(params: {
  sessionDate: string;
  universeCoverage: UniverseCoverageSnapshot;
  signalsDetected: number;
  signalsQualified: number;
  riskApproved: number;
  paperTradesOpened: number;
  paperTradesResolved: number;
  winners: number;
  losers: number;
  missedOpportunities: number;
  falseSignals: number;
  duplicatesPrevented: number;
  riskRejected: number;
  byStrategy: Array<{
    strategyId: string;
    sourceType: SignalSourceType;
    signalsDetected: number;
    qualified: number;
    paperTrades: number;
    wins: number;
    losses: number;
    pnlPct: number;
  }>;
  mlEvaluated: boolean;
  mlBaseSignals: number;
  mlFilteredIn: number;
  mlFilteredOut: number;
  mlIncrementalPrecision: number;
  avgSpreadPct: number;
  avgSlippagePct: number;
  dataFreshnessScore: number;
  replayHash: string | null;
}): TodaySignalAuditReport {
  return {
    sessionDate: params.sessionDate,
    generatedAtMs: Date.now(),
    universeCoverage: params.universeCoverage,
    signalsDetected: params.signalsDetected,
    signalsQualified: params.signalsQualified,
    riskApproved: params.riskApproved,
    paperTradesOpened: params.paperTradesOpened,
    paperTradesResolved: params.paperTradesResolved,
    winners: params.winners,
    losers: params.losers,
    missedOpportunities: params.missedOpportunities,
    falseSignals: params.falseSignals,
    duplicatesPrevented: params.duplicatesPrevented,
    riskRejected: params.riskRejected,
    byStrategy: params.byStrategy,
    mlContribution: {
      evaluated: params.mlEvaluated,
      baseSignals: params.mlBaseSignals,
      mlFilteredIn: params.mlFilteredIn,
      mlFilteredOut: params.mlFilteredOut,
      incrementalPrecision: params.mlIncrementalPrecision,
    },
    executionQuality: {
      avgSpreadPct: params.avgSpreadPct,
      avgSlippagePct: params.avgSlippagePct,
      dataFreshnessScore: params.dataFreshnessScore,
    },
    replayHash: params.replayHash,
  };
}

/**
 * Generate a deterministic replay hash from an audit report.
 * The same session replayed with the same data MUST produce the same hash.
 * Any difference requires investigation.
 */
export function computeReplayHash(report: TodaySignalAuditReport): string {
  // Use a deterministic JSON serialization (sorted keys)
  const deterministicData = {
    sessionDate: report.sessionDate,
    signalsDetected: report.signalsDetected,
    signalsQualified: report.signalsQualified,
    riskApproved: report.riskApproved,
    paperTradesOpened: report.paperTradesOpened,
    winners: report.winners,
    losers: report.losers,
    byStrategy: [...report.byStrategy].sort((a, b) =>
      a.strategyId.localeCompare(b.strategyId),
    ),
    coverageScore: report.universeCoverage.coverageScore,
    expectedInstruments: report.universeCoverage.expectedInstruments,
  };

  // Simple hash using JSON serialization (replace with SHA-256 in production)
  const json = JSON.stringify(deterministicData);
  let hash = 0;
  for (let i = 0; i < json.length; i++) {
    const char = json.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return `h${Math.abs(hash).toString(16).padStart(8, "0")}`;
}
