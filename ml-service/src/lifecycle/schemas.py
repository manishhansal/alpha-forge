"""
Phase 3J — Model Lifecycle Schemas.

Canonical types for the champion/challenger, registry, evidence, and promotion
system.

Design rules
------------
1. Model identity is IMMUTABLE. Once (model_id, model_version) is registered, the
   artifact underneath must never change. If it changes, a NEW version is created.
2. Every artifact carries a SHA-256 hash. Loading verifies integrity (fail-closed).
3. Evidence packages are FROZEN once generated (evidence_hash proves immutability).
4. "latest" is NEVER a valid production reference — only (model_id, model_version)
   plus a governed champion pointer.
5. Acceptance ≠ Promotion. They are separate gates.
6. No black-box 0–100 promotion score — structured gates (PASS/FAIL/INSUFFICIENT).
7. No np.random.* anywhere in this package.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Optional

UTC = timezone.utc


# ══════════════════════════════════════════════════════════════════════════════
# Enumerations
# ══════════════════════════════════════════════════════════════════════════════

class LifecycleState(str, Enum):
    """
    Model lifecycle state machine (spec §2, §58).

    Valid forward path:
        REGISTERED → VALIDATING → EVIDENCE_READY → CANDIDATE
        → SHADOW → PAPER → PROMOTION_ELIGIBLE → CHAMPION

    Alternative exits: REJECTED / BLOCKED / RETIRED / ROLLED_BACK
    """
    REGISTERED           = "REGISTERED"
    VALIDATING           = "VALIDATING"
    EVIDENCE_READY       = "EVIDENCE_READY"
    CANDIDATE            = "CANDIDATE"
    SHADOW               = "SHADOW"
    PAPER                = "PAPER"
    PROMOTION_ELIGIBLE   = "PROMOTION_ELIGIBLE"
    CHAMPION             = "CHAMPION"
    # Terminal / alternative
    REJECTED             = "REJECTED"
    BLOCKED              = "BLOCKED"
    RETIRED              = "RETIRED"
    ROLLED_BACK          = "ROLLED_BACK"
    ABSTAINED            = "ABSTAINED"


# Allowed forward transitions (spec §57 — invalid transitions must fail)
VALID_TRANSITIONS: dict[LifecycleState, set[LifecycleState]] = {
    LifecycleState.REGISTERED:         {LifecycleState.VALIDATING, LifecycleState.REJECTED, LifecycleState.BLOCKED},
    LifecycleState.VALIDATING:         {LifecycleState.EVIDENCE_READY, LifecycleState.REJECTED, LifecycleState.BLOCKED, LifecycleState.ABSTAINED},
    LifecycleState.EVIDENCE_READY:     {LifecycleState.CANDIDATE, LifecycleState.REJECTED, LifecycleState.BLOCKED},
    LifecycleState.CANDIDATE:          {LifecycleState.SHADOW, LifecycleState.REJECTED, LifecycleState.BLOCKED},
    LifecycleState.SHADOW:             {LifecycleState.PAPER, LifecycleState.REJECTED, LifecycleState.RETIRED},
    LifecycleState.PAPER:              {LifecycleState.PROMOTION_ELIGIBLE, LifecycleState.REJECTED, LifecycleState.RETIRED},
    LifecycleState.PROMOTION_ELIGIBLE: {LifecycleState.CHAMPION, LifecycleState.REJECTED, LifecycleState.BLOCKED},
    LifecycleState.CHAMPION:           {LifecycleState.RETIRED, LifecycleState.ROLLED_BACK},
    # Terminal states — require an explicit NEW lifecycle action + evidence to re-enter
    LifecycleState.REJECTED:           set(),
    LifecycleState.BLOCKED:            {LifecycleState.VALIDATING},   # re-validate after fix
    LifecycleState.RETIRED:            set(),
    LifecycleState.ROLLED_BACK:        {LifecycleState.RETIRED},
    LifecycleState.ABSTAINED:          {LifecycleState.VALIDATING},
}

# Terminal states that cannot become champion without a fresh lifecycle
TERMINAL_STATES = {
    LifecycleState.REJECTED,
    LifecycleState.RETIRED,
    LifecycleState.ROLLED_BACK,
}


def is_valid_transition(from_state: LifecycleState, to_state: LifecycleState) -> bool:
    """Return True if the transition from_state → to_state is allowed."""
    return to_state in VALID_TRANSITIONS.get(from_state, set())


class ChallengerStatus(str, Enum):
    """Challenger registry status (spec §12)."""
    REGISTERED           = "REGISTERED"
    VALIDATING           = "VALIDATING"
    SHADOW               = "SHADOW"
    PAPER                = "PAPER"
    PROMOTION_ELIGIBLE   = "PROMOTION_ELIGIBLE"
    PROMOTED             = "PROMOTED"
    REJECTED             = "REJECTED"
    RETIRED              = "RETIRED"


class EvidenceLevel(str, Enum):
    """Evidence hierarchy (spec §15)."""
    LEVEL_A               = "LEVEL_A"   # Observed / fully supported OOS
    LEVEL_B               = "LEVEL_B"   # High-quality derived historical
    LEVEL_C               = "LEVEL_C"   # Proxy-based
    LEVEL_D               = "LEVEL_D"   # Insufficient evidence


class PredictionSemantics(str, Enum):
    """What a model's output represents (spec §6)."""
    ALPHA_SCORE            = "ALPHA_SCORE"
    EXPECTED_RETURN        = "EXPECTED_RETURN"
    RAW_PROBABILITY        = "RAW_PROBABILITY"
    CALIBRATED_PROBABILITY = "CALIBRATED_PROBABILITY"
    EXPECTED_VALUE         = "EXPECTED_VALUE"
    REGIME_CLASS           = "REGIME_CLASS"
    UNKNOWN                = "UNKNOWN"


