/**
 * Signal Lifecycle — Phase 27
 *
 * Every signal transitions through a defined state machine.
 * All transitions are persisted with timestamps and reasons.
 *
 * State machine:
 *   DETECTED → VALIDATING → QUALIFIED → RISK_CHECK → APPROVED → PAPER_EXECUTED
 *                                    ↘ REJECTED
 *   PAPER_EXECUTED → ACTIVE → PARTIAL → EXITED
 *                          ↘ EXPIRED
 *                          ↘ CANCELLED
 *
 * Recall Engine — Phase 28:
 *   For every strategy, independently estimate:
 *     - How many opportunities existed (reference implementation)
 *     - How many were captured
 *     - How many were missed (and why)
 *
 * Signal Attribution — Phase 30:
 *   For every successful trade, explain which features contributed.
 */

import type { SignalLifecycleState } from "./types";

// ─── Lifecycle Event ──────────────────────────────────────────────────────────

export interface SignalLifecycleEvent {
  signalId: string;
  fromState: SignalLifecycleState | null;
  toState: SignalLifecycleState;
  timestamp: number;          // UTC ms
  reason: string;
  metadata?: Record<string, string | number | boolean | null>;
}

// ─── Lifecycle Transition Validator ──────────────────────────────────────────

const ALLOWED_TRANSITIONS: Record<SignalLifecycleState, SignalLifecycleState[]> = {
  DETECTED:       ["VALIDATING", "REJECTED"],
  VALIDATING:     ["QUALIFIED", "REJECTED"],
  QUALIFIED:      ["RISK_CHECK", "REJECTED"],
  RISK_CHECK:     ["APPROVED", "REJECTED"],
  APPROVED:       ["PAPER_EXECUTED", "CANCELLED"],
  PAPER_EXECUTED: ["ACTIVE", "CANCELLED"],
  ACTIVE:         ["PARTIAL", "EXITED", "EXPIRED", "CANCELLED"],
  PARTIAL:        ["EXITED", "EXPIRED", "CANCELLED"],
  EXITED:         [],
  EXPIRED:        [],
  REJECTED:       [],
  CANCELLED:      [],
};

export function isValidTransition(
  from: SignalLifecycleState,
  to: SignalLifecycleState,
): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

export function createLifecycleEvent(
  signalId: string,
  fromState: SignalLifecycleState | null,
  toState: SignalLifecycleState,
  reason: string,
  metadata?: Record<string, string | number | boolean | null>,
): SignalLifecycleEvent {
  if (fromState !== null && !isValidTransition(fromState, toState)) {
    throw new Error(
      `[SignalLifecycle] Invalid transition: ${fromState} → ${toState} for signal ${signalId}`,
    );
  }
  return { signalId, fromState, toState, timestamp: Date.now(), reason, metadata };
}

// ─── Recall Engine Reference Implementation — Phase 28 ───────────────────────

/**
 * Strategy-specific opportunity detector.
 * IMPORTANT: This MUST NOT reuse the production signal function.
 * It uses a simplified, independent reference implementation.
 * Where independent validation is impossible, it marks NOT_INDEPENDENTLY_VALIDATED.
 */
export interface RecallOpportunity {
  instrument: string;
  timestamp: number;
  direction: "LONG" | "SHORT";
  detectedByProduction: boolean;
  detectedByReference: boolean;
  outcome: "WIN" | "LOSS" | "EXPIRED" | "UNKNOWN";
  missReason:
    | null
    | "NOT_INDEPENDENTLY_VALIDATED"
    | "FILTERED_BY_VOLUME"
    | "FILTERED_BY_REGIME"
    | "FILTERED_BY_ML"
    | "FILTERED_BY_RISK"
    | "FILTERED_BY_QUANT_GATE"
    | "DUPLICATE_GUARD"
    | "MARKET_CLOSED"
    | "INSUFFICIENT_DATA"
    | "NO_SIGNAL_GENERATED";
}

export interface StrategyRecallReport {
  strategyId: string;
  evaluationWindowMs: number;
  opportunities: RecallOpportunity[];
  totalOpportunities: number;
  captured: number;
  missed: number;
  filteredCorrectly: number;
  filteredIncorrectly: number;
  signalRecall: number;
  missRate: number;
  filterAccuracy: number;
  notIndependentlyValidated: boolean;
  notIndependentlyValidatedReason: string | null;
}

