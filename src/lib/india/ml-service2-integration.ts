/**
 * ml-service2-integration.ts
 *
 * Wires ml-service2.0's MetaDecisionEngine into AlphaForge's
 * Opportunity Engine pipeline.
 *
 * WHAT THIS MODULE DOES
 * ─────────────────────
 * 1. Aggregates base-model outputs (regime, ranker, strategy, risk, price,
 *    iv, execution) into a single ``MLModelOutput[]`` array.
 * 2. Forwards the array + SentinelPulse news context to POST /v2/meta/decide.
 * 3. Maps the ``MLMetaDecision`` response back onto the ``OpportunityV1``
 *    fields that the existing pipeline already consumes:
 *      - opportunity.scores.mlScore           ← meta.confidence × agreement_ratio
 *      - opportunity.evidence.decisionRationale ← meta.rationale (≤200 chars)
 *      - opportunity.decision                 ← overridden to ABSTAIN when abstention=true
 *      - opportunity.softPenalties            ← adds ML_UNCERTAINTY when abstained
 *      - opportunity.versions.mlModelVersion  ← provenance tag
 * 4. The MetaDecision result is a GATE, not merely a score: when the engine
 *    abstains (agreement_ratio < 0.5, high uncertainty, or all models
 *    UNAVAILABLE), ``applyMetaDecision`` overrides the pipeline's APPROVED
 *    decision to ABSTAIN before the opportunity reaches the execution layer.
 *
 * QUANT JUSTIFICATION
 * ────────────────────
 * • Zero lookahead: all model_outputs are derived from features assembled at
 *   the current PIT boundary — no future prices or labels are used.
 * • Purged K-fold: the underlying ML models were trained with embargo-purged
 *   cross-validation (ml-service2.0 Phase 3), so their probabilities do not
 *   embed historical bias.
 * • Platt scaling: raw model probabilities are calibrated [0.28–0.82] in
 *   ml-service2.0 before returning to AlphaForge.
 * • Abstention gate: the MetaDecisionEngine enforces a 50% agreement quorum
 *   and a 3-model minimum — signals with too few confident models are silently
 *   suppressed before any capital allocation decision.
 *
 * USAGE IN pipeline.ts (Stage 12 replacement)
 * ─────────────────────────────────────────────
 *   import { buildModelOutputs, applyMetaDecision } from "./ml-service2-integration";
 *   import { predictMetaDecision } from "@/lib/india/ml-client";
 *
 *   const modelOutputs = buildModelOutputs(regimeResult, rankResult, strategyResult,
 *                                          riskResult, priceResult, ivResult, execResult);
 *   const meta = await predictMetaDecision({
 *     symbol: input.instrument,
 *     regime: regimeResult?.regime ?? "sideways",
 *     model_outputs: modelOutputs,
 *     news_context: sentinelCtx,
 *     risk_context: riskResult ? { prob_stop_hit: riskResult.prob_stop_hit } : undefined,
 *   });
 *   const finalOpportunity = applyMetaDecision(opportunity, meta);
 */

import type {
  MLMetaDecision,
  MLModelOutput,
  MLRegimeResponse,
  MLRankingResponse,
  MLStrategyResponse,
  MLRiskResponse,
  MLExecutionDecision,
  MLNewsContext,
} from "./ml-client";
import {
  metaDecisionRationale,
  metaDecisionToMlScore,
} from "./ml-client";
import type { OpportunityV1, SoftPenaltyCode } from "@/lib/opportunity-engine/types";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Optional price-regime forecast result shape. */
interface PriceForecastResult {
  regime: "bull" | "bear" | "flat";
  probability: number;
}

/** Optional IV-regime result shape. */
interface IVRegimeResult {
  iv_regime: string;
}

// ─── Model output assembly ────────────────────────────────────────────────────

