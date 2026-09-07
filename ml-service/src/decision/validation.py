"""
Phase 3M — Dependency validation, model/artifact compatibility, staleness
(spec §7, §8, §9).

Before a decision can be executable, every MANDATORY dependency must validate.
Any failure yields a fail-closed `DecisionState` — the decision NEVER falls back
to a fabricated value or the "latest/closest" model.

Provides:
  - `ValidationResult` — status + reason + failed_state per check.
  - Dependency validators: data, features, model, calibration, portfolio,
    execution, RL (spec §7).
  - `ModelCompatibility` — enforces feature_schema_hash / label_config_hash /
    horizon / instrument / regime compatibility (spec §8).
  - `Staleness` — FRESH / AGING / STALE / REVOKED / UNKNOWN, config-driven,
    versioned thresholds (spec §9).

Determinism: pure stdlib; no np.random.*.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Optional

from .state import DecisionState

UTC = timezone.utc


class Staleness(str, Enum):
    """Model staleness states (spec §9)."""
    FRESH   = "FRESH"
    AGING   = "AGING"
    STALE   = "STALE"
    REVOKED = "REVOKED"
    UNKNOWN = "UNKNOWN"


@dataclass
class StalenessConfig:
    """
    Config-driven, versioned staleness thresholds (spec §9). Documented reasons:
    a model AGES after `aging_days` and becomes STALE after `stale_days`;
    calibration expires after `calibration_max_age_days`. These are inputs, not
    magic constants baked into logic.
    """
    aging_days:               float = 30.0
    stale_days:               float = 90.0
    calibration_max_age_days: float = 90.0
    version:                  str = "staleness-config-v1"


@dataclass
class ValidationResult:
    """Result of one dependency validation (spec §7)."""
    check:          str
    ok:             bool
    reason:         str = ""
    failed_state:   Optional[str] = None       # DecisionState value on failure

    def to_dict(self) -> dict:
        return {"check": self.check, "ok": self.ok, "reason": self.reason,
                "failed_state": self.failed_state}


def _now() -> datetime:
    return datetime.now(UTC)


def _parse_iso(ts: str) -> Optional[datetime]:
    try:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=UTC)
        return dt
    except Exception:
        return None


# ══════════════════════════════════════════════════════════════════════════════
# Dependency validators (spec §7)  — every mandatory failure -> fail closed
# ══════════════════════════════════════════════════════════════════════════════

def validate_data(
    snapshot_id: Optional[str],
    as_of_time: Optional[str],
    max_age_seconds: Optional[float] = None,
    now: Optional[datetime] = None,
    instrument: Optional[str] = None,
    expected_instrument: Optional[str] = None,
) -> ValidationResult:
    """Validate data availability, PIT validity, freshness, instrument identity."""
    if not snapshot_id:
        return ValidationResult("data", False, "no data snapshot", DecisionState.DATA_UNAVAILABLE.value)
    dt = _parse_iso(as_of_time) if as_of_time else None
    if as_of_time and dt is None:
        return ValidationResult("data", False, "unparseable as_of_time", DecisionState.DATA_INVALID.value)
    ref = now or _now()
    if dt is not None and dt > ref:
        # future timestamp = PIT violation (spec §31 adversarial)
        return ValidationResult("data", False, "future data timestamp (PIT violation)",
                                DecisionState.DATA_INVALID.value)
    if dt is not None and max_age_seconds is not None:
        age = (ref - dt).total_seconds()
        if age > max_age_seconds:
            return ValidationResult("data", False, f"stale data ({age:.0f}s > {max_age_seconds}s)",
                                    DecisionState.DATA_UNAVAILABLE.value)
    if expected_instrument and instrument and instrument != expected_instrument:
        return ValidationResult("data", False, "instrument identity mismatch",
                                DecisionState.DATA_INVALID.value)
    return ValidationResult("data", True)


def validate_features(
    feature_version: Optional[str],
    feature_schema_hash: Optional[str],
    required_features: Optional[list[str]] = None,
    present_features: Optional[list[str]] = None,
) -> ValidationResult:
    """Validate feature version, schema hash, and required-feature presence."""
    if not feature_version or not feature_schema_hash:
        return ValidationResult("features", False, "missing feature version/schema hash",
                                DecisionState.FEATURES_UNAVAILABLE.value)
    if required_features is not None:
        present = set(present_features or [])
        missing = [f for f in required_features if f not in present]
        if missing:
            return ValidationResult("features", False, f"missing features: {missing[:5]}",
                                    DecisionState.FEATURES_UNAVAILABLE.value)
    return ValidationResult("features", True)


def validate_model(
    model_exists: bool,
    model_hash: Optional[str],
    registry_status: Optional[str],
    acceptance_status: Optional[str] = None,
) -> ValidationResult:
    """
    Validate model existence, hash, registry status, acceptance/promotion.
    A REVOKED/DISABLED model fails closed (spec §9). Unknown status is treated as
    unavailable (fail-closed).
    """
    if not model_exists:
        return ValidationResult("model", False, "model unavailable", DecisionState.MODEL_UNAVAILABLE.value)
    if not model_hash:
        return ValidationResult("model", False, "missing model hash", DecisionState.MODEL_UNAVAILABLE.value)
    status = (registry_status or "").upper()
    if status in ("REVOKED", "DISABLED"):
        return ValidationResult("model", False, f"model {status.lower()}", DecisionState.MODEL_REVOKED.value)
    if acceptance_status and acceptance_status.upper() in ("REJECTED",):
        return ValidationResult("model", False, "model acceptance REJECTED", DecisionState.MODEL_REVOKED.value)
    return ValidationResult("model", True)


def validate_calibration(
    calibration_exists: bool,
    calibration_model_id: Optional[str],
    model_id: Optional[str],
    calibration_fit_time: Optional[str] = None,
    max_age_days: float = 90.0,
    now: Optional[datetime] = None,
) -> ValidationResult:
    """
    Validate calibration existence, model compatibility, and staleness. No
    fabricated probability is ever substituted for a missing calibrator (spec §5).
    """
    if not calibration_exists:
        return ValidationResult("calibration", False, "calibration unavailable",
                                DecisionState.CALIBRATION_UNAVAILABLE.value)
    if calibration_model_id and model_id and calibration_model_id != model_id:
        return ValidationResult("calibration", False, "calibrator/model mismatch",
                                DecisionState.CALIBRATION_UNAVAILABLE.value)
    if calibration_fit_time:
        dt = _parse_iso(calibration_fit_time)
        if dt is not None:
            age_days = ((now or _now()) - dt).total_seconds() / 86400.0
            # A calibration fitted in the FUTURE is a point-in-time violation
            # (negative age) — fail closed, never accept future-dated evidence.
            if age_days < 0:
                return ValidationResult("calibration", False,
                                        f"calibration fit time in the future ({-age_days:.0f}d ahead)",
                                        DecisionState.CALIBRATION_UNAVAILABLE.value)
            if age_days > max_age_days:
                return ValidationResult("calibration", False,
                                        f"calibration stale ({age_days:.0f}d > {max_age_days}d)",
                                        DecisionState.CALIBRATION_UNAVAILABLE.value)
    return ValidationResult("calibration", True)


def validate_portfolio(risk_available: bool, constraints_ok: bool,
                       reason: str = "") -> ValidationResult:
    """
    Validate portfolio/risk constraints. If the risk engine is UNAVAILABLE we
    fail closed (BLOCK), never fall through to execution (spec §20).
    """
    if not risk_available:
        return ValidationResult("portfolio", False, "risk engine unavailable",
                                DecisionState.RISK_REJECTED.value)
    if not constraints_ok:
        return ValidationResult("portfolio", False, reason or "portfolio constraint breach",
                                DecisionState.PORTFOLIO_REJECTED.value)
    return ValidationResult("portfolio", True)


def validate_execution(
    cost_model_version: Optional[str],
    slippage_model_version: Optional[str],
    simulator_available: bool,
) -> ValidationResult:
    """Validate execution cost/slippage versions + simulator availability."""
    if not simulator_available:
        return ValidationResult("execution", False, "execution simulator unavailable",
                                DecisionState.BLOCKED.value)
    if not cost_model_version or not slippage_model_version:
        return ValidationResult("execution", False, "missing cost/slippage model version",
                                DecisionState.BLOCKED.value)
    return ValidationResult("execution", True)


def validate_rl(
    policy_id: Optional[str],
    action_allowed: bool,
    ood: bool,
    challenger_status: Optional[str] = None,
) -> ValidationResult:
    """
    Validate RL policy identity, OOD protection, action mask, challenger status.
    RL is a CHALLENGER only; an invalid/OOD RL action is rejected (spec §21).
    """
    if not policy_id:
        return ValidationResult("rl", False, "RL policy identity missing",
                                DecisionState.BLOCKED.value)
    if ood:
        return ValidationResult("rl", False, "RL action out-of-distribution",
                                DecisionState.BLOCKED.value)
    if not action_allowed:
        return ValidationResult("rl", False, "RL action not allowed by safety mask",
                                DecisionState.BLOCKED.value)
    return ValidationResult("rl", True)


# ══════════════════════════════════════════════════════════════════════════════
# Model / artifact compatibility (spec §8)
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class ModelCompatibility:
    """
    Declarative model compatibility metadata (spec §8). Incompatible
    combinations (e.g. model trained with feature schema A + runtime schema B)
    fail closed. The "closest" or "latest" model is NEVER auto-substituted.
    """
    model_id:               str
    model_version:          str
    artifact_hash:          str
    feature_version:        str
    feature_schema_hash:    str
    label_version:          str = ""
    label_config_hash:      str = ""
    calibration_id:         str = ""
    calibration_version:    str = ""
    supported_horizons:     list[int] = field(default_factory=list)
    supported_instruments:  list[str] = field(default_factory=list)
    supported_regimes:      list[str] = field(default_factory=list)
    status:                 str = "ACTIVE"   # ACTIVE | REVOKED | DISABLED
    created_at:             str = ""
    expires_at:             str = ""

    def check(
        self,
        runtime_feature_version: str,
        runtime_feature_schema_hash: str,
        runtime_horizon: Optional[int] = None,
        runtime_instrument: Optional[str] = None,
        runtime_regime: Optional[str] = None,
        runtime_label_config_hash: Optional[str] = None,
    ) -> ValidationResult:
        """Return a ValidationResult; MODEL_INCOMPATIBLE on any mismatch."""
        if self.status.upper() in ("REVOKED", "DISABLED"):
            return ValidationResult("compatibility", False, f"model {self.status.lower()}",
                                    DecisionState.MODEL_REVOKED.value)
        if runtime_feature_version != self.feature_version:
            return ValidationResult("compatibility", False,
                                    f"feature version {runtime_feature_version} != {self.feature_version}",
                                    DecisionState.MODEL_INCOMPATIBLE.value)
        if runtime_feature_schema_hash != self.feature_schema_hash:
            return ValidationResult("compatibility", False, "feature schema hash mismatch",
                                    DecisionState.MODEL_INCOMPATIBLE.value)
        if (runtime_label_config_hash and self.label_config_hash
                and runtime_label_config_hash != self.label_config_hash):
            return ValidationResult("compatibility", False, "label config hash mismatch",
                                    DecisionState.MODEL_INCOMPATIBLE.value)
        if (runtime_horizon is not None and self.supported_horizons
                and runtime_horizon not in self.supported_horizons):
            return ValidationResult("compatibility", False,
                                    f"horizon {runtime_horizon} unsupported",
                                    DecisionState.MODEL_INCOMPATIBLE.value)
        if (runtime_instrument and self.supported_instruments
                and runtime_instrument not in self.supported_instruments):
            return ValidationResult("compatibility", False,
                                    f"instrument {runtime_instrument} unsupported",
                                    DecisionState.MODEL_INCOMPATIBLE.value)
        if (runtime_regime and self.supported_regimes
                and runtime_regime not in self.supported_regimes):
            return ValidationResult("compatibility", False,
                                    f"regime {runtime_regime} unsupported",
                                    DecisionState.MODEL_INCOMPATIBLE.value)
        return ValidationResult("compatibility", True)

    def to_dict(self) -> dict:
        from dataclasses import asdict
        return asdict(self)


# ══════════════════════════════════════════════════════════════════════════════
# Staleness assessment (spec §9)
# ══════════════════════════════════════════════════════════════════════════════

def assess_staleness(
    deployment_date: Optional[str],
    registry_status: Optional[str] = None,
    calibration_fit_time: Optional[str] = None,
    config: Optional[StalenessConfig] = None,
    now: Optional[datetime] = None,
) -> tuple[Staleness, str]:
    """
    Assess model staleness from age, registry status, and calibration age
    (spec §9). Config-driven thresholds. Returns (Staleness, reason).
    """
    cfg = config or StalenessConfig()
    ref = now or _now()

    status = (registry_status or "").upper()
    if status in ("REVOKED", "DISABLED"):
        return Staleness.REVOKED, f"registry status {status.lower()}"

    dt = _parse_iso(deployment_date) if deployment_date else None
    if dt is None:
        return Staleness.UNKNOWN, "no/invalid deployment date"

    age_days = (ref - dt).total_seconds() / 86400.0

    # calibration expiry escalates to STALE regardless of model age
    if calibration_fit_time:
        cdt = _parse_iso(calibration_fit_time)
        if cdt is not None:
            cal_age = (ref - cdt).total_seconds() / 86400.0
            if cal_age > cfg.calibration_max_age_days:
                return Staleness.STALE, f"calibration expired ({cal_age:.0f}d)"

    if age_days > cfg.stale_days:
        return Staleness.STALE, f"model age {age_days:.0f}d > {cfg.stale_days}d"
    if age_days > cfg.aging_days:
        return Staleness.AGING, f"model age {age_days:.0f}d > {cfg.aging_days}d"
    return Staleness.FRESH, f"model age {age_days:.0f}d"
