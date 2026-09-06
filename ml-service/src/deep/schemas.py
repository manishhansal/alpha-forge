"""
Phase 3K — Deep-Learning research schemas.

Identities, experiment records, provenance, and classifications for the
advanced-ML / deep-learning research phase.

Design invariants
-----------------
1. The classical stack is the baseline. A deep model must PROVE incremental
   value; nothing here assumes DL > classical.
2. No np.random.* — all stochasticity flows through an explicit seed recorded
   in provenance (spec §24, §27).
3. Complexity is a STRUCTURED classification (LOW/MODERATE/HIGH/VERY_HIGH), not
   a subjective numeric score (spec §41, §79).
4. Model value is a STRUCTURED classification with documented criteria
   (spec §58), never a single-metric verdict.
5. Every deep model enters Phase 3J as a CHALLENGER; it never auto-promotes
   (spec §28, §29, §83).
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, field
from enum import Enum
from typing import Any, Optional


# ══════════════════════════════════════════════════════════════════════════════
# Enums
# ══════════════════════════════════════════════════════════════════════════════

class ExperimentStatus(str, Enum):
    """Deep-learning experiment status (spec §61)."""
    PLANNED             = "PLANNED"
    RUNNING             = "RUNNING"
    COMPLETED           = "COMPLETED"
    FAILED              = "FAILED"
    REJECTED            = "REJECTED"
    PROMOTION_ELIGIBLE  = "PROMOTION_ELIGIBLE"
    PROMOTED            = "PROMOTED"
    RETIRED             = "RETIRED"


# Allowed experiment status transitions.
VALID_EXPERIMENT_TRANSITIONS: dict[ExperimentStatus, set[ExperimentStatus]] = {
    ExperimentStatus.PLANNED:            {ExperimentStatus.RUNNING, ExperimentStatus.REJECTED},
    ExperimentStatus.RUNNING:            {ExperimentStatus.COMPLETED, ExperimentStatus.FAILED, ExperimentStatus.REJECTED},
    ExperimentStatus.COMPLETED:          {ExperimentStatus.PROMOTION_ELIGIBLE, ExperimentStatus.REJECTED, ExperimentStatus.RETIRED},
    ExperimentStatus.FAILED:             {ExperimentStatus.RETIRED},
    ExperimentStatus.REJECTED:           set(),
    ExperimentStatus.PROMOTION_ELIGIBLE: {ExperimentStatus.PROMOTED, ExperimentStatus.REJECTED, ExperimentStatus.RETIRED},
    ExperimentStatus.PROMOTED:           {ExperimentStatus.RETIRED},
    ExperimentStatus.RETIRED:            set(),
}


def is_valid_experiment_transition(a: ExperimentStatus, b: ExperimentStatus) -> bool:
    return b in VALID_EXPERIMENT_TRANSITIONS.get(a, set())


class ArchitectureFamily(str, Enum):
    """Advanced-ML architecture families (spec §4)."""
    MLP                 = "MLP"
    TEMPORAL_CNN        = "TEMPORAL_CNN"
    LSTM                = "LSTM"
    GRU                 = "GRU"
    TRANSFORMER_LITE    = "TRANSFORMER_LITE"
    # Classical baselines (for comparison bookkeeping only)
    LINEAR              = "LINEAR"
    RIDGE               = "RIDGE"
    ELASTIC_NET         = "ELASTIC_NET"
    GBM                 = "GBM"
    CLASSICAL_RANKER    = "CLASSICAL_RANKER"
    ENSEMBLE            = "ENSEMBLE"


class TaskType(str, Enum):
    """Learning task (spec §16, §17)."""
    REGRESSION          = "REGRESSION"          # forward / excess return
    CLASSIFICATION      = "CLASSIFICATION"      # barrier success / direction
    RANKING             = "RANKING"             # cross-sectional rank
    MULTI_TASK          = "MULTI_TASK"


class LossType(str, Enum):
    """Task-appropriate loss (spec §18). Loss is NEVER chosen by OOS."""
    MSE                 = "MSE"
    HUBER               = "HUBER"
    BCE                 = "BCE"
    FOCAL               = "FOCAL"
    PAIRWISE_RANK       = "PAIRWISE_RANK"
    LISTWISE_RANK       = "LISTWISE_RANK"


class ComplexityClass(str, Enum):
    """Structured production complexity (spec §41, §79). NOT a numeric score."""
    LOW                 = "LOW"
    MODERATE            = "MODERATE"
    HIGH                = "HIGH"
    VERY_HIGH           = "VERY_HIGH"


class ModelValueClass(str, Enum):
    """Advanced-model value classification (spec §58)."""
    SUPERIOR              = "SUPERIOR"              # dominates baseline on the hierarchy
    COMPLEMENTARY         = "COMPLEMENTARY"         # improves ensemble, not standalone champion
    REDUNDANT             = "REDUNDANT"             # ~ same predictions/errors as champion
    UNSTABLE              = "UNSTABLE"              # good mean but fails seed/fold/regime stability
    WORSE                 = "WORSE"                 # inferior to baseline
    INSUFFICIENT_EVIDENCE = "INSUFFICIENT_EVIDENCE" # not enough OOS to judge


class ContaminationStatus(str, Enum):
    """Final-OOS contamination check (spec §69)."""
    CLEAN                   = "CLEAN"
    FINAL_OOS_CONTAMINATED  = "FINAL_OOS_CONTAMINATED"


class OverfitStatus(str, Enum):
    """Overfitting flag from train/val/OOS gaps (spec §53)."""
    OK                    = "OK"
    MILD_GAP              = "MILD_GAP"
    LARGE_GAP             = "LARGE_GAP"
    INSUFFICIENT_EVIDENCE = "INSUFFICIENT_EVIDENCE"


class ResearchEvidenceLevel(str, Enum):
    """
    Mirrors lifecycle.EvidenceLevel for research-side bookkeeping.
    LEVEL_A observed OOS ... LEVEL_D insufficient.
    """
    LEVEL_A = "LEVEL_A"
    LEVEL_B = "LEVEL_B"
    LEVEL_C = "LEVEL_C"
    LEVEL_D = "LEVEL_D"


# ══════════════════════════════════════════════════════════════════════════════
# Deep-model provenance (spec §27, §62, §63)
# ══════════════════════════════════════════════════════════════════════════════

@dataclass(frozen=True)
class DeepModelProvenance:
    """
    Complete provenance for a neural model. Frozen for reproducibility.

    Records everything needed to reproduce the model from code + data + seed
    (spec §27, §62). Determinism limitations (e.g. GPU) are documented, never
    silently claimed away (spec §63).
    """
    architecture:            str            # ArchitectureFamily value
    parameter_count:         int
    trainable_parameter_count: int
    framework:               str            # "numpy" | "torch"
    framework_version:       str
    optimizer:               str            # e.g. "adam"
    loss:                    str            # LossType value
    learning_rate:           float
    batch_size:              int
    max_epochs:              int
    seed:                    int
    numpy_seed:              int
    python_seed:             int
    framework_seed:          int
    deterministic_mode:      bool

    # Data / feature / label lineage (matches lifecycle.ModelIdentity fields)
    dataset_version:         str = ""
    dataset_snapshot_id:     str = ""
    feature_version:         str = ""
    label_version:           str = ""
    label_config_hash:       str = ""
    sequence_version:        str = ""
    scaler_version:          str = ""
    code_version:            str = ""
    artifact_hash:           str = ""

    # Honest determinism note
    determinism_limitations: str = ""

    @property
    def hyperparameter_hash(self) -> str:
        key = {
            "architecture":  self.architecture,
            "optimizer":     self.optimizer,
            "loss":          self.loss,
            "learning_rate": self.learning_rate,
            "batch_size":    self.batch_size,
            "max_epochs":    self.max_epochs,
        }
        raw = json.dumps(key, sort_keys=True)
        return hashlib.sha256(raw.encode()).hexdigest()[:16]

    def to_dict(self) -> dict:
        d = asdict(self)
        d["hyperparameter_hash"] = self.hyperparameter_hash
        return d


# ══════════════════════════════════════════════════════════════════════════════
# Complexity & latency profiles (spec §40, §41, §42, §43)
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class LatencyProfile:
    """Inference-latency profile (spec §42). NaN where insufficient observations."""
    n_observations:      int
    mean_ms:             Optional[float] = None
    median_ms:           Optional[float] = None
    p95_ms:              Optional[float] = None
    p99_ms:              Optional[float] = None

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class ComplexityProfile:
    """
    Structured complexity (spec §41). Reports discrete criteria + a class,
    NOT a subjective numeric penalty.
    """
    complexity_class:    ComplexityClass
    parameter_count:     int
    trainable_parameters: int
    model_size_bytes:    int
    training_time_s:     Optional[float] = None
    inference_time_ms:   Optional[float] = None
    memory_mb:           Optional[float] = None
    requires_gpu:        bool = False
    dependencies:        list[str] = field(default_factory=list)
    hardware_notes:      str = ""
    debuggability:       str = ""            # e.g. "high" | "moderate" | "low"
    operational_risk:    str = ""            # e.g. "low" | "moderate" | "high"
    criteria:            list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        d = asdict(self)
        d["complexity_class"] = self.complexity_class.value
        return d


# ══════════════════════════════════════════════════════════════════════════════
# Deep-learning experiment record (spec §60)
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class DeepLearningExperiment:
    """
    A single reproducible deep-learning experiment (spec §60, §62).

    Failed experiments are recorded, never hidden (spec §59).
    """
    experiment_id:       str
    model_id:            str
    architecture:        str                 # ArchitectureFamily value
    task_type:           str                 # TaskType value
    status:              ExperimentStatus

    # Reproducibility (spec §62)
    dataset_version:     str = ""
    feature_version:     str = ""
    label_version:       str = ""
    label_config_hash:   str = ""
    sequence_version:    str = ""
    scaler_version:      str = ""
    code_version:        str = ""
    seed:                int = 1337
    training_config:     dict = field(default_factory=dict)
    validation_config:   dict = field(default_factory=dict)

    # Results (populated when COMPLETED)
    results:             dict = field(default_factory=dict)
    evidence_package_id: str = ""
    model_value_class:   str = ""            # ModelValueClass value
    contamination_status: str = ContaminationStatus.CLEAN.value
    overfit_status:      str = ""
    rejection_reason:    str = ""

    created_at:          str = ""
    updated_at:          str = ""
    status_history:      list[dict] = field(default_factory=list)
    notes:               list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        d = asdict(self)
        d["status"] = self.status.value if isinstance(self.status, ExperimentStatus) else self.status
        return d

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "DeepLearningExperiment":
        data = dict(d)
        if isinstance(data.get("status"), str):
            data["status"] = ExperimentStatus(data["status"])
        # Drop any unknown keys defensively
        known = {f for f in cls.__dataclass_fields__}  # type: ignore[attr-defined]
        data = {k: v for k, v in data.items() if k in known}
        return cls(**data)
