"""
Prediction Provenance — classifies the source and evidence quality of every
model prediction produced by AlphaForge ml-service.

Every prediction that leaves the ml-service MUST carry one of these
classification values so that:
  - The frontend can show users whether they are seeing ML predictions
    or rule-based heuristics.
  - The execution layer can gate live orders on TRAINED_MODEL provenance.
  - The monitoring layer can track the fraction of HEURISTIC vs ML signals.
  - Research and live execution remain separated.

Rules
-----
TRAINED_MODEL
  A model artifact exists, was trained with chronological splits, passed
  the ModelAcceptanceGate, and the model version is registered in the
  ModelRegistry.  This is the only provenance level acceptable for live
  trading.

HEURISTIC
  No valid trained artifact exists (or the artifact failed the acceptance
  gate).  The response was produced by the rule-based fallback logic
  embedded in each model class.  Suitable for paper trading and research
  only.

INSUFFICIENT_EVIDENCE
  The model exists and is trained but OOS evidence does not meet the
  minimum threshold (IC > 0.02, net Sharpe > 0 after costs, CPCV
  fraction positive > 0.50).  The prediction is suppressed and the
  caller receives NO_TRADE with this provenance.

UNAVAILABLE
  All model paths failed (exception during inference, all features NaN,
  etc.).  The system could not produce any prediction.  Signal is treated
  as NO_TRADE.
"""

from __future__ import annotations

from enum import Enum


class PredictionProvenance(str, Enum):
    """Source and evidence quality of a single model prediction."""

    TRAINED_MODEL         = "trained_model"
    HEURISTIC             = "heuristic"
    INSUFFICIENT_EVIDENCE = "insufficient_evidence"
    UNAVAILABLE           = "unavailable"

    @property
    def is_live_eligible(self) -> bool:
        """Only TRAINED_MODEL predictions are eligible for live execution."""
        return self == PredictionProvenance.TRAINED_MODEL

    @property
    def should_trade(self) -> bool:
        """Whether this provenance level permits generating a trade signal."""
        return self in {
            PredictionProvenance.TRAINED_MODEL,
            PredictionProvenance.HEURISTIC,
        }


# ---------------------------------------------------------------------------
# Governs what happens when a heuristic runs in a given deployment mode.
# ---------------------------------------------------------------------------

class DeploymentMode(str, Enum):
    """
    Deployment mode controls how heuristic fallbacks behave.

    RESEARCH
        Heuristics are allowed; all provenance levels produce signals.
        Use this for strategy exploration and offline research.

    PAPER
        Heuristics are allowed; signals are paper-traded (no real capital).
        Same as RESEARCH for provenance purposes but logged separately.

    SHADOW
        Heuristics produce signals that are LOGGED but not executed.
        TRAINED_MODEL signals are also only logged.

    VALIDATED_ML_ONLY
        Only TRAINED_MODEL provenance produces trade signals.
        HEURISTIC provenance → NO_TRADE + INSUFFICIENT_EVIDENCE reason.
        Use this for live capital deployment.
    """

    RESEARCH         = "research"
    PAPER            = "paper"
    SHADOW           = "shadow"
    VALIDATED_ML_ONLY = "validated_ml_only"


def resolve_action(
    provenance: PredictionProvenance,
    proposed_action: str,
    deployment_mode: DeploymentMode = DeploymentMode.PAPER,
) -> tuple[str, PredictionProvenance]:
    """
    Apply deployment-mode governance to a proposed trade action.

    Parameters
    ----------
    provenance       : provenance of the prediction that produced the action
    proposed_action  : the action the engine wants to take (BUY/SELL/WAIT/NO_TRADE)
    deployment_mode  : current deployment configuration

    Returns
    -------
    (final_action, final_provenance)
    - In VALIDATED_ML_ONLY mode: HEURISTIC predictions are forced to NO_TRADE
      and provenance is changed to INSUFFICIENT_EVIDENCE.
    - In UNAVAILABLE: always NO_TRADE regardless of mode.
    - Otherwise: action passes through unchanged.
    """
    if provenance == PredictionProvenance.UNAVAILABLE:
        return "NO_TRADE", PredictionProvenance.UNAVAILABLE

    if provenance == PredictionProvenance.INSUFFICIENT_EVIDENCE:
        return "NO_TRADE", PredictionProvenance.INSUFFICIENT_EVIDENCE

    if (
        deployment_mode == DeploymentMode.VALIDATED_ML_ONLY
        and provenance == PredictionProvenance.HEURISTIC
    ):
        return "NO_TRADE", PredictionProvenance.INSUFFICIENT_EVIDENCE

    return proposed_action, provenance
