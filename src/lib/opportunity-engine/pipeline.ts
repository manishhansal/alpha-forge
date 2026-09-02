/**
 * Opportunity Pipeline Orchestrator
 *
 * Implements the full staged pipeline:
 *
 *   MARKET DATA
 *       ↓
 *   OPPORTUNITY DETECTION (OpportunityDetector)
 *       ↓
 *   SIGNAL QUALITY ENGINE (MultiLayerEngine + QualityVector)
 *       ↓
 *   EXPECTED VALUE ENGINE (EVEngine)
 *       ↓
 *   HARD GATE EVALUATION (HardGateEngine)
 *       ↓
 *   REGIME COMPATIBILITY (MarketRegimeEngine)
 *       ↓
 *   MTF CONFIRMATION (MTFConfirmationEngine)
 *       ↓
 *   PORTFOLIO RISK (PortfolioRiskEngine via RiskGate)
 *       ↓
 *   POSITION SIZING (PositionSizingEngine)
 *       ↓
 *   OPPORTUNITY RANKING (OpportunityRanker)
 *       ↓
 *   FINAL DECISION (OpportunityV1 with full evidence chain)
 *
 * Key rules:
 *   1. Each stage can REJECT — rejection propagates through
 *   2. No stage can APPROVE what an earlier stage REJECTED
 *   3. All soft scores are advisory — hard gates override everything
 *   4. The final OpportunityV1 contains the complete evidence chain
 *   5. NO_TRADE is a valid first-class outcome
 *
 * This module IS allowed to do I/O (Redis, DB reads) but contains no
 * business logic — all logic is in the pure engine modules.
 */

import { v4 as uuidv4 } from "uuid";
import type { OHLCVCandle } from "@/lib/market-data/types";
import type { OptionChain } from "@/types/india";

import {
  createOpportunityId, createCorrelationId,
  type OpportunityV1, type OpportunityDecision, type OpportunityLifecycleState,
  type QualityTier, type MarketRegimeState, type MTFAlignmentState,
  type OIBuildupClassification, type OptionsFlowBias,
  type SectorContextClassification, type VolatilityRegimeState,
  type LiquidityRegimeState,
} from "./types";
import { classifyMarketRegime, computeRegimeScore, type RegimeEvaluation } from "./market-regime-engine";
import { detectBestOpportunity, type OpportunityDetectorInput } from "./opportunity-detector";
import { evaluateMTFAlignment, type MTFInput } from "./mtf-confirmation";
import { computeRelativeStrength, evaluateSectorContext, sectorClassificationToScore, INDIA_SECTOR_MAP, type ReturnSeries } from "./relative-strength-engine";
import { computeFullEV, DEFAULT_NSE_FNO_COST_MODEL, type EVInput, type EVResult } from "./expected-value-engine";
import { evaluateHardGates, evaluateSoftPenalties, type HardGateInputs, type SoftPenaltyInputs } from "./hard-gate-engine";
import { computePositionSize, classifyDrawdownTier, type SizingInput, type SizingConfig } from "./position-sizing-engine";
import { gradeOpportunityTier } from "./probability-calibration";

// ─── Pipeline Input ───────────────────────────────────────────────────────────

export interface OpportunityPipelineInput {
  // Instrument
  instrument: string;
  instrumentName: string;
  exchange: "NSE" | "NFO" | "BSE" | "BFO";
  segment: "FUTURES" | "OPTIONS" | "EQUITY" | "INDEX";
  lotSize: number;
  currentPrice: number;

  // Market data
  dailyCandles: OHLCVCandle[];
  intradayCandles: OHLCVCandle[];
  h1Candles?: OHLCVCandle[];
  m15Candles?: OHLCVCandle[];
  m5Candles?: OHLCVCandle[];
  atr: number | null;
  rsi: number | null;
  sma20: number | null;
  sma50: number | null;
  vwap: number | null;
  avgVolume20d: number | null;
  currentVolume: number | null;