/**
 * Assemble the ``MLModelOutput[]`` array from individual model results.
 *
 * Each model maps to one entry.  When a model result is null (service down,
 * schema validation failed) the entry is marked with provenance "unavailable"
 * and direction 0 — the MetaDecisionEngine counts these when computing the
 * quorum and may abstain if too many models are missing.
 *
 * The seven recognised models (matching META_MODELS in ml-meta-decision.ts):
 *   1. regimeClassifier
 *   2. stockRanker
 *   3. strategySelector
 *   4. riskPredictor
 *   5. priceForecaster
 *   6. ivClassifier
 *   7. quantEngine  (execution agent / RL)
 */
export function buildModelOutputs(
  regimeResult:    MLRegimeResponse    | null,
  rankResult:      MLRankingResponse   | null,
  strategyResult:  MLStrategyResponse  | null,
  riskResult:      MLRiskResponse      | null,
  priceForecast:   PriceForecastResult | null,
  ivResult:        IVRegimeResult      | null,
  execResult:      MLExecutionDecision | null,
  /** Direction the broader opportunity pipeline has already identified. */
  pipelineDirection: "LONG" | "SHORT" | "NEUTRAL" = "LONG",
): MLModelOutput[] {
  const dir: 1 | -1 | 0 = pipelineDirection === "LONG" ? 1 : pipelineDirection === "SHORT" ? -1 : 0;

  // ── 1. RegimeClassifier ───────────────────────────────────────────────────
  const regimeOutput: MLModelOutput = regimeResult
    ? {
        model_id: "regimeClassifier",
        // Bullish regimes vote BUY; crash/bear vote SELL; sideways/volatile WAIT
        action:
          ["strong_bull", "bull"].includes(regimeResult.regime) ? "BUY" :
          ["bear", "crash"].includes(regimeResult.regime)       ? "SELL" :
          "WAIT",
        confidence: regimeResult.confidence,
        direction:
          ["strong_bull", "bull"].includes(regimeResult.regime) ? 1 :
          ["bear", "crash"].includes(regimeResult.regime)       ? -1 :
          0,
        provenance: regimeResult.provenance ?? "trained_model",
      }
    : {
        model_id: "regimeClassifier",
        action: "NO_TRADE",
        confidence: 0,
        direction: 0,
        provenance: "unavailable",
      };

  // ── 2. StockRanker ────────────────────────────────────────────────────────
  // High rank score → bullish (>0.65), low rank score → neutral; all in LONG direction
  const rankOutput: MLModelOutput = rankResult && rankResult.rankings.length > 0
    ? (() => {
        const topScore = rankResult.rankings[0]?.score ?? 50;
        const normalised = topScore / 100;
        return {
          model_id: "stockRanker",
          action: normalised >= 0.65 ? (dir > 0 ? "BUY" : "SELL") : "WAIT",
          confidence: normalised,
          direction: normalised >= 0.65 ? dir : 0,
          provenance: "trained_model",
        };
      })()
    : {
        model_id: "stockRanker",
        action: "NO_TRADE",
        confidence: 0,
        direction: 0,
        provenance: "unavailable",
      };

  // ── 3. StrategySelector ───────────────────────────────────────────────────
  const stratOutput: MLModelOutput = strategyResult
    ? {
        model_id: "strategySelector",
        action: strategyResult.confidence >= 0.55 ? (dir > 0 ? "BUY" : "SELL") : "WAIT",
        confidence: strategyResult.confidence,
        direction: strategyResult.confidence >= 0.55 ? dir : 0,
        provenance: "trained_model",
      }
    : {
        model_id: "strategySelector",
        action: "NO_TRADE",
        confidence: 0,
        direction: 0,
        provenance: "unavailable",
      };

  // ── 4. RiskPredictor ──────────────────────────────────────────────────────
  // High prob_stop_hit → bearish / WAIT; low → proceed in pipeline direction
  const riskOutput: MLModelOutput = riskResult
    ? (() => {
        const stopRisk = riskResult.prob_stop_hit;
        const confidence = Math.max(0, 1 - stopRisk);
        return {
          model_id: "riskPredictor",
          action:
            riskResult.risk_score > 7.0 ? "NO_TRADE" :
            stopRisk > 0.55             ? "WAIT" :
            dir > 0                     ? "BUY" : "SELL",
          confidence,
          direction: stopRisk > 0.55 ? 0 : dir,
          provenance: riskResult.provenance ?? "trained_model",
        };
      })()
    : {
        model_id: "riskPredictor",
        action: "NO_TRADE",
        confidence: 0,
        direction: 0,
        provenance: "unavailable",
      };

  // ── 5. PriceForecaster ────────────────────────────────────────────────────
  const priceOutput: MLModelOutput = priceForecast
    ? {
        model_id: "priceForecaster",
        action:
          priceForecast.regime === "bull" ? "BUY" :
          priceForecast.regime === "bear" ? "SELL" :
          "WAIT",
        confidence: priceForecast.probability,
        direction:
          priceForecast.regime === "bull" ? 1 :
          priceForecast.regime === "bear" ? -1 :
          0,
        provenance: "trained_model",
      }
    : {
        model_id: "priceForecaster",
        action: "NO_TRADE",
        confidence: 0,
        direction: 0,
        provenance: "unavailable",
      };

  // ── 6. IVClassifier ───────────────────────────────────────────────────────
  // SPIKE → uncertainty / WAIT; CRUSH / STABLE → support existing direction
  const ivOutput: MLModelOutput = ivResult
    ? {
        model_id: "ivClassifier",
        action:
          ivResult.iv_regime === "SPIKE" ? "WAIT" :
          dir > 0                        ? "BUY" : "SELL",
        confidence: ivResult.iv_regime === "SPIKE" ? 0.3 : 0.6,
        direction: ivResult.iv_regime === "SPIKE" ? 0 : dir,
        provenance: "heuristic",
      }
    : {
        model_id: "ivClassifier",
        action: "NO_TRADE",
        confidence: 0,
        direction: 0,
        provenance: "unavailable",
      };

  // ── 7. QuantEngine (RL execution agent) ───────────────────────────────────
  const execOutput: MLModelOutput = execResult
    ? {
        model_id: "quantEngine",
        action:
          execResult.action === "enter_now" || execResult.action === "scale_in"
            ? (dir > 0 ? "BUY" : "SELL")
            : execResult.action === "full_exit" || execResult.action === "partial_exit"
              ? "NO_TRADE"
              : "WAIT",
        confidence: execResult.confidence,
        direction:
          execResult.action === "enter_now" || execResult.action === "scale_in"
            ? dir
            : 0,
        provenance: execResult.provenance ?? "heuristic",
      }
    : {
        model_id: "quantEngine",
        action: "NO_TRADE",
        confidence: 0,
        direction: 0,
        provenance: "unavailable",
      };

  return [
    regimeOutput,
    rankOutput,
    stratOutput,
    riskOutput,
    priceOutput,
    ivOutput,
    execOutput,
  ];
}

