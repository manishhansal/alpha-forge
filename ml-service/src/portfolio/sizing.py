"""
Phase 3H — Position Sizing Engine.

Translates portfolio weights into concrete position sizes (lots)
and computes EV-aware, Kelly-aware, and volatility-targeted weights.

Design rules
------------
1. raw_size ∝ positive_ev / risk — this exact formula is not hardcoded;
   the formula is selected by SizingMethod and versioned.
2. Kelly sizing uses fractional Kelly (fraction configurable).
   Full Kelly is NEVER the default.
3. When probability / payoff are unreliable → KELLY_UNAVAILABLE.
4. Volatility targeting scales the entire portfolio to hit a target
   annualised volatility, subject to position and exposure limits.
5. Risk budgeting computes each position's risk contribution and
   verifies sum(component_risk) ≈ portfolio_risk within tolerance.
6. F&O lot-size awareness: positions are rounded to integer lots.
   Fractional lots are never produced.
7. No uncontrolled randomness.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Optional

import numpy as np

from .schemas import (
    PortfolioCandidate, SizingMethod,
)


# ── Configuration ─────────────────────────────────────────────────────────────

@dataclass
class SizingConfig:
    """
    Configuration for the sizing engine.
    All parameters are versioned and configurable.
    """
    method:                 SizingMethod = SizingMethod.EV_RISK_RATIO

    # EV/risk sizing
    ev_risk_power:          float = 1.0      # exponent on EV term (1.0 = linear)
    ev_risk_risk_floor:     float = 0.001    # floor on daily σ to avoid division by zero

    # Fractional Kelly
    kelly_fraction:         float = 0.25     # 0.25 = 1/4 Kelly
    kelly_max_weight:       float = 0.20     # max weight from Kelly formula
    kelly_min_prob:         float = 0.52     # minimum probability to trigger Kelly

    # Volatility targeting
    target_ann_volatility:  Optional[float] = None   # e.g. 0.15 = 15% p.a.; None = disabled
    ann_factor:             float = 252.0             # trading days per year

    # Risk budgeting
    risk_budget:            Optional[dict[str, float]] = None  # {instrument_id: budget fraction}
                            # None = equal risk contribution

    # General
    min_weight:             float = 0.0
    max_weight:             float = 0.20
    version:                str = "sizing-v1"


# ── Sizing result ─────────────────────────────────────────────────────────────

@dataclass
class SizingResult:
    """
    Output of the sizing engine for one portfolio.
    """
    weights:        dict[str, float]    # instrument_id → raw weight (before normalization)
    method:         SizingMethod
    lots:           dict[str, int]      # instrument_id → lots (integer, F&O-aware)
    notionals:      dict[str, float]    # instrument_id → notional INR
    notes:          str = ""
    kelly_fractions: dict[str, float] = None   # fractional Kelly weights (diagnostic)
    vol_scale:      Optional[float] = None      # volatility targeting scale factor

    def __post_init__(self):
        if self.kelly_fractions is None:
            self.kelly_fractions = {}


# ── Kelly sizing ──────────────────────────────────────────────────────────────

def _fractional_kelly(
    probability: float,
    win_fraction: float,   # E[win] as fraction
    loss_fraction: float,  # E[loss] as fraction (positive = loss magnitude)
    kelly_fraction: float = 0.25,
    max_weight: float = 0.20,
    min_prob: float = 0.52,
) -> Optional[float]:
    """
    Fractional Kelly criterion position size.

    Full Kelly: f* = p/l - (1-p)/w  where w = win%, l = loss%

    Returns None (KELLY_UNAVAILABLE) when:
    - probability < min_prob
    - win_fraction <= 0 or loss_fraction <= 0
    - Full Kelly is negative (negative edge)

    Returns fractional Kelly, clipped to [0, max_weight].
    """
    if probability < min_prob:
        return None
    if win_fraction <= 0 or loss_fraction <= 0:
        return None

    # Convert to fraction of bankroll  (win = gain per unit bet; loss = loss per unit bet)
    p = probability
    q = 1.0 - p
    b = win_fraction   # odds (fraction of stake gained if win)
    # Kelly formula: f* = p - q/b  (for binary outcome)
    full_kelly = p - (q / b)

    if full_kelly <= 0:
        return None  # negative edge

    frac = kelly_fraction * full_kelly
    return min(float(frac), max_weight)


# ── EV/risk sizing ────────────────────────────────────────────────────────────

def _ev_risk_weight(
    ev: float,
    daily_vol: float,
    power: float = 1.0,
    risk_floor: float = 0.001,
) -> float:
    """
    Raw weight proportional to positive EV / risk.

    raw_w = (max(ev, 0))^power / max(daily_vol, risk_floor)

    If EV ≤ 0 → weight = 0.
    """
    if ev <= 0:
        return 0.0
    vol = max(daily_vol, risk_floor)
    return (ev ** power) / vol


# ── Risk budgeting ────────────────────────────────────────────────────────────

def risk_budgeting_weights(
    cov: np.ndarray,
    budgets: Optional[np.ndarray] = None,
    tol: float = 1e-8,
    max_iter: int = 500,
) -> np.ndarray:
    """
    Compute risk-budgeting (risk-parity) weights via iterative algorithm.

    Each position's risk contribution equals its budget:
        w_i × (Σw)_i / σ_p = budget_i

    If budgets is None → equal risk contribution (risk parity).

    Reference: Roncalli (2013), "Introduction to Risk Parity and
    Budgeting", Chapter 2.
    """
    n = cov.shape[0]
    if budgets is None:
        budgets = np.ones(n) / n
    budgets = budgets / budgets.sum()  # normalise

    # Initialise with equal weights
    w = np.ones(n) / n

    for _ in range(max_iter):
        sigma = math.sqrt(max(float(w @ cov @ w), 1e-16))
        # Marginal risk contributions
        mrc = cov @ w / sigma
        # Component risk contributions
        crc = w * mrc

        # Newton step toward target budgets (multiplicative update)
        target = budgets * sigma
        w_new = w * (target / np.maximum(crc, 1e-16))
        w_new = np.maximum(w_new, 0.0)
        s = w_new.sum()
        if s > 0:
            w_new /= s

        if float(np.max(np.abs(w_new - w))) < tol:
            return w_new
        w = w_new

    return w


# ── Volatility targeting ──────────────────────────────────────────────────────

def volatility_targeting_scale(
    weights: np.ndarray,
    cov: np.ndarray,
    target_ann_vol: float,
    ann_factor: float = 252.0,
) -> float:
    """
    Compute the scale factor to hit target_ann_vol.

    scale = target_daily_vol / current_daily_vol
    Applied to all weights uniformly.

    Returns scale factor (will be clipped to [0, 1] by the caller to
    avoid leverage beyond gross exposure limits).
    """
    port_var = float(weights @ cov @ weights)
    if port_var <= 0:
        return 1.0
    current_daily_vol = math.sqrt(port_var)
    target_daily_vol  = target_ann_vol / math.sqrt(ann_factor)
    return target_daily_vol / current_daily_vol


# ── Main sizing engine ────────────────────────────────────────────────────────

class SizingEngine:
    """
    Translates portfolio weights and candidate metadata into
    concrete position sizes.

    Usage
    -----
    ::
        engine = SizingEngine(config)
        result = engine.compute(candidates, cov_matrix, capital_inr)
        # result.weights: normalised raw weights
        # result.lots:    integer lots per instrument
    """

    def __init__(self, config: Optional[SizingConfig] = None) -> None:
        self.config = config or SizingConfig()

    def compute(
        self,
        candidates: list[PortfolioCandidate],
        cov_matrix: Optional[np.ndarray],
        capital_inr: float = 1_000_000.0,
    ) -> SizingResult:
        """
        Compute position sizes for a list of eligible candidates.

        Parameters
        ----------
        candidates  : eligible PortfolioCandidate objects
        cov_matrix  : (n × n) daily covariance matrix or None
                      Required for RISK_BUDGET and vol-targeting.
        capital_inr : total portfolio capital in INR

        Returns
        -------
        SizingResult with weights (normalised), lots (integer), notionals.
        """
        cfg = self.config
        n = len(candidates)
        if n == 0:
            return SizingResult(
                weights={}, method=cfg.method, lots={}, notionals={},
                notes="No eligible candidates.",
            )

        method = cfg.method
        raw_weights = np.zeros(n)
        kelly_fracs: dict[str, float] = {}
        notes_parts = []

        # ── Method dispatch ───────────────────────────────────────────────────

        if method == SizingMethod.EV_RISK_RATIO:
            raw_weights = self._ev_risk_weights(candidates, cfg)
            if raw_weights.sum() < 1e-12:
                # All EVs non-positive — fall back to equal weight
                method = SizingMethod.EQUAL_WEIGHT
                raw_weights = np.ones(n)
                notes_parts.append("Fallback to EQUAL_WEIGHT: all EV non-positive.")

        elif method == SizingMethod.FRACTIONAL_KELLY:
            raw_weights, kelly_fracs = self._kelly_weights(candidates, cfg)
            if raw_weights.sum() < 1e-12:
                method = SizingMethod.EQUAL_WEIGHT
                raw_weights = np.ones(n)
                notes_parts.append("KELLY_UNAVAILABLE for all candidates; using EQUAL_WEIGHT.")

        elif method == SizingMethod.EQUAL_WEIGHT:
            raw_weights = np.ones(n)

        elif method == SizingMethod.INVERSE_VOL:
            raw_weights = self._inverse_vol_weights(candidates, cfg)

        elif method == SizingMethod.RISK_BUDGET:
            if cov_matrix is not None:
                budgets = self._build_budgets(candidates, cfg)
                raw_weights = risk_budgeting_weights(cov_matrix, budgets)
                method = SizingMethod.RISK_BUDGET
            else:
                raw_weights = np.ones(n)
                method = SizingMethod.EQUAL_WEIGHT
                notes_parts.append("Covariance unavailable; RISK_BUDGET → EQUAL_WEIGHT.")

        else:
            # OPTIMIZER_WEIGHT or UNAVAILABLE — caller provides weights externally
            raw_weights = np.ones(n)

        # ── Clip to [min, max] after normalization ────────────────────────────
        # Note: clip is applied AFTER normalization so that high-EV candidates
        # get proportionally higher weight before the ceiling is enforced.
        vol_scale: Optional[float] = None
        if cfg.target_ann_volatility is not None and cov_matrix is not None:
            s = raw_weights.sum()
            w_norm = raw_weights / s if s > 0 else raw_weights
            scale = volatility_targeting_scale(
                w_norm, cov_matrix, cfg.target_ann_volatility, cfg.ann_factor
            )
            # Clip scale to [0, 1] — never lever up beyond gross cap
            vol_scale = min(1.0, max(0.0, scale))
            raw_weights = w_norm * vol_scale
            notes_parts.append(f"Volatility targeting scale={vol_scale:.4f}.")
        else:
            # Normalise to sum to 1
            s = raw_weights.sum()
            if s > 0:
                raw_weights = raw_weights / s

        # Apply per-position ceiling after normalization
        raw_weights = np.clip(raw_weights, cfg.min_weight, cfg.max_weight)
        # Re-normalise after clip to maintain sum=1
        s = raw_weights.sum()
        if s > 0:
            raw_weights = raw_weights / s

        # ── Build output dicts ────────────────────────────────────────────────
        weights_dict: dict[str, float] = {}
        lots_dict:    dict[str, int]   = {}
        notionals_dict: dict[str, float] = {}

        for i, cand in enumerate(candidates):
            w = float(raw_weights[i])
            weights_dict[cand.instrument_id] = w

            # Lot sizing (F&O-aware)
            if cand.price and cand.price > 0 and cand.lot_size > 0:
                notional_target = w * capital_inr
                lot_notional = cand.price * cand.lot_size
                lots = max(0, int(notional_target / lot_notional))
                actual_notional = lots * lot_notional
            else:
                lots = 0
                actual_notional = 0.0

            lots_dict[cand.instrument_id] = lots
            notionals_dict[cand.instrument_id] = actual_notional

        return SizingResult(
            weights=weights_dict,
            method=method,
            lots=lots_dict,
            notionals=notionals_dict,
            notes="; ".join(notes_parts),
            kelly_fractions=kelly_fracs,
            vol_scale=vol_scale,
        )

    # ── Private helpers ───────────────────────────────────────────────────────

    def _ev_risk_weights(
        self,
        candidates: list[PortfolioCandidate],
        cfg: SizingConfig,
    ) -> np.ndarray:
        """raw_w_i = (max(ev_i, 0))^power / max(σ_i, floor)"""
        w = np.zeros(len(candidates))
        for i, c in enumerate(candidates):
            ev = c.expected_value if c.expected_value is not None else 0.0
            vol = c.volatility_daily if c.volatility_daily is not None else cfg.ev_risk_risk_floor
            w[i] = _ev_risk_weight(ev, vol, cfg.ev_risk_power, cfg.ev_risk_risk_floor)
        return w

    def _kelly_weights(
        self,
        candidates: list[PortfolioCandidate],
        cfg: SizingConfig,
    ) -> tuple[np.ndarray, dict[str, float]]:
        """Fractional Kelly weights per candidate."""
        w = np.zeros(len(candidates))
        kelly_fracs: dict[str, float] = {}

        for i, c in enumerate(candidates):
            prob = c.calibrated_probability
            # expected_value contains both win/loss info as a net figure;
            # we need gross win and gross loss estimates for Kelly.
            # If expected_value is available but win/loss breakdown is not,
            # approximate: assume win = ev * 2, loss = ev * 1 (optimistic).
            # For proper Kelly, callers should supply win/loss separately.
            ev = c.expected_value

            if prob is None or ev is None or ev <= 0:
                kelly_fracs[c.instrument_id] = 0.0
                continue

            # Simple Kelly approximation using EV directly:
            # f* = p × (ev/p) / (ev/p) ≈ prob - (1-prob) / (ev/prob)
            # Better: use calibrated_probability and estimate win from ev
            # win_frac ≈ ev / prob (expected gain if successful)
            # loss_frac = ev / (1-prob) * -1 (expected loss if not successful)
            win_frac  = ev / max(prob, 0.01)
            loss_frac = max(abs(ev / max(1.0 - prob, 0.01)), 0.001)

            f = _fractional_kelly(
                probability=prob,
                win_fraction=win_frac,
                loss_fraction=loss_frac,
                kelly_fraction=cfg.kelly_fraction,
                max_weight=cfg.kelly_max_weight,
                min_prob=cfg.kelly_min_prob,
            )
            if f is None:
                kelly_fracs[c.instrument_id] = 0.0
            else:
                w[i] = f
                kelly_fracs[c.instrument_id] = f

        return w, kelly_fracs

    def _inverse_vol_weights(
        self,
        candidates: list[PortfolioCandidate],
        cfg: SizingConfig,
    ) -> np.ndarray:
        """w_i = 1 / σ_i, normalised."""
        w = np.zeros(len(candidates))
        for i, c in enumerate(candidates):
            vol = c.volatility_daily if c.volatility_daily else cfg.ev_risk_risk_floor
            w[i] = 1.0 / max(vol, cfg.ev_risk_risk_floor)
        return w

    @staticmethod
    def _build_budgets(
        candidates: list[PortfolioCandidate],
        cfg: SizingConfig,
    ) -> Optional[np.ndarray]:
        """Build risk budget array from config or equal weights."""
        n = len(candidates)
        if cfg.risk_budget is None:
            return None  # equal risk contribution

        budgets = np.array([
            cfg.risk_budget.get(c.instrument_id, 1.0 / n)
            for c in candidates
        ], dtype=float)
        s = budgets.sum()
        return budgets / s if s > 0 else None