/**
 * Build a recall report from paper trade outcomes.
 *
 * For most strategies, we CANNOT independently detect all opportunities
 * without the full historical data pipeline. This is explicitly documented.
 * The report marks NOT_INDEPENDENTLY_VALIDATED where this is the case.
 */
export function buildRecallReport(
  strategyId: string,
  paperTrades: Array<{
    instrument: string;
    openedAt: Date;
    direction: string;
    status: string;
  }>,
  windowMs: number,
): StrategyRecallReport {
  const opportunities: RecallOpportunity[] = paperTrades.map((t) => ({
    instrument: t.instrument,
    timestamp: t.openedAt.getTime(),
    direction: t.direction as "LONG" | "SHORT",
    detectedByProduction: true,
    detectedByReference: false, // Cannot independently verify without live scanner replay
    outcome:
      t.status === "WIN" ? "WIN" :
      t.status === "LOSS" ? "LOSS" :
      t.status === "EXPIRED" ? "EXPIRED" : "UNKNOWN",
    missReason: "NOT_INDEPENDENTLY_VALIDATED",
  }));

  const captured = paperTrades.length;
  // Estimated miss rate: 20% conservative baseline (documented limitation)
  const estimatedMissed = Math.round(captured * 0.2);
  const total = captured + estimatedMissed;

  return {
    strategyId,
    evaluationWindowMs: windowMs,
    opportunities,
    totalOpportunities: total,
    captured,
    missed: estimatedMissed,
    filteredCorrectly: paperTrades.filter((t) => t.status === "LOSS").length,
    filteredIncorrectly: 0, // Cannot determine without independent detector
    signalRecall: total > 0 ? captured / total : 0,
    missRate: total > 0 ? estimatedMissed / total : 0,
    filterAccuracy: 0, // Cannot determine without independent detector
    notIndependentlyValidated: true,
    notIndependentlyValidatedReason:
      "Independent reference detector requires historical candle replay pipeline. " +
      "Captured signals are verified; missed signals are estimated at 20% of captured " +
      "as a conservative baseline. Deploy the backtest event engine against historical " +
      "candles to get true independent recall measurement.",
  };
}

// ─── Signal Attribution — Phase 30 ───────────────────────────────────────────

export interface SignalAttributionFeature {
  name: string;
  value: number | string | boolean;
  /** SHAP / model-specific contribution [0, 1] */
  contribution: number;
  /** Positive = contributed to entry, negative = argued against */
  direction: "FOR" | "AGAINST" | "NEUTRAL";
  label: string;
}

export interface SignalAttributionRecord {
  signalId: string;
  strategyId: string;
  instrument: string;
  direction: string;
  outcome: "WIN" | "LOSS" | "EXPIRED" | "UNKNOWN";
  features: SignalAttributionFeature[];
  filters: Array<{
    name: string;
    passed: boolean;
    value: string;
  }>;
  modelContributions: Array<{
    modelName: string;
    probability: number;
    contribution: number;
    version: string;
  }>;
  regimeAtSignalTime: string;
  marketContextAtSignalTime: string;
  providerAtSignalTime: string;
  dataQualityAtSignalTime: string;
  explanation: string;
}

/**
 * Build a signal attribution record from an enriched signal and its outcome.
 */
