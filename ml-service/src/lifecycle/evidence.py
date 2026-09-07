"""
Phase 3J — Model Evidence Package.

A frozen, hashed bundle of all evidence supporting a model.

Design rules
------------
1. Once generated, an evidence package is IMMUTABLE (spec §14). The evidence_hash
   proves it has not been modified. If evidence changes → new package.
2. Evidence is classified into a hierarchy A/B/C/D (spec §15). A model relying
   heavily on Level C/D evidence must NOT automatically qualify for promotion.
3. Required evidence components are recorded where applicable; irrelevant metrics
   are not required (spec §16).
4. No np.random.* — deterministic.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Optional

from .schemas import EvidenceLevel, ModelIdentity

UTC = timezone.utc

EVIDENCE_SCHEMA_VERSION = "evidence-v1"


@dataclass
class TrainingEvidence:
    """Training integrity evidence."""
    training_folds:       str = ""
    purge_window_bars:    int = 0
    embargo_window_bars:  int = 0
    n_training_rows:      int = 0
    pit_violations:       int = 0
    leakage_audit_status: str = "INSUFFICIENT_EVIDENCE"   # PASS/FAIL/CONDITIONAL


@dataclass
class OOSEvidence:
    """Walk-forward OOS evidence (spec §16)."""
    mean_ic:              Optional[float] = None
    mean_rank_ic:         Optional[float] = None
    icir:                 Optional[float] = None
    decile_monotonicity:  Optional[float] = None
    top_bottom_spread:    Optional[float] = None
    n_oos_observations:   int = 0
    n_oos_timestamps:     int = 0
    final_oos_used_for_selection: bool = False   # spec §24 — contamination flag


@dataclass
class CalibrationEvidence:
    """Calibration evidence (spec §16, §29)."""
    brier:                Optional[float] = None
    log_loss:             Optional[float] = None
    ece:                  Optional[float] = None
    mce:                  Optional[float] = None
    calibration_slope:    Optional[float] = None
    calibration_intercept: Optional[float] = None
    calibrator_version:   str = ""
    eval_is_oos:          bool = False


@dataclass
class ExecutionEvidence:
    """Execution-adjusted evidence (spec §16, §31)."""
    gross_return:         Optional[float] = None
    net_return:           Optional[float] = None
    total_cost:           Optional[float] = None
    turnover:             Optional[float] = None
    capacity_pct_adv:     Optional[float] = None
    execution_model_version: str = ""
    cost_model_version:   str = ""
    slippage_model_version: str = ""


@dataclass
class PortfolioEvidence:
    """Portfolio evidence (spec §16, §32)."""
    portfolio_return:     Optional[float] = None
    volatility_ann:       Optional[float] = None
    sharpe:               Optional[float] = None
    sortino:              Optional[float] = None
    calmar:               Optional[float] = None
    max_drawdown:         Optional[float] = None
    cvar_95:              Optional[float] = None
    sector_hhi:           Optional[float] = None
    gross_exposure:       Optional[float] = None
    net_exposure:         Optional[float] = None
    portfolio_model_version: str = ""
    risk_model_version:   str = ""
    constraint_set_version: str = ""


@dataclass
class StabilityEvidence:
    """Stability/decay evidence from Phase 3I (spec §16, §33)."""
    ic_decay_status:      str = "INSUFFICIENT_EVIDENCE"
    ic_trend_slope:       Optional[float] = None
    half_life_status:     str = "HALF_LIFE_INSUFFICIENT_EVIDENCE"
    feature_drift_severity: str = "NONE"
    prediction_drift_severity: str = "NONE"
    calibration_drift_status: str = "INSUFFICIENT_EVIDENCE"
    regime_robustness:    str = "INSUFFICIENT_EVIDENCE"


@dataclass
class RiskEvidence:
    """Risk evidence (spec §16)."""
    max_drawdown:         Optional[float] = None
    cvar_95:              Optional[float] = None
    tail_loss_frequency:  Optional[float] = None
    worst_regime_ic:      Optional[float] = None


@dataclass
class ModelEvidencePackage:
    """
    Complete, FROZEN evidence package for one model (spec §13, §14).

    Once `freeze()` is called, `evidence_hash` is computed and the package
    must not be modified. If evidence changes, create a NEW package (new
    evidence_version).
    """
    evidence_package_id:  str
    model_identity:       ModelIdentity

    # Identity references
    dataset_identity:     str = ""
    feature_identity:     str = ""
    label_identity:       str = ""

    # Evidence components
    training_evidence:    TrainingEvidence = field(default_factory=TrainingEvidence)
    oos_evidence:         OOSEvidence = field(default_factory=OOSEvidence)
    calibration_evidence: CalibrationEvidence = field(default_factory=CalibrationEvidence)
    execution_evidence:   ExecutionEvidence = field(default_factory=ExecutionEvidence)
    portfolio_evidence:   PortfolioEvidence = field(default_factory=PortfolioEvidence)
    stability_evidence:   StabilityEvidence = field(default_factory=StabilityEvidence)
    risk_evidence:        RiskEvidence = field(default_factory=RiskEvidence)

    # Evidence classification
    evidence_level:       EvidenceLevel = EvidenceLevel.LEVEL_D

    # Metadata
    evidence_generated_at: str = ""
    evidence_version:     str = EVIDENCE_SCHEMA_VERSION
    evidence_hash:        str = ""      # set by freeze()
    _frozen:              bool = field(default=False, repr=False)

    def classify_evidence_level(self) -> EvidenceLevel:
        """
        Classify the evidence hierarchy (spec §15).

        LEVEL_A — real OOS evidence with sufficient sample and no contamination
        LEVEL_B — high-quality historical but limited sample
        LEVEL_C — proxy-based (e.g. no real execution/cost data)
        LEVEL_D — insufficient evidence

        A model at LEVEL_C/D must not auto-qualify for promotion.
        """
        oos = self.oos_evidence

        # Final OOS contamination forces LEVEL_D (cannot trust for promotion)
        if oos.final_oos_used_for_selection:
            return EvidenceLevel.LEVEL_D

        # Need real OOS observations
        if oos.n_oos_observations < 30 or oos.mean_rank_ic is None:
            return EvidenceLevel.LEVEL_D

        # Execution/cost realism check
        exec_ev = self.execution_evidence
        has_execution = exec_ev.net_return is not None and exec_ev.cost_model_version not in ("", "DATA_UNAVAILABLE")
        has_calibration = self.calibration_evidence.brier is not None
        has_stability = self.stability_evidence.ic_decay_status not in ("INSUFFICIENT_EVIDENCE", "")

        if oos.n_oos_observations >= 100 and has_execution and has_calibration and has_stability:
            return EvidenceLevel.LEVEL_A
        if oos.n_oos_observations >= 60 and (has_calibration or has_stability):
            return EvidenceLevel.LEVEL_B
        if not has_execution:
            return EvidenceLevel.LEVEL_C
        return EvidenceLevel.LEVEL_B

    def _compute_hash(self) -> str:
        """
        Deterministic SHA-256 over the evidence CONTENT.

        Excludes the hash field itself AND evidence_generated_at — the hash
        depends only on the evidence content so that identical evidence produces
        an identical hash regardless of when it was generated (reproducibility,
        spec §69). Tampering with any content field is still detected.
        """
        payload = {
            "evidence_package_id":  self.evidence_package_id,
            "model_identity":       self.model_identity.to_dict(),
            "dataset_identity":     self.dataset_identity,
            "feature_identity":     self.feature_identity,
            "label_identity":       self.label_identity,
            "training_evidence":    asdict(self.training_evidence),
            "oos_evidence":         asdict(self.oos_evidence),
            "calibration_evidence": asdict(self.calibration_evidence),
            "execution_evidence":   asdict(self.execution_evidence),
            "portfolio_evidence":   asdict(self.portfolio_evidence),
            "stability_evidence":   asdict(self.stability_evidence),
            "risk_evidence":        asdict(self.risk_evidence),
            "evidence_level":       self.evidence_level.value,
            "evidence_version":     self.evidence_version,
        }
        raw = json.dumps(payload, sort_keys=True, default=str)
        return hashlib.sha256(raw.encode()).hexdigest()

    def freeze(self) -> "ModelEvidencePackage":
        """
        Freeze the package: classify evidence level and compute the hash.
        After freezing, the package is immutable — mutations are detectable
        via verify_integrity().
        """
        if self._frozen:
            return self
        if not self.evidence_generated_at:
            self.evidence_generated_at = datetime.now(UTC).isoformat()
        self.evidence_level = self.classify_evidence_level()
        self.evidence_hash = self._compute_hash()
        self._frozen = True
        return self

    def verify_integrity(self) -> bool:
        """
        Verify the package has not been modified since freezing.
        Returns True if the recomputed hash matches the stored evidence_hash.
        """
        if not self._frozen or not self.evidence_hash:
            return False
        return self._compute_hash() == self.evidence_hash

    def to_dict(self) -> dict:
        return {
            "evidence_package_id":  self.evidence_package_id,
            "model_identity":       self.model_identity.to_dict(),
            "dataset_identity":     self.dataset_identity,
            "feature_identity":     self.feature_identity,
            "label_identity":       self.label_identity,
            "training_evidence":    asdict(self.training_evidence),
            "oos_evidence":         asdict(self.oos_evidence),
            "calibration_evidence": asdict(self.calibration_evidence),
            "execution_evidence":   asdict(self.execution_evidence),
            "portfolio_evidence":   asdict(self.portfolio_evidence),
            "stability_evidence":   asdict(self.stability_evidence),
            "risk_evidence":        asdict(self.risk_evidence),
            "evidence_level":       self.evidence_level.value,
            "evidence_generated_at": self.evidence_generated_at,
            "evidence_version":     self.evidence_version,
            "evidence_hash":        self.evidence_hash,
        }
