"""
Ranking Engine Schemas — Phase 3E.

Defines the canonical data structures for the cross-sectional ranking system.

Design principles
-----------------
1. alpha_score semantics are ALWAYS documented.  A score is NOT a probability
   unless explicitly calibrated and marked as such.
2. Ranking is ALWAYS defined as: higher score = more attractive.
   Models that natively produce lower-is-better scores must invert before
   storing in CrossSectionalAlphaSignal.
3. Every signal carries full provenance so historical predictions cannot be
   recomputed from a mutable model artifact.
4. Tie-breaking is deterministic: average rank, then by instrument_id.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Optional


# ── Enumerations ──────────────────────────────────────────────────────────────

class PredictionProvenance(str, Enum):
    """
    How the alpha score was produced.
    TRAINED_MODEL must never be assigned to a heuristic or baseline.
    """
    TRAINED_MODEL       = "TRAINED_MODEL"
    BASELINE            = "BASELINE"
    HEURISTIC           = "HEURISTIC"
    UNAVAILABLE         = "UNAVAILABLE"
    INSUFFICIENT_EVIDENCE = "INSUFFICIENT_EVIDENCE"


class SignalStatus(str, Enum):
    """Lifecycle status of this ranking signal."""
    RANKED                    = "RANKED"
    INSUFFICIENT_CROSS_SECTION = "INSUFFICIENT_CROSS_SECTION"
    DATA_UNAVAILABLE          = "DATA_UNAVAILABLE"
    MODEL_UNAVAILABLE         = "MODEL_UNAVAILABLE"
    INSUFFICIENT_EVIDENCE     = "INSUFFICIENT_EVIDENCE"


class EligibilityState(str, Enum):
    """Per-instrument universe eligibility at timestamp t."""
    MODEL_ELIGIBLE     = "MODEL_ELIGIBLE"
    MODEL_INELIGIBLE   = "MODEL_INELIGIBLE"
    DATA_UNAVAILABLE   = "DATA_UNAVAILABLE"
    INSUFFICIENT_LIQUIDITY = "INSUFFICIENT_LIQUIDITY"
    FNO_BANNED         = "FNO_BANNED"
    CONTRACT_EXPIRED   = "CONTRACT_EXPIRED"
    INSUFFICIENT_HISTORY = "INSUFFICIENT_HISTORY"


class AlphaScoreSemantics(str, Enum):
    """
    Documents what the alpha_score value represents.
    Must be set on every CrossSectionalAlphaSignal.
    """
    PREDICTED_EXCESS_RETURN    = "PREDICTED_EXCESS_RETURN"
    PREDICTED_RAW_RETURN       = "PREDICTED_RAW_RETURN"
    PREDICTED_CS_ZSCORE        = "PREDICTED_CS_ZSCORE"
    PREDICTED_RANK_SCORE       = "PREDICTED_RANK_SCORE"     # listwise ranker
    COMPOSITE_SCORE            = "COMPOSITE_SCORE"          # weighted composite
    MOMENTUM_RANK              = "MOMENTUM_RANK"            # baseline
    UNKNOWN                    = "UNKNOWN"                  # must not be used in production


# ── Core signal ───────────────────────────────────────────────────────────────

@dataclass
class CrossSectionalAlphaSignal:
    """
    The canonical output of the ranking engine for one instrument at one time.

    Conventions
    -----------
    alpha_score  : float; higher = more attractive (invariant).
                   Range depends on semantics (see alpha_score_semantics).
    rank         : 1 = highest alpha score (best), N = lowest (worst).
    percentile   : 0 = lowest, 100 = highest (consistent with alpha_score direction).
    """
    instrument_id:    str
    timestamp:        datetime

    # Core output
    alpha_score:      Optional[float]
    rank:             Optional[int]
    percentile:       Optional[float]

    # Context
    cross_section_size: int
    universe_version: str
    model_id:         str
    model_version:    str
    feature_set_id:   str
    label_version:    str
    dataset_id:       str

    # Semantics and provenance — mandatory
    alpha_score_semantics: AlphaScoreSemantics
    prediction_provenance: PredictionProvenance
    signal_status:        SignalStatus

    # Optional research fields
    raw_score:          Optional[float] = None   # score before percentile transform
    target_horizon_bars: Optional[int]  = None
    notes:              str = ""


@dataclass
class RankingRow:
    """
    One row of the flattened training / evaluation dataset.

    group_id MUST equal timestamp (as ISO string or pd.Timestamp) so
    that cross-sectional ranking objectives (LambdaRank, etc.) know which
    rows belong to the same decision timestamp.
    """
    instrument_id:  str
    timestamp:      datetime
    group_id:       str            # = str(timestamp); defines CS groups for LambdaRank

    # Features (flat dict; NaN for unavailable)
    features:       dict[str, Optional[float]] = field(default_factory=dict)

    # Label variants (targets A–F)
    raw_return:     Optional[float] = None
    excess_return:  Optional[float] = None
    sector_relative: Optional[float] = None
    cs_percentile:  Optional[float] = None
    cs_zscore:      Optional[float] = None
    cs_rank:        Optional[int]   = None

    # Provenance
    universe_version:   str = ""
    feature_set_id:     str = ""
    label_version:      str = "lv2"
    event_start_time:   Optional[datetime] = None
    event_end_time:     Optional[datetime] = None
    sample_weight:      float = 1.0


@dataclass
class RankingDataset:
    """
    A fully constructed ranking dataset ready for model training.

    rows        : All RankingRow objects, ordered by timestamp then instrument.
    feature_names : Ordered list of feature column names.
    groups      : Number of stocks per timestamp (for LambdaRank).
    timestamps  : Unique sorted prediction timestamps.
    """
    rows:          list[RankingRow]
    feature_names: list[str]
    groups:        list[int]           # stocks per timestamp
    timestamps:    list[datetime]
    universe_version: str = ""
    feature_set_id:   str = ""
    label_version:    str = "lv2"
    dataset_id:       str = ""

    def to_arrays(
        self,
        target: str = "excess_return",
    ):
        """
        Convert to numpy arrays (X, y, groups, weights).

        Parameters
        ----------
        target : Which label to use as y.
                 One of: raw_return, excess_return, sector_relative,
                         cs_percentile, cs_zscore, cs_rank.

        Returns
        -------
        X       : (n, n_features) float32
        y       : (n,) float32 — NaN rows not removed here; caller filters
        groups  : list[int] — stocks per timestamp
        weights : (n,) float32
        timestamps_per_row : list[datetime]
        instrument_ids : list[str]
        """
        import numpy as np

        n_feat = len(self.feature_names)
        feat_idx = {f: i for i, f in enumerate(self.feature_names)}

        X_list, y_list, w_list = [], [], []
        ts_list, id_list = [], []

        for row in self.rows:
            x = np.full(n_feat, np.nan, dtype=np.float32)
            for fname, idx in feat_idx.items():
                v = row.features.get(fname)
                if v is not None and not (isinstance(v, float) and not _isfinite(v)):
                    x[idx] = float(v)
            X_list.append(x)

            y_val = getattr(row, target, None)
            y_list.append(float(y_val) if y_val is not None else np.nan)
            w_list.append(float(row.sample_weight))
            ts_list.append(row.timestamp)
            id_list.append(row.instrument_id)

        X = np.array(X_list, dtype=np.float32)
        y = np.array(y_list, dtype=np.float32)
        w = np.array(w_list, dtype=np.float32)
        return X, y, self.groups, w, ts_list, id_list


def _isfinite(v: float) -> bool:
    import math
    return math.isfinite(v)


# ── Experiment manifest ───────────────────────────────────────────────────────

@dataclass
class ExperimentManifest:
    """
    Reproducibility manifest for a ranking experiment.

    Stored alongside every model artifact so that historical predictions
    can be reconstructed from scratch.
    """
    experiment_id:    str
    created_at:       str   # ISO datetime
    git_commit:       str
    dataset_id:       str
    universe_version: str
    feature_set_id:   str
    label_version:    str
    target_horizon:   int
    models:           list[str]
    hyperparameters:  dict
    validation_config: dict
    normalization:    str
    neutralization:   str
    cost_model:       str
    random_seed:      int
    n_experiments:    int = 1
    n_models:         int = 1
    n_feature_sets:   int = 1
    n_horizons:       int = 1
    n_hpo_trials:     int = 0
    notes:            str = ""


# ── Model output ─────────────────────────────────────────────────────────────

@dataclass
class RankerEvalResult:
    """
    Complete OOS evaluation results for one ranker model.
    """
    model_id:         str
    model_version:    str
    target_label:     str
    horizon_bars:     int

    # IC statistics
    mean_ic:          Optional[float] = None
    median_ic:        Optional[float] = None
    std_ic:           Optional[float] = None
    icir:             Optional[float] = None
    positive_ic_pct:  Optional[float] = None
    ic_p5:            Optional[float] = None
    ic_p25:           Optional[float] = None
    ic_p75:           Optional[float] = None
    ic_p95:           Optional[float] = None

    # Rank IC (Spearman of ranks vs ranks)
    mean_rank_ic:     Optional[float] = None
    median_rank_ic:   Optional[float] = None
    rank_icir:        Optional[float] = None
    positive_rank_ic_pct: Optional[float] = None

    # Decile returns (Q1=lowest alpha, Q10=highest)
    decile_mean_returns: list[float] = field(default_factory=list)
    top_bottom_spread:   Optional[float] = None

    # Turnover and coverage
    turnover_proxy:   Optional[float] = None
    coverage_pct:     Optional[float] = None
    mean_cs_size:     Optional[float] = None

    # Acceptance
    verdict:          str = "INSUFFICIENT_EVIDENCE"
    n_timestamps:     int = 0
    n_observations:   int = 0
    notes:            str = ""