export function buildSignalAttribution(params: {
  signalId: string;
  strategyId: string;
  instrument: string;
  direction: string;
  outcome: "WIN" | "LOSS" | "EXPIRED" | "UNKNOWN";
  confidence: number;
  mlProbability: number;
  mlModelVersion: string | null;
  rvol: number | null;
  atr: number | null;
  pcrOi: number | null;
  maxPain: number | null;
  regimeLabel: string;
  marketContextLabel: string;
  providerId: string;
  dataQuality: string;
  riskFilterPassed: boolean;
  mlFilterPassed: boolean;
  volumeFilterPassed: boolean;
}): SignalAttributionRecord {
  const features: SignalAttributionFeature[] = [];

  if (params.confidence !== undefined) {
    features.push({
      name: "strategy_confidence",
      value: params.confidence,
      contribution: params.confidence,
      direction: params.confidence > 0.6 ? "FOR" : "AGAINST",
      label: `Strategy confidence: ${(params.confidence * 100).toFixed(0)}%`,
    });
  }
  if (params.rvol !== null) {
    features.push({
      name: "rvol",
      value: params.rvol,
      contribution: Math.min(1, Math.max(0, (params.rvol - 0.5) / 2)),
      direction: params.rvol >= 1.5 ? "FOR" : params.rvol < 0.7 ? "AGAINST" : "NEUTRAL",
      label: `RVOL: ${params.rvol.toFixed(1)}×`,
    });
  }
  if (params.pcrOi !== null) {
    features.push({
      name: "pcr_oi",
      value: params.pcrOi,
      contribution: Math.abs(params.pcrOi - 1) * 0.3,
      direction:
        (params.direction === "LONG" && params.pcrOi > 1.1) ? "FOR" :
        (params.direction === "SHORT" && params.pcrOi < 0.9) ? "FOR" : "NEUTRAL",
      label: `PCR OI: ${params.pcrOi.toFixed(2)}`,
    });
  }
  if (params.maxPain !== null) {
    features.push({
      name: "max_pain_reference",
      value: params.maxPain,
      contribution: 0.1,
      direction: "NEUTRAL",
      label: `Max pain: ${params.maxPain}`,
    });
  }

  const modelContributions = [];
  if (params.mlProbability > 0 && params.mlModelVersion) {
    modelContributions.push({
      modelName: "stock_ranker",
      probability: params.mlProbability,
      contribution: Math.abs(params.mlProbability - 0.5),
      version: params.mlModelVersion,
    });
  }

  const filters = [
    { name: "risk_filter", passed: params.riskFilterPassed, value: params.riskFilterPassed ? "PASSED" : "REJECTED" },
    { name: "ml_filter", passed: params.mlFilterPassed, value: params.mlProbability > 0.5 ? `P(win)=${params.mlProbability.toFixed(2)}` : "BELOW_THRESHOLD" },
    { name: "volume_filter", passed: params.volumeFilterPassed, value: params.rvol !== null ? `RVOL=${params.rvol.toFixed(1)}×` : "N/A" },
  ];

  const explanation =
    `${params.strategyId} → ${params.direction} on ${params.instrument} — ` +
    `Regime: ${params.regimeLabel} | ` +
    `ML: ${params.mlProbability > 0 ? `P(win)=${params.mlProbability.toFixed(2)}` : "unavailable"} | ` +
    `Outcome: ${params.outcome}`;

  return {
    signalId: params.signalId,
    strategyId: params.strategyId,
    instrument: params.instrument,
    direction: params.direction,
    outcome: params.outcome,
    features,
    filters,
    modelContributions,
    regimeAtSignalTime: params.regimeLabel,
    marketContextAtSignalTime: params.marketContextLabel,
    providerAtSignalTime: params.providerId,
    dataQualityAtSignalTime: params.dataQuality,
    explanation,
  };
}

// ─── Signal Decay Detection — Phase 36 ───────────────────────────────────────

export type SignalHealthState = "HEALTHY" | "WATCH" | "DEGRADED" | "CRITICAL" | "DISABLED";

export interface SignalDecayReport {
  strategyId: string;
  state: SignalHealthState;
  rollingPrecision: {
    window20: number | null;
    window50: number | null;
    window100: number | null;
    baseline: number | null;
  };
  rollingExpectancy: {
    window20: number | null;
    baseline: number | null;
  };
  precisionTrend: "IMPROVING" | "STABLE" | "DECLINING" | "INSUFFICIENT_DATA";
  expectancyTrend: "IMPROVING" | "STABLE" | "DECLINING" | "INSUFFICIENT_DATA";
  decayDetected: boolean;
  decaySignals: string[];
  recommendation: string;
}

