/**
 * A+ Signal Factory — India
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The purpose is NOT to generate more signals. It is to identify the SMALLEST
 * subset of signals with the strongest statistically-defensible edge, and rank
 * them by expected NET P&L per unit risk — never by raw confidence.
 *
 * It is the ranking/selection layer on top of the six engines built this
 * session (their outputs are the `CandidateSignal` input, so this module stays
 * pure and testable):
 *
 *   ALL CANDIDATES → DATA QUALITY → LIQUIDITY → REGIME → STRATEGY FIT →
 *   MULTI-LAYER CONFIRMATION → CALIBRATED PROBABILITY → PREDICTIVE QUALITY →
 *   NET EV → COST ROBUSTNESS → COUNTERFACTUAL ROBUSTNESS →
 *   HISTORICAL CONDITIONAL EDGE → MODEL AGREEMENT → CORRELATION DEDUP →
 *   A+/A/B → TOP OPPORTUNITIES
 *
 * A+ is RARE by EVIDENCE, not by targeting a percentage. A candidate is A+ only
 * when ALL of the listed evidence conditions hold simultaneously.
 *
 * Deterministic + I/O-free.
 */

export const A_PLUS_FACTORY_VERSION = "apf-1.0.0";

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
const clamp01 = (x: number): number => clamp(x, 0, 1);

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 1 — Candidate input (outputs of the six engines)
// ═══════════════════════════════════════════════════════════════════════════

export type FactoryDirection = "LONG" | "SHORT";
export type FactoryRegime = "BULL_TREND" | "BEAR_TREND" | "RANGE" | "HIGH_VOL" | "LOW_VOL" | "UNKNOWN";
export type FactoryInstrument = "INDEX_OPTION" | "STOCK_OPTION" | "INDEX_FUT" | "STOCK_FUT" | "EQUITY";

/**
 * A candidate signal ready for ranking. Every field is an OUTPUT of an upstream
 * engine; the factory only reads them.
 */
export interface CandidateSignal {
  signalId: string;
  underlying: string;          // e.g. "NIFTY", "RELIANCE"
  symbol: string;              // tradable symbol (option/fut/equity)
  strategy: string;
  signalFamily: string;        // e.g. "BREAKOUT", "OPTIONS_FLOW"
  featureFamily: string;       // dominant feature cluster driving the signal
  direction: FactoryDirection;
  instrument: FactoryInstrument;
  timestamp: number;           // UTC ms
  regime: FactoryRegime;

  // ── data quality / liquidity (market-data + reconciliation) ──
  dataQuality: number;         // [0,1]
  criticalDataIssue: boolean;
  liquidity: number;           // [0,1]

  // ── strategy fit + regime (strategy-regime-scoring) ──
  strategyRegimeSuitable: boolean;
  strategySuppressed: boolean;
  strategyHealth: number;      // [0,1]
  strategyDegraded: boolean;   // serious alpha decay

  // ── multi-layer confirmation ──
  multiLayerConfirmed: boolean;
  layerVetoed: boolean;

  // ── calibrated probability + model agreement (ml-meta-decision) ──
  calibratedProbability: number; // [0,1]
  probabilityLowerBound: number; // [0,1]
  modelAgreement: number;        // [0,1]
  predictionUncertainty: number; // [0,1]

  // ── predictive quality (predictive-quality-engine) ──
  qualityScore: number;        // 0–100

  // ── net EV + robustness (profitability-engine) ──
  netEVPct: number;            // % of entry, cost-adjusted
  netEVR: number;              // R units
  riskPct: number;             // |entry-stop|/entry × 100
  costRobustnessScore: number; // [0,1]
  survives2xCost: boolean;
  counterfactualRobustness: number; // [0,1]
  fragile: boolean;

  // ── historical conditional edge (signal-learning-loop rolling stats) ──
  historicalWinRate: number;   // shrunk conditional win rate [0,1]
  historicalExpectancyR: number;
  historicalProfitFactor: number;
  historicalSampleCount: number;

  // ── conflict ──
  hasConflict: boolean;

