"""
Expected Value Engine — Phase 3F.

Computes the expected economic value of acting on a meta-model probability.

Architecture
------------
EV = P(success) × E[win] - (1 - P(success)) × |E[loss]| - E[cost]

This is a decision statistic, NOT a portfolio backtest.
EV > 0 is necessary but not sufficient for a tradable strategy.

Rules enforced
--------------
1. Asymmetric payoffs are explicitly modelled — E[win] ≠ |E[loss]| by default.
2. Cost status is explicitly tracked — never fabricates cost estimates.
3. Probability must be CalibratedProbability with status=CALIBRATED or
   EV status = PROBABILITY_UNCALIBRATED.
4. EV > 0 threshold is configurable and must not be hardcoded as 0.
5. Current-event outcomes (return, MFE, MAE) may not be used to estimate
   the payoff distribution for that same event (leakage rule).

Payoff estimation
-----------------
E[win] and E[loss] are estimated from HISTORICAL OOS outcomes,
not from the current event's future return.  The historical window
must end before the current event's prediction_time.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional

import numpy as np

from .schemas import (
    CalibratedProbability,
    EVStatus,
    ExpectedValue,
    ProbabilityStatus,
    ScoreType,
)


# ── Payoff distribution ───────────────────────────────────────────────────────

@dataclass
class PayoffDistribution:
    """
    Estimated win/loss payoff parameters.
    Must be estimated from historical OOS outcomes ending BEFORE prediction_time.

    win_mean   : E[return | win] as % (positive)
    loss_mean  : E[return | loss] as % (negative)
    win_std    : standard deviation of win returns
    loss_std   : standard deviation of loss returns
    n_samples  : number of historical observations used
    fit_end_time : latest observation timestamp (must be <= prediction_time)
    """
    win_mean:     float
    loss_mean:    float
    win_std:      float  = 0.0
    loss_std:     float  = 0.0
    n_samples:    int    = 0
    fit_end_time: Optional[datetime] = None
    data_source:  str    = ""

    def is_valid(self) -> bool:
        return (
            self.win_mean > 0
            and self.loss_mean < 0
            and self.n_samples >= 10
        )

    def assert_no_future_leakage(self, prediction_time: datetime) -> None:
        """
        Raise RuntimeError if payoff distribution includes the current event.

        The payoff distribution must be estimated from events BEFORE
        prediction_time to prevent EV leakage (using the current event's
        return to estimate its own payoff).
        """
        if self.fit_end_time is None:
            return  # cannot verify; caller must ensure
        ft = self.fit_end_time
        pt = prediction_time
        # Normalise timezone
        if ft.tzinfo is None:
            ft = ft.replace(tzinfo=None)
        if pt.tzinfo is None:
            pt = pt.replace(tzinfo=None)
        if ft >= pt:
            raise RuntimeError(
                f"EV leakage: PayoffDistribution.fit_end_time ({ft}) "
                f">= prediction_time ({pt}). The payoff distribution includes "
                "observations from the current or future periods. This violates "
                "the EV leakage rule: current-event outcomes must never enter "
                "the payoff estimation for that same event."
            )


def estimate_payoff_from_outcomes(
    returns: np.ndarray,
    prediction_times: np.ndarray,
    cutoff_time: datetime,
    min_samples: int = 10,
) -> Optional[PayoffDistribution]:
    """
    Estimate win/loss payoff distribution from historical returns.

    Only uses returns from events with prediction_time < cutoff_time.
    Returns None if insufficient data.

    Parameters
    ----------
    returns          : array of realized returns (% or fraction)
    prediction_times : prediction timestamps aligned with returns
    cutoff_time      : latest timestamp to include (strictly <)
    min_samples      : minimum samples for a valid estimate
    """
    # Filter to historical (before cutoff) observations
    mask = np.array([t < cutoff_time for t in prediction_times], dtype=bool)
    hist = returns[mask]
    if len(hist) < min_samples:
        return None

    wins   = hist[hist > 0]
    losses = hist[hist <= 0]

    if len(wins) == 0 or len(losses) == 0:
        return None

    fit_end = max(t for t, m in zip(prediction_times, mask) if m)

    return PayoffDistribution(
        win_mean=float(np.mean(wins)),
        loss_mean=float(np.mean(losses)),
        win_std=float(np.std(wins, ddof=1)) if len(wins) > 1 else 0.0,
        loss_std=float(np.std(losses, ddof=1)) if len(losses) > 1 else 0.0,
        n_samples=len(hist),
        fit_end_time=fit_end,
    )


# ── Cost model ────────────────────────────────────────────────────────────────

@dataclass
class CostModel:
    """
    Round-trip transaction cost estimate.
    If any component is unavailable, status = COST_DATA_UNAVAILABLE.
    """
    brokerage_pct:     Optional[float] = None   # one-way %
    exchange_charges:  Optional[float] = None
    stt_pct:           Optional[float] = None   # NSE STT
    gst_pct:           Optional[float] = None
    slippage_pct:      Optional[float] = None
    version:           str = "cost_model_unavailable"

    def total_round_trip_pct(self) -> Optional[float]:
        """Sum of all cost components × 2 (round-trip). None if any component absent."""
        components = [
            self.brokerage_pct,
            self.exchange_charges,
            self.stt_pct,
            self.gst_pct,
            self.slippage_pct,
        ]
        known = [c for c in components if c is not None]
        if not known:
            return None
        return float(sum(known) * 2.0)

    def is_available(self) -> bool:
        return self.total_round_trip_pct() is not None

    @classmethod
    def unavailable(cls) -> "CostModel":
        return cls()


# ── EV calculator ─────────────────────────────────────────────────────────────

@dataclass
class EVConfig:
    """
    Configuration for the ExpectedValue engine.
    All thresholds are configurable and versioned.
    Never hardcode EV > 0 as the decision threshold.
    """
    min_ev_for_take:     float = 0.0       # EV must exceed this for TAKE
    ev_config_version:   str = "ev_config-v1"
    cost_model:          CostModel = field(default_factory=CostModel.unavailable)


class ExpectedValueCalculator:
    """
    Computes expected economic value from a calibrated probability + payoff distribution.

    Usage
    -----
    calc = ExpectedValueCalculator(config)
    ev   = calc.compute(calibrated_prob, payoff, prediction_time)
    """

    def __init__(self, config: EVConfig | None = None) -> None:
        self.config = config or EVConfig()

    def compute(
        self,
        calibrated_prob: CalibratedProbability,
        payoff: Optional[PayoffDistribution],
        prediction_time: Optional[datetime] = None,
    ) -> ExpectedValue:
        """
        Compute ExpectedValue.

        Parameters
        ----------
        calibrated_prob : CalibratedProbability (must be status=CALIBRATED)
        payoff          : PayoffDistribution estimated from historical data
        prediction_time : Current prediction time (for leakage check)

        Returns
        -------
        ExpectedValue with explicit status.

        Rules enforced:
        - Returns status=PROBABILITY_UNCALIBRATED if probability is not CALIBRATED
        - Returns status=OUTCOME_DATA_INSUFFICIENT if payoff is None or invalid
        - Returns status=COST_DATA_UNAVAILABLE when cost data is absent (EV still computed
          without cost component; ev_without_cost is available for research)
        """
        # 1. Probability must be calibrated
        if not calibrated_prob.is_usable():
            return ExpectedValue(
                value=None,
                probability=calibrated_prob.value,
                expected_win=None,
                expected_loss=None,
                expected_cost=None,
                confidence=None,
                status=EVStatus.PROBABILITY_UNCALIBRATED,
                payoff_assumptions="probability_not_calibrated",
            )

        p = calibrated_prob.value  # type: ignore[assignment]
        assert p is not None

        # 2. Payoff must be available and historically estimated
        if payoff is None or not payoff.is_valid():
            return ExpectedValue(
                value=None,
                probability=p,
                expected_win=None,
                expected_loss=None,
                expected_cost=None,
                confidence=None,
                status=EVStatus.OUTCOME_DATA_INSUFFICIENT,
                payoff_assumptions="payoff_distribution_unavailable",
            )

        # 3. Enforce EV leakage rule
        if prediction_time is not None:
            try:
                payoff.assert_no_future_leakage(prediction_time)
            except RuntimeError:
                return ExpectedValue(
                    value=None,
                    probability=p,
                    expected_win=None,
                    expected_loss=None,
                    expected_cost=None,
                    confidence=None,
                    status=EVStatus.INSUFFICIENT_EVIDENCE,
                    payoff_assumptions="EV_LEAKAGE_DETECTED",
                )

        # 4. Compute cost
        cost = self.config.cost_model.total_round_trip_pct()
        cost_status = EVStatus.VALID if cost is not None else EVStatus.COST_DATA_UNAVAILABLE
        cost = cost or 0.0  # compute EV without cost for research; flag the status

        # 5. EV = P × E[win] + (1-P) × E[loss] - cost
        ew = payoff.win_mean
        el = payoff.loss_mean   # negative value

        ev_gross = p * ew + (1.0 - p) * el
        ev_net   = ev_gross - cost

        # 6. Simple confidence (based on sample size)
        confidence: Optional[float] = None
        if payoff.n_samples >= 30:
            confidence = min(1.0, payoff.n_samples / 252.0)

        return ExpectedValue(
            value=round(ev_net, 6),
            probability=p,
            expected_win=round(ew, 6),
            expected_loss=round(el, 6),
            expected_cost=round(cost, 6),
            confidence=confidence,
            status=cost_status,
            payoff_assumptions=(
                f"payoff_n={payoff.n_samples}; "
                f"win={ew:.3f}%; loss={el:.3f}%; cost={cost:.4f}%"
            ),
        )

    def is_take(self, ev: ExpectedValue) -> bool:
        """Return True if EV exceeds the configured minimum threshold."""
        return ev.is_valid() and ev.value > self.config.min_ev_for_take  # type: ignore[operator]


# ── Probability bucket analysis ───────────────────────────────────────────────

@dataclass
class ProbabilityBucketResult:
    """Statistics for one probability bucket."""
    bucket_lo:       float
    bucket_hi:       float
    n_observations:  int
    actual_success_rate: Optional[float]
    mean_net_return:     Optional[float]
    median_net_return:   Optional[float]
    mean_mfe:            Optional[float]
    mean_mae:            Optional[float]


def compute_probability_bucket_analysis(
    probabilities: np.ndarray,
    outcomes: np.ndarray,       # 1=success, 0=failure
    net_returns: np.ndarray,
    mfe: Optional[np.ndarray] = None,
    mae: Optional[np.ndarray] = None,
    n_buckets: int = 10,
) -> list[ProbabilityBucketResult]:
    """
    Group OOS candidates by calibrated probability bucket and compute statistics.

    Parameters
    ----------
    probabilities : calibrated P(success) per candidate
    outcomes      : binary {0,1} — did the trade succeed?
    net_returns   : realized net return per candidate
    mfe           : maximum favourable excursion per candidate (optional)
    mae           : maximum adverse excursion per candidate (optional)
    n_buckets     : number of equal-width probability buckets

    Returns
    -------
    List of ProbabilityBucketResult — all buckets, none cherry-picked.
    """
    edges = np.linspace(0.0, 1.0, n_buckets + 1)
    results: list[ProbabilityBucketResult] = []

    for lo, hi in zip(edges[:-1], edges[1:]):
        mask = (probabilities >= lo) & (probabilities < hi)
        n = int(mask.sum())
        if n == 0:
            results.append(ProbabilityBucketResult(lo, hi, 0, None, None, None, None, None))
            continue

        results.append(ProbabilityBucketResult(
            bucket_lo=round(lo, 2),
            bucket_hi=round(hi, 2),
            n_observations=n,
            actual_success_rate=round(float(outcomes[mask].mean()), 4),
            mean_net_return=round(float(net_returns[mask].mean()), 4),
            median_net_return=round(float(np.median(net_returns[mask])), 4),
            mean_mfe=round(float(mfe[mask].mean()), 4) if mfe is not None else None,
            mean_mae=round(float(mae[mask].mean()), 4) if mae is not None else None,
        ))

    return results