// ─── Meta-decision application ────────────────────────────────────────────────

/**
 * Apply the MetaDecisionEngine verdict to an ``OpportunityV1``.
 *
 * This is the final gate before an opportunity reaches the execution layer.
 * It modifies:
 *   - ``scores.mlScore``              ← calibrated confidence × agreement_ratio
 *   - ``evidence.decisionRationale``  ← ≤200-char LLM/heuristic rationale
 *   - ``decision``                    ← overridden to ABSTAIN when abstention=true
 *   - ``softPenalties``               ← appends ML_UNCERTAINTY on abstention
 *   - ``versions.mlModelVersion``     ← tags provenance
 *   - ``scores.finalScore``           ← recalculated to include mlScore
 *
 * PURE ABSTENTION SEMANTICS:
 *   When meta.abstention is true OR meta.action is "NO_TRADE", the opportunity
 *   decision is unconditionally overridden to ABSTAIN — even if the earlier
 *   pipeline stages approved it. This enforces the quant rule that no capital
 *   is deployed without model agreement.
 *
 * NULL SAFETY:
 *   When meta is null (ML service down), the opportunity passes through
 *   unmodified. The pipeline's heuristic quality score already produced a
 *   decision; ML enhancement is additive, not a hard dependency.
 *
 * @param opportunity  The ``OpportunityV1`` produced by the pipeline to date.
 * @param meta         The ``MLMetaDecision`` from POST /v2/meta/decide, or null.
 * @returns            A new ``OpportunityV1`` with ML fields applied.
 */
