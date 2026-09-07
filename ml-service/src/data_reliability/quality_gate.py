"""
Phase 3Q — Canonical Data-Quality Gate (spec §14).

One authoritative data-quality verdict that every downstream consumer can read to
decide whether data is safe to consume. It AGGREGATES the existing, verified
signals (paper.data_quality.QualityReport, StaleAssessment, CompletenessReport,
ConsistencyResult, SanitizedSeries) into a single fail-closed 8-value verdict.
It does NOT reimplement any of those checks.

Fail-closed precedence (worst-wins, §14):
    INVALID > CONFLICT > STALE > INCOMPLETE > UNAVAILABLE
           > INSUFFICIENT_EVIDENCE > VALID_WITH_WARNINGS > VALID

Critical data failures fail closed — invalid data can never pass to features/models.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Optional


class DQVerdict(str, Enum):
    VALID                 = "VALID"
    VALID_WITH_WARNINGS   = "VALID_WITH_WARNINGS"
    STALE                 = "STALE"
    INCOMPLETE            = "INCOMPLETE"
    INVALID               = "INVALID"
    CONFLICT              = "CONFLICT"
    INSUFFICIENT_EVIDENCE = "INSUFFICIENT_EVIDENCE"
    UNAVAILABLE           = "UNAVAILABLE"


# worst-wins ordering (higher index = worse / more-blocking). VALID is best.
_SEVERITY_ORDER = [
    DQVerdict.VALID,
    DQVerdict.VALID_WITH_WARNINGS,
    DQVerdict.INSUFFICIENT_EVIDENCE,
    DQVerdict.UNAVAILABLE,
    DQVerdict.INCOMPLETE,
    DQVerdict.STALE,
    DQVerdict.CONFLICT,
    DQVerdict.INVALID,
]
_RANK = {v: i for i, v in enumerate(_SEVERITY_ORDER)}

# Verdicts on which data is SAFE to consume downstream (spec §14).
_SAFE = frozenset({DQVerdict.VALID, DQVerdict.VALID_WITH_WARNINGS})


@dataclass
class DataQualityDecision:
    verdict:      str            # DQVerdict value
    instrument:   str = ""
    reasons:      list[str] = field(default_factory=list)
    components:   dict = field(default_factory=dict)   # per-signal verdicts

    @property
    def safe_to_consume(self) -> bool:
        """Fail-closed: only VALID / VALID_WITH_WARNINGS may pass downstream."""
        try:
            return DQVerdict(self.verdict) in _SAFE
        except ValueError:
            return False

    def to_dict(self) -> dict:
        return {"verdict": self.verdict, "instrument": self.instrument,
                "safe_to_consume": self.safe_to_consume,
                "reasons": self.reasons, "components": self.components}


def _worst(verdicts: list[DQVerdict]) -> DQVerdict:
    return max(verdicts, key=lambda v: _RANK[v]) if verdicts else DQVerdict.VALID


def evaluate_data_quality(
    instrument: str = "",
    ohlcv_report=None,        # paper.data_quality.QualityReport
    stale=None,               # data_reliability.stale.StaleAssessment
    completeness=None,        # data_reliability.completeness.CompletenessReport
    consistency=None,         # data_reliability.consistency.ConsistencyResult
    sanitized=None,           # data_reliability.ohlc_repair.SanitizedSeries
    sufficient_history: Optional[bool] = None,
) -> DataQualityDecision:
    """
    Aggregate the supplied signals into one canonical verdict (spec §14). Any
    signal may be None (not evaluated). Worst-wins, fail-closed. A downstream
    consumer must check `.safe_to_consume` before using the data.
    """
    verdicts: list[DQVerdict] = []
    reasons: list[str] = []
    components: dict = {}

    # OHLCV validity (CRITICAL issues → INVALID)
    if ohlcv_report is not None:
        crit = getattr(ohlcv_report, "critical", [])
        if crit:
            verdicts.append(DQVerdict.INVALID)
            reasons.append(f"{len(crit)} critical OHLCV issue(s)")
            components["ohlcv"] = "INVALID"
        else:
            components["ohlcv"] = "OK"

    # Sanitized series with quarantined bars → INVALID (bad bars present)
    if sanitized is not None:
        if getattr(sanitized, "n_quarantined", 0) > 0:
            verdicts.append(DQVerdict.INVALID)
            reasons.append(f"{sanitized.n_quarantined} quarantined bar(s)")
            components["sanitized"] = "INVALID"
        else:
            components["sanitized"] = "CLEAN"

    # Cross-provider conflict → CONFLICT
    if consistency is not None:
        if getattr(consistency, "is_conflict", False):
            verdicts.append(DQVerdict.CONFLICT)
            reasons.append(consistency.detail or "provider conflict")
            components["consistency"] = "CONFLICT"
        else:
            components["consistency"] = getattr(consistency, "verdict", "CONSISTENT")

    # Staleness → STALE / UNAVAILABLE
    if stale is not None:
        if getattr(stale, "is_stale", False):
            reason = getattr(stale, "reason", "")
            components["stale"] = reason
            if reason == "UNAVAILABLE":
                verdicts.append(DQVerdict.UNAVAILABLE)
            else:
                verdicts.append(DQVerdict.STALE)
            reasons.append(stale.detail or f"stale: {reason}")
        else:
            components["stale"] = "FRESH"

    # Completeness → INCOMPLETE / UNAVAILABLE
    if completeness is not None:
        cs = getattr(completeness, "status", "")
        components["completeness"] = cs
        if cs == "INCOMPLETE":
            verdicts.append(DQVerdict.INCOMPLETE)
            reasons.append(f"incomplete: {completeness.missing_bars} missing, "
                           f"{completeness.duplicate_bars} dup, "
                           f"{completeness.out_of_order} out-of-order")
        elif cs == "UNAVAILABLE":
            verdicts.append(DQVerdict.UNAVAILABLE)
            reasons.append("completeness unavailable")

    # History sufficiency → INSUFFICIENT_EVIDENCE
    if sufficient_history is False:
        verdicts.append(DQVerdict.INSUFFICIENT_EVIDENCE)
        reasons.append("insufficient historical context")
        components["history"] = "INSUFFICIENT"

    # non-critical OHLCV warnings → VALID_WITH_WARNINGS (only if nothing worse)
    if ohlcv_report is not None:
        n_issues = len(getattr(ohlcv_report, "issues", []))
        n_crit = len(getattr(ohlcv_report, "critical", []))
        if n_issues > n_crit and not verdicts:
            verdicts.append(DQVerdict.VALID_WITH_WARNINGS)
            reasons.append(f"{n_issues - n_crit} non-critical warning(s)")

    final = _worst(verdicts)
    return DataQualityDecision(verdict=final.value, instrument=instrument,
                               reasons=reasons, components=components)
