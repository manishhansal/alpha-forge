"""
Phase 3S — Hypothesis registry & pre-registration (spec §5-§7).

Every research experiment MUST start with a falsifiable hypothesis. The
hypothesis is *pre-registered* — its design, primary metric, validation windows,
expected direction, and success/failure criteria are frozen BEFORE any result is
visible. This prevents post-hoc metric selection and hypothesis-after-results
(HARKing).

Design rules
------------
1. A hypothesis must be falsifiable: it must state explicit success AND failure
   criteria and an expected direction. A hypothesis with no failure criterion is
   rejected.
2. Hypothesis types (§6) must not be mixed silently — a hypothesis declares
   exactly one type.
3. A pre-registration is FROZEN: once frozen it computes a hash; any later change
   requires a NEW pre-registration (a new experiment), never mutation (§64).
4. Storage is append-only via lifecycle._storage; historical hypotheses are
   immutable (§49).
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Optional


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _hash_obj(obj) -> str:
    """Deterministic SHA-256 (first 16 hex) over a canonical JSON payload."""
    raw = json.dumps(obj, sort_keys=True, default=str).encode()
    return hashlib.sha256(raw).hexdigest()[:16]


# ══════════════════════════════════════════════════════════════════════════════
# §6 Hypothesis types
# ══════════════════════════════════════════════════════════════════════════════

class HypothesisType(str, Enum):
    """Category of a research hypothesis (spec §6). Types must not be mixed."""
    ALPHA        = "ALPHA"
    RANKING      = "RANKING"
    REGIME       = "REGIME"
    VOLATILITY   = "VOLATILITY"
    DERIVATIVES  = "DERIVATIVES"
    EXECUTION    = "EXECUTION"
    PORTFOLIO    = "PORTFOLIO"
    RISK         = "RISK"
    CALIBRATION  = "CALIBRATION"
    FEATURE      = "FEATURE"
    MODEL        = "MODEL"
    COST         = "COST"
    SLIPPAGE     = "SLIPPAGE"


HYPOTHESIS_TYPES: tuple[HypothesisType, ...] = tuple(HypothesisType)


class ExpectedDirection(str, Enum):
    """Expected sign of the effect (falsifiability requirement, §5)."""
    POSITIVE = "POSITIVE"
    NEGATIVE = "NEGATIVE"
    NONZERO  = "NONZERO"


class HypothesisError(ValueError):
    """Raised when a hypothesis is not falsifiable / not well-formed."""


# ══════════════════════════════════════════════════════════════════════════════
# §5 Falsifiable hypothesis
# ══════════════════════════════════════════════════════════════════════════════

@dataclass(frozen=True)
class Hypothesis:
    """
    A falsifiable research hypothesis (spec §5).

    A GOOD hypothesis is specific and testable, e.g.:
        "Cross-sectional relative-strength residualized against sector and beta
         improves next-5-day rank IC after transaction costs."

    A BAD hypothesis ("improve the model") is rejected: it has no mechanism,
    direction, target, or falsification criterion.
    """
    hypothesis_id:        str
    hypothesis_type:      HypothesisType
    statement:            str            # the falsifiable claim
    expected_mechanism:   str            # WHY it should work (economic rationale)
    expected_direction:   ExpectedDirection
    target:               str            # what is predicted / improved (e.g. "next-5-day rank IC")
    horizon:              str            # e.g. "5 bars" / "5 days"
    universe:             str            # e.g. "NIFTY100_liquid"
    regime_assumptions:   str            # regimes under which the effect is expected
    economic_rationale:   str            # the economic story
    success_criteria:     str            # what result would SUPPORT the hypothesis
    failure_criteria:     str            # what result would FALSIFY it
    created_at:           str = field(default_factory=_now_iso)
    author:               str = "researcher"

    def __post_init__(self):
        # Falsifiability enforcement (§5): must have a mechanism, both criteria,
        # a non-trivial statement, and a declared type.
        missing = [
            name for name, val in (
                ("statement", self.statement),
                ("expected_mechanism", self.expected_mechanism),
                ("target", self.target),
                ("success_criteria", self.success_criteria),
                ("failure_criteria", self.failure_criteria),
                ("economic_rationale", self.economic_rationale),
            ) if not (val and str(val).strip())
        ]
        if missing:
            raise HypothesisError(
                f"Hypothesis is not falsifiable — missing required field(s): "
                f"{', '.join(missing)}. A hypothesis must state a mechanism and "
                f"explicit success AND failure criteria (spec §5)."
            )
        if not isinstance(self.hypothesis_type, HypothesisType):
            raise HypothesisError("hypothesis_type must be a HypothesisType (spec §6)")
        if not isinstance(self.expected_direction, ExpectedDirection):
            raise HypothesisError("expected_direction must be an ExpectedDirection (spec §5)")
        if len(str(self.statement).strip()) < 20:
            raise HypothesisError(
                "Hypothesis statement is too vague to be falsifiable — provide a "
                "specific, testable claim (spec §5)."
            )

    @property
    def hypothesis_hash(self) -> str:
        return _hash_obj(self._payload())

    def _payload(self) -> dict:
        d = asdict(self)
        d["hypothesis_type"] = self.hypothesis_type.value
        d["expected_direction"] = self.expected_direction.value
        # hash excludes created_at/author (content-addressable)
        d.pop("created_at", None)
        d.pop("author", None)
        return d

    def to_dict(self) -> dict:
        d = asdict(self)
        d["hypothesis_type"] = self.hypothesis_type.value
        d["expected_direction"] = self.expected_direction.value
        d["hypothesis_hash"] = self.hypothesis_hash
        return d


# ══════════════════════════════════════════════════════════════════════════════
# §7 Pre-registration
# ══════════════════════════════════════════════════════════════════════════════

class PreRegistrationError(RuntimeError):
    """Raised on an attempt to mutate a frozen pre-registration (§7, §64)."""


@dataclass
class PreRegistration:
    """
    Pre-registered experiment design (spec §7). Stored BEFORE results are visible
    to the researcher. Freezing computes a hash; any later change to the design is
    a NEW experiment (§64), never a mutation of this record.

    Exactly ONE primary metric is allowed (spec §8). Secondary metrics may exist
    but cannot replace the primary metric after results without a new experiment.
    """
    prereg_id:            str
    hypothesis_id:        str
    experiment_design:    str
    primary_metric:       str                       # exactly one (§8)
    secondary_metrics:    list[str] = field(default_factory=list)
    validation_windows:   list[str] = field(default_factory=list)
    expected_direction:   str = ExpectedDirection.NONZERO.value
    stopping_criteria:    str = ""
    exclusion_criteria:   str = ""
    universe:             str = ""
    cost_model:           str = ""
    statistical_test:     str = ""
    created_at:           str = field(default_factory=_now_iso)
    frozen_hash:          str = ""
    _frozen:              bool = field(default=False, repr=False)

    def __post_init__(self):
        if not self.primary_metric or not str(self.primary_metric).strip():
            raise PreRegistrationError(
                "Pre-registration requires exactly one primary_metric (spec §8)."
            )
        if self.primary_metric in self.secondary_metrics:
            raise PreRegistrationError(
                "primary_metric must not also appear in secondary_metrics (spec §8)."
            )

    def _payload(self) -> dict:
        return {
            "prereg_id":          self.prereg_id,
            "hypothesis_id":      self.hypothesis_id,
            "experiment_design":  self.experiment_design,
            "primary_metric":     self.primary_metric,
            "secondary_metrics":  sorted(self.secondary_metrics),
            "validation_windows": list(self.validation_windows),
            "expected_direction": self.expected_direction,
            "stopping_criteria":  self.stopping_criteria,
            "exclusion_criteria": self.exclusion_criteria,
            "universe":           self.universe,
            "cost_model":         self.cost_model,
            "statistical_test":   self.statistical_test,
        }

    def freeze(self) -> "PreRegistration":
        """Freeze the design and compute its hash. Idempotent."""
        if self._frozen:
            return self
        self.frozen_hash = _hash_obj(self._payload())
        self._frozen = True
        return self

    @property
    def frozen(self) -> bool:
        return self._frozen

    def verify(self) -> bool:
        """True if the frozen content matches the stored hash (tamper check)."""
        if not self._frozen or not self.frozen_hash:
            return False
        return _hash_obj(self._payload()) == self.frozen_hash

    def to_dict(self) -> dict:
        d = self._payload()
        d["created_at"] = self.created_at
        d["frozen"] = self._frozen
        d["frozen_hash"] = self.frozen_hash
        return d


# ══════════════════════════════════════════════════════════════════════════════
# Hypothesis registry (append-only, immutable history — §49)
# ══════════════════════════════════════════════════════════════════════════════

class HypothesisRegistry:
    """
    Append-only registry of hypotheses + pre-registrations. Never overwrites a
    historical record (spec §49). Duplicate hypothesis_id is rejected.
    """

    def __init__(self, root: str | Path):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.hyp_path = self.root / "hypotheses.jsonl"
        self.prereg_path = self.root / "preregistrations.jsonl"

    # ── hypotheses ────────────────────────────────────────────────────────
    def register(self, hyp: Hypothesis) -> Hypothesis:
        from src.lifecycle._storage import append_jsonl
        if self.get(hyp.hypothesis_id) is not None:
            raise HypothesisError(
                f"hypothesis_id '{hyp.hypothesis_id}' already registered — "
                f"historical hypotheses are immutable (spec §49)."
            )
        append_jsonl(self.hyp_path, hyp.to_dict())
        return hyp

    def get(self, hypothesis_id: str) -> Optional[dict]:
        from src.lifecycle._storage import read_jsonl
        if not self.hyp_path.exists():
            return None
        for rec in read_jsonl(self.hyp_path):
            if rec.get("hypothesis_id") == hypothesis_id:
                return rec
        return None

    def all(self) -> list[dict]:
        from src.lifecycle._storage import read_jsonl
        return read_jsonl(self.hyp_path) if self.hyp_path.exists() else []

    # ── pre-registrations ────────────────────────────────────────────────
    def pre_register(self, prereg: PreRegistration) -> PreRegistration:
        """Freeze and persist a pre-registration (before results are seen)."""
        from src.lifecycle._storage import append_jsonl
        if self.get(prereg.hypothesis_id) is None:
            raise PreRegistrationError(
                f"cannot pre-register: hypothesis '{prereg.hypothesis_id}' is not "
                f"registered (spec §7)."
            )
        if self.get_prereg(prereg.prereg_id) is not None:
            raise PreRegistrationError(
                f"prereg_id '{prereg.prereg_id}' already exists — pre-registrations "
                f"are immutable; a design change is a NEW experiment (spec §64)."
            )
        prereg.freeze()
        append_jsonl(self.prereg_path, prereg.to_dict())
        return prereg

    def get_prereg(self, prereg_id: str) -> Optional[dict]:
        from src.lifecycle._storage import read_jsonl
        if not self.prereg_path.exists():
            return None
        for rec in read_jsonl(self.prereg_path):
            if rec.get("prereg_id") == prereg_id:
                return rec
        return None