  // ── invalidation ──
  entry: number;
  stop: number;
  target: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 2 — Signal Evidence Score (positive − penalty; OOS-learnable weights)
// ═══════════════════════════════════════════════════════════════════════════

/** The positive evidence components (each normalised to [0,1]). */
export const EVIDENCE_COMPONENTS = [
  "probabilityEvidence",
  "historicalEvidence",
  "evEvidence",
  "regimeEvidence",
  "modelAgreement",
  "robustness",
  "liquidity",
  "execution",
] as const;
export type EvidenceComponent = (typeof EVIDENCE_COMPONENTS)[number];

/** The penalty components (each normalised to [0,1]; subtracted). */
export const PENALTY_COMPONENTS = [
  "uncertainty",
  "conflict",
  "costSensitivity",
  "dataRisk",
] as const;
export type PenaltyComponent = (typeof PENALTY_COMPONENTS)[number];

/** OOS-learnable weight vector. Evidence weights sum to 1; penalties are subtractive. */
export interface EvidenceWeights {
  evidence: Record<EvidenceComponent, number>;
  penalty: Record<PenaltyComponent, number>;
  provenance: "LEARNED_OOS" | "UNTRAINED_UNIFORM_PRIOR";
}

/** Uniform-prior default weights (explicitly flagged untrained). */
export const DEFAULT_EVIDENCE_WEIGHTS: EvidenceWeights = {
  evidence: {
    probabilityEvidence: 1 / 8, historicalEvidence: 1 / 8, evEvidence: 1 / 8, regimeEvidence: 1 / 8,
    modelAgreement: 1 / 8, robustness: 1 / 8, liquidity: 1 / 8, execution: 1 / 8,
  },
  penalty: { uncertainty: 0.5, conflict: 0.5, costSensitivity: 0.5, dataRisk: 0.5 },
  provenance: "UNTRAINED_UNIFORM_PRIOR",
};

export interface EvidenceBreakdown {
  components: Record<EvidenceComponent, number>;
  penalties: Record<PenaltyComponent, number>;
  positiveScore: number;   // weighted evidence [0,1]
  penaltyScore: number;    // weighted penalties [0,1]
  /** Final Signal Evidence Score ∈ [0,1]. */
  evidenceScore: number;
}

/** Map a candidate to its raw evidence + penalty components (each [0,1]). */
export function computeEvidenceComponents(c: CandidateSignal): { components: Record<EvidenceComponent, number>; penalties: Record<PenaltyComponent, number> } {
  const components: Record<EvidenceComponent, number> = {
    // probability evidence uses the LOWER bound (conservative) blended with point est.
    probabilityEvidence: clamp01(0.5 * c.calibratedProbability + 0.5 * c.probabilityLowerBound),
    // historical evidence: shrunk win rate scaled by sample confidence
    historicalEvidence: clamp01(c.historicalWinRate) * clamp01(c.historicalSampleCount / (c.historicalSampleCount + 30)),
    // EV evidence: net EV in R normalised (0R→0.5, +1R→1)
    evEvidence: clamp01(0.5 + c.netEVR / 2),
    regimeEvidence: c.strategyRegimeSuitable ? clamp01(c.strategyHealth) : 0,
    modelAgreement: clamp01(c.modelAgreement),
    robustness: clamp01(0.5 * c.costRobustnessScore + 0.5 * c.counterfactualRobustness),
    liquidity: clamp01(c.liquidity),
    execution: clamp01(c.qualityScore / 100),
  };
  const penalties: Record<PenaltyComponent, number> = {
    uncertainty: clamp01(c.predictionUncertainty),
    conflict: c.hasConflict ? 1 : 0,
    costSensitivity: clamp01(1 - c.costRobustnessScore),
    dataRisk: c.criticalDataIssue ? 1 : clamp01(1 - c.dataQuality),
  };
  return { components, penalties };
}

/**
 * Signal Evidence Score = weighted positive evidence − weighted penalties, all
 * in [0,1]. Weights are learnable OOS (§training); the default is uniform and
 * flagged untrained so it cannot masquerade as empirical.
 */
export function computeEvidenceScore(c: CandidateSignal, weights: EvidenceWeights = DEFAULT_EVIDENCE_WEIGHTS): EvidenceBreakdown {
  const { components, penalties } = computeEvidenceComponents(c);
  let positive = 0;
  for (const k of EVIDENCE_COMPONENTS) positive += components[k] * (weights.evidence[k] ?? 0);
  let penalty = 0;
  let penaltyW = 0;
  for (const k of PENALTY_COMPONENTS) { penalty += penalties[k] * (weights.penalty[k] ?? 0); penaltyW += (weights.penalty[k] ?? 0); }
  const penaltyScore = penaltyW > 0 ? penalty / penaltyW : 0;
  // penalties reduce the score multiplicatively-ish: subtract a fraction.
  const evidenceScore = clamp01(positive * (1 - 0.5 * penaltyScore));
  return { components, penalties, positiveScore: clamp01(positive), penaltyScore, evidenceScore };
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 3 — Correlation clustering + independentSignalCount
// ═══════════════════════════════════════════════════════════════════════════

export interface SignalCluster {
  clusterId: string;
  members: CandidateSignal[];
  /** Effective INDEPENDENT confirmations (NOT raw member count). */
  independentSignalCount: number;
  /** The representative (highest-evidence) member. */
  representative: CandidateSignal;
  /** Conservatively-aggregated cluster probability (geometric-ish mean). */
  clusterProbability: number;
}

/**
 * Two signals are correlated (same opportunity) when they share the same
 * underlying + direction within a time window. Multiple correlated confirmations
 * are NOT independent — e.g. two NIFTY LONGs + a NIFTY CALL LONG + two BANKNIFTY
 * LONGs are far fewer than five independent bets.
 */
function sameOpportunity(a: CandidateSignal, b: CandidateSignal, windowMs: number): boolean {
  if (a.direction !== b.direction) return false;
  if (Math.abs(a.timestamp - b.timestamp) > windowMs) return false;
  // Same underlying (NIFTY option and NIFTY future are the same underlying).
  return a.underlying === b.underlying;
}

/**
 * Count INDEPENDENT confirmations within a cluster. Confirmations that share a
 * strategy, feature family OR signal family are NOT independent. Independence =
 * number of DISTINCT (strategy ⊕ featureFamily ⊕ signalFamily) evidence sources,
 * capped so a pile of same-family signals counts as ~1.
 */
export function independentConfirmations(members: CandidateSignal[]): number {
  if (members.length <= 1) return members.length;
  // distinct evidence "families": a signal is independent evidence only if it
  // brings a NEW strategy AND a NEW feature family AND a NEW signal family.
  const strategies = new Set(members.map((m) => m.strategy));
  const featureFamilies = new Set(members.map((m) => m.featureFamily));
  const signalFamilies = new Set(members.map((m) => m.signalFamily));
  // The most conservative independent count = the SMALLEST distinct-family count
  // (if everything shares a signal family, they collapse to that family count).
  const distinct = Math.min(strategies.size, featureFamilies.size, signalFamilies.size);
  return Math.max(1, distinct);
}

/**
 * Cluster candidates by underlying+direction+time and compute independent
 * confirmations + a conservatively-aggregated cluster probability.
 *
 * Cluster probability uses the GEOMETRIC MEAN of member probabilities (so
 * duplicates cannot inflate confidence — the geometric mean of identical values
 * equals that value, never higher), and only the independent confirmations
 * receive a modest boost.
 */
export function clusterCandidates(candidates: CandidateSignal[], windowMs = 30 * 60 * 1000): SignalCluster[] {
  const assigned = new Set<string>();
  const clusters: SignalCluster[] = [];
  // deterministic order
  const ordered = [...candidates].sort((a, b) => (a.signalId < b.signalId ? -1 : 1));

  for (const seed of ordered) {
    if (assigned.has(seed.signalId)) continue;
    const members = ordered.filter((c) => !assigned.has(c.signalId) && sameOpportunity(seed, c, windowMs));
    for (const m of members) assigned.add(m.signalId);

    const probs = members.map((m) => clamp01(m.calibratedProbability)).filter((p) => p > 0);
    const geoMean = probs.length > 0 ? Math.pow(probs.reduce((p, x) => p * x, 1), 1 / probs.length) : 0;
    const indep = independentConfirmations(members);
    // Independent confirmations add a small, capped boost above the geo-mean;
    // correlated duplicates add nothing.
    const boost = 1 + 0.05 * Math.max(0, indep - 1);
    const clusterProbability = clamp01(geoMean * boost);

    const representative = members.reduce((best, m) =>
      computeEvidenceScore(m).evidenceScore > computeEvidenceScore(best).evidenceScore ? m : best, members[0]!);

    clusters.push({
      clusterId: `${seed.underlying}:${seed.direction}:${Math.floor(seed.timestamp / windowMs)}`,
      members,
      independentSignalCount: indep,
      representative,
      clusterProbability,
    });
  }
  return clusters;
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 4 — OpportunityScore (net-EV per unit risk, OOS-normalised)
// ═══════════════════════════════════════════════════════════════════════════

/** OOS-learnable normalisation for the OpportunityScore factors. */
export interface OpportunityNormalization {
  /** Divisor that maps a "good" netEV-per-risk to ~1.0. */
  evPerRiskScale: number;
  provenance: "LEARNED_OOS" | "UNTRAINED_UNIFORM_PRIOR";
}
export const DEFAULT_OPPORTUNITY_NORMALIZATION: OpportunityNormalization = {
  evPerRiskScale: 0.5, // 0.5R net EV → factor ~1
  provenance: "UNTRAINED_UNIFORM_PRIOR",
};

export interface OpportunityScore {
  /** The product-form score used for RANKING (optimises net P&L per unit risk). */
  opportunityScore: number;
  /** The normalised net-EV-per-unit-risk factor. */
  evFactor: number;
  probabilityFactor: number;
  qualityFactor: number;
  robustnessFactor: number;
  liquidityFactor: number;
  independenceFactor: number;
}

/**
 * OpportunityScore = NetEV × Probability × Quality × Robustness × Liquidity ×
 * Independence, each normalised to ~[0,1]. It ranks by expected NET P&L PER UNIT
 * RISK (the `evFactor` is net EV in R, normalised) — NOT raw confidence. The
 * independence factor down-weights correlated duplicates.
 */
export function computeOpportunityScore(
  c: CandidateSignal,
  independentSignalCount: number,
  norm: OpportunityNormalization = DEFAULT_OPPORTUNITY_NORMALIZATION,
): OpportunityScore {
  // net EV per unit risk = netEVR (already per-R). Normalise via the learned scale.
  const evFactor = clamp01(Math.max(0, c.netEVR) / (norm.evPerRiskScale * 2));
  const probabilityFactor = clamp01(c.calibratedProbability);
  const qualityFactor = clamp01(c.qualityScore / 100);
  const robustnessFactor = clamp01(0.5 * c.costRobustnessScore + 0.5 * c.counterfactualRobustness);
  const liquidityFactor = clamp01(c.liquidity);
  // independence: 1 confirmation → 1.0 baseline; correlated pile does not exceed
  // ~1; genuinely independent confirmations add a small sqrt-diminishing boost.
  const independenceFactor = clamp01(Math.min(1, 0.7 + 0.3 * Math.sqrt(Math.max(1, independentSignalCount)) / Math.sqrt(3)));

  const opportunityScore = evFactor * probabilityFactor * qualityFactor * robustnessFactor * liquidityFactor * independenceFactor;
  return { opportunityScore, evFactor, probabilityFactor, qualityFactor, robustnessFactor, liquidityFactor, independenceFactor };
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 5 — The A+ evidence gate (all conditions simultaneously)
// ═══════════════════════════════════════════════════════════════════════════

/** Evidence-defined A+ thresholds (learnable OOS; conservative defaults). */
export interface APlusGateConfig {
  minCalibratedProbability: number;
  minProbabilityLowerBound: number;
  minHistoricalWinRate: number;
  minHistoricalSample: number;
  minQuality: number;
  minModelAgreement: number;
  minLiquidity: number;
  minCostRobustness: number;
  minCounterfactualRobustness: number;
  maxUncertainty: number;
  minEvidenceScore: number;
}
export const DEFAULT_A_PLUS_GATE: APlusGateConfig = {
  minCalibratedProbability: 0.62,
  minProbabilityLowerBound: 0.5,
  minHistoricalWinRate: 0.55,
  minHistoricalSample: 50,
  minQuality: 75,
  minModelAgreement: 0.6,
  minLiquidity: 0.6,
  minCostRobustness: 0.5,
  minCounterfactualRobustness: 0.7,
  maxUncertainty: 0.4,
  minEvidenceScore: 0.68,
};

export interface APlusCriterionCheck { criterion: string; passed: boolean; detail: string; }

/**
 * The 13 A+ conditions the brief requires — ALL must hold simultaneously. A+ is
 * rare because it must clear every bar at once, not because a percentage is
 * targeted.
 */
export function evaluateAPlusGate(c: CandidateSignal, evidence: EvidenceBreakdown, cfg: APlusGateConfig = DEFAULT_A_PLUS_GATE): { qualifies: boolean; checks: APlusCriterionCheck[] } {
  const checks: APlusCriterionCheck[] = [
    { criterion: "positiveCostAdjustedEV", passed: c.netEVPct > 0 && c.survives2xCost, detail: `netEV=${c.netEVPct.toFixed(3)}% survives2x=${c.survives2xCost}` },
    { criterion: "highCalibratedProbability", passed: c.calibratedProbability >= cfg.minCalibratedProbability && c.probabilityLowerBound >= cfg.minProbabilityLowerBound, detail: `p=${c.calibratedProbability.toFixed(3)} lb=${c.probabilityLowerBound.toFixed(3)}` },
    { criterion: "strongHistoricalWinRate", passed: c.historicalWinRate >= cfg.minHistoricalWinRate, detail: `histWR=${c.historicalWinRate.toFixed(3)}` },
    { criterion: "strongQuality", passed: c.qualityScore >= cfg.minQuality, detail: `q=${c.qualityScore.toFixed(1)}` },
    { criterion: "strongRegimeFit", passed: c.strategyRegimeSuitable && !c.strategySuppressed, detail: `suitable=${c.strategyRegimeSuitable} suppressed=${c.strategySuppressed}` },
    { criterion: "highModelAgreement", passed: c.modelAgreement >= cfg.minModelAgreement, detail: `agree=${c.modelAgreement.toFixed(2)}` },
    { criterion: "goodLiquidity", passed: c.liquidity >= cfg.minLiquidity, detail: `liq=${c.liquidity.toFixed(2)}` },
    { criterion: "robustCostSensitivity", passed: c.costRobustnessScore >= cfg.minCostRobustness, detail: `costRobust=${c.costRobustnessScore.toFixed(2)}` },
    { criterion: "robustEntrySensitivity", passed: c.counterfactualRobustness >= cfg.minCounterfactualRobustness && !c.fragile, detail: `cfRobust=${c.counterfactualRobustness.toFixed(2)} fragile=${c.fragile}` },
    { criterion: "sufficientSample", passed: c.historicalSampleCount >= cfg.minHistoricalSample, detail: `n=${c.historicalSampleCount}` },
    { criterion: "lowModelUncertainty", passed: c.predictionUncertainty <= cfg.maxUncertainty, detail: `uncertainty=${c.predictionUncertainty.toFixed(2)}` },
    { criterion: "noCriticalDataIssues", passed: !c.criticalDataIssue && c.dataQuality >= 0.7, detail: `dq=${c.dataQuality.toFixed(2)} critical=${c.criticalDataIssue}` },
    { criterion: "noStrategyDegradation", passed: !c.strategyDegraded, detail: `degraded=${c.strategyDegraded}` },
  ];
  const allPass = checks.every((k) => k.passed);
  const qualifies = allPass && evidence.evidenceScore >= cfg.minEvidenceScore && !c.hasConflict && !c.layerVetoed && c.multiLayerConfirmed;
  return { qualifies, checks };
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 6 — Ranking pipeline, buckets, evidence card
// ═══════════════════════════════════════════════════════════════════════════

export type FactoryBucket = "A_PLUS_PRIME" | "A_PLUS_STRONG" | "A_HIGH" | "B_SELECTIVE" | "WATCH" | "NO_TRADE";

export const PIPELINE_STAGES = [
  "DATA_QUALITY", "LIQUIDITY", "REGIME", "STRATEGY_FIT", "MULTI_LAYER",
  "CALIBRATED_PROBABILITY", "PREDICTIVE_QUALITY", "NET_EV", "COST_ROBUSTNESS",
  "COUNTERFACTUAL_ROBUSTNESS", "HISTORICAL_CONDITIONAL_EDGE", "MODEL_AGREEMENT",
  "CORRELATION_DEDUP", "GRADE",
] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export interface RankedSignal {
  signalId: string;
  bucket: FactoryBucket;
  evidence: EvidenceBreakdown;
  opportunity: OpportunityScore;
  independentSignalCount: number;
  aPlusChecks: APlusCriterionCheck[];
  /** Which pipeline stage rejected it (null if it reached grading). */
  rejectedAtStage: PipelineStage | null;
  reasons: string[];
  candidate: CandidateSignal;
}

export interface FactoryResult {
  version: string;
  ranked: RankedSignal[];
  /** Only PRIME + STRONG — the highest-priority surface. */
  topOpportunities: RankedSignal[];
  clusters: SignalCluster[];
  stats: { total: number; aPlusPrime: number; aPlusStrong: number; aHigh: number; bSelective: number; watch: number; noTrade: number };
}

/** Hard gates walked in pipeline order. Returns the stage that rejects, or null. */
function firstRejectingStage(c: CandidateSignal): PipelineStage | null {
  if (c.criticalDataIssue || c.dataQuality < 0.5) return "DATA_QUALITY";
  if (c.liquidity < 0.3) return "LIQUIDITY";
  if (c.regime === "UNKNOWN") return "REGIME";
  if (c.strategySuppressed || !c.strategyRegimeSuitable) return "STRATEGY_FIT";
  if (c.layerVetoed || !c.multiLayerConfirmed) return "MULTI_LAYER";
  if (c.calibratedProbability < 0.5) return "CALIBRATED_PROBABILITY";
  if (c.qualityScore < 40) return "PREDICTIVE_QUALITY";
  if (c.netEVPct <= 0) return "NET_EV";
  if (!c.survives2xCost) return "COST_ROBUSTNESS";
  if (c.fragile) return "COUNTERFACTUAL_ROBUSTNESS";
  // HISTORICAL_CONDITIONAL_EDGE, MODEL_AGREEMENT are soft (feed evidence, not hard-reject)
  return null;
}

/**
 * Run the full A+ Signal Factory ranking pipeline. Filters candidates through
 * the hard gates in order, clusters correlated confirmations, computes the
 * evidence + opportunity scores, buckets by EVIDENCE (A+ rare), and returns the
 * top-priority surface (PRIME + STRONG only).
 */
export function runAPlusFactory(
  candidates: CandidateSignal[],
  opts: {
    weights?: EvidenceWeights;
    normalization?: OpportunityNormalization;
    gate?: APlusGateConfig;
    clusterWindowMs?: number;
  } = {},
): FactoryResult {
  const weights = opts.weights ?? DEFAULT_EVIDENCE_WEIGHTS;
  const norm = opts.normalization ?? DEFAULT_OPPORTUNITY_NORMALIZATION;
  const gate = opts.gate ?? DEFAULT_A_PLUS_GATE;

  // correlation dedup first, so independence flows into scoring
  const clusters = clusterCandidates(candidates, opts.clusterWindowMs ?? 30 * 60 * 1000);
  const indepBySignal = new Map<string, number>();
  for (const cl of clusters) for (const m of cl.members) indepBySignal.set(m.signalId, cl.independentSignalCount);

  const ranked: RankedSignal[] = candidates.map((c) => {
    const rejectedAtStage = firstRejectingStage(c);
    const evidence = computeEvidenceScore(c, weights);
    const independentSignalCount = indepBySignal.get(c.signalId) ?? 1;
    const opportunity = computeOpportunityScore(c, independentSignalCount, norm);
    const { qualifies: aPlusQualifies, checks } = evaluateAPlusGate(c, evidence, gate);
    const reasons: string[] = [];

    let bucket: FactoryBucket;
    if (rejectedAtStage) {
      bucket = "NO_TRADE";
      reasons.push(`rejected_at:${rejectedAtStage}`);
    } else if (aPlusQualifies && evidence.evidenceScore >= 0.72) {
      // A+ requires the full 13-condition gate AND top-band evidence — the
      // scarce top of the distribution. PRIME additionally needs a high
      // opportunity score (net-EV/risk) and an INDEPENDENT confirmation.
      const prime = opportunity.opportunityScore >= 0.35 && evidence.evidenceScore >= 0.8 && independentSignalCount >= 2;
      bucket = prime ? "A_PLUS_PRIME" : "A_PLUS_STRONG";
      reasons.push(prime ? "a_plus_prime_all_evidence_plus_independent_confirmation" : "a_plus_strong_all_evidence");
    } else if (evidence.evidenceScore >= 0.6 && c.netEVPct > 0 && c.survives2xCost && c.calibratedProbability >= 0.58) {
      // Strong, tradable, but not clearing the full A+ bar.
      bucket = "A_HIGH";
      reasons.push("strong_but_not_all_a_plus_criteria");
    } else if (evidence.evidenceScore >= 0.45 && c.netEVPct > 0 && c.survives2xCost) {
      bucket = "B_SELECTIVE";
      reasons.push("tradable_selective");
    } else if (c.netEVPct > 0 || evidence.evidenceScore >= 0.3) {
      bucket = "WATCH";
      reasons.push("informational_watch");
    } else {
      bucket = "NO_TRADE";
      reasons.push("insufficient_evidence");
    }

    if (bucket !== "A_PLUS_PRIME" && bucket !== "A_PLUS_STRONG" && !rejectedAtStage) {
      const failed = checks.filter((k) => !k.passed).map((k) => k.criterion);
      if (failed.length > 0) reasons.push(`a_plus_blocked_by:${failed.slice(0, 4).join(",")}`);
    }

    return { signalId: c.signalId, bucket, evidence, opportunity, independentSignalCount, aPlusChecks: checks, rejectedAtStage, reasons, candidate: c };
  });

  // rank by OpportunityScore (net P&L per unit risk), deterministic tie-break
  ranked.sort((a, b) => b.opportunity.opportunityScore - a.opportunity.opportunityScore || (a.signalId < b.signalId ? -1 : 1));

  const topOpportunities = ranked.filter((r) => r.bucket === "A_PLUS_PRIME" || r.bucket === "A_PLUS_STRONG");

  const stats = {
    total: ranked.length,
    aPlusPrime: ranked.filter((r) => r.bucket === "A_PLUS_PRIME").length,
    aPlusStrong: ranked.filter((r) => r.bucket === "A_PLUS_STRONG").length,
    aHigh: ranked.filter((r) => r.bucket === "A_HIGH").length,
    bSelective: ranked.filter((r) => r.bucket === "B_SELECTIVE").length,
    watch: ranked.filter((r) => r.bucket === "WATCH").length,
    noTrade: ranked.filter((r) => r.bucket === "NO_TRADE").length,
  };

  return { version: A_PLUS_FACTORY_VERSION, ranked, topOpportunities, clusters, stats };
}

// ─── Evidence card ────────────────────────────────────────────────────────────

export interface EvidenceCard {
  signalId: string;
  symbol: string;
  strategy: string;
  bucket: FactoryBucket;
  whyItQualifies: string[];
  probability: number;
  historicalWinRate: number;
  sampleSize: number;
  expectedValueR: number;
  riskReward: number;
  regime: FactoryRegime;
  modelAgreement: number;
  liquidity: number;
  costRobustness: number;
  recentStrategyPerformance: number; // strategy health [0,1]
  mainInvalidation: string;
}

/** Build an evidence card for an A+ (PRIME/STRONG) signal. Returns null otherwise. */
export function buildEvidenceCard(r: RankedSignal): EvidenceCard | null {
  if (r.bucket !== "A_PLUS_PRIME" && r.bucket !== "A_PLUS_STRONG") return null;
  const c = r.candidate;
  const rr = c.riskPct > 0 ? Math.abs(c.target - c.entry) / Math.abs(c.entry - c.stop) : 0;
  return {
    signalId: c.signalId,
    symbol: c.symbol,
    strategy: c.strategy,
    bucket: r.bucket,
    whyItQualifies: r.aPlusChecks.filter((k) => k.passed).map((k) => `${k.criterion}: ${k.detail}`),
    probability: c.calibratedProbability,
    historicalWinRate: c.historicalWinRate,
    sampleSize: c.historicalSampleCount,
    expectedValueR: c.netEVR,
    riskReward: rr,
    regime: c.regime,
    modelAgreement: c.modelAgreement,
    liquidity: c.liquidity,
    costRobustness: c.costRobustnessScore,
    recentStrategyPerformance: c.strategyHealth,
    mainInvalidation: `${c.direction === "LONG" ? "Close below" : "Close above"} stop ${c.stop} invalidates the thesis`,
  };
}