export function applyMetaDecision(
  opportunity: OpportunityV1,
  meta: MLMetaDecision | null,
): OpportunityV1 {
  if (meta === null) {
    // ML service unavailable — pass through with a note in the evidence
    return {
      ...opportunity,
      evidence: {
        ...opportunity.evidence,
        missingFactors: [
          ...opportunity.evidence.missingFactors,
          "ML MetaDecisionEngine (service unavailable — heuristic fallback active)",
        ],
      },
    };
  }

  // ── mlScore → calibrated probability for OpportunityScoreVector ──────────
  const mlScore = metaDecisionToMlScore(meta);

  // ── Rationale → inject into OpportunityV1.evidence.decisionRationale ─────
  const rationale = metaDecisionRationale(meta, opportunity.instrument);

  // ── Abstention gate ───────────────────────────────────────────────────────
  // When the MetaDecisionEngine abstains, we MUST NOT trade — override the
  // pipeline's APPROVED decision regardless of the quality score.
  const shouldAbstain =
    meta.abstention ||
    meta.action === "NO_TRADE" ||
    meta.agreement_ratio < 0.5;

  const overriddenDecision = shouldAbstain
    ? ("ABSTAIN" as const)
    : opportunity.decision;

  const overriddenLifecycle = shouldAbstain
    ? ("ABSTAINED" as const)
    : opportunity.lifecycleState;

  // ── Soft penalty for ML uncertainty ──────────────────────────────────────
  const additionalPenalties: SoftPenaltyCode[] = [];
  if (shouldAbstain) {
    additionalPenalties.push("ML_UNCERTAINTY");
  }

  // ── Final score recalculation (weighted blend with existing qualityScore) ─
  // ml-service2.0 mlScore contributes 15% of final score.
  const ML_SCORE_WEIGHT = 0.15;
  const updatedFinalScore = Math.max(
    0,
    Math.min(
      100,
      opportunity.scores.finalScore * (1 - ML_SCORE_WEIGHT) +
        mlScore * 100 * ML_SCORE_WEIGHT,
    ),
  );

  // ── Positive/negative evidence from reason_codes ─────────────────────────
  const mlPositive: string[] = [];
  const mlNegative: string[] = [];
  for (const code of meta.reason_codes ?? []) {
    if (
      code.includes("UNAVAILABLE") ||
      code.includes("ABSTAIN") ||
      code.includes("INSUFFICIENT") ||
      code.includes("CONFLICT") ||
      code.includes("HIGH_RISK")
    ) {
      mlNegative.push(`ML: ${code}`);
    } else if (code.includes("PASS") || code.includes("BUY") || code.includes("APPROVED")) {
      mlPositive.push(`ML: ${code}`);
    }
  }

  // ── Top SHAP drivers ─────────────────────────────────────────────────────
  const topDrivers =
    meta.explainability?.top_features
      .slice(0, 3)
      .map((f) => `${f.feature} (${f.direction === "positive" ? "+" : "-"}${Math.abs(f.contribution).toFixed(3)})`) ?? [];

  if (topDrivers.length > 0) {
    mlPositive.push(`SHAP drivers: ${topDrivers.join(", ")}`);
  }

  return {
    ...opportunity,
    decision: overriddenDecision,
    decisionReason: shouldAbstain
      ? `ML MetaDecisionEngine abstained: ${meta.reason_codes.slice(0, 2).join(", ") || "insufficient agreement"}`
      : opportunity.decisionReason,
    lifecycleState: overriddenLifecycle,
    softPenalties: [
      ...opportunity.softPenalties,
      ...additionalPenalties,
    ],
    scores: {
      ...opportunity.scores,
      mlScore,
      finalScore: updatedFinalScore,
    },
    evidence: {
      ...opportunity.evidence,
      decisionRationale: rationale,
      positiveEvidence: [
        ...opportunity.evidence.positiveEvidence,
        ...mlPositive,
      ],
      negativeEvidence: [
        ...opportunity.evidence.negativeEvidence,
        ...mlNegative,
      ],
    },
    versions: {
      ...opportunity.versions,
      mlModelVersion: `ml-service2.0/v2 | prov=${meta.provenance} | agree=${meta.agreement_ratio.toFixed(2)}`,
    },
  };
}

