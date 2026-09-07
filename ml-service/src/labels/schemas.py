"""
Label Schemas — canonical data contracts for AlphaForge Label V2.

Every label produced by the label engine is an instance of one of these
dataclasses.  The schemas are the interface contract between label generation
and model training — models may not access raw label internals directly.

PIT rule
--------
event_start_time  = prediction time (features available here)
event_end_time    = when outcome was resolved (future — may use future prices)
label_available_time = event_end_time for offline/historical training
                       For live trading this would be the real settlement time.

The critical distinction: event_end_time may be in the future relative to
event_start_time.  That is intentional and correct.  The label is the
OUTCOME, not a feature.  Future information must NEVER leak into features.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Optional


# ── Enumerations ───────────────────────────────────────────────────────────────

class FirstTouch(str, Enum):
    """Which barrier was touched first in a triple-barrier event."""
    TAKE_PROFIT       = "TAKE_PROFIT"
    STOP_LOSS         = "STOP_LOSS"
    TIME_LIMIT        = "TIME_LIMIT"
    DATA_INSUFFICIENT = "DATA_INSUFFICIENT"   # horizon ends before full window
    INTRABAR_AMBIGUOUS = "INTRABAR_AMBIGUOUS" # both barriers inside same bar
    DATA_MISSING      = "DATA_MISSING"        # OHLC data absent/invalid


class Side(int, Enum):
    """Trade direction. +1 = long, -1 = short, 0 = neutral/no trade."""
    LONG    =  1
    SHORT   = -1
    NEUTRAL =  0


class DirectionClass(str, Enum):
    """Fixed-horizon directional classification."""
    UP   = "UP"
    DOWN = "DOWN"
    FLAT = "FLAT"


class PriceBasis(str, Enum):
    """Whether label prices are raw or corporate-action adjusted."""
    RAW                         = "RAW"
    CORPORATE_ACTION_ADJUSTED   = "ADJUSTED"
    DATA_UNAVAILABLE            = "DATA_UNAVAILABLE"


class LabelFamily(str, Enum):
    FIXED_RETURN       = "FIXED_RETURN"
    DIRECTIONAL        = "DIRECTIONAL"
    EXCESS_RETURN      = "EXCESS_RETURN"
    SECTOR_RELATIVE    = "SECTOR_RELATIVE"
    VOL_ADJUSTED       = "VOL_ADJUSTED_RETURN"
    TRIPLE_BARRIER     = "TRIPLE_BARRIER"
    META_LABEL         = "META_LABEL"
    MFE                = "MFE"
    MAE                = "MAE"
    HOLDING_PERIOD     = "HOLDING_PERIOD"
    TIME_TO_EVENT      = "TIME_TO_EVENT"


# ── Core event ─────────────────────────────────────────────────────────────────

@dataclass
class LabelEvent:
    """
    Base event record shared by every label type.

    Fields
    ------
    symbol              : Trading symbol (NSE uppercase).
    event_start_time    : When the observation was made / trade notionally entered.
                          This is the prediction time — features use data up to here.
    event_end_time      : When the outcome was resolved.
                          May be after event_start_time (future) — this is intentional.
    label_available_time: When this label becomes available for offline training.
                          Equals event_end_time for historical offline labels.
    label_family        : LabelFamily enum value.
    label_version       : e.g. "lv2"
    label_config_hash   : SHA-256 prefix of the LabelConfig that produced this event.
    side                : Trade direction (LONG/SHORT/NEUTRAL).
    price_basis         : Whether raw or adjusted prices were used.
    bar_frequency       : "1D", "5T", "15T", etc.
    data_snapshot_id    : Optional reference to the DatasetSnapshot that produced this.
    """

    symbol:               str
    event_start_time:     datetime           # prediction time
    event_end_time:       datetime           # outcome resolved
    label_available_time: datetime           # for offline training = event_end_time
    label_family:         LabelFamily
    label_version:        str = "lv2"
    label_config_hash:    str = ""
    side:                 Side = Side.LONG
    price_basis:          PriceBasis = PriceBasis.RAW
    bar_frequency:        str = "1D"
    data_snapshot_id:     Optional[str] = None

    @property
    def holding_bars(self) -> Optional[float]:
        """Duration in calendar terms — subclasses override with bar count."""
        return None


# ── Fixed-horizon label ────────────────────────────────────────────────────────

@dataclass
class FixedHorizonLabel(LabelEvent):
    """
    Fixed-horizon forward return label.

    Produced by labels/fixed_horizon.py.
    """

    horizon_bars:       int   = 5
    entry_price:        float = 0.0
    exit_price:         float = 0.0       # close at t+horizon
    gross_return:       Optional[float] = None   # (exit-entry)/entry
    direction_class:    Optional[DirectionClass] = None
    is_incomplete:      bool  = False    # True when tail of dataset reached


# ── Triple-barrier label ───────────────────────────────────────────────────────

@dataclass
class TripleBarrierLabel(LabelEvent):
    """
    Triple-barrier event-based label.

    Produced by labels/triple_barrier.py.

    Critical fields
    ---------------
    first_touch         : Which barrier was hit first (see FirstTouch enum).
    barrier_hit_time    : When the first barrier was hit (None if TIME_LIMIT/DATA_INSUFFICIENT).
    gross_return        : Side-adjusted gross return at event_end.
    net_return          : Gross return minus costs. None when cost data unavailable.
    intrabar_ambiguous  : True when both TP and SL appear in the same OHLC bar.
    ambiguity_policy    : How ambiguity was handled ("CONSERVATIVE_SL", "DATA_AMBIGUOUS", etc.)

    Barrier definitions
    -------------------
    upper_barrier_pct   : TP barrier as % of entry price (unsigned).
    lower_barrier_pct   : SL barrier as % of entry price (unsigned).
    vertical_barrier_bars: Maximum bars before TIME_LIMIT.

    For a LONG:
      TP hit when price >= entry * (1 + upper_barrier_pct/100)
      SL hit when price <= entry * (1 - lower_barrier_pct/100)

    For a SHORT:
      TP hit when price <= entry * (1 - upper_barrier_pct/100)
      SL hit when price >= entry * (1 + lower_barrier_pct/100)
    """

    # Barriers
    upper_barrier_pct:     float = 0.0
    lower_barrier_pct:     float = 0.0
    vertical_barrier_bars: int   = 20
    volatility_reference:  float = 0.0   # ATR or σ used to set barriers

    # Entry / exit
    entry_price:           float = 0.0
    exit_price:            Optional[float] = None

    # Outcome
    first_touch:           FirstTouch = FirstTouch.DATA_INSUFFICIENT
    barrier_hit_time:      Optional[datetime] = None
    gross_return:          Optional[float] = None   # side-adjusted
    net_return:            Optional[float] = None   # gross minus costs
    cost_status:           str = "DATA_UNAVAILABLE" # "APPLIED" | "DATA_UNAVAILABLE"

    # Ambiguity
    intrabar_ambiguous:    bool = False
    ambiguity_policy:      str = "DATA_AMBIGUOUS"   # or "CONSERVATIVE_SL"

    # Completeness
    is_incomplete:         bool = False  # horizon not fully elapsed when dataset ends


# ── Risk outcomes ──────────────────────────────────────────────────────────────

@dataclass
class RiskOutcomeLabel(LabelEvent):
    """
    MFE / MAE and holding period for a completed event.

    Produced by labels/risk_outcomes.py.
    Always attached to a completed TripleBarrierLabel or FixedHorizonLabel.
    These are OUTCOMES — never features.
    """

    # MFE: maximum favorable excursion
    mfe:            Optional[float] = None  # always >= 0 (signed relative to side)
    mfe_time:       Optional[datetime] = None
    mfe_bar_offset: Optional[int] = None    # bars from entry to MFE

    # MAE: maximum adverse excursion
    mae:            Optional[float] = None  # always <= 0 (signed relative to side)
    mae_time:       Optional[datetime] = None
    mae_bar_offset: Optional[int] = None

    # Holding period
    holding_bars:   Optional[int] = None
    holding_seconds: Optional[float] = None

    # Time-to-event
    bars_to_tp:     Optional[int] = None
    bars_to_sl:     Optional[int] = None
    bars_to_time:   Optional[int] = None


# ── Meta-label ─────────────────────────────────────────────────────────────────

@dataclass
class MetaLabel(LabelEvent):
    """
    Meta-label: given the primary signal's side, should we take the trade?

    The side is supplied by the primary model (regime + ranker + strategy).
    The meta-label only decides TAKE (1) or SKIP (0).

    Meta-label = 1 iff the primary side produced a positive net outcome.

    The meta-label never independently decides direction.
    Direction belongs to the primary signal.
    """

    primary_side:           Side = Side.LONG
    primary_signal_source:  str  = ""          # identifier of the primary model
    meta_label:             Optional[int] = None  # 1=TAKE, 0=SKIP, None=UNKNOWN
    gross_return:           Optional[float] = None
    net_return:             Optional[float] = None
    outcome_threshold:      float = 0.0         # net return must exceed this to be TAKE
    cost_status:            str = "DATA_UNAVAILABLE"

    @property
    def take(self) -> Optional[bool]:
        if self.meta_label is None:
            return None
        return self.meta_label == 1

    @property
    def skip(self) -> Optional[bool]:
        if self.meta_label is None:
            return None
        return self.meta_label == 0


# ── Sample metadata ───────────────────────────────────────────────────────────

@dataclass
class SampleMetadata:
    """
    Per-observation metadata for sample weighting.

    Attached to every training event so the training loop can compute
    sample weights for the PurgedKFold.

    Fields
    ------
    event_start_time   : t0 of the label event.
    event_end_time     : t1 of the label event (the actual label window end).
    average_uniqueness : Fraction of this event's window not overlapped by other events.
    concurrency        : Number of simultaneous active events at this bar.
    sample_weight      : Derived weight (1 / concurrency, or uniqueness-based).
    """

    symbol:              str
    event_start_time:    datetime
    event_end_time:      datetime
    average_uniqueness:  float = 1.0   # 0..1; lower = more overlapping
    concurrency:         int   = 1     # how many events are active simultaneously
    sample_weight:       float = 1.0   # for model.fit(..., sample_weight=)

    def t1_series_value(self) -> datetime:
        """Returns event_end_time for use in build_t1_series / PurgedKFold."""
        return self.event_end_time


# ── Label diagnostics summary ─────────────────────────────────────────────────

@dataclass
class LabelDiagnostics:
    """
    Summary statistics for a generated label dataset.
    Diagnostic only — never used for label optimization.
    """

    label_family:           str
    label_version:          str
    label_config_hash:      str
    sample_count:           int = 0
    positive_count:         int = 0
    negative_count:         int = 0
    neutral_count:          int = 0
    incomplete_count:       int = 0
    ambiguous_count:        int = 0

    # For triple-barrier
    tp_count:               int = 0
    sl_count:               int = 0
    time_count:             int = 0

    mean_gross_return:      Optional[float] = None
    median_gross_return:    Optional[float] = None
    std_gross_return:       Optional[float] = None
    mean_mfe:               Optional[float] = None
    mean_mae:               Optional[float] = None
    median_holding_bars:    Optional[float] = None
    event_overlap_fraction: Optional[float] = None

    @property
    def tp_pct(self) -> Optional[float]:
        total = self.tp_count + self.sl_count + self.time_count
        return round(self.tp_count / total * 100, 1) if total > 0 else None

    @property
    def sl_pct(self) -> Optional[float]:
        total = self.tp_count + self.sl_count + self.time_count
        return round(self.sl_count / total * 100, 1) if total > 0 else None

    @property
    def time_pct(self) -> Optional[float]:
        total = self.tp_count + self.sl_count + self.time_count
        return round(self.time_count / total * 100, 1) if total > 0 else None

    def to_dict(self) -> dict:
        return {
            "label_family":          self.label_family,
            "label_version":         self.label_version,
            "label_config_hash":     self.label_config_hash,
            "sample_count":          self.sample_count,
            "positive_count":        self.positive_count,
            "negative_count":        self.negative_count,
            "neutral_count":         self.neutral_count,
            "incomplete_count":      self.incomplete_count,
            "ambiguous_count":       self.ambiguous_count,
            "tp_count":              self.tp_count,
            "sl_count":              self.sl_count,
            "time_count":            self.time_count,
            "tp_pct":                self.tp_pct,
            "sl_pct":                self.sl_pct,
            "time_pct":              self.time_pct,
            "mean_gross_return":     self.mean_gross_return,
            "median_gross_return":   self.median_gross_return,
            "std_gross_return":      self.std_gross_return,
            "mean_mfe":              self.mean_mfe,
            "mean_mae":              self.mean_mae,
            "median_holding_bars":   self.median_holding_bars,
            "event_overlap_fraction": self.event_overlap_fraction,
        }
