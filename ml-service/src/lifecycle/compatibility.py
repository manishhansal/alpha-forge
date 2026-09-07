"""
Phase 3J — Model Compatibility Checks.

Validates compatibility between a model and its dependent artifacts before
promotion (spec §7).

Design rules
------------
1. A model trained on feature_version A must not silently load with
   feature_version B.
2. A calibrator trained for model A must not be used with model B unless
   explicitly compatible.
3. All checks fail closed — an unverifiable combination is INCOMPATIBLE or
   UNVERIFIED, never silently COMPATIBLE.
4. No np.random.* — deterministic.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

from .schemas import (
    CompatibilityStatus, ModelIdentity, ModelSchemaContract, PredictionSemantics,
)


@dataclass
class CompatibilityCheck:
    """Result of one compatibility check."""
    check_name:   str
    status:       CompatibilityStatus
    reason:       str = ""

    @property
    def compatible(self) -> bool:
        return self.status == CompatibilityStatus.COMPATIBLE


@dataclass
class CompatibilityReport:
    """Full compatibility report for a model + its dependents."""
    model_id:     str
    model_version: str
    checks:       list[CompatibilityCheck] = field(default_factory=list)

    @property
    def all_compatible(self) -> bool:
        return len(self.checks) > 0 and all(c.compatible for c in self.checks)

    @property
    def incompatible_checks(self) -> list[CompatibilityCheck]:
        return [c for c in self.checks if c.status == CompatibilityStatus.INCOMPATIBLE]

    def to_dict(self) -> dict:
        return {
            "model_id":       self.model_id,
            "model_version":  self.model_version,
            "all_compatible": self.all_compatible,
            "checks":         [
                {"check_name": c.check_name, "status": c.status.value, "reason": c.reason}
                for c in self.checks
            ],
        }


class CompatibilityChecker:
    """
    Validates compatibility between a model and its dependent artifacts.

    Usage
    -----
    ::
        checker = CompatibilityChecker()
        report = checker.check_all(
            model_identity=identity,
            feature_version="feat-v3",
            label_version="lv2",
            calibrator_model_id=..., calibrator_model_version=...,
            expected_semantics=PredictionSemantics.ALPHA_SCORE,
            schema_contract=contract,
        )
        if not report.all_compatible:
            # block promotion
    """

    def check_feature_version(
        self,
        model_feature_version: str,
        dataset_feature_version: str,
    ) -> CompatibilityCheck:
        """Model's feature version must match the dataset's feature version."""
        if not model_feature_version or not dataset_feature_version:
            return CompatibilityCheck(
                "feature_version", CompatibilityStatus.UNVERIFIED,
                "Feature version missing on model or dataset.",
            )
        if model_feature_version != dataset_feature_version:
            return CompatibilityCheck(
                "feature_version", CompatibilityStatus.INCOMPATIBLE,
                f"Model feature_version {model_feature_version!r} != "
                f"dataset feature_version {dataset_feature_version!r}.",
            )
        return CompatibilityCheck("feature_version", CompatibilityStatus.COMPATIBLE)

    def check_label_version(
        self,
        model_label_version: str,
        dataset_label_version: str,
    ) -> CompatibilityCheck:
        if not model_label_version or not dataset_label_version:
            return CompatibilityCheck(
                "label_version", CompatibilityStatus.UNVERIFIED,
                "Label version missing.",
            )
        if model_label_version != dataset_label_version:
            return CompatibilityCheck(
                "label_version", CompatibilityStatus.INCOMPATIBLE,
                f"Model label_version {model_label_version!r} != "
                f"dataset label_version {dataset_label_version!r}.",
            )
        return CompatibilityCheck("label_version", CompatibilityStatus.COMPATIBLE)

    def check_calibrator(
        self,
        model_id: str,
        model_version: str,
        calibrator_model_id: str,
        calibrator_model_version: str,
    ) -> CompatibilityCheck:
        """
        A calibrator trained for (model_id, model_version) must not be used with
        a different model. Mirrors CalibratorArtifact.is_compatible().
        """
        if not calibrator_model_id:
            return CompatibilityCheck(
                "calibrator", CompatibilityStatus.UNVERIFIED,
                "No calibrator provided.",
            )
        if calibrator_model_id != model_id or calibrator_model_version != model_version:
            return CompatibilityCheck(
                "calibrator", CompatibilityStatus.INCOMPATIBLE,
                f"Calibrator was trained for {calibrator_model_id}@{calibrator_model_version} "
                f"but model is {model_id}@{model_version}.",
            )
        return CompatibilityCheck("calibrator", CompatibilityStatus.COMPATIBLE)

    def check_meta_model(
        self,
        model_id: str,
        meta_base_model_id: str,
    ) -> CompatibilityCheck:
        """A meta-model must be built on the same base model."""
        if not meta_base_model_id:
            return CompatibilityCheck(
                "meta_model", CompatibilityStatus.UNVERIFIED,
                "No meta-model provided.",
            )
        if meta_base_model_id != model_id:
            return CompatibilityCheck(
                "meta_model", CompatibilityStatus.INCOMPATIBLE,
                f"Meta-model base {meta_base_model_id!r} != model {model_id!r}.",
            )
        return CompatibilityCheck("meta_model", CompatibilityStatus.COMPATIBLE)

    def check_semantics(
        self,
        contract: Optional[ModelSchemaContract],
        expected_semantics: PredictionSemantics,
    ) -> CompatibilityCheck:
        """
        A model producing ALPHA_SCORE must never be loaded where a
        CALIBRATED_PROBABILITY is expected (spec §6).
        """
        if contract is None:
            return CompatibilityCheck(
                "prediction_semantics", CompatibilityStatus.UNVERIFIED,
                "No schema contract provided.",
            )
        if not contract.is_compatible_semantics(expected_semantics):
            return CompatibilityCheck(
                "prediction_semantics", CompatibilityStatus.INCOMPATIBLE,
                f"Model produces {contract.prediction_semantics.value} but "
                f"{expected_semantics.value} was expected.",
            )
        return CompatibilityCheck("prediction_semantics", CompatibilityStatus.COMPATIBLE)

    def check_execution_version(
        self,
        model_execution_version: str,
        expected_execution_version: str,
    ) -> CompatibilityCheck:
        """Model must be evaluated with the execution model version it targets."""
        if not model_execution_version or not expected_execution_version:
            return CompatibilityCheck(
                "execution_version", CompatibilityStatus.UNVERIFIED,
                "Execution version missing.",
            )
        if model_execution_version != expected_execution_version:
            return CompatibilityCheck(
                "execution_version", CompatibilityStatus.INCOMPATIBLE,
                f"Model execution_version {model_execution_version!r} != "
                f"expected {expected_execution_version!r}.",
            )
        return CompatibilityCheck("execution_version", CompatibilityStatus.COMPATIBLE)

    def check_portfolio_version(
        self,
        evaluated_portfolio_version: str,
        promotion_portfolio_version: str,
    ) -> CompatibilityCheck:
        """
        A model cannot be promoted based on a portfolio configuration different
        from the one actually evaluated (spec §47).
        """
        if not evaluated_portfolio_version or not promotion_portfolio_version:
            return CompatibilityCheck(
                "portfolio_version", CompatibilityStatus.UNVERIFIED,
                "Portfolio version missing.",
            )
        if evaluated_portfolio_version != promotion_portfolio_version:
            return CompatibilityCheck(
                "portfolio_version", CompatibilityStatus.INCOMPATIBLE,
                f"Evaluated with portfolio {evaluated_portfolio_version!r} but "
                f"promoting with {promotion_portfolio_version!r}.",
            )
        return CompatibilityCheck("portfolio_version", CompatibilityStatus.COMPATIBLE)

    def check_all(
        self,
        model_identity: ModelIdentity,
        dataset_feature_version: str,
        dataset_label_version: str,
        calibrator_model_id: str = "",
        calibrator_model_version: str = "",
        meta_base_model_id: str = "",
        schema_contract: Optional[ModelSchemaContract] = None,
        expected_semantics: Optional[PredictionSemantics] = None,
        model_execution_version: str = "",
        expected_execution_version: str = "",
        evaluated_portfolio_version: str = "",
        promotion_portfolio_version: str = "",
    ) -> CompatibilityReport:
        """Run all applicable compatibility checks."""
        checks: list[CompatibilityCheck] = []

        checks.append(self.check_feature_version(
            model_identity.feature_version, dataset_feature_version))
        checks.append(self.check_label_version(
            model_identity.label_version, dataset_label_version))

        if calibrator_model_id:
            checks.append(self.check_calibrator(
                model_identity.model_id, model_identity.model_version,
                calibrator_model_id, calibrator_model_version))

        if meta_base_model_id:
            checks.append(self.check_meta_model(
                model_identity.model_id, meta_base_model_id))

        if expected_semantics is not None:
            checks.append(self.check_semantics(schema_contract, expected_semantics))

        if model_execution_version or expected_execution_version:
            checks.append(self.check_execution_version(
                model_execution_version, expected_execution_version))

        if evaluated_portfolio_version or promotion_portfolio_version:
            checks.append(self.check_portfolio_version(
                evaluated_portfolio_version, promotion_portfolio_version))

        return CompatibilityReport(
            model_id=model_identity.model_id,
            model_version=model_identity.model_version,
            checks=checks,
        )
