"""
Phase 3J — Model Lifecycle, Champion/Challenger & Evidence-Gated Promotion.

Answers: Which model is currently trusted, why, what evidence supports it, what
challengers exist, and under exactly what conditions may a challenger replace
the champion?

Governance package — NOT model generation. It consumes candidate models
produced by the existing training system. It does NOT retrain, does NOT
auto-generate challengers, and does NOT auto-promote high-impact changes
without the configured approval policy.

Modules
-------
schemas.py           — ModelIdentity, ModelProvenance, ModelSchemaContract,
                       LifecycleState machine, PromotionDecision, GateResult,
                       ModelCard, ChampionCard, all enums
artifact_integrity.py — SHA-256 artifact hashing, fail-closed verification
evidence.py          — ModelEvidencePackage (frozen + hashed), A/B/C/D hierarchy
compatibility.py     — model/feature/label/calibrator/meta/execution/portfolio checks
registry.py          — persistent versioned registry, atomic + cross-process safe
champion.py          — scoped ChampionIndex, history, historical lookup, rollback
challenger.py        — challenger registry, shadow/paper, soak, selection bias
gates.py             — PromotionGate (6 structured gates) + PromotionPolicy
comparison.py        — apples-to-apples comparison on a frozen eval snapshot
promotion.py         — PromotionOrchestrator, PromotionManifest, atomic promotion,
                       rollback, crash-safety, model cards

Design invariants
-----------------
1. (model_id, model_version) is immutable; artifacts are SHA-256 verified.
2. Evidence packages are frozen and hashed.
3. Acceptance ≠ Promotion. Promotion uses six structured gates (no 0-100 score).
4. "latest" is never a valid production reference.
5. Fail-closed: missing evidence/artifact → NO_PROMOTION.
6. No np.random.* anywhere.
"""

from .schemas import (
    # Enums
    LifecycleState,
    ChallengerStatus,
    EvidenceLevel,
    PredictionSemantics,
    GateStatus,
    PromotionOutcome,
    ApprovalPolicy,
    RetirementReason,
    IntegrityStatus,
    CompatibilityStatus,
    # Functions / constants
    is_valid_transition,
    VALID_TRANSITIONS,
    TERMINAL_STATES,
    # Dataclasses
    ModelIdentity,
    ModelProvenance,
    ModelSchemaContract,
    GateResult,
    PromotionDecision,
    ModelCard,
    ChampionCard,
)
from .artifact_integrity import (
    compute_artifact_hash,
    artifact_size_bytes,
    is_forbidden_reference,
    verify_artifact_integrity,
    safe_load_guard,
    ArtifactIntegrityResult,
)
from .evidence import (
    ModelEvidencePackage,
    TrainingEvidence,
    OOSEvidence,
    CalibrationEvidence,
    ExecutionEvidence,
    PortfolioEvidence,
    StabilityEvidence,
    RiskEvidence,
)
from .compatibility import (
    CompatibilityChecker,
    CompatibilityCheck,
    CompatibilityReport,
)
from .registry import (
    ModelRegistry,
    RegistryRecord,
    RegistryError,
    ImmutabilityViolation,
    InvalidTransition,
)
from .champion import (
    ChampionIndex,
    ChampionEntry,
    ChampionHistoryEntry,
    ChampionError,
)
from .challenger import (
    ChallengerRegistry,
    ChallengerRecord,
    ShadowOutput,
    SoakConfig,
    ChallengerError,
)
from .gates import (
    PromotionGate,
    PromotionPolicy,
)
from .comparison import (
    ChampionChallengerComparator,
    ComparisonResult,
    FrozenEvalSnapshot,
)
from .promotion import (
    PromotionOrchestrator,
    PromotionManifest,
    PromotionError,
)

__all__ = [
    # Enums
    "LifecycleState", "ChallengerStatus", "EvidenceLevel", "PredictionSemantics",
    "GateStatus", "PromotionOutcome", "ApprovalPolicy", "RetirementReason",
    "IntegrityStatus", "CompatibilityStatus",
    "is_valid_transition", "VALID_TRANSITIONS", "TERMINAL_STATES",
    # Schemas
    "ModelIdentity", "ModelProvenance", "ModelSchemaContract",
    "GateResult", "PromotionDecision", "ModelCard", "ChampionCard",
    # Integrity
    "compute_artifact_hash", "artifact_size_bytes", "is_forbidden_reference",
    "verify_artifact_integrity", "safe_load_guard", "ArtifactIntegrityResult",
    # Evidence
    "ModelEvidencePackage", "TrainingEvidence", "OOSEvidence",
    "CalibrationEvidence", "ExecutionEvidence", "PortfolioEvidence",
    "StabilityEvidence", "RiskEvidence",
    # Compatibility
    "CompatibilityChecker", "CompatibilityCheck", "CompatibilityReport",
    # Registry
    "ModelRegistry", "RegistryRecord", "RegistryError",
    "ImmutabilityViolation", "InvalidTransition",
    # Champion
    "ChampionIndex", "ChampionEntry", "ChampionHistoryEntry", "ChampionError",
    # Challenger
    "ChallengerRegistry", "ChallengerRecord", "ShadowOutput", "SoakConfig",
    "ChallengerError",
    # Gates
    "PromotionGate", "PromotionPolicy",
    # Comparison
    "ChampionChallengerComparator", "ComparisonResult", "FrozenEvalSnapshot",
    # Promotion
    "PromotionOrchestrator", "PromotionManifest", "PromotionError",
]