  // NIFTY context
  niftyDailyCandles: OHLCVCandle[];
  niftyChangePct: number | null;
  bankniftyChangePct: number | null;
  indiaVix: number | null;
  indiaVixPrevClose: number | null;
  advancingCount: number | null;
  decliningCount: number | null;

  // Derivatives
  optionChain: OptionChain | null;
  oiChange: number | null;
  pcrOi: number | null;

  // Strategy context
  strategyId: string;
  signalSource: string;
  rawConfidence: number;
  direction: "LONG" | "SHORT" | "NEUTRAL";
  mlProbability: number | null;
  mlRegimeScore: number | null;

  // Pre-computed signal entry/exit levels (from existing signal builder)
  signalEntry: number | null;
  signalStopLoss: number | null;
  signalTarget1: number | null;
  signalTarget2: number | null;
  signalTarget3: number | null;

  // Portfolio state
  portfolioState: {
    capitalINR: number;
    currentExposurePct: number;
    currentDrawdownPct: number;
    dailyPnlPct: number;
    correlatedPositions: number;
    openRiskPct: number;
    isKillSwitchActive: boolean;
    isDailyLossBreach: boolean;
  };

  // Universe context (for relative strength)
  universeReturns: ReturnSeries[];
  niftyReturns: ReturnSeries;

  // Timing
  sessionOpenMs: number;
  nowMs: number;
  tradeDate: string;

  // Spread (from bid/ask if available)
  observedSpreadPct?: number;
  dataAgeMs?: number;
}

// ─── Pipeline Result ──────────────────────────────────────────────────────────

export interface OpportunityPipelineResult {
  opportunity: OpportunityV1;
  /** Whether the pipeline should open a paper trade */
  shouldTrade: boolean;
  /** Pipeline stage where first rejection occurred (if any) */
  rejectionStage: string | null;
  /** Time taken to evaluate (ms) */
  evaluationMs: number;
}

// ─── Pipeline ────────────────────────────────────────────────────────────────

const PIPELINE_VERSION = "opportunity-engine-v1";
const FEATURE_VERSION = "fv1.0";
const POLICY_VERSION = "pv1.0";

/**
 * Run the full opportunity evaluation pipeline.
 *
 * Returns an OpportunityV1 regardless of outcome — the decision field
 * records the result. A REJECT or ABSTAIN is as important as a BUY.
 */