// ─── Convenience: build news context from SentinelPulse payload ──────────────

/**
 * Build the ``MLNewsContext`` payload expected by ``predictMetaDecision``
 * from a raw SentinelPulse news-context API response.
 *
 * This is a lightweight adapter — it normalises field names and discards
 * unknown keys so the ml-service2.0 Pydantic models can parse it cleanly.
 */
export function sentinelToNewsContext(
  sentinel: Record<string, unknown> | null,
): MLNewsContext | undefined {
  if (!sentinel) return undefined;

  const sentiment = sentinel.sentiment as Record<string, number> | undefined;
  return {
    news_impact_score:
      typeof sentinel.news_impact_score === "number"
        ? sentinel.news_impact_score
        : undefined,
    impact_direction:
      (sentinel.impact_direction as "BULLISH" | "BEARISH" | "NEUTRAL") ??
      undefined,
    impact_confidence:
      typeof sentinel.impact_confidence === "number"
        ? sentinel.impact_confidence
        : undefined,
    sentiment: sentiment
      ? {
          overall: sentiment.overall ?? 0,
          market:  sentiment.market  ?? 0,
          company: sentiment.company ?? 0,
          macro:   sentiment.macro   ?? 0,
          risk:    sentiment.risk    ?? 0,
        }
      : undefined,
    market_regime:
      typeof sentinel.market_regime === "string"
        ? sentinel.market_regime
        : undefined,
    event_tags: Array.isArray(sentinel.event_tags)
      ? (sentinel.event_tags as string[])
      : undefined,
  };
}

// ─── Opportunity pipeline integration guide ───────────────────────────────────
//
// Add the following block at the END of runOpportunityPipeline() in pipeline.ts,
// replacing the existing "Stage 12: Final decision" block:
//
// ── Stage 12: MetaDecisionEngine gate (ml-service2.0 Phase 4) ────────────────
//
//   import { buildModelOutputs, applyMetaDecision, sentinelToNewsContext }
//     from "@/lib/india/ml-service2-integration";
//   import { predictMetaDecision, type MLModelOutput } from "@/lib/india/ml-client";
//
//   const modelOutputs = buildModelOutputs(
//     mlContext.regime,           // from buildMLContext()
//     mlContext.rankings,         // from buildMLContext()
//     await getMLStrategy(mlContext, input.instrument, stratFeatures),
//     riskPrediction,             // from getMLRisk()
//     mlContext.priceForecast,    // from buildMLContext()
//     ivClassificationResult,     // from predictIVRegime()
//     executionDecision,          // from predictExecution()
//     input.direction,
//   );
//
//   const sentinelCtx = sentinelToNewsContext(rawSentinelPayload);
//
//   const meta = await predictMetaDecision({
//     symbol: input.instrument,
//     regime: mlContext.regime?.regime ?? "sideways",
//     model_outputs: modelOutputs,
//     news_context: sentinelCtx,
//     risk_context: riskPrediction
//       ? { prob_stop_hit: riskPrediction.prob_stop_hit }
//       : undefined,
//   });
//
//   const opportunity = applyMetaDecision(partialOpportunity, meta);
//
// The returned ``opportunity`` has:
//   - opportunity.decision            updated to ABSTAIN when ML abstains
//   - opportunity.scores.mlScore      calibrated meta confidence × agreement
//   - opportunity.evidence.decisionRationale  ≤200-char LLM explanation
//   - opportunity.versions.mlModelVersion     provenance tag
//
// ─────────────────────────────────────────────────────────────────────────────
