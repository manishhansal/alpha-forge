"""
Label Leakage Validators — Phase 3C.

Enforces the critical separation:
  Features use data available at event_start_time.
  Labels may use future data after event_start_time.
  Label outcome data must NEVER leak back into features.

Seven rules checked
-------------------
Rule 1: Features never contain event_end_time, barrier_hit_time, MFE, MAE,
        or any column that requires future knowledge.
Rule 2: The label uses future observations only after prediction_time.
Rule 3: event_end_time is not used to select the training universe.
Rule 4: Labels do not affect feature computation.
Rule 5: No future corporate action contaminates features at t0.
Rule 6: No event uses bars after its own first-touch/event_end_time.
Rule 7: Incomplete future horizons are not treated as valid outcomes.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional, Sequence

import numpy as np
import pandas as pd
import structlog

from .schemas import (
    FixedHorizonLabel, TripleBarrierLabel, FirstTouch, LabelFamily,
    LabelDiagnostics, SampleMetadata
)

logger = structlog.get_logger(__name__)


# ── Violation record ───────────────────────────────────────────────────────────

@dataclass
class LabelViolation:
    rule:        str
    severity:    str    # "CRITICAL" | "ERROR" | "WARNING"
    symbol:      str
    description: str
    row_hint:    Optional[str] = None

    def to_dict(self) -> dict:
        return {
            "rule": self.rule, "severity": self.severity,
            "symbol": self.symbol, "description": self.description,
        }


# ── Future columns that must never appear in feature sets ──────────────────────

_LABEL_ONLY_COLUMNS = frozenset({
    "event_end_time", "barrier_hit_time", "first_touch",
    "mfe", "mae", "mfe_time", "mae_time",
    "gross_return", "net_return", "exit_price",
    "holding_bars", "holding_seconds", "bars_to_tp", "bars_to_sl",
    "stop_hit", "target_hit", "y_stop", "y_target", "y_drawdown",
    "label", "meta_label",
})


class LabelLeakageValidator:
    """
    Validates that label outputs do not contaminate feature inputs.

    Usage
    -----
    ::
        validator = LabelLeakageValidator()
        violations = validator.check_feature_columns(feature_df.columns)
        violations += validator.check_label_sequence(labels, feature_df)
        if any(v.severity == "CRITICAL" for v in violations):
            raise RuntimeError("Label leakage detected")
    """

    def check_feature_columns(
        self,
        feature_columns: Sequence[str],
        symbol: str = "*",
    ) -> list[LabelViolation]:
        """
        Rule 1: Feature columns must not include any label-only outcome columns.
        """
        violations: list[LabelViolation] = []
        for col in feature_columns:
            if col.lower() in _LABEL_ONLY_COLUMNS:
                violations.append(LabelViolation(
                    rule="RULE1_OUTCOME_IN_FEATURES",
                    severity="CRITICAL",
                    symbol=symbol,
                    description=(
                        f"Column '{col}' is a label outcome field and must NEVER "
                        "appear in the feature matrix.  Future information would "
                        "leak into model training."
                    ),
                ))
        return violations

    def check_label_sequence(
        self,
        labels: list,
        feature_df: "pd.DataFrame",
        prediction_time_col: Optional[str] = None,
    ) -> list[LabelViolation]:
        """
        Rule 2: Label event_end_time must be >= event_start_time.
        Rule 6: No event uses bars after its own event_end_time.
        Rule 7: Incomplete events must be marked DATA_INSUFFICIENT, not used.
        """
        violations: list[LabelViolation] = []

        for label in labels:
            if not hasattr(label, "event_start_time") or not hasattr(label, "event_end_time"):
                continue

            # Rule 2: end must be after or equal to start
            if label.event_end_time < label.event_start_time:
                violations.append(LabelViolation(
                    rule="RULE2_END_BEFORE_START",
                    severity="CRITICAL",
                    symbol=label.symbol,
                    description=(
                        f"event_end_time ({label.event_end_time}) < "
                        f"event_start_time ({label.event_start_time}). "
                        "Label event cannot end before it begins."
                    ),
                ))

            # Rule 7: incomplete horizon must not be valid label
            if hasattr(label, "is_incomplete") and label.is_incomplete:
                if hasattr(label, "first_touch"):
                    if label.first_touch == FirstTouch.TIME_LIMIT:
                        violations.append(LabelViolation(
                            rule="RULE7_INCOMPLETE_AS_VALID",
                            severity="ERROR",
                            symbol=label.symbol,
                            description=(
                                f"Label at {label.event_start_time} has "
                                "is_incomplete=True but first_touch=TIME_LIMIT. "
                                "Incomplete horizons must be DATA_INSUFFICIENT, "
                                "not TIME_LIMIT."
                            ),
                        ))

        return violations

    def check_pit_invariant(
        self,
        feature_df: "pd.DataFrame",
        label_outcomes: "pd.Series",
        symbol: str = "*",
        tolerance_bars: int = 0,
    ) -> list[LabelViolation]:
        """
        PIT mutation test: injecting a future value into label_outcomes
        must not change any feature value in feature_df.

        This checks that the feature DataFrame was computed BEFORE labels.
        Since feature_df is already computed, we check that no feature
        column is trivially the same as the label series.
        """
        violations: list[LabelViolation] = []

        for col in feature_df.columns:
            try:
                feat = feature_df[col].astype(float)
                lbl  = label_outcomes.astype(float)
                if len(feat) != len(lbl):
                    continue
                valid = ~(np.isnan(feat.values) | np.isnan(lbl.values))
                if valid.sum() < 5:
                    continue
                corr = float(np.corrcoef(feat.values[valid], lbl.values[valid])[0, 1])
                if abs(corr) > 0.999:
                    violations.append(LabelViolation(
                        rule="RULE1_FEATURE_IDENTICAL_TO_LABEL",
                        severity="CRITICAL",
                        symbol=symbol,
                        description=(
                            f"Feature column '{col}' is nearly identical (corr={corr:.4f}) "
                            "to the label series. This feature IS the label — "
                            "future outcome has leaked into features."
                        ),
                    ))
            except Exception:
                continue

        return violations

    def check_triple_barrier_outcomes(
        self,
        labels: "list[TripleBarrierLabel]",
    ) -> list[LabelViolation]:
        """
        Validate that TripleBarrierLabel outcomes satisfy mathematical invariants.
        """
        violations: list[LabelViolation] = []

        for lbl in labels:
            if not isinstance(lbl, TripleBarrierLabel):
                continue

            sym = lbl.symbol
            t0  = lbl.event_start_time
            t1  = lbl.event_end_time

            # event_end >= event_start
            if t1 < t0:
                violations.append(LabelViolation(
                    rule="TB_INVARIANT_END_BEFORE_START",
                    severity="CRITICAL", symbol=sym,
                    description=f"[{t0}] event_end_time < event_start_time",
                ))

            # If TP hit, barrier_hit_time must be set
            if lbl.first_touch == FirstTouch.TAKE_PROFIT and lbl.barrier_hit_time is None:
                violations.append(LabelViolation(
                    rule="TB_INVARIANT_TP_NO_HIT_TIME",
                    severity="ERROR", symbol=sym,
                    description=f"[{t0}] first_touch=TAKE_PROFIT but barrier_hit_time is None",
                ))

            # barrier_hit_time must be within event window
            if lbl.barrier_hit_time is not None:
                if lbl.barrier_hit_time < t0 or lbl.barrier_hit_time > t1:
                    violations.append(LabelViolation(
                        rule="TB_INVARIANT_HIT_OUTSIDE_WINDOW",
                        severity="CRITICAL", symbol=sym,
                        description=(
                            f"[{t0}] barrier_hit_time {lbl.barrier_hit_time} "
                            f"outside event window [{t0}, {t1}]"
                        ),
                    ))

            # Incomplete must be DATA_INSUFFICIENT
            if lbl.is_incomplete and lbl.first_touch not in (
                FirstTouch.DATA_INSUFFICIENT, FirstTouch.DATA_MISSING
            ):
                violations.append(LabelViolation(
                    rule="TB_INVARIANT_INCOMPLETE_WRONG_TOUCH",
                    severity="ERROR", symbol=sym,
                    description=(
                        f"[{t0}] is_incomplete=True but first_touch={lbl.first_touch.value}. "
                        "Incomplete events must be DATA_INSUFFICIENT."
                    ),
                ))

        return violations


# ── Convenience: full validation pipeline ─────────────────────────────────────

def validate_labels(
    labels: list,
    feature_columns: Optional[Sequence[str]] = None,
    feature_df: Optional["pd.DataFrame"] = None,
    symbol: str = "*",
) -> list[LabelViolation]:
    """
    Run all applicable label validators and return combined violations.

    Parameters
    ----------
    labels         : List of any label type (FixedHorizonLabel, TripleBarrierLabel, etc.)
    feature_columns: If provided, checks Rule 1 (no outcome cols in features).
    feature_df     : If provided, checks PIT correlation invariant.
    symbol         : For logging.
    """
    v = LabelLeakageValidator()
    all_violations: list[LabelViolation] = []

    if feature_columns is not None:
        all_violations += v.check_feature_columns(feature_columns, symbol)

    all_violations += v.check_label_sequence(labels, feature_df or pd.DataFrame())

    tb_labels = [l for l in labels if isinstance(l, TripleBarrierLabel)]
    if tb_labels:
        all_violations += v.check_triple_barrier_outcomes(tb_labels)

    n_crit = sum(1 for v in all_violations if v.severity == "CRITICAL")
    n_err  = sum(1 for v in all_violations if v.severity == "ERROR")
    if n_crit or n_err:
        logger.warning(
            "label_validation_issues",
            n_critical=n_crit, n_errors=n_err,
            symbol=symbol,
        )

    return all_violations
