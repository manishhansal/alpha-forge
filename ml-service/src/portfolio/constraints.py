"""
Phase 3H — Portfolio Constraint Engine.

Validates a proposed weight vector against the configured ConstraintSet
and computes violation reports.

Design rules
------------
1. Constraints are always evaluated against the PROPOSED weights, not
   against the current holdings.
2. Every violation is documented with which constraint was breached and by
   how much.
3. Relaxation (if configured) is ordered, versioned, and fully reported.
4. INFEASIBLE_CONSTRAINT_SET is returned when constraints are jointly
   infeasible before the optimizer is even called (pre-solve check).
5. No uncontrolled randomness.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

import numpy as np

from .schemas import (
    ConstraintRelaxationPolicy, ConstraintSet, OptimizationStatus,
    PortfolioCandidate, PortfolioMode,
)


# ── Violation record ──────────────────────────────────────────────────────────

@dataclass
class ConstraintViolation:
    """Description of one violated constraint."""
    constraint_name:    str
    limit:              float
    actual:             float
    excess:             float    # actual - limit (positive = violation)
    instrument_id:      Optional[str] = None   # None for portfolio-level constraints
    details:            str = ""


@dataclass
class ConstraintCheckResult:
    """
    Result of checking all constraints for one weight vector.
    feasible == True only when all hard constraints are satisfied.
    """
    feasible:           bool
    violations:         list[ConstraintViolation] = field(default_factory=list)
    status:             OptimizationStatus = OptimizationStatus.OPTIMIZED
    relaxation_applied: list[str] = field(default_factory=list)
    notes:              str = ""


# ── Scipy-compatible constraint builder ───────────────────────────────────────

@dataclass
class OptimizerConstraint:
    """
    A constraint in the form usable by scipy.optimize.minimize.
    type: "eq" (equality) or "ineq" (inequality ≥ 0)
    """
    ctype:  str       # "eq" | "ineq"
    fun:    object    # callable(w) -> float
    label:  str       # human-readable description


# ── Constraint engine ─────────────────────────────────────────────────────────

class ConstraintEngine:
    """
    Builds and evaluates portfolio constraints.

    Usage (constraint check)
    ------------------------
    ::
        engine = ConstraintEngine(constraint_set)
        result = engine.check(weights_dict, candidates, prior_weights_dict)
        if not result.feasible:
            # handle violations

    Usage (optimizer bounds/constraints)
    ------------------------------------
    ::
        bounds = engine.weight_bounds(n_assets, mode)
        constraints = engine.scipy_constraints(
            candidates, prior_weights, portfolio_value_inr
        )
    """

    def __init__(self, constraint_set: ConstraintSet) -> None:
        self.cs = constraint_set

    # ── Pre-solve feasibility check ───────────────────────────────────────────

    def pre_solve_feasibility(
        self,
        candidates: list[PortfolioCandidate],
    ) -> ConstraintCheckResult:
        """
        Check whether the constraint set is jointly feasible given the
        candidate universe, WITHOUT running the optimizer.

        Detects obvious conflicts such as:
        - max_positions < number of sectors exceeding min sector weight
        - max_gross_exposure < min_positions * min_position_weight
        """
        cs = self.cs
        violations = []
        n = len(candidates)

        # max_positions ≥ min_positions
        if n > 0 and cs.max_positions < cs.min_positions:
            violations.append(ConstraintViolation(
                constraint_name="max_positions_vs_min_positions",
                limit=cs.min_positions,
                actual=cs.max_positions,
                excess=cs.min_positions - cs.max_positions,
                details="max_positions < min_positions: infeasible.",
            ))

        # Minimum gross exposure achievable
        if cs.min_positions > 0 and cs.min_position_weight is not None:
            min_achievable_gross = cs.min_positions * cs.min_position_weight
            if cs.max_gross_exposure is not None:
                if min_achievable_gross > cs.max_gross_exposure:
                    violations.append(ConstraintViolation(
                        constraint_name="gross_exposure_vs_min_positions",
                        limit=cs.max_gross_exposure,
                        actual=min_achievable_gross,
                        excess=min_achievable_gross - cs.max_gross_exposure,
                        details=(
                            f"min_positions ({cs.min_positions}) × "
                            f"min_position_weight ({cs.min_position_weight}) "
                            f"= {min_achievable_gross:.3f} > "
                            f"max_gross_exposure ({cs.max_gross_exposure})."
                        ),
                    ))

        # Single-name limit vs gross exposure
        if (cs.max_position_weight is not None and cs.max_gross_exposure is not None
                and cs.min_positions > 0):
            min_n_for_gross = cs.max_gross_exposure / cs.max_position_weight
            if cs.min_positions > min_n_for_gross:
                violations.append(ConstraintViolation(
                    constraint_name="position_weight_vs_gross_exposure",
                    limit=min_n_for_gross,
                    actual=cs.min_positions,
                    excess=cs.min_positions - min_n_for_gross,
                    details=(
                        f"max_gross_exposure ({cs.max_gross_exposure}) / "
                        f"max_position_weight ({cs.max_position_weight}) = "
                        f"{min_n_for_gross:.1f} < min_positions ({cs.min_positions})."
                    ),
                ))

        if violations:
            return ConstraintCheckResult(
                feasible=False,
                violations=violations,
                status=OptimizationStatus.INFEASIBLE_CONSTRAINT_SET,
                notes="Pre-solve feasibility check failed. See violations.",
            )

        return ConstraintCheckResult(feasible=True)

    # ── Weight bounds for scipy.optimize ─────────────────────────────────────

    def weight_bounds(self, n_assets: int) -> list[tuple[float, float]]:
        """
        Return scipy-compatible bounds for each weight.
        Long-only: (min_w, max_w)
        Long-short: (-max_w, max_w) where negative = short
        """
        cs = self.cs
        lo = cs.min_position_weight or 0.0
        hi = cs.max_position_weight or 1.0

        if cs.mode == PortfolioMode.LONG_SHORT:
            return [(-hi, hi)] * n_assets
        return [(lo, hi)] * n_assets

    # ── Scipy constraint list ─────────────────────────────────────────────────

    def scipy_constraints(
        self,
        candidates: list[PortfolioCandidate],
        prior_weights: Optional[dict[str, float]] = None,
        portfolio_value_inr: float = 1_000_000.0,
    ) -> list[dict]:
        """
        Build constraint dicts compatible with scipy.optimize.minimize.

        Each dict has keys: 'type' ('eq' or 'ineq'), 'fun' (callable).
        scipy interprets 'ineq' as fun(w) >= 0.
        """
        cs = self.cs
        n = len(candidates)
        constraints = []

        # ── Gross exposure ≤ max ──────────────────────────────────────────────
        if cs.max_gross_exposure is not None:
            lim = cs.max_gross_exposure
            constraints.append({
                "type": "ineq",
                "fun":  lambda w, _l=lim: _l - np.sum(np.abs(w)),
            })

        # ── Net exposure ≤ max ────────────────────────────────────────────────
        if cs.max_net_exposure is not None:
            lim = cs.max_net_exposure
            constraints.append({
                "type": "ineq",
                "fun":  lambda w, _l=lim: _l - np.sum(w),
            })

        # ── Net exposure ≥ min ────────────────────────────────────────────────
        if cs.min_net_exposure is not None:
            lim = cs.min_net_exposure
            constraints.append({
                "type": "ineq",
                "fun":  lambda w, _l=lim: np.sum(w) - _l,
            })

        # ── Long-only: weights sum ≤ 1 (normalisation for equity portfolios) ─
        if cs.mode == PortfolioMode.LONG_ONLY:
            # Equality: weights must sum to exactly 1 (fully invested)
            constraints.append({
                "type": "eq",
                "fun":  lambda w: np.sum(w) - 1.0,
            })

        # ── Sector constraints ────────────────────────────────────────────────
        if cs.max_sector_weight is not None:
            sectors = list({c.sector for c in candidates if c.sector})
            for sector in sectors:
                idx = [i for i, c in enumerate(candidates) if c.sector == sector]
                lim = cs.max_sector_weight

                def _sector_constraint(w, _idx=idx, _lim=lim):
                    return _lim - sum(abs(w[i]) for i in _idx)

                constraints.append({"type": "ineq", "fun": _sector_constraint})

        # ── Industry constraints ──────────────────────────────────────────────
        if cs.max_industry_weight is not None:
            industries = list({c.industry for c in candidates if c.industry})
            for industry in industries:
                idx = [i for i, c in enumerate(candidates) if c.industry == industry]
                lim = cs.max_industry_weight

                def _industry_constraint(w, _idx=idx, _lim=lim):
                    return _lim - sum(abs(w[i]) for i in _idx)

                constraints.append({"type": "ineq", "fun": _industry_constraint})

        # ── Turnover constraint ───────────────────────────────────────────────
        if cs.max_rebalance_turnover is not None and prior_weights is not None:
            instruments = [c.instrument_id for c in candidates]
            w_prior = np.array([
                prior_weights.get(inst, 0.0) for inst in instruments
            ])
            lim = cs.max_rebalance_turnover

            def _turnover_constraint(w, _wp=w_prior, _lim=lim):
                return _lim - float(np.sum(np.abs(w - _wp)))

            constraints.append({"type": "ineq", "fun": _turnover_constraint})

        return constraints

    # ── Post-optimization violation check ────────────────────────────────────

    def check(
        self,
        weights: dict[str, float],
        candidates: list[PortfolioCandidate],
        prior_weights: Optional[dict[str, float]] = None,
    ) -> ConstraintCheckResult:
        """
        Check a realized weight dictionary against all constraints.
        Returns a ConstraintCheckResult with all violations listed.
        """
        cs = self.cs
        violations: list[ConstraintViolation] = []
        w_arr = np.array([weights.get(c.instrument_id, 0.0) for c in candidates])

        # Single-name limits
        if cs.max_position_weight is not None:
            for i, c in enumerate(candidates):
                if abs(w_arr[i]) > cs.max_position_weight + 1e-8:
                    violations.append(ConstraintViolation(
                        constraint_name="max_position_weight",
                        limit=cs.max_position_weight,
                        actual=abs(w_arr[i]),
                        excess=abs(w_arr[i]) - cs.max_position_weight,
                        instrument_id=c.instrument_id,
                    ))

        if cs.min_position_weight is not None and cs.mode == PortfolioMode.LONG_ONLY:
            for i, c in enumerate(candidates):
                if 0 < abs(w_arr[i]) < cs.min_position_weight - 1e-8:
                    violations.append(ConstraintViolation(
                        constraint_name="min_position_weight",
                        limit=cs.min_position_weight,
                        actual=abs(w_arr[i]),
                        excess=cs.min_position_weight - abs(w_arr[i]),
                        instrument_id=c.instrument_id,
                    ))

        # Gross exposure
        gross = float(np.sum(np.abs(w_arr)))
        if cs.max_gross_exposure is not None and gross > cs.max_gross_exposure + 1e-8:
            violations.append(ConstraintViolation(
                constraint_name="max_gross_exposure",
                limit=cs.max_gross_exposure,
                actual=gross,
                excess=gross - cs.max_gross_exposure,
            ))

        # Net exposure
        net = float(np.sum(w_arr))
        if cs.max_net_exposure is not None and net > cs.max_net_exposure + 1e-8:
            violations.append(ConstraintViolation(
                constraint_name="max_net_exposure",
                limit=cs.max_net_exposure,
                actual=net,
                excess=net - cs.max_net_exposure,
            ))
        if cs.min_net_exposure is not None and net < cs.min_net_exposure - 1e-8:
            violations.append(ConstraintViolation(
                constraint_name="min_net_exposure",
                limit=cs.min_net_exposure,
                actual=net,
                excess=cs.min_net_exposure - net,
            ))

        # Sector limits
        sector_map: dict[str, list[int]] = {}
        for i, c in enumerate(candidates):
            if c.sector:
                sector_map.setdefault(c.sector, []).append(i)
        for sector, idx in sector_map.items():
            sw = sum(abs(w_arr[i]) for i in idx)
            if cs.max_sector_weight is not None and sw > cs.max_sector_weight + 1e-8:
                violations.append(ConstraintViolation(
                    constraint_name="max_sector_weight",
                    limit=cs.max_sector_weight,
                    actual=sw,
                    excess=sw - cs.max_sector_weight,
                    details=f"sector={sector}",
                ))

        # Industry limits
        ind_map: dict[str, list[int]] = {}
        for i, c in enumerate(candidates):
            if c.industry:
                ind_map.setdefault(c.industry, []).append(i)
        for industry, idx in ind_map.items():
            iw = sum(abs(w_arr[i]) for i in idx)
            if cs.max_industry_weight is not None and iw > cs.max_industry_weight + 1e-8:
                violations.append(ConstraintViolation(
                    constraint_name="max_industry_weight",
                    limit=cs.max_industry_weight,
                    actual=iw,
                    excess=iw - cs.max_industry_weight,
                    details=f"industry={industry}",
                ))

        # Position count
        n_pos = sum(1 for w in w_arr if abs(w) > 1e-6)
        if n_pos > cs.max_positions:
            violations.append(ConstraintViolation(
                constraint_name="max_positions",
                limit=cs.max_positions,
                actual=n_pos,
                excess=n_pos - cs.max_positions,
            ))

        # Turnover
        if prior_weights is not None and cs.max_rebalance_turnover is not None:
            instruments = [c.instrument_id for c in candidates]
            w_prior = np.array([prior_weights.get(inst, 0.0) for inst in instruments])
            turnover = float(np.sum(np.abs(w_arr - w_prior)))
            if turnover > cs.max_rebalance_turnover + 1e-8:
                violations.append(ConstraintViolation(
                    constraint_name="max_rebalance_turnover",
                    limit=cs.max_rebalance_turnover,
                    actual=turnover,
                    excess=turnover - cs.max_rebalance_turnover,
                ))

        feasible = len(violations) == 0
        status = (
            OptimizationStatus.OPTIMIZED if feasible
            else OptimizationStatus.INFEASIBLE
        )

        return ConstraintCheckResult(
            feasible=feasible,
            violations=violations,
            status=status,
        )
