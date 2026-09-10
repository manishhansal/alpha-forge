/**
 * Shadow Signal-Intelligence Evaluator (remediation P0/P1 — Phases 2/4/19/20/21)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Composes the real signal-intelligence engines into ONE canonical decision,
 * WITHOUT altering execution. This is the runtime integration point: it gives
 * `runProfitabilityPipeline` and `runAPlusFactory` genuine runtime callers, and
 * derives the meta-model state from the loaded artifact so an untrained model
 * can never lend live conviction.
 *
 * Flow (all from a single canonical candidate):
 *   meta artifact → model-state gate → profitability pipeline (net EV, cost
 *   stress, counterfactual, derivatives gate, grade) → A+ factory (evidence
 *   gate, correlation dedup, opportunity score) → canonical decision authority.
 *
 * PURE + deterministic given its inputs (the meta artifact is injected). It does
 * NOT read the market or write the DB — persistence + execution are the
 * caller's responsibility (see `shadow-persistence.ts`), and in SHADOW mode the
 * caller must NOT act on the decision. This keeps the working live path intact.
 */

import type { MetaModelArtifact } from "./ml-meta-decision";
import { classifyModelState, type ModelState } from "./model-state-gate";
import {
  runProfitabilityPipeline,
  type ProfitabilityPipelineInput,
  type ProfitabilityResult,
  type InstrumentKind,
} from "./profitability-engine";
import {
  runAPlusFactory,
  type CandidateSignal,
  type FactoryBucket,
  type FactoryDirection,
  type FactoryRegime,
  type FactoryInstrument,
} from "./a-plus-signal-factory";
import { resolveCanonicalDecision, type CanonicalDecisionResult } from "./canonical-decision";

export const SHADOW_INTELLIGENCE_VERSION = "shadow-1.0.0";

/**
 * A market-agnostic canonical candidate — the single input the shadow pipeline
 * consumes. Callers (e.g. the India builder) map their signal onto this.
 */
export interface CanonicalCandidate {
  signalId: string;
  underlying: string;
  symbol: string;
  strategy: string;
  signalFamily: string;
  featureFamily: string;
  direction: FactoryDirection;
  instrument: FactoryInstrument;
  timestamp: number;
  regime: FactoryRegime;

  // data / liquidity / execution
  dataQuality: number;          // [0,1]
  criticalDataIssue: boolean;
  insufficientData: boolean;
  liquidity: number;            // [0,1]
  quotedSpreadPct: number | null;
  relativeVolume: number;
  volatility: number;           // [0,1]
  minutesFromOpen: number;

  // strategy / regime
  strategyRegimeSuitable: boolean;
  strategySuppressed: boolean;
  strategyHealth: number;       // [0,1]
  strategyDegraded: boolean;

  // multi-layer
  multiLayerConfirmed: boolean;
  layerVetoed: boolean;
  hasConflict: boolean;

  // probability / model
  calibratedProbability: number;
  probabilityLowerBound: number;
  modelAgreement: number;
  predictionUncertainty: number;
  rawConfidence: number;
  /** Whether calibration is genuinely available (trained calibrator + sample). */
  calibrationAvailable: boolean;

  // quality
  qualityScore: number;         // 0–100

  // payoff geometry
  entry: number;
  stop: number;
  target: number;
  expectedWinR: number;
  expectedLossR: number;
  riskPct: number;
  notionalINR: number;

  // historical edge
  historicalWinRate: number;
  historicalExpectancyR: number;
  historicalProfitFactor: number;
  historicalSampleCount: number;

  // derivatives evidence
  directionalThesisSupported: boolean;
  maxPainAgrees: boolean;
  pcrAgrees: boolean;
  oiAgrees: boolean;
  isValidatedOptionsFlowStrategy: boolean;

  // risk / correlation
  clusterCorrelation: number;
  riskBlocked: boolean;

  // counterfactual decay assumptions
  delayDecayRPerCandle: number;
  hourlyDecayR: number;
}