class GateStatus(str, Enum):
    """Per-gate result (spec §62)."""
    PASS                  = "PASS"
    FAIL                  = "FAIL"
    INSUFFICIENT_EVIDENCE = "INSUFFICIENT_EVIDENCE"


class PromotionOutcome(str, Enum):
    """Final promotion decision (spec §63)."""
    PROMOTE               = "PROMOTE"
    DO_NOT_PROMOTE        = "DO_NOT_PROMOTE"
    BLOCKED               = "BLOCKED"
    INSUFFICIENT_EVIDENCE = "INSUFFICIENT_EVIDENCE"
    NO_PROMOTION          = "NO_PROMOTION"   # no challenger satisfies the gate


class ApprovalPolicy(str, Enum):
    """Human review policy (spec §50)."""
    AUTO_APPROVED           = "AUTO_APPROVED"
    HUMAN_APPROVAL_REQUIRED = "HUMAN_APPROVAL_REQUIRED"
    AUTO_REJECTED           = "AUTO_REJECTED"


class RetirementReason(str, Enum):
    """Model retirement reasons (spec §42)."""
    DECAY                 = "DECAY"
    DRIFT                 = "DRIFT"
    SUPERSEDED            = "SUPERSEDED"
    DATA_DEPRECATION      = "DATA_DEPRECATION"
    EXECUTION_LIMITATION  = "EXECUTION_LIMITATION"
    MODEL_FAILURE         = "MODEL_FAILURE"


class IntegrityStatus(str, Enum):
    """Artifact integrity check result (spec §5)."""
    VERIFIED              = "VERIFIED"
    INTEGRITY_FAILURE     = "MODEL_ARTIFACT_INTEGRITY_FAILURE"
    ARTIFACT_MISSING      = "ARTIFACT_MISSING"


class CompatibilityStatus(str, Enum):
    """Compatibility check result (spec §7)."""
    COMPATIBLE            = "COMPATIBLE"
    INCOMPATIBLE          = "INCOMPATIBLE"
    UNVERIFIED            = "UNVERIFIED"


# ══════════════════════════════════════════════════════════════════════════════
# Model identity (immutable)
# ══════════════════════════════════════════════════════════════════════════════

