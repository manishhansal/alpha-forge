"""
Label Registry — single source of truth for all registered label types.

Training code references label IDs instead of duplicating label formulas.
Every registered label exposes its full metadata so the training pipeline
can build the correct DatasetSnapshot fields.

Usage
-----
::
    from src.labels.registry import LABEL_REGISTRY, get_label_config

    label_info = LABEL_REGISTRY["TRIPLE_BARRIER_V2_DAILY"]
    config = get_label_config("TRIPLE_BARRIER_V2_DAILY")
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Optional, Sequence

from .config import LabelConfig, CostModelConfig
from .schemas import LabelFamily


@dataclass
class LabelRegistration:
    """Metadata for a registered label type."""

    name:                str
    version:             str
    label_family:        LabelFamily
    config:              LabelConfig
    description:         str
    required_input_cols: Sequence[str]
    output_columns:      Sequence[str]
    event_based:         bool  = True
    point_in_time_safe:  bool  = True
    tested:              bool  = False
    deprecated:          bool  = False
    deprecation_note:    str   = ""

    @property
    def label_config_hash(self) -> str:
        return self.config.hash

    @property
    def horizon(self) -> int:
        return self.config.horizon_bars

    def to_dict(self) -> dict:
        return {
            "name":               self.name,
            "version":            self.version,
            "label_family":       self.label_family.value,
            "label_config_hash":  self.label_config_hash,
            "horizon":            self.horizon,
            "event_based":        self.event_based,
            "pit_safe":           self.point_in_time_safe,
            "tested":             self.tested,
            "deprecated":         self.deprecated,
        }


# ─── Registered Labels ────────────────────────────────────────────────────────

LABEL_REGISTRY: dict[str, LabelRegistration] = {}


def _reg(entry: LabelRegistration) -> None:
    LABEL_REGISTRY[entry.name] = entry


# ── Fixed-horizon labels ───────────────────────────────────────────────────────

_reg(LabelRegistration(
    name="FIXED_RETURN_5",
    version="lv2",
    label_family=LabelFamily.FIXED_RETURN,
    config=LabelConfig(version="lv2", horizon_bars=5, bar_frequency="1D"),
    description="Raw 5-bar forward return, long-only perspective.",
    required_input_cols=["close"],
    output_columns=["gross_return", "direction_class", "event_start_time", "event_end_time"],
    event_based=False,
    tested=True,
))

_reg(LabelRegistration(
    name="FIXED_RETURN_20",
    version="lv2",
    label_family=LabelFamily.FIXED_RETURN,
    config=LabelConfig(version="lv2", horizon_bars=20, bar_frequency="1D"),
    description="Raw 20-bar forward return, long-only perspective.",
    required_input_cols=["close"],
    output_columns=["gross_return", "direction_class", "event_start_time", "event_end_time"],
    event_based=False,
    tested=True,
))

_reg(LabelRegistration(
    name="EXCESS_RETURN_5",
    version="lv2",
    label_family=LabelFamily.EXCESS_RETURN,
    config=LabelConfig.ranking_daily(),
    description="5-bar risk-adjusted excess return vs NIFTY.",
    required_input_cols=["close", "nifty_close"],
    output_columns=["excess_return", "gross_return", "event_start_time", "event_end_time"],
    event_based=False,
    tested=True,
))

_reg(LabelRegistration(
    name="EXCESS_RETURN_20",
    version="lv2",
    label_family=LabelFamily.EXCESS_RETURN,
    config=LabelConfig(version="lv2", horizon_bars=20, bar_frequency="1D"),
    description="20-bar risk-adjusted excess return vs NIFTY.",
    required_input_cols=["close", "nifty_close"],
    output_columns=["excess_return", "gross_return", "event_start_time", "event_end_time"],
    event_based=False,
    tested=True,
))

# ── Triple-barrier labels ──────────────────────────────────────────────────────

_reg(LabelRegistration(
    name="TRIPLE_BARRIER_V2_DAILY",
    version="lv2",
    label_family=LabelFamily.TRIPLE_BARRIER,
    config=LabelConfig.default_daily(),
    description=(
        "Event-based triple-barrier label for daily NSE equity/F&O. "
        "Barriers are ATR-scaled. Intrabar ambiguity policy: CONSERVATIVE_SL."
    ),
    required_input_cols=["open", "high", "low", "close"],
    output_columns=[
        "first_touch", "gross_return", "net_return",
        "upper_barrier_pct", "lower_barrier_pct",
        "event_start_time", "event_end_time", "barrier_hit_time",
        "intrabar_ambiguous", "is_incomplete",
    ],
    event_based=True,
    tested=True,
))

_reg(LabelRegistration(
    name="TRIPLE_BARRIER_V2_RANKING",
    version="lv2",
    label_family=LabelFamily.TRIPLE_BARRIER,
    config=LabelConfig.ranking_daily(),
    description="Triple-barrier variant for 5-bar cross-sectional ranking tasks.",
    required_input_cols=["open", "high", "low", "close"],
    output_columns=[
        "first_touch", "gross_return",
        "event_start_time", "event_end_time", "barrier_hit_time",
    ],
    event_based=True,
    tested=True,
))

# ── Meta-label ─────────────────────────────────────────────────────────────────

_reg(LabelRegistration(
    name="META_LABEL_V2",
    version="lv2",
    label_family=LabelFamily.META_LABEL,
    config=LabelConfig.default_daily(),
    description=(
        "Meta-label: given primary signal side, TAKE (1) or SKIP (0). "
        "Outcome threshold = net_return > 0. "
        "Direction is supplied by primary model; meta only decides take/skip."
    ),
    required_input_cols=["open", "high", "low", "close"],
    output_columns=["meta_label", "gross_return", "net_return", "event_start_time", "event_end_time"],
    event_based=True,
    tested=True,
))

# ── Risk outcomes (MFE/MAE) ────────────────────────────────────────────────────

_reg(LabelRegistration(
    name="RISK_OUTCOMES_V2",
    version="lv2",
    label_family=LabelFamily.MFE,
    config=LabelConfig.default_daily(),
    description="MFE, MAE, holding period, and time-to-event for completed events.",
    required_input_cols=["high", "low", "close"],
    output_columns=["mfe", "mae", "mfe_time", "mae_time", "holding_bars"],
    event_based=True,
    tested=True,
))

# ── Legacy labels (deprecated, kept for backward compat) ──────────────────────

_reg(LabelRegistration(
    name="RISK_LABELS_V1",
    version="lv1",
    label_family=LabelFamily.TRIPLE_BARRIER,
    config=LabelConfig(version="lv1", horizon_bars=20, bar_frequency="1D"),
    description=(
        "[DEPRECATED] Legacy stop_hit / target_hit / MAE labels. "
        "Does NOT correctly handle simultaneous stop+target (both scan full window). "
        "No event timestamps. No costs. Use TRIPLE_BARRIER_V2_DAILY instead."
    ),
    required_input_cols=["high", "low", "close"],
    output_columns=["stop_hit", "target_hit", "mae"],
    event_based=False,
    tested=False,
    deprecated=True,
    deprecation_note="Use TRIPLE_BARRIER_V2_DAILY. See Phase 3C migration.",
))

_reg(LabelRegistration(
    name="RANKING_LABELS_V1",
    version="lv1",
    label_family=LabelFamily.EXCESS_RETURN,
    config=LabelConfig(version="lv1", horizon_bars=5, bar_frequency="1D"),
    description=(
        "[DEPRECATED] Legacy risk-adjusted excess return. "
        "No event timestamps. Use EXCESS_RETURN_5 instead."
    ),
    required_input_cols=["close", "nifty_close"],
    output_columns=["excess_return"],
    event_based=False,
    tested=False,
    deprecated=True,
    deprecation_note="Use EXCESS_RETURN_5. See Phase 3C migration.",
))


# ─── Registry access helpers ──────────────────────────────────────────────────

def get_label_registration(label_id: str) -> LabelRegistration:
    if label_id not in LABEL_REGISTRY:
        raise KeyError(
            f"Label '{label_id}' not found in registry. "
            f"Available: {sorted(LABEL_REGISTRY)}"
        )
    return LABEL_REGISTRY[label_id]


def get_label_config(label_id: str) -> LabelConfig:
    return get_label_registration(label_id).config


def list_active_labels() -> list[str]:
    """Return all non-deprecated label IDs."""
    return sorted(k for k, v in LABEL_REGISTRY.items() if not v.deprecated)


def list_deprecated_labels() -> list[str]:
    return sorted(k for k, v in LABEL_REGISTRY.items() if v.deprecated)
