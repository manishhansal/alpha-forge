"""
Phase 3H — Portfolio Optimizer.

Implements deterministic portfolio construction for six objectives
plus HRP and three baselines.

Objectives
----------
MIN_VARIANCE        — global minimum-variance portfolio (SLSQP)
MAX_SHARPE          — maximum Sharpe ratio (SLSQP, requires expected returns)
MAX_DIVERSIFICATION — maximum diversification ratio (SLSQP, requires volatilities)
CVaR_MINIMIZATION   — minimise historical CVaR (SLSQP, requires returns matrix)
RISK_BUDGETING      — equal/custom risk contribution (iterative)
EV_RISK_OPTIMIZATION — maximise sum(EV_i * w_i) / portfolio_volatility (SLSQP)
HRP                 — Hierarchical Risk Parity (scipy clustering, no solver)
EQUAL_WEIGHT        — 1/N baseline
INVERSE_VOL         — 1/σ_i baseline
RANK_WEIGHTED       — top-N rank-weighted baseline

Design invariants
-----------------
1. No uncontrolled randomness — np.random.* forbidden.
2. NEVER silently fall back to equal weights without setting
   status = FEASIBLE_FALLBACK and fallback_reason.
3. rank_score is NEVER used as an expected return.
4. All objectives return explicit OptimizationStatus.
5. Constraints are passed to the solver — violations are checked
   post-solve and documented.
6. PIT: the covariance matrix and returns must come from data that
   ends before formation_time (enforced by RiskModel.estimate).
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime
from typing import Optional

import numpy as np
from scipy.cluster.hierarchy import linkage, leaves_list
from scipy.optimize import minimize
from scipy.spatial.distance import squareform

from .constraints import ConstraintEngine
from .risk_model import RiskModel
from .schemas import (
    ComponentRisk, ConstraintSet, CovarianceResult, CovarianceStatus,
    ExposureSummary, OptimizationStatus, PortfolioCandidate, PortfolioMode,
    PortfolioObjective, PortfolioTarget, SizingMethod,
)
from .sizing import SizingConfig, SizingEngine, risk_budgeting_weights


# ── Optimizer configuration ───────────────────────────────────────────────────

@dataclass
class OptimizerConfig:
    """
    Configuration for one portfolio optimizer run.
    All parameters are versioned.
    """
    objective:              PortfolioObjective = PortfolioObjective.MIN_VARIANCE
    objective_version:      str  = "objective-v1"
    mode:                   PortfolioMode = PortfolioMode.LONG_ONLY

    # Solver
    solver:                 str  = "SLSQP"    # scipy solver
    solver_tol:             float = 1e-10
    solver_maxiter:         int  = 1000

    # CVaR
    cvar_alpha:             float = 0.05      # tail probability for CVaR

    # Sharpe / EV-risk
    risk_free_rate_daily:   float = 0.07 / 252  # 7% p.a. — RBI repo rate (configurable)

    # EV/risk objective
    ev_risk_power:          float = 1.0

    # HRP
    hrp_linkage_method:     str  = "single"
    hrp_codependence:       str  = "pearson"  # "pearson" | "spearman"

    # Fallback objective (used when primary is infeasible/no data)
    fallback_objective:     PortfolioObjective = PortfolioObjective.EQUAL_WEIGHT

    # Diversification ratio floor (warn if below this)
    min_diversification_ratio: float = 1.0

    version:                str  = "optimizer-v1"


# ── HRP implementation ────────────────────────────────────────────────────────

def _hrp_weights(
    corr: np.ndarray,
    vols: np.ndarray,
    linkage_method: str = "single",
) -> np.ndarray:
    """
    Hierarchical Risk Parity allocation.

    Uses actual historical covariance/correlation — no synthetic data.

    Algorithm
    ---------
    1. Distance matrix from correlation: d = sqrt(0.5 * (1 - corr))
    2. Single-linkage hierarchical clustering
    3. Quasi-diagonalisation (sort by cluster leaf order)
    4. Recursive bisection: allocate between sub-clusters proportionally
       to inverse variance

    Reference: Lopez de Prado (2016), "Building Diversified Portfolios
    that Outperform Out-of-Sample", Journal of Portfolio Management.
    """
    n = len(vols)
    if n == 1:
        return np.array([1.0])

    # 1. Distance matrix
    dist = np.sqrt(np.clip(0.5 * (1.0 - corr), 0.0, None))
    np.fill_diagonal(dist, 0.0)
    condensed = squareform(dist, checks=False)

    # 2. Linkage
    link = linkage(condensed, method=linkage_method)

    # 3. Leaf ordering (quasi-diagonalisation)
    sort_ix = leaves_list(link).tolist()

    # 4. Recursive bisection on ordered clusters
    variances = vols ** 2
    weights = np.ones(n)
    cluster_items = [sort_ix]

    while cluster_items:
        new_clusters = []
        for cluster in cluster_items:
            if len(cluster) <= 1:
                continue
            mid = len(cluster) // 2
            left  = cluster[:mid]
            right = cluster[mid:]

            # Variance of each sub-cluster (inverse-variance weighted)
            var_left  = float(np.sum(variances[left]))
            var_right = float(np.sum(variances[right]))
            total_var = var_left + var_right

            alpha = 1.0 - var_left / total_var if total_var > 1e-12 else 0.5

            for i in left:
                weights[i] *= alpha
            for i in right:
                weights[i] *= (1.0 - alpha)

            if len(left) > 1:
                new_clusters.append(left)
            if len(right) > 1:
                new_clusters.append(right)

        cluster_items = new_clusters

    total = weights.sum()
    return weights / total if total > 1e-12 else np.ones(n) / n


# ── Objective functions ───────────────────────────────────────────────────────

def _min_variance_obj(w: np.ndarray, cov: np.ndarray) -> float:
    return float(w @ cov @ w)

def _neg_sharpe_obj(
    w: np.ndarray,
    cov: np.ndarray,
    mu: np.ndarray,
    rf: float,
) -> float:
    port_ret = float(w @ mu)
    port_vol = math.sqrt(max(float(w @ cov @ w), 1e-16))
    return -(port_ret - rf) / port_vol

def _neg_diversification_ratio_obj(
    w: np.ndarray,
    cov: np.ndarray,
    vols: np.ndarray,
) -> float:
    weighted_vols = float(w @ vols)
    port_vol = math.sqrt(max(float(w @ cov @ w), 1e-16))
    return -weighted_vols / port_vol

def _cvar_obj(w: np.ndarray, returns: np.ndarray, alpha: float) -> float:
    port_r = returns @ w
    k = max(1, int(math.floor(alpha * len(port_r))))
    sorted_r = np.sort(port_r)
    return float(-np.mean(sorted_r[:k]))  # return as positive loss (minimise)

def _neg_ev_risk_obj(
    w: np.ndarray,
    cov: np.ndarray,
    ev_vector: np.ndarray,
    power: float,
) -> float:
    ev_total = float(w @ (np.abs(ev_vector) ** power))
    port_vol = math.sqrt(max(float(w @ cov @ w), 1e-16))
    return -(ev_total / port_vol)


# ── Main optimizer ────────────────────────────────────────────────────────────

class PortfolioOptimizer:
    """
    Deterministic portfolio optimizer.

    Usage
    -----
    ::
        opt = PortfolioOptimizer(config)
        target = opt.optimize(
            candidates=eligible_candidates,
            cov_result=risk_model.estimate(returns, formation_time),
            constraint_set=cs,
            formation_time=ts,
            returns=returns_matrix,   # optional; needed for CVaR
            capital_inr=1_000_000.0,
        )
    """

    def __init__(self, config: Optional[OptimizerConfig] = None) -> None:
        self.config = config or OptimizerConfig()

    def optimize(
        self,
        candidates: list[PortfolioCandidate],
        cov_result: CovarianceResult,
        constraint_set: ConstraintSet,
        formation_time: datetime,
        returns: Optional[np.ndarray] = None,    # (T × n) daily returns matrix, PIT
        capital_inr: float = 1_000_000.0,
    ) -> PortfolioTarget:
        """
        Run portfolio optimization.

        Parameters
        ----------
        candidates      : eligible candidates (already filtered by EligibilityFilter)
        cov_result      : CovarianceResult from RiskModel.estimate()
        constraint_set  : ConstraintSet with all limits
        formation_time  : portfolio formation timestamp (PIT gate)
        returns         : (T × n) returns matrix for CVaR; columns must align
                          with cov_result.instruments
        capital_inr     : total portfolio capital

        Returns
        -------
        PortfolioTarget with weights, status, exposure diagnostics.
        """
        cfg = self.config
        obj = cfg.objective
        n = len(candidates)

        # ── Sanity checks ─────────────────────────────────────────────────────
        if n == 0:
            return self._no_candidates_target(formation_time, constraint_set, obj)

        # ── Pre-solve feasibility check ───────────────────────────────────────
        constraint_engine = ConstraintEngine(constraint_set)
        pre_check = constraint_engine.pre_solve_feasibility(candidates)
        if not pre_check.feasible:
            return PortfolioTarget(
                formation_time=formation_time,
                instruments=[c.instrument_id for c in candidates],
                weights={},
                objective=obj,
                objective_version=cfg.objective_version,
                status=OptimizationStatus.INFEASIBLE_CONSTRAINT_SET,
                notes=pre_check.notes,
            )

        # ── Covariance availability check ─────────────────────────────────────
        need_cov = obj in (
            PortfolioObjective.MIN_VARIANCE,
            PortfolioObjective.MAX_SHARPE,
            PortfolioObjective.MAX_DIVERSIFICATION,
            PortfolioObjective.CVaR_MINIMIZATION,
            PortfolioObjective.RISK_BUDGETING,
            PortfolioObjective.EV_RISK_OPTIMIZATION,
            PortfolioObjective.HRP,
        )
        if need_cov and not cov_result.is_usable:
            return self._covariance_unavailable_target(
                candidates, formation_time, constraint_set, obj, cov_result
            )

        # ── Align covariance to candidates ────────────────────────────────────
        if cov_result.is_usable and cov_result.cov_matrix is not None:
            cov, vols = self._align_covariance(candidates, cov_result)
        else:
            cov, vols = None, None

        # ── Dispatch to objective ─────────────────────────────────────────────
        try:
            weights, status, fallback_reason, fallback_method = self._dispatch(
                obj, candidates, cov, vols, returns,
                constraint_engine, capital_inr
            )
        except Exception as exc:
            return PortfolioTarget(
                formation_time=formation_time,
                instruments=[c.instrument_id for c in candidates],
                weights={},
                objective=obj,
                objective_version=cfg.objective_version,
                status=OptimizationStatus.SOLVER_ERROR,
                notes=f"Solver error: {exc}",
            )

        # ── Post-solve constraint check ───────────────────────────────────────
        post_check = constraint_engine.check(weights, candidates)
        if not post_check.feasible and status == OptimizationStatus.OPTIMIZED:
            status = OptimizationStatus.INFEASIBLE
            fallback_reason = (
                "Solver returned infeasible solution. Violations: "
                + "; ".join(
                    f"{v.constraint_name}({v.excess:.4f})"
                    for v in post_check.violations
                )
            )

        # ── Compute exposure and component risk ───────────────────────────────
        instruments = [c.instrument_id for c in candidates]
        w_arr = np.array([weights.get(inst, 0.0) for inst in instruments])
        exposure = self._exposure_summary(w_arr, candidates, cov, vols)
        comp_risks = []
        if cov is not None:
            comp_risks = self._component_risk_list(w_arr, cov, instruments)

        return PortfolioTarget(
            formation_time=formation_time,
            instruments=instruments,
            weights=weights,
            objective=obj,
            objective_version=cfg.objective_version,
            status=status,
            fallback_reason=fallback_reason,
            fallback_method=fallback_method,
            total_capital_inr=capital_inr,
            risk_model_version=cfg.version,
            covariance_method=cov_result.method,
            covariance_status=cov_result.status,
            constraint_set_version=constraint_set.version,
            exposure=exposure,
            component_risks=comp_risks,
        )

    # ── Dispatch ──────────────────────────────────────────────────────────────

    def _dispatch(
        self,
        obj: PortfolioObjective,
        candidates: list[PortfolioCandidate],
        cov: Optional[np.ndarray],
        vols: Optional[np.ndarray],
        returns: Optional[np.ndarray],
        constraint_engine: ConstraintEngine,
        capital_inr: float,
    ) -> tuple[dict[str, float], OptimizationStatus, str, Optional[PortfolioObjective]]:
        """Returns (weights_dict, status, fallback_reason, fallback_method)."""

        cfg = self.config
        n = len(candidates)
        instruments = [c.instrument_id for c in candidates]
        bounds = constraint_engine.weight_bounds(n)
        constraints = constraint_engine.scipy_constraints(candidates)

        # ── Equal weight baseline ─────────────────────────────────────────────
        if obj == PortfolioObjective.EQUAL_WEIGHT:
            w = np.ones(n) / n
            return self._to_dict(w, instruments), OptimizationStatus.OPTIMIZED, "", None

        # ── Inverse-vol baseline ──────────────────────────────────────────────
        if obj == PortfolioObjective.INVERSE_VOL:
            if vols is None or np.all(vols == 0):
                w = np.ones(n) / n
                return (self._to_dict(w, instruments),
                        OptimizationStatus.FEASIBLE_FALLBACK,
                        "Volatilities unavailable; used equal weight.", None)
            w = 1.0 / np.maximum(vols, 1e-8)
            w /= w.sum()
            return self._to_dict(w, instruments), OptimizationStatus.OPTIMIZED, "", None

        # ── Rank-weighted baseline ────────────────────────────────────────────
        if obj == PortfolioObjective.RANK_WEIGHTED:
            # rank_score → weight proportional to percentile
            # This is the BASELINE only — rank_score is NOT treated as expected return
            scores = np.array([
                c.rank_percentile if c.rank_percentile is not None else 50.0
                for c in candidates
            ])
            scores = np.maximum(scores, 0.0)
            s = scores.sum()
            w = scores / s if s > 1e-12 else np.ones(n) / n
            return self._to_dict(w, instruments), OptimizationStatus.OPTIMIZED, "", None

        # ── HRP ───────────────────────────────────────────────────────────────
        if obj == PortfolioObjective.HRP:
            if cov is None or vols is None:
                w = np.ones(n) / n
                return (self._to_dict(w, instruments),
                        OptimizationStatus.FEASIBLE_FALLBACK,
                        "Covariance unavailable; HRP fell back to equal weight.",
                        PortfolioObjective.EQUAL_WEIGHT)
            corr = cov / np.outer(np.maximum(vols, 1e-12), np.maximum(vols, 1e-12))
            corr = np.clip(corr, -1.0, 1.0)
            np.fill_diagonal(corr, 1.0)
            w = _hrp_weights(corr, vols, cfg.hrp_linkage_method)
            return self._to_dict(w, instruments), OptimizationStatus.OPTIMIZED, "", None

        # ── Risk budgeting ────────────────────────────────────────────────────
        if obj == PortfolioObjective.RISK_BUDGETING:
            if cov is None:
                w = np.ones(n) / n
                return (self._to_dict(w, instruments),
                        OptimizationStatus.FEASIBLE_FALLBACK,
                        "Covariance unavailable; RISK_BUDGETING fell back to equal weight.",
                        PortfolioObjective.EQUAL_WEIGHT)
            w = risk_budgeting_weights(cov)
            return self._to_dict(w, instruments), OptimizationStatus.OPTIMIZED, "", None

        # ── MIN_VARIANCE ──────────────────────────────────────────────────────
        if obj == PortfolioObjective.MIN_VARIANCE:
            w0 = np.ones(n) / n
            result = minimize(
                fun=_min_variance_obj,
                x0=w0,
                args=(cov,),
                method="SLSQP",
                bounds=bounds,
                constraints=constraints,
                options={"ftol": cfg.solver_tol, "maxiter": cfg.solver_maxiter},
            )
            if result.success:
                w = np.maximum(result.x, 0.0)
                w /= w.sum() if w.sum() > 0 else 1.0
                return self._to_dict(w, instruments), OptimizationStatus.OPTIMIZED, "", None
            else:
                w = np.ones(n) / n
                return (self._to_dict(w, instruments),
                        OptimizationStatus.FEASIBLE_FALLBACK,
                        f"SLSQP did not converge: {result.message}",
                        PortfolioObjective.EQUAL_WEIGHT)

        # ── MAX_SHARPE ────────────────────────────────────────────────────────
        if obj == PortfolioObjective.MAX_SHARPE:
            mu = np.array([
                c.expected_return if c.expected_return is not None else 0.0
                for c in candidates
            ])
            if np.all(mu == 0):
                w0 = np.ones(n) / n
                result = minimize(
                    fun=_min_variance_obj,
                    x0=w0, args=(cov,), method="SLSQP",
                    bounds=bounds, constraints=constraints,
                    options={"ftol": cfg.solver_tol, "maxiter": cfg.solver_maxiter},
                )
                w = np.maximum(result.x, 0.0) if result.success else np.ones(n) / n
                s = w.sum()
                w /= s if s > 0 else 1.0
                return (self._to_dict(w, instruments),
                        OptimizationStatus.FEASIBLE_FALLBACK,
                        "No expected returns available; used MIN_VARIANCE.",
                        PortfolioObjective.MIN_VARIANCE)

            w0 = np.ones(n) / n
            result = minimize(
                fun=_neg_sharpe_obj,
                x0=w0,
                args=(cov, mu, cfg.risk_free_rate_daily),
                method="SLSQP",
                bounds=bounds,
                constraints=constraints,
                options={"ftol": cfg.solver_tol, "maxiter": cfg.solver_maxiter},
            )
            if result.success:
                w = np.maximum(result.x, 0.0)
                w /= w.sum() if w.sum() > 0 else 1.0
                return self._to_dict(w, instruments), OptimizationStatus.OPTIMIZED, "", None
            else:
                w = np.ones(n) / n
                return (self._to_dict(w, instruments),
                        OptimizationStatus.FEASIBLE_FALLBACK,
                        f"MAX_SHARPE solver failed: {result.message}",
                        PortfolioObjective.EQUAL_WEIGHT)

        # ── MAX_DIVERSIFICATION ───────────────────────────────────────────────
        if obj == PortfolioObjective.MAX_DIVERSIFICATION:
            if vols is None:
                w = np.ones(n) / n
                return (self._to_dict(w, instruments),
                        OptimizationStatus.FEASIBLE_FALLBACK,
                        "Volatilities unavailable; MAX_DIVERSIFICATION fell back.",
                        PortfolioObjective.EQUAL_WEIGHT)
            w0 = np.ones(n) / n
            result = minimize(
                fun=_neg_diversification_ratio_obj,
                x0=w0,
                args=(cov, vols),
                method="SLSQP",
                bounds=bounds,
                constraints=constraints,
                options={"ftol": cfg.solver_tol, "maxiter": cfg.solver_maxiter},
            )
            if result.success:
                w = np.maximum(result.x, 0.0)
                w /= w.sum() if w.sum() > 0 else 1.0
                return self._to_dict(w, instruments), OptimizationStatus.OPTIMIZED, "", None
            else:
                w = np.ones(n) / n
                return (self._to_dict(w, instruments),
                        OptimizationStatus.FEASIBLE_FALLBACK,
                        f"MAX_DIVERSIFICATION solver failed: {result.message}",
                        PortfolioObjective.EQUAL_WEIGHT)

        # ── CVaR MINIMIZATION ─────────────────────────────────────────────────
        if obj == PortfolioObjective.CVaR_MINIMIZATION:
            if returns is None:
                # Fall back to MIN_VARIANCE
                w0 = np.ones(n) / n
                result = minimize(
                    fun=_min_variance_obj, x0=w0, args=(cov,),
                    method="SLSQP", bounds=bounds, constraints=constraints,
                    options={"ftol": cfg.solver_tol, "maxiter": cfg.solver_maxiter},
                )
                w = np.maximum(result.x, 0.0) if result.success else np.ones(n) / n
                s = w.sum(); w /= s if s > 0 else 1.0
                return (self._to_dict(w, instruments),
                        OptimizationStatus.FEASIBLE_FALLBACK,
                        "Returns unavailable for CVaR; used MIN_VARIANCE.",
                        PortfolioObjective.MIN_VARIANCE)

            w0 = np.ones(n) / n
            result = minimize(
                fun=_cvar_obj,
                x0=w0,
                args=(returns, cfg.cvar_alpha),
                method="SLSQP",
                bounds=bounds,
                constraints=constraints,
                options={"ftol": cfg.solver_tol, "maxiter": cfg.solver_maxiter},
            )
            if result.success:
                w = np.maximum(result.x, 0.0)
                w /= w.sum() if w.sum() > 0 else 1.0
                return self._to_dict(w, instruments), OptimizationStatus.OPTIMIZED, "", None
            else:
                w = np.ones(n) / n
                return (self._to_dict(w, instruments),
                        OptimizationStatus.FEASIBLE_FALLBACK,
                        f"CVaR solver failed: {result.message}",
                        PortfolioObjective.EQUAL_WEIGHT)

        # ── EV_RISK_OPTIMIZATION ──────────────────────────────────────────────
        if obj == PortfolioObjective.EV_RISK_OPTIMIZATION:
            ev_vec = np.array([
                c.expected_value if c.expected_value is not None else 0.0
                for c in candidates
            ])
            if np.all(ev_vec <= 0) or cov is None:
                w = np.ones(n) / n
                return (self._to_dict(w, instruments),
                        OptimizationStatus.FEASIBLE_FALLBACK,
                        "No positive EV or covariance unavailable; equal weight.",
                        PortfolioObjective.EQUAL_WEIGHT)

            w0 = np.ones(n) / n
            result = minimize(
                fun=_neg_ev_risk_obj,
                x0=w0,
                args=(cov, ev_vec, cfg.ev_risk_power),
                method="SLSQP",
                bounds=bounds,
                constraints=constraints,
                options={"ftol": cfg.solver_tol, "maxiter": cfg.solver_maxiter},
            )
            if result.success:
                w = np.maximum(result.x, 0.0)
                w /= w.sum() if w.sum() > 0 else 1.0
                return self._to_dict(w, instruments), OptimizationStatus.OPTIMIZED, "", None
            else:
                w = np.ones(n) / n
                return (self._to_dict(w, instruments),
                        OptimizationStatus.FEASIBLE_FALLBACK,
                        f"EV_RISK solver failed: {result.message}",
                        PortfolioObjective.EQUAL_WEIGHT)

        # Unrecognised objective
        w = np.ones(n) / n
        return (self._to_dict(w, instruments),
                OptimizationStatus.FEASIBLE_FALLBACK,
                f"Unrecognised objective {obj}; used equal weight.",
                PortfolioObjective.EQUAL_WEIGHT)

    # ── Helpers ───────────────────────────────────────────────────────────────

    def _align_covariance(
        self,
        candidates: list[PortfolioCandidate],
        cov_result: CovarianceResult,
    ) -> tuple[np.ndarray, np.ndarray]:
        """
        Align cov_result to the candidate order.
        Candidates not in the covariance matrix get a diagonal entry
        equal to the average variance (best available estimate).
        """
        inst_to_idx = {inst: i for i, inst in enumerate(cov_result.instruments)}
        n = len(candidates)
        cov_full = np.array(cov_result.cov_matrix)
        vols_full = np.array(cov_result.volatilities)

        if all(c.instrument_id in inst_to_idx for c in candidates):
            # All candidates are in the covariance matrix — standard path
            idx = [inst_to_idx[c.instrument_id] for c in candidates]
            cov = cov_full[np.ix_(idx, idx)]
            vols = vols_full[idx]
            return cov, vols

        # Some candidates are missing — fill with average variance
        avg_var = float(np.mean(np.diag(cov_full)))
        avg_vol = float(math.sqrt(avg_var))
        cov_out = np.zeros((n, n))
        vols_out = np.zeros(n)

        for i, c in enumerate(candidates):
            if c.instrument_id in inst_to_idx:
                j = inst_to_idx[c.instrument_id]
                vols_out[i] = vols_full[j]
                for k, c2 in enumerate(candidates):
                    if c2.instrument_id in inst_to_idx:
                        j2 = inst_to_idx[c2.instrument_id]
                        cov_out[i, k] = cov_full[j, j2]
                    else:
                        cov_out[i, k] = 0.0
            else:
                # Use candidate's own volatility if available
                v = c.volatility_daily if c.volatility_daily else avg_vol
                vols_out[i] = v
                cov_out[i, i] = v ** 2

        return cov_out, vols_out

    @staticmethod
    def _to_dict(w: np.ndarray, instruments: list[str]) -> dict[str, float]:
        return {inst: float(w[i]) for i, inst in enumerate(instruments)}

    def _no_candidates_target(
        self,
        formation_time: datetime,
        constraint_set: ConstraintSet,
        obj: PortfolioObjective,
    ) -> PortfolioTarget:
        return PortfolioTarget(
            formation_time=formation_time,
            instruments=[],
            weights={},
            objective=obj,
            objective_version=self.config.objective_version,
            status=OptimizationStatus.NO_ELIGIBLE_CANDIDATES,
            notes="No eligible candidates after eligibility filter.",
        )

    def _covariance_unavailable_target(
        self,
        candidates: list[PortfolioCandidate],
        formation_time: datetime,
        constraint_set: ConstraintSet,
        obj: PortfolioObjective,
        cov_result: CovarianceResult,
    ) -> PortfolioTarget:
        return PortfolioTarget(
            formation_time=formation_time,
            instruments=[c.instrument_id for c in candidates],
            weights={},
            objective=obj,
            objective_version=self.config.objective_version,
            status=OptimizationStatus.COVARIANCE_UNAVAILABLE,
            covariance_method=cov_result.method,
            covariance_status=cov_result.status,
            notes=(
                f"Covariance unavailable (status={cov_result.status.value}): "
                f"{cov_result.notes}"
            ),
        )

    @staticmethod
    def _exposure_summary(
        w: np.ndarray,
        candidates: list[PortfolioCandidate],
        cov: Optional[np.ndarray],
        vols: Optional[np.ndarray],
    ) -> ExposureSummary:
        """Compute exposure diagnostics from weights and candidate metadata."""
        long_w  = float(np.sum(w[w > 0]))
        short_w = float(np.sum(w[w < 0]))
        gross   = long_w + abs(short_w)
        net     = long_w + short_w

        # Sector weights
        sec_w: dict[str, float] = {}
        ind_w: dict[str, float] = {}
        for i, c in enumerate(candidates):
            wi = abs(float(w[i]))
            if c.sector:
                sec_w[c.sector] = sec_w.get(c.sector, 0.0) + wi
            if c.industry:
                ind_w[c.industry] = ind_w.get(c.industry, 0.0) + wi

        # Portfolio volatility and CVaR
        port_vol_daily = port_vol_ann = cvar = None
        if cov is not None and len(w) == cov.shape[0]:
            pv = float(w @ cov @ w)
            if pv >= 0:
                port_vol_daily = math.sqrt(pv)
                port_vol_ann   = port_vol_daily * math.sqrt(252.0)

        # HHI
        n_nonzero = sum(1 for wi in w if abs(wi) > 1e-6)
        if gross > 0:
            norm_w = np.abs(w) / gross
            hhi = float(np.sum(norm_w ** 2))
            eff_n = 1.0 / hhi if hhi > 0 else float(n_nonzero)
            top1  = float(np.sort(np.abs(w))[::-1][0]) if len(w) > 0 else 0.0
            top5  = float(np.sum(np.sort(np.abs(w))[::-1][:5]))
            top10 = float(np.sum(np.sort(np.abs(w))[::-1][:10]))
        else:
            hhi = eff_n = top1 = top5 = top10 = None

        # Beta (weighted average beta to benchmark)
        betas = [c.beta for c in candidates if c.beta is not None]
        port_beta = None
        if betas and len(betas) == len(candidates):
            port_beta = float(np.dot(w, [c.beta for c in candidates]))

        # Options Greeks (portfolio-level; only if options present)
        has_options = any(c.is_option for c in candidates)
        delta = gamma = vega = theta = None
        if has_options:
            delta = sum(
                float(w[i]) * c.delta
                for i, c in enumerate(candidates)
                if c.delta is not None
            )
            gamma = sum(
                float(w[i]) * c.gamma
                for i, c in enumerate(candidates)
                if c.gamma is not None
            )
            vega = sum(
                float(w[i]) * c.vega
                for i, c in enumerate(candidates)
                if c.vega is not None
            )
            theta = sum(
                float(w[i]) * c.theta
                for i, c in enumerate(candidates)
                if c.theta is not None
            )

        return ExposureSummary(
            gross_exposure=gross,
            net_exposure=net,
            long_exposure=long_w,
            short_exposure=abs(short_w),
            cash_pct=max(0.0, 1.0 - gross),
            portfolio_volatility_daily=port_vol_daily,
            portfolio_volatility_annual=port_vol_ann,
            sector_weights=sec_w,
            industry_weights=ind_w,
            hhi=hhi,
            effective_n=eff_n,
            top_1_weight=top1,
            top_5_weight=top5,
            top_10_weight=top10,
            portfolio_beta=port_beta,
            portfolio_delta=delta,
            portfolio_gamma=gamma,
            portfolio_vega=vega,
            portfolio_theta=theta,
        )

    @staticmethod
    def _component_risk_list(
        w: np.ndarray,
        cov: np.ndarray,
        instruments: list[str],
    ) -> list[ComponentRisk]:
        """Compute component risk for each position."""
        port_var = float(w @ cov @ w)
        port_vol = math.sqrt(max(port_var, 1e-16))
        mr = (cov @ w) / port_vol
        cr = w * mr
        result = []
        for i, inst in enumerate(instruments):
            pct = cr[i] / port_vol * 100.0 if port_vol > 1e-12 else 0.0
            result.append(ComponentRisk(
                instrument_id=inst,
                weight=float(w[i]),
                marginal_risk=float(mr[i]),
                component_risk=float(cr[i]),
                risk_contribution_pct=float(pct),
            ))
        return result