@dataclass(frozen=True)
class ModelIdentity:
    """
    Immutable identity of a model artifact (spec §3).

    A model is NEVER identified only by "LightGBM" or "v2". The full identity
    includes all versions and hashes needed for reproducibility.

    frozen=True enforces immutability at the Python level.
    """
    model_id:             str            # unique, e.g. "ranker-lgbm-20240115-a1b2c3"
    model_family:         str            # e.g. "cross_sectional_ranker"
    model_type:           str            # e.g. "LightGBM"
    model_version:        str            # e.g. "v3"
    artifact_hash:        str            # SHA-256 of the artifact file
    created_at:           str            # ISO-8601 UTC
    training_start:       str
    training_end:         str
    code_version:         str            # git commit

    # Data / feature / label identity
    dataset_version:      str = ""
    dataset_snapshot_id:  str = ""
    universe_version:     str = ""
    feature_version:      str = ""
    label_version:        str = ""
    label_config_hash:    str = ""
    training_config_hash: str = ""
    hyperparameter_hash:  str = ""
    random_seed:          int = 42

    @property
    def full_key(self) -> str:
        """Immutable registry key: model_id@model_version."""
        return f"{self.model_id}@{self.model_version}"

    @property
    def identity_hash(self) -> str:
        """Deterministic hash of the full identity (for tamper detection)."""
        key = {
            "model_id":             self.model_id,
            "model_family":         self.model_family,
            "model_type":           self.model_type,
            "model_version":        self.model_version,
            "artifact_hash":        self.artifact_hash,
            "training_start":       self.training_start,
            "training_end":         self.training_end,
            "code_version":         self.code_version,
            "dataset_version":      self.dataset_version,
            "dataset_snapshot_id":  self.dataset_snapshot_id,
            "universe_version":     self.universe_version,
            "feature_version":      self.feature_version,
            "label_version":        self.label_version,
            "label_config_hash":    self.label_config_hash,
            "training_config_hash": self.training_config_hash,
            "hyperparameter_hash":  self.hyperparameter_hash,
            "random_seed":          self.random_seed,
        }
        raw = json.dumps(key, sort_keys=True)
        return hashlib.sha256(raw.encode()).hexdigest()[:16]

    def to_dict(self) -> dict:
        d = asdict(self)
        d["full_key"] = self.full_key
        d["identity_hash"] = self.identity_hash
        return d


# ══════════════════════════════════════════════════════════════════════════════
# Model provenance
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class ModelProvenance:
    """
    Full model provenance for reproducibility (spec §4).
    Records every version needed to reproduce the model.
    """
    model_id:             str
    model_version:        str

    # Data pipeline
    data_snapshot_id:     str = ""
    universe_version:     str = ""
    feature_version:      str = ""
    label_version:        str = ""
    label_config_hash:    str = ""

    # Training
    training_folds:       str = ""       # e.g. "walk_forward_5fold"
    purge_window_bars:    int = 0
    embargo_window_bars:  int = 0
    hyperparameter_hash:  str = ""
    random_seed:          int = 42

    # Downstream model versions (lineage)
    calibrator_id:        str = ""
    calibrator_version:   str = ""
    meta_model_id:        str = ""
    meta_model_version:   str = ""
    execution_model_version: str = ""
    cost_model_version:   str = ""
    slippage_model_version: str = ""
    market_calendar_version: str = ""
    portfolio_model_version: str = ""
    risk_model_version:   str = ""
    constraint_set_version: str = ""
    position_sizing_version: str = ""

    # Code / environment
    code_commit:          str = ""
    python_version:       str = ""
    library_versions:     dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return asdict(self)


# ══════════════════════════════════════════════════════════════════════════════
# Model schema contract
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class ModelSchemaContract:
    """
    Input/output contract of a model (spec §6).

    A model producing an ALPHA_SCORE must never be loaded where a
    CALIBRATED_PROBABILITY is expected.
    """
    model_id:             str
    model_version:        str
    feature_schema_version: str
    input_features:       list[str]
    required_columns:     list[str]
    column_types:         dict[str, str]   # column → dtype string
    missingness_policy:   str              # e.g. "RETURN_NAN"
    output_schema:        str              # e.g. "float score in [0,100]"
    prediction_semantics: PredictionSemantics
    prediction_horizon:   int              # bars

    def is_compatible_semantics(self, expected: PredictionSemantics) -> bool:
        return self.prediction_semantics == expected

    def to_dict(self) -> dict:
        d = asdict(self)
        d["prediction_semantics"] = self.prediction_semantics.value
        return d


