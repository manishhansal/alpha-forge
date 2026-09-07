"""
Phase 3S — Incremental-alpha test, correlated-signal audit & research diagnostics
(spec §20-§23).

§20 Incremental alpha: does a new feature/model/signal add information the system
    does not already have? Verdicts:
      NO_NET_ALPHA          — improvement disappears after costs
      NO_OOS_ALPHA          — improvement disappears out-of-sample
      INSUFFICIENT_EVIDENCE — improvement is statistically weak / sample too small
      INCREMENTAL_ALPHA     — survives costs, OOS, and has adequate evidence

§21 Correlated-signal audit: is a new signal redundant with existing signals, or
    does it carry incremental information? Correlation alone does not reject a
    signal — conditional/residual information decides.

§22 Cross-sectional diagnostics: IC / Rank IC / ICIR / decile monotonicity /
    top-bottom spread (reuses ranking.evaluation).

§23 Time-series diagnostics: directional accuracy / hit rate / expectancy /
    cost-adjusted expectancy. Classification accuracy is NOT trading profitability.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Optional

import numpy as np


# ══════════════════════════════════════════════════════════════════════════════
# §20 Incremental alpha
# ══════════════════════════════════════════════════════════════════════════════

class IncrementalVerdict(str, Enum):
    INCREMENTAL_ALPHA     = "INCREMENTAL_ALPHA"
    NO_NET_ALPHA          = "NO_NET_ALPHA"           # erased by costs
    NO_OOS_ALPHA          = "NO_OOS_ALPHA"           # erased out-of-sample
    INSUFFICIENT_EVIDENCE = "INSUFFICIENT_EVIDENCE"  # statistically weak / small sample


@dataclass
class IncrementalResult:
    verdict:              IncrementalVerdict
    gross_improvement:    float
    net_improvement:      float          # after costs
    oos_improvement:      float
    n_observations:       int
    min_observations:     int
    detail:               str = ""

    def to_dict(self) -> dict:
        return {
            "verdict":           self.verdict.value,
            "gross_improvement": self.gross_improvement,
            "net_improvement":   self.net_improvement,
            "oos_improvement":   self.oos_improvement,
            "n_observations":    self.n_observations,
            "min_observations":  self.min_observations,
            "detail":            self.detail,
        }


def incremental_alpha_test(
    *,
    gross_improvement: float,
    net_improvement: float,
    oos_improvement: float,
    n_observations: int,
    min_observations: int = 30,
    min_effect: float = 1e-6,
) -> IncrementalResult:
    """
    Classify whether a candidate adds incremental alpha (spec §20). Order of checks
    is deliberate and conservative:
      1. sample too small            -> INSUFFICIENT_EVIDENCE (never claim from few obs)
      2. improvement erased by costs -> NO_NET_ALPHA
      3. improvement erased OOS       -> NO_OOS_ALPHA
      4. otherwise                    -> INCREMENTAL_ALPHA
    """
    if n_observations < min_observations:
        return IncrementalResult(
            IncrementalVerdict.INSUFFICIENT_EVIDENCE, gross_improvement,
            net_improvement, oos_improvement, n_observations, min_observations,
            f"n={n_observations} < min {min_observations}: cannot claim alpha (spec §20).")
    if net_improvement <= min_effect:
        return IncrementalResult(
            IncrementalVerdict.NO_NET_ALPHA, gross_improvement, net_improvement,
            oos_improvement, n_observations, min_observations,
            "improvement does not survive transaction costs (spec §20).")
    if oos_improvement <= min_effect:
        return IncrementalResult(
            IncrementalVerdict.NO_OOS_ALPHA, gross_improvement, net_improvement,
            oos_improvement, n_observations, min_observations,
            "improvement does not persist out-of-sample (spec §20).")
    return IncrementalResult(
        IncrementalVerdict.INCREMENTAL_ALPHA, gross_improvement, net_improvement,
        oos_improvement, n_observations, min_observations,
        "improvement survives costs and OOS with adequate sample (spec §20).")


# ══════════════════════════════════════════════════════════════════════════════
# §21 Correlated-signal audit
# ══════════════════════════════════════════════════════════════════════════════

class SignalRelationship(str, Enum):
    REDUNDANT   = "REDUNDANT"     # adds little beyond existing signals
    INCREMENTAL = "INCREMENTAL"   # carries meaningful new information


@dataclass
class CorrelatedSignalResult:
    relationship:        SignalRelationship
    max_abs_correlation: float
    residual_ic:         Optional[float]     # IC of the residual after removing existing signals
    detail:              str = ""

    def to_dict(self) -> dict:
        return {
            "relationship":        self.relationship.value,
            "max_abs_correlation": self.max_abs_correlation,
            "residual_ic":         self.residual_ic,
            "detail":              self.detail,
        }


def audit_correlated_signal(
    new_signal: np.ndarray,
    existing_signals: dict[str, np.ndarray],
    realized: np.ndarray,
    *,
    residual_ic_floor: float = 0.01,
) -> CorrelatedSignalResult:
    """
    Determine whether a new signal is redundant or incremental (spec §21).

    High correlation with an existing signal does NOT automatically reject it —
    what matters is the RESIDUAL information coefficient: regress the new signal on
    the existing ones (least squares), take the residual, and measure its IC vs
    realized returns. If the residual still has meaningful IC, the signal is
    INCREMENTAL despite correlation.
    """
    from src.ranking.evaluation import compute_rank_ic

    new = np.asarray(new_signal, dtype=float)
    y = np.asarray(realized, dtype=float)

    # max absolute correlation with any existing signal
    max_abs_corr = 0.0
    for _, sig in existing_signals.items():
        s = np.asarray(sig, dtype=float)
        if s.std() > 0 and new.std() > 0 and len(s) == len(new):
            c = float(np.corrcoef(new, s)[0, 1])
            if not np.isnan(c):
                max_abs_corr = max(max_abs_corr, abs(c))

    # Residualize the new signal against the existing ones. The residual is the
    # part of the new signal NOT explained by the existing signals. If the new
    # signal is (near-)collinear with an existing signal, the residual carries a
    # negligible fraction of the signal's variance (high R^2) and is treated as
    # noise regardless of any spurious IC it may show.
    residual_ic: Optional[float] = None
    explained_fraction = 0.0
    if existing_signals:
        cols = [np.asarray(s, dtype=float) for s in existing_signals.values()
                if len(s) == len(new)]
        if cols:
            X = np.column_stack([np.ones(len(new))] + cols)
            try:
                beta, *_ = np.linalg.lstsq(X, new, rcond=None)
                fitted = X @ beta
                residual = new - fitted
                ss_tot = float(np.sum((new - new.mean()) ** 2))
                ss_res = float(np.sum(residual ** 2))
                explained_fraction = (1.0 - ss_res / ss_tot) if ss_tot > 0 else 1.0
                # If the residual is a negligible share of the signal's variance,
                # there is effectively no independent information to score.
                if (1.0 - explained_fraction) < 1e-6 or residual.std() < 1e-9:
                    residual_ic = 0.0
                else:
                    residual_ic = compute_rank_ic(residual, y)
            except np.linalg.LinAlgError:
                residual_ic = compute_rank_ic(new, y)
    else:
        residual_ic = compute_rank_ic(new, y)

    ric = abs(residual_ic) if residual_ic is not None else 0.0
    # Redundant if either: (a) the new signal is almost entirely explained by the
    # existing ones, or (b) the residual carries little IC.
    nearly_collinear = explained_fraction >= 0.999
    if not nearly_collinear and ric >= residual_ic_floor:
        rel = SignalRelationship.INCREMENTAL
        detail = (f"residual IC {ric:.4f} >= floor {residual_ic_floor} "
                  f"(explained {explained_fraction:.3f}): incremental information "
                  f"despite correlation {max_abs_corr:.3f} (spec §21).")
    else:
        rel = SignalRelationship.REDUNDANT
        detail = (f"residual IC {ric:.4f} < floor {residual_ic_floor} or explained "
                  f"{explained_fraction:.3f} >= 0.999: redundant with existing "
                  f"signals (spec §21).")
    return CorrelatedSignalResult(rel, max_abs_corr, residual_ic, detail)


# ══════════════════════════════════════════════════════════════════════════════
# §22 Cross-sectional diagnostics
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class CrossSectionalReport:
    mean_rank_ic:        Optional[float]
    mean_ic:             Optional[float]
    n_cross_sections:    int
    top_bottom_spread:   Optional[float]
    decile_monotonic:    Optional[bool]

    def to_dict(self) -> dict:
        return {
            "mean_rank_ic":      self.mean_rank_ic,
            "mean_ic":           self.mean_ic,
            "n_cross_sections":  self.n_cross_sections,
            "top_bottom_spread": self.top_bottom_spread,
            "decile_monotonic":  self.decile_monotonic,
        }


def cross_sectional_diagnostics(
    scores_by_ts: list[np.ndarray],
    realized_by_ts: list[np.ndarray],
    *,
    n_buckets: int = 5,
) -> CrossSectionalReport:
    """
    Cross-sectional ranking diagnostics (spec §22). Computes per-timestamp Rank IC
    and IC (reusing ranking.evaluation), plus top-minus-bottom bucket spread and
    monotonicity of bucket-mean realized returns. Do not accept a ranking signal
    solely because top-bucket return is high — monotonicity + spread + IC together.
    """
    from src.ranking.evaluation import compute_rank_ic, compute_ic

    rank_ics, ics = [], []
    top_scores, bottom_scores = [], []
    bucket_means_accum = np.zeros(n_buckets)
    bucket_counts = np.zeros(n_buckets)

    for scores, realized in zip(scores_by_ts, realized_by_ts):
        s = np.asarray(scores, dtype=float)
        r = np.asarray(realized, dtype=float)
        ric = compute_rank_ic(s, r)
        ic = compute_ic(s, r)
        if ric is not None:
            rank_ics.append(ric)
        if ic is not None:
            ics.append(ic)
        if len(s) >= n_buckets:
            order = np.argsort(s)
            buckets = np.array_split(order, n_buckets)
            for b, idx in enumerate(buckets):
                if len(idx):
                    bucket_means_accum[b] += r[idx].mean()
                    bucket_counts[b] += 1
            top_scores.append(r[buckets[-1]].mean())
            bottom_scores.append(r[buckets[0]].mean())

    mean_rank_ic = float(np.mean(rank_ics)) if rank_ics else None
    mean_ic = float(np.mean(ics)) if ics else None
    top_bottom = (float(np.mean(top_scores) - np.mean(bottom_scores))
                  if top_scores and bottom_scores else None)

    monotonic: Optional[bool] = None
    valid = bucket_counts > 0
    if valid.sum() >= 2:
        means = bucket_means_accum[valid] / bucket_counts[valid]
        monotonic = bool(np.all(np.diff(means) >= 0)) or bool(np.all(np.diff(means) <= 0))

    return CrossSectionalReport(
        mean_rank_ic=mean_rank_ic, mean_ic=mean_ic,
        n_cross_sections=len(scores_by_ts),
        top_bottom_spread=top_bottom, decile_monotonic=monotonic,
    )


# ══════════════════════════════════════════════════════════════════════════════
# §23 Time-series diagnostics
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class TimeSeriesReport:
    directional_accuracy: Optional[float]
    hit_rate:            Optional[float]
    expectancy:          Optional[float]
    cost_adjusted_expectancy: Optional[float]
    n:                   int

    def to_dict(self) -> dict:
        return {
            "directional_accuracy":      self.directional_accuracy,
            "hit_rate":                  self.hit_rate,
            "expectancy":                self.expectancy,
            "cost_adjusted_expectancy":  self.cost_adjusted_expectancy,
            "n":                         self.n,
        }


def time_series_diagnostics(
    predicted_direction: np.ndarray,
    realized_return: np.ndarray,
    *,
    per_trade_cost: float = 0.0,
) -> TimeSeriesReport:
    """
    Time-series signal diagnostics (spec §23). Directional accuracy is reported but
    NOT equated with profitability — expectancy and cost-adjusted expectancy carry
    the economic verdict.
    """
    d = np.asarray(predicted_direction, dtype=float)
    r = np.asarray(realized_return, dtype=float)
    n = int(min(len(d), len(r)))
    if n == 0:
        return TimeSeriesReport(None, None, None, None, 0)
    d, r = d[:n], r[:n]

    correct = (np.sign(d) == np.sign(r))
    directional_accuracy = float(correct.mean())

    # PnL of taking the predicted direction
    pnl = np.sign(d) * r
    hit_rate = float((pnl > 0).mean())
    expectancy = float(pnl.mean())
    cost_adjusted = float((pnl - per_trade_cost).mean())

    return TimeSeriesReport(
        directional_accuracy=directional_accuracy, hit_rate=hit_rate,
        expectancy=expectancy, cost_adjusted_expectancy=cost_adjusted, n=n)