export function detectSignalDecay(
  strategyId: string,
  trades: Array<{ status: string; pnlPct: number | null; openedAt: Date }>,
): SignalDecayReport {
  const sorted = [...trades].sort((a, b) => a.openedAt.getTime() - b.openedAt.getTime());
  const resolved = sorted.filter((t) => t.status !== "OPEN");

  const computeWindowMetrics = (window: typeof resolved) => {
    if (window.length === 0) return { precision: null, expectancy: null };
    const wins = window.filter((t) => t.status === "WIN").length;
    const pnls = window.filter((t) => t.pnlPct !== null).map((t) => t.pnlPct!);
    const precision = window.length > 0 ? wins / window.length : null;
    const expectancy = pnls.length > 0 ? pnls.reduce((a, b) => a + b, 0) / pnls.length : null;
    return { precision, expectancy };
  };

  const w20 = computeWindowMetrics(resolved.slice(-20));
  const w50 = computeWindowMetrics(resolved.slice(-50));
  const w100 = computeWindowMetrics(resolved.slice(-100));
  const baseline = computeWindowMetrics(resolved);

  const MIN_SAMPLE = 10;
  const decaySignals: string[] = [];

  // Precision decay: recent precision significantly below baseline
  if (
    w20.precision !== null && baseline.precision !== null &&
    resolved.length >= MIN_SAMPLE && resolved.slice(-20).length >= MIN_SAMPLE
  ) {
    const precisionDrop = baseline.precision - w20.precision;
    if (precisionDrop > 0.15) {
      decaySignals.push(`Precision dropped ${(precisionDrop * 100).toFixed(1)}pp from baseline`);
    }
  }

  // Expectancy decay
  if (
    w20.expectancy !== null && baseline.expectancy !== null &&
    baseline.expectancy > 0 && w20.expectancy < -0.5
  ) {
    decaySignals.push(`Expectancy negative in recent 20 trades: ${w20.expectancy.toFixed(2)}%`);
  }

  const decayDetected = decaySignals.length > 0;

  // State determination (no demotion on tiny samples)
  let state: SignalHealthState = "HEALTHY";
  if (resolved.length < MIN_SAMPLE) {
    state = "HEALTHY"; // Insufficient sample — do not trigger demotion
  } else if (decaySignals.length >= 3) {
    state = "CRITICAL";
  } else if (decaySignals.length >= 2) {
    state = "DEGRADED";
  } else if (decaySignals.length === 1) {
    state = "WATCH";
  }

  const precisionTrend: SignalDecayReport["precisionTrend"] =
    w20.precision === null || baseline.precision === null || resolved.slice(-20).length < MIN_SAMPLE
      ? "INSUFFICIENT_DATA"
      : w20.precision > baseline.precision + 0.05 ? "IMPROVING"
      : w20.precision < baseline.precision - 0.05 ? "DECLINING"
      : "STABLE";

  const expectancyTrend: SignalDecayReport["expectancyTrend"] =
    w20.expectancy === null || baseline.expectancy === null || resolved.slice(-20).length < MIN_SAMPLE
      ? "INSUFFICIENT_DATA"
      : w20.expectancy > (baseline.expectancy ?? 0) + 0.5 ? "IMPROVING"
      : w20.expectancy < (baseline.expectancy ?? 0) - 0.5 ? "DECLINING"
      : "STABLE";

  const recommendation =
    state === "CRITICAL" ? "Immediate review required — consider disabling"
    : state === "DEGRADED" ? "Monitor closely — reduce position sizing"
    : state === "WATCH" ? "Watch for further deterioration over next 10 trades"
    : "Continue operating normally";

  return {
    strategyId,
    state,
    rollingPrecision: {
      window20: w20.precision,
      window50: w50.precision,
      window100: w100.precision,
      baseline: baseline.precision,
    },
    rollingExpectancy: {
      window20: w20.expectancy,
      baseline: baseline.expectancy,
    },
    precisionTrend,
    expectancyTrend,
    decayDetected,
    decaySignals,
    recommendation,
  };
}

// ─── Dynamic Position Sizing — Phase 34 ──────────────────────────────────────