# ══════════════════════════════════════════════════════════════════════════════
# Gate result & promotion decision
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class GateResult:
    """Result of one promotion gate (spec §62)."""
    gate_name:            str    # PREDICTIVE / CALIBRATION / EXECUTION / RISK / STABILITY / DATA
    status:               GateStatus
    reasons:              list[str] = field(default_factory=list)
    metrics_checked:      dict = field(default_factory=dict)

    @property
    def passed(self) -> bool:
        return self.status == GateStatus.PASS

    def to_dict(self) -> dict:
        return {
            "gate_name":       self.gate_name,
            "status":          self.status.value,
            "reasons":         self.reasons,
            "metrics_checked": self.metrics_checked,
        }


@dataclass
class PromotionDecision:
    """
    Structured promotion decision (spec §63).
    NOT a black-box score. Every gate result is explicit.
    """
    outcome:              PromotionOutcome
    scope:                str
    champion_id:          Optional[str]
    challenger_id:        str
    gate_results:         list[GateResult] = field(default_factory=list)
    reasons:              list[str] = field(default_factory=list)
    approval_policy:      ApprovalPolicy = ApprovalPolicy.HUMAN_APPROVAL_REQUIRED
    final_oos_contaminated: bool = False
    promotion_policy_version: str = "promotion-policy-v1"
    decided_at:           str = ""
    evidence_package_id:  str = ""
    comparison_id:        str = ""

    def gate(self, name: str) -> Optional[GateResult]:
        for g in self.gate_results:
            if g.gate_name == name:
                return g
        return None

    @property
    def all_gates_pass(self) -> bool:
        return len(self.gate_results) > 0 and all(g.passed for g in self.gate_results)

    def to_dict(self) -> dict:
        return {
            "outcome":                  self.outcome.value,
            "scope":                    self.scope,
            "champion_id":              self.champion_id,
            "challenger_id":            self.challenger_id,
            "gate_results":             [g.to_dict() for g in self.gate_results],
            "reasons":                  self.reasons,
            "approval_policy":          self.approval_policy.value,
            "final_oos_contaminated":   self.final_oos_contaminated,
            "promotion_policy_version": self.promotion_policy_version,
            "decided_at":               self.decided_at,
            "evidence_package_id":      self.evidence_package_id,
            "comparison_id":            self.comparison_id,
        }


# ══════════════════════════════════════════════════════════════════════════════
# Model card & champion card
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class ModelCard:
    """Model card for a promoted champion (spec §65)."""
    model_id:             str
    model_version:        str
    scope:                str
    purpose:              str
    prediction_semantics: str
    horizon_bars:         int
    training_period:      str
    dataset_version:      str
    feature_version:      str
    label_version:        str
    model_family:         str
    calibrator_version:   str = ""
    meta_model_version:   str = ""
    known_limitations:    list[str] = field(default_factory=list)
    performance_evidence: dict = field(default_factory=dict)
    risk_evidence:        dict = field(default_factory=dict)
    execution_evidence:   dict = field(default_factory=dict)
    stability_evidence:   dict = field(default_factory=dict)
    promotion_reason:     str = ""
    rollback_criteria:    list[str] = field(default_factory=list)
    created_at:           str = ""

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class ChampionCard:
    """Current champion summary (spec §66)."""
    scope:                str
    model_id:             str
    model_version:        str
    promoted_at:          str
    evidence_package_id:  str
    model_health:         str = "INSUFFICIENT_EVIDENCE"
    calibration_health:   str = "INSUFFICIENT_EVIDENCE"
    drift_health:         str = "INSUFFICIENT_EVIDENCE"
    execution_health:     str = "INSUFFICIENT_EVIDENCE"
    portfolio_health:     str = "INSUFFICIENT_EVIDENCE"

    def to_dict(self) -> dict:
        return asdict(self)