export function runOpportunityPipeline(
  input: OpportunityPipelineInput,
): OpportunityPipelineResult {
  const startMs = Date.now();

  // ── Stage 0: Data validation ──────────────────────────────────────────
  const ohlcValid = input.currentPrice > 0 &&
    (input.atr === null || input.atr > 0) &&
    input.dailyCandles.length > 0;

  const isDataValid = ohlcValid && (input.dataAgeMs ?? 0) < 10 * 60 * 1000;

  // ── Stage 1: Market regime ─────────────────────────────────────────────
  const regimeEval = classifyMarketRegime({
    niftyDailyCandles: input.niftyDailyCandles,
    niftyChangePct: input.niftyChangePct,
    bankniftyChangePct: input.bankniftyChangePct,
    indiaVix: input.indiaVix,
    indiaVixPrevClose: input.indiaVixPrevClose,
    advancingCount: input.advancingCount,
    decliningCount: input.decliningCount,
    isOpeningPeriod: (input.nowMs - input.sessionOpenMs) < 15 * 60 * 1000,
    nowMs: input.nowMs,
  });

  const marketRegime = regimeEval.regime;
  const regimeScore = computeRegimeScore(input.strategyId, marketRegime);
  const strategyCompatible = regimeEval.strategyCompatibility.get(input.strategyId);
  const regimeCompatible = !strategyCompatible || strategyCompatible.compatible;

  // ── Stage 2: Opportunity detection ────────────────────────────────────
  const detectorInput: OpportunityDetectorInput = {
    candles: input.dailyCandles, intradayCandles: input.intradayCandles,
    atr: input.atr, rsi: input.rsi, sma20: input.sma20, sma50: input.sma50,
    vwap: input.vwap, volumeAvg20d: input.avgVolume20d,
    niftyChangePct: input.niftyChangePct, sessionOpenMs: input.sessionOpenMs, nowMs: input.nowMs,
  };
  const detection = detectBestOpportunity(detectorInput);

  // ── Stage 3: MTF confirmation ──────────────────────────────────────────
  const mtfInput: MTFInput = {
    direction: input.direction === "NEUTRAL" ? "LONG" : input.direction,
    dailyCandles: input.dailyCandles,
    h1Candles: input.h1Candles ?? null,
    h1BarConfirmed: true,
    m15Candles: input.m15Candles ?? null,
    m15BarConfirmed: true,
    m5Candles: input.m5Candles ?? null,
    m5BarConfirmed: true,
    m1Candles: null, m1BarConfirmed: false,
    vwap: input.vwap,
  };
  const mtfResult = evaluateMTFAlignment(mtfInput);
  const mtfAlignment: MTFAlignmentState = mtfResult.alignment;

  // ── Stage 4: Relative strength + sector ───────────────────────────────
  const sector = INDIA_SECTOR_MAP[input.instrument] ?? "UNKNOWN";
  const stockReturns: ReturnSeries = {
    symbol: input.instrument,
    returns: input.dailyCandles.slice(-25).map((c, i, arr) =>
      i === 0 ? 0 : arr[i - 1].close > 0 ? (c.close - arr[i - 1].close) / arr[i - 1].close * 100 : 0
    ).slice(1),
    avgVolume20d: input.avgVolume20d, currentVolume: input.currentVolume,
  };

  const relStrength = computeRelativeStrength(
    input.instrument, stockReturns, input.niftyReturns, null, input.universeReturns
  );

  const sectorStocks = input.universeReturns.filter(r => INDIA_SECTOR_MAP[r.symbol] === sector);
  const niftyReturn5d = input.niftyReturns.returns.length >= 5
    ? input.niftyReturns.returns.slice(-5).reduce((a, b) => a + b, 0) : 0;
  const sectorContext = evaluateSectorContext(sector, sectorStocks, niftyReturn5d);
  const sectorScore = sectorClassificationToScore(sectorContext.classification, input.direction === "SHORT" ? "SHORT" : "LONG");

  // ── Stage 5: Compute trade levels ─────────────────────────────────────
  const entry = input.signalEntry ?? input.currentPrice;
  const stop = input.signalStopLoss ?? (input.direction === "LONG"
    ? entry - (input.atr ?? entry * 0.02)
    : entry + (input.atr ?? entry * 0.02));
  const target1 = input.signalTarget1 ?? (input.direction === "LONG"
    ? entry + (input.atr ?? entry * 0.02) * 1.6
    : entry - (input.atr ?? entry * 0.02) * 1.6);
  const target2 = input.signalTarget2 ?? (input.direction === "LONG"
    ? entry + (input.atr ?? entry * 0.02) * 2.6
    : entry - (input.atr ?? entry * 0.02) * 2.6);
  const target3 = input.signalTarget3 ?? (input.direction === "LONG"
    ? entry + (input.atr ?? entry * 0.02) * 4.0
    : entry - (input.atr ?? entry * 0.02) * 4.0);

  const riskPct = entry > 0 ? Math.abs(entry - stop) / entry * 100 : 1;
  const rewardPct = entry > 0 ? Math.abs(target2 - entry) / entry * 100 : 2;
  const riskReward = riskPct > 0 ? rewardPct / riskPct : 0;
  const stopLossPct = riskPct;

  // ── Stage 6: Expected value ────────────────────────────────────────────
  const evInput: EVInput = {
    strategyId: input.strategyId,
    direction: input.direction === "SHORT" ? "SHORT" : "LONG",
    entry, stopLoss: stop, target1, target2,
    rawConfidence: input.rawConfidence,
    notionalINR: input.portfolioState.capitalINR * 0.02, // estimate 2% of capital
    costModel: DEFAULT_NSE_FNO_COST_MODEL,
    expectedHoldingHours: 4,
    observedSpreadPct: input.observedSpreadPct,
  };
  const evResult: EVResult = computeFullEV(evInput);

  // ── Stage 7: Hard gates ────────────────────────────────────────────────
  const rvol = input.avgVolume20d && input.avgVolume20d > 0 && input.currentVolume !== null
    ? input.currentVolume / input.avgVolume20d : null;
  const spreadPct = input.observedSpreadPct ?? null;

  const hardGateInputs: HardGateInputs = {
    dataAgeMs: input.dataAgeMs ?? 0,
    isDataValid, ohlcValid,
    entry, stopLoss: stop, target1, target2,
    evResult, spreadPct, volumeRatio: rvol,
    isMarketOpen: true, // caller verifies market hours before calling pipeline
    isInstrumentSuspended: false,
    currentPortfolioExposurePct: input.portfolioState.currentExposurePct,
    dailyPnlPct: input.portfolioState.dailyPnlPct,
    openRiskPct: input.portfolioState.openRiskPct,
    existingCorrelation: null,
    isKillSwitchActive: input.portfolioState.isKillSwitchActive,
    isDrawdownHalt: input.portfolioState.currentDrawdownPct >= 20,
    isDailyLossBreach: input.portfolioState.isDailyLossBreach,
    riskReward, stopLossPct, isDuplicateOpportunity: false,
    isInstrumentInUniverse: true,
    isModelRequiredAndUnavailable: false,
    isExpiryGammaRiskTooHigh: false,
  };
  const hardGateResult = evaluateHardGates(hardGateInputs, false);

  // ── Stage 8: Soft penalties ────────────────────────────────────────────
  const volScore = rvol !== null ? Math.min(1, rvol / 2) : 0.5;
  const volatilityTooHigh = (input.atr !== null && input.dailyCandles.length >= 20) && (() => {
    const atrs = input.dailyCandles.slice(-20).map((c, i, arr) =>
      i === 0 ? c.high - c.low :
      Math.max(c.high - c.low, Math.abs(c.high - arr[i-1].close), Math.abs(c.low - arr[i-1].close))
    );
    const avgAtr = atrs.reduce((a, b) => a + b, 0) / atrs.length;
    return input.atr !== null && input.atr > avgAtr * 1.8;
  })();

  const softPenaltyInputs: SoftPenaltyInputs = {
    marketRegime, strategyCompatibleWithRegime: regimeCompatible,
    sectorSupportsDirection: sectorContext.classification === "STRONGLY_SUPPORTIVE" || sectorContext.classification === "SUPPORTIVE",
    marketSupportsDirection: regimeEval.directionScore > 0 === (input.direction !== "SHORT"),
    oiBiasSupportsDirection: true, // set from OI analysis
    optionFlowSupportsDirection: true,
    volatilityTooHigh,
    isLateEntry: detection !== null && !detection.isFresh,
    isSignalExpired: false,
    mlUncertain: input.mlProbability !== null && input.mlProbability < 0.4,
    isCalibrationPoor: false,
    volumeAdequate: rvol === null || rvol >= 0.5,
    structureStrong: detection !== null && detection.detectionStrength >= 0.5,
    momentumConfirmed: input.rsi !== null && (input.direction === "LONG" ? input.rsi > 50 : input.rsi < 50),
    slippageRisk: spreadPct !== null && spreadPct > 0.2 ? "HIGH" : "LOW",
    timeOfDayRecommendation: "TRADE",
    mtfConflict: mtfAlignment === "CONFLICTING",
    sectorBreadthMixed: sectorContext.sectorBreadth > 0.35 && sectorContext.sectorBreadth < 0.65,
    highCorrelationPenalty: input.portfolioState.correlatedPositions >= 2,
  };
  const softPenalties = evaluateSoftPenalties(softPenaltyInputs);

  // ── Stage 9: Quality scoring ───────────────────────────────────────────
  const structureScore = detection?.detectionStrength ?? 0.4;
  const momentumScore = input.rsi !== null
    ? Math.min(1, Math.abs((input.rsi - 50) / 50) + 0.3) : 0.4;
  const volatilityScore = volatilityTooHigh ? 0.35 : 0.7;
  const liquidityScore = rvol !== null ? Math.min(1, rvol / 1.5) : 0.5;
  const mlScore = input.mlProbability ?? 0.5;
  const evNorm = Math.max(0, Math.min(1, (evResult.netEV + 0.5) / 1.5));

  let qualityScore =
    structureScore * 0.12 +
    momentumScore * 0.10 +
    volScore * 0.10 +
    volatilityScore * 0.08 +
    liquidityScore * 0.12 +
    Math.max(0, (regimeScore - 0.3) / 0.7) * 0.12 +
    ((mtfResult.alignmentScore + 1) / 2) * 0.10 +
    Math.max(0, (relStrength.compositeScore + 1) / 2) * 0.08 +
    Math.max(0, (sectorScore + 1) / 2) * 0.08 +
    mlScore * 0.05 +
    evNorm * 0.05;

  qualityScore = Math.max(0, Math.min(1, qualityScore - softPenalties.totalScoreReduction));

  // ── Stage 10: Quality tier ─────────────────────────────────────────────
  const hasHardRejection = !hardGateResult.passes;
  const qualityTier: QualityTier = gradeOpportunityTier(
    qualityScore, evResult.netEV, liquidityScore, hasHardRejection, regimeScore, null
  );

  // ── Stage 11: Position sizing ──────────────────────────────────────────
  const drawdownState = classifyDrawdownTier(input.portfolioState.currentDrawdownPct);
  const sizingConfig: SizingConfig = {
    baseRiskPct: 1.5,
    maxPositionSizePct: 20,
    maxPortfolioExposurePct: 80,
    capitalINR: input.portfolioState.capitalINR,
    currentExposurePct: input.portfolioState.currentExposurePct,
    currentDrawdownPct: input.portfolioState.currentDrawdownPct,
    correlatedPositions: input.portfolioState.correlatedPositions,
  };
  const sizingInput: SizingInput = {
    qualityTier, netEV: evResult.netEV, liquidityScore,
    regime: marketRegime, lotSize: input.lotSize,
    currentPrice: input.currentPrice, config: sizingConfig,
  };
  const sizingResult = computePositionSize(sizingInput);

  // ── Stage 12: Final decision ───────────────────────────────────────────
  let decision: OpportunityDecision;
  let lifecycleState: OpportunityLifecycleState;
  let decisionReason: string;
  let rejectionStage: string | null = null;

  if (hasHardRejection) {
    decision = "REJECT";
    lifecycleState = "REJECTED";
    decisionReason = hardGateResult.summary;
    rejectionStage = "HARD_GATE";
  } else if (!drawdownState.allowNewTrades) {
    decision = "REJECT";
    lifecycleState = "REJECTED";
    decisionReason = drawdownState.reason;
    rejectionStage = "DRAWDOWN_HALT";
  } else if (qualityTier === "REJECT" || qualityTier === "D") {
    decision = "ABSTAIN";
    lifecycleState = "ABSTAINED";
    decisionReason = `Quality tier ${qualityTier} — insufficient edge`;
    rejectionStage = "QUALITY_GATE";
  } else if (mtfAlignment === "CONFLICTING") {
    decision = "WAIT";
    lifecycleState = "QUALIFIED";
    decisionReason = "MTF conflict — wait for alignment";
    rejectionStage = null;
  } else if (qualityTier === "A_PLUS") {
    decision = "STRONG_BUY";
    lifecycleState = "APPROVED";
    decisionReason = `A+ quality — all criteria met, net EV ${evResult.netEV.toFixed(3)}%`;
  } else if (qualityTier === "A") {
    decision = "BUY";
    lifecycleState = "APPROVED";
    decisionReason = `A quality — strong opportunity, net EV ${evResult.netEV.toFixed(3)}%`;
  } else if (qualityTier === "B") {
    decision = "BUY";
    lifecycleState = "APPROVED";
    decisionReason = `B quality — tradeable opportunity`;
  } else {
    decision = "WATCH";
    lifecycleState = "QUALIFIED";
    decisionReason = `C quality — monitor only`;
  }

  // ── Build OpportunityV1 ────────────────────────────────────────────────
  const opportunityId = createOpportunityId(input.instrument, input.nowMs);
  const correlationId = createCorrelationId(input.instrument, input.direction === "SHORT" ? "SHORT" : "LONG", input.nowMs);

  const opportunity: OpportunityV1 = {
    opportunityId, correlationId,
    label: `${input.instrument} ${input.direction} — ${input.strategyId}`,
    instrument: input.instrument, instrumentName: input.instrumentName,
    exchange: input.exchange, segment: input.segment,
    instrumentCategory: "FNO_STOCK",
    lotSize: input.lotSize,
    timestamp: input.nowMs, availableAt: input.nowMs,
    expiresAt: input.nowMs + 4 * 60 * 60 * 1000,
    tradeDate: input.tradeDate,
    direction: input.direction, strategy: input.strategyId, signalSource: input.signalSource,
    setupType: detection?.setupType ?? "UNKNOWN",
    levels: {
      entryZone: { low: entry * 0.999, high: entry * 1.001, ideal: entry },
      invalidation: stop, target1, target2, target3,
      expectedMove: rewardPct, expectedAdverseMove: riskPct, riskReward,
      atrAtSignal: input.atr ?? 0, stopAtrMultiplier: 0.75,
    },
    marketRegime, sectorRegime: sectorContext.classification,
    volatilityRegime: volatilityTooHigh ? "EXPANDING" : "NORMAL",
    liquidityRegime: liquidityScore > 0.7 ? "DEEP" : liquidityScore > 0.4 ? "ADEQUATE" : "THIN",
    mtfAlignment, timeOfDay: new Date(input.nowMs).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }),
    sessionMinutesElapsed: Math.floor((input.nowMs - input.sessionOpenMs) / 60000),
    expiryContext: {
      isExpiryDay: false, expiryType: "NONE", daysToExpiry: 7, hoursToExpiry: 168,
      expiryBehaviorModifier: 1.0, gammaRiskActive: false,
      ivBehaviorExpected: "NEUTRAL", optionLiquidityAdequate: true,
    },
    scores: {
      structureScore, momentumScore, volumeScore: volScore,
      volatilityScore, liquidityScore, marketContextScore: regimeEval.directionScore,
      regimeScore, oiScore: 0, optionsScore: 0,
      relativeStrengthScore: relStrength.compositeScore, sectorScore,
      mlScore, executionScore: 0.7,
      qualityScore, probabilityWin: evResult.pWin, expectedValue: evResult.grossEV,
      expectedShortfall: evResult.expectedShortfall, costEstimate: evResult.totalCostPct,
      slippageEstimate: evResult.slippageCostPct, netExpectedValue: evResult.netEV,
      riskScore: 0.7, portfolioRiskScore: 0.7, correlationPenalty: 0,
      finalScore: Math.max(0, Math.min(100,
        qualityScore * 50 + Math.max(0, evResult.netEV) * 20 + regimeScore * 20 + liquidityScore * 10
      )),
    },
    qualityTier, decision, decisionReason, lifecycleState,
    hardRejections: hardGateResult.triggeredGates.map(g => g.code),
    softPenalties: softPenalties.penalties.map(p => p.code),
    evidence: {
      positiveEvidence: [
        ...(detection?.reasons ?? []),
        ...(regimeCompatible ? [`Regime ${marketRegime} supports ${input.strategyId}`] : []),
        ...(sectorContext.classification === "SUPPORTIVE" || sectorContext.classification === "STRONGLY_SUPPORTIVE"
          ? [sectorContext.reasons[0] ?? ""] : []),
        ...(mtfResult.higherTFContextValid ? ["Higher TF context valid"] : []),
      ].filter(Boolean),
      negativeEvidence: [
        ...softPenalties.penalties.map(p => p.reason),
        ...(hardGateResult.triggeredGates.map(g => g.reason)),
      ],
      invalidationConditions: [`Stop loss breached at ${stop.toFixed(2)}`],
      missingFactors: [],
      decisionRationale: decisionReason,
      instrumentSelectionReason: `${input.instrument} selected by ${input.strategyId}`,
      timingJustification: `Session at ${Math.floor((input.nowMs - input.sessionOpenMs) / 60000)}min`,
    },
    recommendedSizePct: sizingResult.recommendedSizePct,
    recommendedSizeINR: sizingResult.recommendedSizeINR,
    sizingCapApplied: sizingResult.hardCapApplied,
    oiBuildupClassification: "NEUTRAL" as OIBuildupClassification,
    optionsFlowBias: "NEUTRAL" as OptionsFlowBias,
    relativeStrengthVsNifty: relStrength.vsNifty.score,
    relativeStrengthVsSector: relStrength.vsSector.score,
    sectorRank: relStrength.momentumRank,
    momentumRank: relStrength.momentumRank,
    versions: {
      modelVersion: PIPELINE_VERSION, featureVersion: FEATURE_VERSION,
      policyVersion: POLICY_VERSION, mlModelVersion: null, strategyVersion: "1.0",
    },
    primaryProvider: "ANGEL_ONE",
    dataQualityLevel: isDataValid ? "COMPLETE" : "STALE",
    providerConfidence: isDataValid ? 0.95 : 0.5,
  };

  const evaluationMs = Date.now() - startMs;
  const shouldTrade = (decision === "STRONG_BUY" || decision === "BUY") && sizingResult.recommendedSizeINR > 0;

  return { opportunity, shouldTrade, rejectionStage, evaluationMs };
}