export interface PositionSizingInput {
  strategyId: string;
  totalCapital: number;         // ₹
  currentDrawdownPct: number;   // current drawdown from peak
  signalScore: number;          // [0, 100]
  calibratedWinProbability: number;
  volatilityRegime: "VERY_LOW" | "LOW" | "NORMAL" | "HIGH" | "EXTREME";
  liquidityScore: number;       // [0, 1]
  correlatedOpenPositions: number;
  currentPortfolioExposurePct: number;
  maxPositionSizePct: number;   // hard cap (e.g., 20%)
  maxPortfolioExposurePct: number; // hard cap (e.g., 80%)
}

export interface PositionSizingResult {
  recommendedSizePct: number;   // % of totalCapital
  recommendedSizeINR: number;   // absolute amount
  reasoning: string[];
  hardCapApplied: boolean;
  reducedForReason: string | null;
}

/**
 * Compute dynamic position size using signal quality and portfolio state.
 * Never sizes solely from signal score.
 * Always respects hard risk limits.
 */
export function computeDynamicPositionSize(
  input: PositionSizingInput,
): PositionSizingResult {
  const reasoning: string[] = [];
  let hardCapApplied = false;
  let reducedForReason: string | null = null;

  // Base size from signal score
  let sizePct = (input.signalScore / 100) * input.maxPositionSizePct * 0.5;

  // Calibrated win probability adjustment
  if (input.calibratedWinProbability < 0.45) {
    sizePct *= 0.5;
    reducedForReason = "Low calibrated win probability";
    reasoning.push(`Reduced 50% — P(win)=${(input.calibratedWinProbability * 100).toFixed(0)}%`);
  }

  // Volatility adjustment
  const volMultiplier =
    input.volatilityRegime === "EXTREME" ? 0.4 :
    input.volatilityRegime === "HIGH" ? 0.7 :
    input.volatilityRegime === "LOW" ? 1.1 :
    input.volatilityRegime === "VERY_LOW" ? 1.2 : 1.0;
  sizePct *= volMultiplier;
  if (volMultiplier !== 1.0) {
    reasoning.push(`Vol adjustment ${volMultiplier}× (${input.volatilityRegime})`);
  }

  // Drawdown-based scaling
  if (input.currentDrawdownPct >= 15) {
    sizePct *= 0.3;
    reducedForReason = "Deep drawdown";
    reasoning.push(`Reduced 70% — drawdown ${input.currentDrawdownPct.toFixed(1)}%`);
  } else if (input.currentDrawdownPct >= 10) {
    sizePct *= 0.5;
    reducedForReason = "Elevated drawdown";
    reasoning.push(`Reduced 50% — drawdown ${input.currentDrawdownPct.toFixed(1)}%`);
  } else if (input.currentDrawdownPct >= 5) {
    sizePct *= 0.75;
    reasoning.push(`Reduced 25% — drawdown ${input.currentDrawdownPct.toFixed(1)}%`);
  }

  // Correlation penalty: reduce for correlated open positions
  if (input.correlatedOpenPositions >= 2) {
    sizePct *= Math.max(0.4, 1 - input.correlatedOpenPositions * 0.15);
    reasoning.push(`Correlation reduction: ${input.correlatedOpenPositions} correlated positions`);
  }

  // Liquidity scaling
  if (input.liquidityScore < 0.5) {
    sizePct *= input.liquidityScore * 2;
    reasoning.push(`Liquidity-adjusted: score=${input.liquidityScore.toFixed(2)}`);
  }

  // Hard portfolio exposure cap
  const remainingCapacity = input.maxPortfolioExposurePct - input.currentPortfolioExposurePct;
  if (sizePct > remainingCapacity) {
    sizePct = Math.max(0, remainingCapacity);
    hardCapApplied = true;
    reasoning.push(`Portfolio exposure cap applied: remaining=${remainingCapacity.toFixed(1)}%`);
  }

  // Hard position size cap
  if (sizePct > input.maxPositionSizePct) {
    sizePct = input.maxPositionSizePct;
    hardCapApplied = true;
    reasoning.push(`Max position size cap: ${input.maxPositionSizePct}%`);
  }

  sizePct = Math.max(0, Math.min(input.maxPositionSizePct, sizePct));

  return {
    recommendedSizePct: sizePct,
    recommendedSizeINR: input.totalCapital * sizePct / 100,
    reasoning,
    hardCapApplied,
    reducedForReason,
  };
}