export interface ShadowDecision {
  signalId: string;
  version: string;
  /** Meta model lifecycle state derived from the loaded artifact. */
  modelState: ModelState;
  /** True only when a validated model actually contributes (else contribution 0). */
  modelContribution: number;
  profitability: ProfitabilityResult;
  aPlusBucket: FactoryBucket;
  independentSignalCount: number;
  canonical: CanonicalDecisionResult;
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Derive the meta-model lifecycle state from the artifact. An untrained artifact
 * (`trainedAtMs == null` or no model addsValue) is UNTRAINED; a trained artifact
 * with at least one value-adding model reaches SHADOW/VALIDATED via the gate.
 * This is the enforcement point that prevents `defaultMetaArtifact` (uniform
 * prior) from lending live conviction.
 */
export function deriveMetaModelState(artifact: MetaModelArtifact): { state: ModelState; contribution: number } {
  const contributions = Object.values(artifact.contribution);
  const anyAddsValue = contributions.some((c) => c.addsValue);
  const bestAuc = contributions.reduce((m, c) => Math.max(m, c.rocAuc), 0.5);
  const trained = artifact.trainedAtMs != null && anyAddsValue;
  const state = classifyModelState({
    trained,
    provenance: trained ? "LEARNED_OOS" : "UNTRAINED_UNIFORM_PRIOR",
    addsValueOOS: anyAddsValue,
    // Without a persisted OOS outcome store these are conservatively low, so an
    // untrained/uniform artifact cannot reach VALIDATED.
    oosSampleCount: trained ? Math.max(...contributions.map(() => 0)) : 0,
    calibrationQuality: trained ? clamp01((bestAuc - 0.5) * 2) : 0,
    acceptancePassed: trained,
  });
  // Contribution is zero unless the model is genuinely live-eligible.
  const contribution = state === "VALIDATED" || state === "PRODUCTION" ? clamp01((bestAuc - 0.5) * 2) : 0;
  return { state, contribution };
}

function toInstrumentKind(i: FactoryInstrument): InstrumentKind {
  return i; // FactoryInstrument and InstrumentKind share the same union
}

/**
 * Evaluate a canonical candidate through the full new stack and return the one
 * canonical decision. This function is the REAL runtime caller of both
 * `runProfitabilityPipeline` and `runAPlusFactory`.
 *
 * `cluster` lets the caller pass sibling candidates so the A+ factory's
 * correlation dedup computes an honest `independentSignalCount` (duplicate
 * confirmations do not inflate). When omitted, the candidate stands alone.
 */
export function evaluateShadow(
  candidate: CanonicalCandidate,
  artifact: MetaModelArtifact,
  cluster: CanonicalCandidate[] = [],
): ShadowDecision {
  const { state: modelState, contribution } = deriveMetaModelState(artifact);

  // If the model is not live-eligible, it must NOT lend conviction: zero its
  // contribution and widen uncertainty (never fabricate probability).
  const modelUsable = modelState === "VALIDATED" || modelState === "PRODUCTION";
  const effectiveAgreement = modelUsable ? candidate.modelAgreement : 0;
  const effectiveUncertainty = modelUsable
    ? candidate.predictionUncertainty
    : Math.max(candidate.predictionUncertainty, 0.6);

  // ── Profitability pipeline (net EV, cost stress, counterfactual, grade) ──
  const profInput: ProfitabilityPipelineInput = {
    instrument: toInstrumentKind(candidate.instrument),
    strategyId: candidate.strategy,
    qualityScore: candidate.qualityScore,
    calibratedPWin: candidate.calibratedProbability,
    probabilityLowerBound: candidate.probabilityLowerBound,
    modelAgreement: effectiveAgreement,
    predictionUncertainty: effectiveUncertainty,
    confidence: candidate.rawConfidence,
    expectedWinR: candidate.expectedWinR,
    expectedLossR: candidate.expectedLossR,
    riskPct: candidate.riskPct,
    notionalINR: candidate.notionalINR,
    slippage: {
      instrument: toInstrumentKind(candidate.instrument),
      quotedSpreadPct: candidate.quotedSpreadPct,
      liquidity: candidate.liquidity,
      relativeVolume: candidate.relativeVolume,
      volatility: candidate.volatility,
      minutesFromOpen: candidate.minutesFromOpen,
      orderSizeRatio: 1,
      option: null,
    },
    derivatives: {
      directionalThesisSupported: candidate.directionalThesisSupported,
      maxPainAgrees: candidate.maxPainAgrees,
      pcrAgrees: candidate.pcrAgrees,
      oiAgrees: candidate.oiAgrees,
      isValidatedOptionsFlowStrategy: candidate.isValidatedOptionsFlowStrategy,
    },
    clusterCorrelation: candidate.clusterCorrelation,
    hasConflict: candidate.hasConflict,
    mlAbstained: !modelUsable,
    riskBlocked: candidate.riskBlocked,
    strategySuppressed: candidate.strategySuppressed,
    delayDecayRPerCandle: candidate.delayDecayRPerCandle,
    hourlyDecayR: candidate.hourlyDecayR,
  };
  const profitability = runProfitabilityPipeline(profInput);

  // ── A+ factory (evidence gate, correlation dedup, opportunity score) ──
  const toFactory = (c: CanonicalCandidate): CandidateSignal => ({
    signalId: c.signalId,
    underlying: c.underlying,
    symbol: c.symbol,
    strategy: c.strategy,
    signalFamily: c.signalFamily,
    featureFamily: c.featureFamily,
    direction: c.direction,
    instrument: c.instrument,
    timestamp: c.timestamp,
    regime: c.regime,
    dataQuality: c.dataQuality,
    criticalDataIssue: c.criticalDataIssue,
    liquidity: c.liquidity,
    strategyRegimeSuitable: c.strategyRegimeSuitable,
    strategySuppressed: c.strategySuppressed,
    strategyHealth: c.strategyHealth,
    strategyDegraded: c.strategyDegraded,
    multiLayerConfirmed: c.multiLayerConfirmed,
    layerVetoed: c.layerVetoed,
    calibratedProbability: c.calibratedProbability,
    probabilityLowerBound: c.probabilityLowerBound,
    modelAgreement: c === candidate ? effectiveAgreement : c.modelAgreement,
    predictionUncertainty: c === candidate ? effectiveUncertainty : c.predictionUncertainty,
    qualityScore: c.qualityScore,
    netEVPct: profitability.netEV.netEVPct,
    netEVR: profitability.netEV.netEVR,
    riskPct: c.riskPct,
    costRobustnessScore: profitability.netEV.costRobustnessScore,
    survives2xCost: profitability.netEV.survives2x,
    counterfactualRobustness: profitability.robustness.robustnessScore,
    fragile: profitability.robustness.fragile,
    historicalWinRate: c.historicalWinRate,
    historicalExpectancyR: c.historicalExpectancyR,
    historicalProfitFactor: c.historicalProfitFactor,
    historicalSampleCount: c.historicalSampleCount,
    hasConflict: c.hasConflict,
    entry: c.entry,
    stop: c.stop,
    target: c.target,
  });

  const factoryInputs = [candidate, ...cluster].map(toFactory);
  const factory = runAPlusFactory(factoryInputs);
  const ranked = factory.ranked.find((r) => r.signalId === candidate.signalId);
  const bucket: FactoryBucket = ranked?.bucket ?? "NO_TRADE";
  const independentSignalCount = ranked?.independentSignalCount ?? 1;
  const isAPlus = bucket === "A_PLUS_PRIME" || bucket === "A_PLUS_STRONG";

  // ── Canonical decision authority ──
  const canonical = resolveCanonicalDecision({
    criticalDataIssue: candidate.criticalDataIssue,
    insufficientData: candidate.insufficientData,
    riskBlocked: candidate.riskBlocked,
    modelState,
    calibrationAvailable: candidate.calibrationAvailable,
    netEVPct: profitability.netEV.netEVPct,
    survives2xCost: profitability.netEV.survives2x,
    fragile: profitability.robustness.fragile,
    hasSufficientEvidence: candidate.historicalSampleCount >= 50,
    aPlus: isAPlus,
    // A+ may only TRADE when the model backing it is live-eligible AND net EV is
    // positive under 2x cost — enforced here as the "all mandatory gates" proxy.
    allMandatoryGatesPass: modelUsable && profitability.netEV.survives2x && profitability.netEV.netEVPct > 0,
  });

  return {
    signalId: candidate.signalId,
    version: SHADOW_INTELLIGENCE_VERSION,
    modelState,
    modelContribution: contribution,
    profitability,
    aPlusBucket: bucket,
    independentSignalCount,
    canonical,
  };
}
