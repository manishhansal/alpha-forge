"""
Meta-Label Construction — Phase 3F.

A meta-label answers: given that the primary ranker has identified a
candidate, did that candidate actually produce the desired outcome?

The meta model is CONDITIONAL on the existence of a primary signal.
It does NOT independently discover direction — that is the ranker's job.

Three policies (configurable, versioned)
-----------------------------------------
A  Positive net outcome:        meta_label = 1 if net_return > threshold
B  Triple-barrier success:      meta_label = 1 if first_touch == TAKE_PROFIT
C  Risk-adjusted success:       meta_label = 1 if net_return > min_required
                                AND adverse excursion <= mae_limit

Leakage rules
-------------
meta_label is computed from FUTURE outcomes.
meta FEATURES must NEVER include:
    - current_event_end_time
    - current_event_return
    - current_event_MFE
    - current_event_MAE
    - current_event_first_touch

These belong exclusively to the target, not the feature set.

Stacking rule
-------------
The meta model must be trained on OOS primary model predictions.
In-sample primary predictions will cause stacking leakage.
Every MetaEvent carries is_oos_primary_prediction — this MUST be True
for any event used in meta-model training.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Optional

import numpy as np
import pandas as pd

from .schemas import MetaLabelPolicyType


# ── Meta event (one training row) ─────────────────────────────────────────────

@dataclass
class MetaEvent:
    """
    One training observation for the meta-label model.

    Contains primary signal context, features available at prediction_time,
    and the meta_label target derived from future outcomes.

    Critical constraints
    --------------------
    - meta_label is derived from outcome fields (gross_return, first_touch)
    - outcome fields (gross_return, net_return, mfe, mae, first_touch) must
      NEVER be used as features — they are the target only.
    - is_oos_primary_prediction must be True for training rows.
    """
    # Identity
    instrument_id:      str
    prediction_time:    datetime
    primary_side:       str              # "LONG" | "SHORT"

    # Primary signal context (features for meta model)
    primary_alpha_score:  float
    primary_rank:         Optional[int]
    primary_percentile:   Optional[float]
    primary_cross_section_size: int = 0

    # OOS provenance — MUST be True for training
    is_oos_primary_prediction: bool = False
    primary_fold_id:    int = 0
    primary_model_id:   str = ""
    primary_model_version: str = ""

    # Event window (for PurgedKFold embargo)
    event_start_time:   Optional[datetime] = None
    event_end_time:     Optional[datetime] = None

    # Outcome fields — ONLY for target construction, NEVER features
    gross_return:       Optional[float] = None
    net_return:         Optional[float] = None
    mfe:                Optional[float] = None    # max favourable excursion ≥ 0
    mae:                Optional[float] = None    # max adverse excursion ≤ 0
    first_touch:        Optional[str]   = None    # "TAKE_PROFIT"|"STOP_LOSS"|"TIME_LIMIT"

    # Meta label (computed by build_meta_labels())
    meta_label:         Optional[int]   = None    # 1=TAKE, 0=SKIP, None=excluded

    # Provenance
    label_policy:       Optional[MetaLabelPolicyType] = None
    label_version:      str = "lv2"
    dataset_id:         str = ""
    feature_set_id:     str = ""

    def assert_oos(self) -> None:
        """Raise RuntimeError if this event is not an OOS primary prediction."""
        if not self.is_oos_primary_prediction:
            raise RuntimeError(
                f"Stacking leakage detected for instrument '{self.instrument_id}' "
                f"at {self.prediction_time}: is_oos_primary_prediction=False. "
                "Meta model must only be trained on OOS primary predictions."
            )


# ── Meta label policies ───────────────────────────────────────────────────────

@dataclass(frozen=True)
class MetaLabelPolicyConfig:
    """
    Configuration for a specific meta-label policy.
    Must be versioned — changing any parameter requires a new policy_version.
    """
    policy_type:     MetaLabelPolicyType
    policy_version:  str

    # Policy A parameters
    min_net_return:  float = 0.0      # net_return > this for label=1

    # Policy B parameters
    require_tp:      bool  = True     # first_touch must be TAKE_PROFIT

    # Policy C parameters
    min_required_return: float = 0.0
    max_mae:             float = -5.0  # MAE must be > this (e.g., -5% max drawdown)

    # General
    exclude_ambiguous: bool = True    # exclude DATA_INSUFFICIENT events
    min_horizon_bars:  int  = 1


class MetaLabelPolicy:
    """
    Computes meta labels for a list of MetaEvent objects.

    Usage
    -----
    policy = MetaLabelPolicy(MetaLabelPolicyConfig(
        policy_type=MetaLabelPolicyType.POLICY_A_POSITIVE_NET,
        policy_version="meta_policy_a-v1",
    ))
    labeled_events = policy.label(events)
    """

    def __init__(self, config: MetaLabelPolicyConfig) -> None:
        self.config = config

    def label(self, events: list[MetaEvent]) -> list[MetaEvent]:
        """
        Assign meta_label to each event according to the configured policy.

        Returns the same list with meta_label populated (1, 0, or None for
        excluded events).

        Side effects: mutates meta_label and label_policy on each event.
        """
        labeled = []
        for ev in events:
            ev_copy = MetaEvent(**ev.__dict__)  # shallow copy
            ev_copy.meta_label, included = self._compute_label(ev_copy)
            ev_copy.label_policy = self.config.policy_type
            labeled.append(ev_copy)
        return labeled

    def _compute_label(self, ev: MetaEvent) -> tuple[Optional[int], bool]:
        """
        Returns (meta_label, included).
        meta_label=None means excluded from training.
        """
        cfg = self.config

        # Exclude incomplete/ambiguous events
        if cfg.exclude_ambiguous:
            if ev.first_touch in ("DATA_INSUFFICIENT", "INTRABAR_AMBIGUOUS", None):
                if ev.gross_return is None:
                    return None, False

        if cfg.policy_type == MetaLabelPolicyType.POLICY_A_POSITIVE_NET:
            return self._policy_a(ev)
        elif cfg.policy_type == MetaLabelPolicyType.POLICY_B_TRIPLE_BARRIER:
            return self._policy_b(ev)
        elif cfg.policy_type == MetaLabelPolicyType.POLICY_C_RISK_ADJUSTED:
            return self._policy_c(ev)
        else:
            return None, False

    def _policy_a(self, ev: MetaEvent) -> tuple[Optional[int], bool]:
        """Policy A: meta_label=1 if net_return > min_net_return."""
        ret = ev.net_return if ev.net_return is not None else ev.gross_return
        if ret is None or not math.isfinite(ret):
            return None, False
        label = 1 if ret > self.config.min_net_return else 0
        return label, True

    def _policy_b(self, ev: MetaEvent) -> tuple[Optional[int], bool]:
        """Policy B: meta_label=1 if first_touch == TAKE_PROFIT."""
        if ev.first_touch is None:
            return None, False
        label = 1 if ev.first_touch == "TAKE_PROFIT" else 0
        return label, True

    def _policy_c(self, ev: MetaEvent) -> tuple[Optional[int], bool]:
        """Policy C: net_return > min_required AND mae > max_mae (less adverse)."""
        ret = ev.net_return if ev.net_return is not None else ev.gross_return
        if ret is None or not math.isfinite(ret):
            return None, False
        mae_ok = (ev.mae is None) or (ev.mae > self.config.max_mae)
        label = 1 if (ret > self.config.min_required_return and mae_ok) else 0
        return label, True


# ── Meta label dataset builders ───────────────────────────────────────────────

def build_meta_labels(
    events: list[MetaEvent],
    policy: MetaLabelPolicy,
    require_oos: bool = True,
) -> tuple[list[MetaEvent], dict]:
    """
    Apply a MetaLabelPolicy to a list of MetaEvent objects.

    Parameters
    ----------
    events      : MetaEvent objects with outcome fields populated.
    policy      : MetaLabelPolicy to apply.
    require_oos : If True, raises RuntimeError on any non-OOS event
                  before labeling. This enforces the stacking leakage rule.

    Returns
    -------
    (labeled_events, stats)
    labeled_events: events with meta_label populated
    stats: {n_total, n_labeled, n_excluded, positive_rate, negative_rate}

    Stacking leakage enforcement
    ----------------------------
    If require_oos=True and any event has is_oos_primary_prediction=False,
    a RuntimeError is raised BEFORE labeling begins.  This is the programmatic
    enforcement of the OOS discipline rule.
    """
    if require_oos:
        leaky = [e for e in events if not e.is_oos_primary_prediction]
        if leaky:
            syms = [e.instrument_id for e in leaky[:5]]
            raise RuntimeError(
                f"Stacking leakage: {len(leaky)} events have "
                f"is_oos_primary_prediction=False (e.g. {syms}). "
                "Provide only OOS primary predictions for meta-label training."
            )

    labeled = policy.label(events)
    included = [e for e in labeled if e.meta_label is not None]
    pos = sum(1 for e in included if e.meta_label == 1)
    neg = len(included) - pos

    stats = {
        "n_total":       len(events),
        "n_labeled":     len(included),
        "n_excluded":    len(events) - len(included),
        "positive_rate": pos / len(included) if included else None,
        "negative_rate": neg / len(included) if included else None,
        "policy":        policy.config.policy_type.value,
        "policy_version": policy.config.policy_version,
    }
    return labeled, stats


def meta_events_to_dataframe(events: list[MetaEvent]) -> pd.DataFrame:
    """
    Convert labeled MetaEvent list to a DataFrame.
    Outcome fields (gross_return, net_return, mfe, mae, first_touch) are
    tagged with an _outcome_ prefix to make it easy to detect if they
    accidentally enter a feature matrix.
    """
    rows = []
    for ev in events:
        row = {
            "instrument_id":           ev.instrument_id,
            "prediction_time":         ev.prediction_time,
            "primary_side":            ev.primary_side,
            "primary_alpha_score":     ev.primary_alpha_score,
            "primary_rank":            ev.primary_rank,
            "primary_percentile":      ev.primary_percentile,
            "primary_cross_section_size": ev.primary_cross_section_size,
            "is_oos_primary_prediction": ev.is_oos_primary_prediction,
            "primary_fold_id":         ev.primary_fold_id,
            "primary_model_id":        ev.primary_model_id,
            "event_start_time":        ev.event_start_time,
            "event_end_time":          ev.event_end_time,
            # Outcome fields — NEVER use as features; prefixed for safety
            "_outcome_gross_return":   ev.gross_return,
            "_outcome_net_return":     ev.net_return,
            "_outcome_mfe":            ev.mfe,
            "_outcome_mae":            ev.mae,
            "_outcome_first_touch":    ev.first_touch,
            # Target
            "meta_label":              ev.meta_label,
            "label_policy":            ev.label_policy.value if ev.label_policy else None,
        }
        rows.append(row)
    return pd.DataFrame(rows)


def validate_no_outcome_features(feature_names: list[str]) -> None:
    """
    Raise ValueError if any feature name matches an outcome column.

    Call this before assembling the meta-model feature matrix to catch
    accidental leakage of outcome fields into the feature set.
    """
    OUTCOME_PATTERNS = [
        "gross_return", "net_return", "mfe", "mae", "first_touch",
        "event_end", "event_return", "_outcome_", "forward_return",
        "realized_return", "exit_price",
    ]
    violations = [
        f for f in feature_names
        if any(p in f.lower() for p in OUTCOME_PATTERNS)
    ]
    if violations:
        raise ValueError(
            f"Meta-label feature leakage detected: these features contain "
            f"outcome information and must not be in the meta-model feature matrix:\n"
            + "\n".join(f"  - {v}" for v in violations)
        )