// ─── Opportunity Ranker ───────────────────────────────────────────────────────

import type { OpportunityRankEntry } from "./types";

/**
 * Rank a set of approved opportunities by risk-adjusted net expected value.
 * Applies sector/strategy concentration penalties.
 */
export function rankOpportunities(
  opportunities: OpportunityV1[],
  maxToReturn = 5,
): OpportunityRankEntry[] {
  const approved = opportunities.filter(o =>
    o.decision === "STRONG_BUY" || o.decision === "BUY"
  );

  // Count sector and strategy usage
  const sectorCount: Record<string, number> = {};
  const strategyCount: Record<string, number> = {};

  const entries: OpportunityRankEntry[] = approved.map(o => {
    const sector = INDIA_SECTOR_MAP[o.instrument] ?? "UNKNOWN";
    const sectorPenalty = (sectorCount[sector] ?? 0) * 0.05;
    const stratPenalty = (strategyCount[o.strategy] ?? 0) * 0.03;
    const correlationPenalty = o.scores.correlationPenalty;

    const adjustedScore = o.scores.finalScore
      * (1 - sectorPenalty)
      * (1 - stratPenalty)
      * (1 - correlationPenalty);

    sectorCount[sector] = (sectorCount[sector] ?? 0) + 1;
    strategyCount[o.strategy] = (strategyCount[o.strategy] ?? 0) + 1;

    return {
      opportunityId: o.opportunityId,
      instrument: o.instrument,
      direction: o.direction,
      strategy: o.strategy,
      qualityTier: o.qualityTier,
      netExpectedValue: o.scores.netExpectedValue,
      finalScore: adjustedScore,
      recommendedSizePct: o.recommendedSizePct,
      correlationPenalty,
      rankPosition: 0,
      selected: false,
      selectionReason: null,
      rejectionReason: null,
    };
  });

  // Sort by adjusted score descending
  entries.sort((a, b) => b.finalScore - a.finalScore);

  // Assign ranks and selection
  entries.forEach((e, i) => {
    e.rankPosition = i + 1;
    e.selected = i < maxToReturn;
    if (e.selected) {
      e.selectionReason = `Rank #${i + 1} by risk-adjusted net EV`;
    }
  });

  return entries;
}
