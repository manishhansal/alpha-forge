"""
Phase 3H — Portfolio Risk Model.

Provides covariance estimation from historical return series.

Design rules
------------
1. NEVER use synthetic / randomly-generated correlations.
   If historical returns are unavailable → CovarianceStatus.UNAVAILABLE.
2. The sample end date of returns must be ≤ formation_time (PIT).
3. Shrinkage is applied by default (Ledoit-Wolf analytical formula
   implemented in pure numpy — no sklearn dependency required).
4. PSD repair (eigenvalue floor) is applied when the matrix is not
   positive semi-definite, and the repair is fully documented.
5. Covariance quality is validated before any optimization:
   symmetry, PSD, condition number, missingness, sample size.
6. No uncontrolled randomness anywhere in this module.

Covariance methods
------------------
HISTORICAL         — sample covariance (biased correction)
EWMA               — exponentially-weighted (λ configurable)
LEDOIT_WOLF        — Ledoit-Wolf shrinkage (analytical Oracle formula)
                     Reference: Ledoit & Wolf (2004)
OAS                — Oracle Approximating Shrinkage (Chen et al. 2010)
                     Implemented in pure numpy to avoid sklearn dependency.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

import numpy as np

from .schemas import (
    CovarianceMethod, CovarianceResult, CovarianceStatus,
)

UTC = timezone.utc

# ── Configuration ─────────────────────────────────────────────────────────────

@dataclass
class RiskModelConfig:
    """Configuration for the covariance risk model."""
    method:              CovarianceMethod = CovarianceMethod.LEDOIT_WOLF
    min_observations:    int  = 60          # minimum return observations required
    max_condition_number: float = 1e6       # warn above this; flag ILL_CONDITIONED
    psd_floor:           float = 1e-8       # eigenvalue floor for PSD repair
    ewma_lambda:         float = 0.94       # EWMA decay factor (RiskMetrics default)
    annualisation_factor: float = 252.0     # trading days per year
    max_missingness_pct: float = 0.10       # reject if >10% missing return obs
    version:             str  = "risk-model-v1"


# ── Ledoit-Wolf analytical shrinkage (pure numpy) ─────────────────────────────

def _ledoit_wolf_shrinkage(X: np.ndarray) -> tuple[np.ndarray, float]:
    """
    Analytical Ledoit-Wolf (2004) Oracle approximation shrinkage estimator.
    Shrinks sample covariance toward scaled identity.

    Returns (shrunk_cov, shrinkage_coefficient λ)

    Reference: Ledoit, O. & Wolf, M. (2004). "A well-conditioned estimator
    for large-dimensional covariance matrices." Journal of Multivariate
    Analysis 88(2): 365-411.  Analytical formula from Oracle Approximating
    Shrinkage (Chen et al. 2010) simplified for μ_1 target.
    """
    n, p = X.shape
    if n < 2:
        return np.cov(X, rowvar=False, ddof=1), 0.0

    # Center the data
    Xc = X - X.mean(axis=0)

    # Sample covariance (unbiased)
    S = np.dot(Xc.T, Xc) / (n - 1)

    # Target: scaled identity
    mu = np.trace(S) / p

    # Analytical shrinkage coefficient (Oracle formula)
    # δ* = min(1, ((n-2)/n * ||S||_F² + Tr(S)²) / ((n+2)(||S||_F² - Tr(S)²/p)))
    # We use the standard simplified closed-form:
    S2 = np.dot(S, S)
    tr_S  = np.trace(S)
    tr_S2 = np.trace(S2)
    tr_S_sq = tr_S ** 2

    # Numerator ∝ mean squared error of sample vs oracle
    # Frobenius norm denominator
    denom = (n + 2) * (tr_S2 - tr_S_sq / p)
    if abs(denom) < 1e-12:
        # Already nearly spherical — no shrinkage needed
        return S, 0.0

    # Oracle coefficient for Frobenius-optimal shrinkage
    numer = ((n - 2) / n) * tr_S2 + tr_S_sq
    rho = min(1.0, max(0.0, numer / denom))

    # Shrunk estimator: (1 - rho) * S + rho * mu * I
    shrunk = (1.0 - rho) * S + rho * mu * np.eye(p)
    return shrunk, float(rho)


def _oas_shrinkage(X: np.ndarray) -> tuple[np.ndarray, float]:
    """
    Oracle Approximating Shrinkage (OAS) estimator — Chen et al. (2010).
    Improved for small n/p ratio compared to LW.

    Returns (shrunk_cov, shrinkage_coefficient ρ)
    """
    n, p = X.shape
    if n < 2:
        return np.cov(X, rowvar=False, ddof=1), 0.0

    Xc = X - X.mean(axis=0)
    S = np.dot(Xc.T, Xc) / (n - 1)

    tr_S  = np.trace(S)
    tr_S2 = np.trace(np.dot(S, S))
    mu = tr_S / p

    # OAS closed form (Chen et al. 2010, eq. 23)
    rho_num = (1.0 - 2.0 / p) * tr_S2 + tr_S ** 2
    rho_den = (n + 1.0 - 2.0 / p) * (tr_S2 - tr_S ** 2 / p)
    if abs(rho_den) < 1e-12:
        return S, 0.0

    rho = min(1.0, max(0.0, rho_num / rho_den))
    shrunk = (1.0 - rho) * S + rho * mu * np.eye(p)
    return shrunk, float(rho)


# ── PSD repair ────────────────────────────────────────────────────────────────

def _ensure_psd(
    cov: np.ndarray,
    floor: float = 1e-8,
) -> tuple[np.ndarray, bool, Optional[float], Optional[float]]:
    """
    Project covariance matrix to PSD cone by flooring negative eigenvalues.

    Returns (repaired_cov, repair_applied, min_pre_eigenvalue, min_post_eigenvalue)
    Repair is documented via the return values — caller records in CovarianceResult.
    """
    # Force symmetry (numerical noise)
    cov = (cov + cov.T) / 2.0
    eigenvalues, eigenvectors = np.linalg.eigh(cov)
    min_pre = float(np.min(eigenvalues))

    if min_pre >= floor:
        return cov, False, min_pre, min_pre

    # Floor negative eigenvalues
    eigenvalues_repaired = np.maximum(eigenvalues, floor)
    cov_repaired = eigenvectors @ np.diag(eigenvalues_repaired) @ eigenvectors.T
    cov_repaired = (cov_repaired + cov_repaired.T) / 2.0  # re-symmetrise
    min_post = float(np.min(eigenvalues_repaired))

    return cov_repaired, True, min_pre, min_post


# ── EWMA covariance ───────────────────────────────────────────────────────────

def _ewma_covariance(returns: np.ndarray, lam: float = 0.94) -> np.ndarray:
    """
    Exponentially weighted covariance matrix.

    Weights decay geometrically: w_t ∝ λ^(T-t).
    Older observations receive less weight.
    """
    n, p = returns.shape
    # Build weights in reverse time order (most recent = highest weight)
    weights = np.array([lam ** i for i in range(n - 1, -1, -1)])
    weights /= weights.sum()

    # Weighted mean
    mu = np.average(returns, axis=0, weights=weights)
    centered = returns - mu

    # Weighted covariance
    cov = np.zeros((p, p))
    for i in range(n):
        r = centered[i:i+1]
        cov += weights[i] * (r.T @ r)

    return cov


# ── Main risk model ───────────────────────────────────────────────────────────

class RiskModel:
    """
    Portfolio risk model — covariance estimation from historical returns.

    Usage
    -----
    ::
        model = RiskModel(config)
        # returns_dict: {instrument_id: [daily_return, ...]}
        # returns must end at or before formation_time
        result = model.estimate(returns_dict, formation_time)
        if result.is_usable:
            cov = result.cov_matrix  # numpy ndarray
    """

    def __init__(self, config: Optional[RiskModelConfig] = None) -> None:
        self.config = config or RiskModelConfig()

    def estimate(
        self,
        returns: dict[str, list[float]],
        formation_time: datetime,
        returns_end_time: Optional[datetime] = None,
    ) -> CovarianceResult:
        """
        Estimate covariance matrix from historical daily returns.

        Parameters
        ----------
        returns           : {instrument_id: [daily_return, ...]}
                            Returns must be ordered chronologically (oldest first).
                            All series must have the same length.
        formation_time    : Portfolio formation timestamp (PIT gate).
        returns_end_time  : Latest timestamp in the returns series.
                            Must be ≤ formation_time (PIT check).
                            If None, the PIT check is skipped (caller's responsibility).

        Returns
        -------
        CovarianceResult with status VALID, PSD_REPAIRED, INSUFFICIENT_SAMPLE,
        MISSINGNESS, or UNAVAILABLE.
        """
        cfg = self.config
        instruments = sorted(returns.keys())
        n_instruments = len(instruments)

        if n_instruments == 0:
            return CovarianceResult(
                instruments=[], cov_matrix=None, corr_matrix=None,
                volatilities=None, method=cfg.method,
                status=CovarianceStatus.UNAVAILABLE,
                n_observations=0, sample_start=None, sample_end=None,
                notes="No instruments provided.",
            )

        # ── PIT check ────────────────────────────────────────────────────────
        if returns_end_time is not None:
            ret_end = returns_end_time
            form_t  = formation_time
            # Normalise timezone
            if ret_end.tzinfo is None:
                ret_end = ret_end.replace(tzinfo=UTC)
            if form_t.tzinfo is None:
                form_t = form_t.replace(tzinfo=UTC)
            if ret_end > form_t:
                return CovarianceResult(
                    instruments=instruments, cov_matrix=None, corr_matrix=None,
                    volatilities=None, method=cfg.method,
                    status=CovarianceStatus.UNAVAILABLE,
                    n_observations=0, sample_start=None, sample_end=returns_end_time,
                    notes=(
                        f"PIT violation: returns_end_time ({returns_end_time}) "
                        f"> formation_time ({formation_time}). "
                        "Future return data cannot be used for portfolio formation."
                    ),
                )

        # ── Build return matrix ───────────────────────────────────────────────
        series_lengths = [len(returns[i]) for i in instruments]
        if len(set(series_lengths)) > 1:
            # Align to shortest common length
            min_len = min(series_lengths)
            return_arrays = [np.array(returns[i][-min_len:], dtype=float) for i in instruments]
        else:
            return_arrays = [np.array(returns[i], dtype=float) for i in instruments]

        R = np.column_stack(return_arrays)  # shape: (T, n_instruments)
        T = R.shape[0]

        # ── Missingness check ─────────────────────────────────────────────────
        n_missing = int(np.isnan(R).sum())
        missingness_pct = n_missing / max(R.size, 1)
        if missingness_pct > cfg.max_missingness_pct:
            return CovarianceResult(
                instruments=instruments, cov_matrix=None, corr_matrix=None,
                volatilities=None, method=cfg.method,
                status=CovarianceStatus.MISSINGNESS,
                n_observations=T, sample_start=None, sample_end=returns_end_time,
                missingness_pct=missingness_pct,
                notes=(
                    f"Missingness {missingness_pct:.1%} exceeds threshold "
                    f"{cfg.max_missingness_pct:.1%}. Covariance unreliable."
                ),
            )

        # Fill any residual NaN with 0 (mean-return imputation)
        R = np.where(np.isnan(R), 0.0, R)

        # ── Sample size check ─────────────────────────────────────────────────
        if T < cfg.min_observations:
            return CovarianceResult(
                instruments=instruments, cov_matrix=None, corr_matrix=None,
                volatilities=None, method=cfg.method,
                status=CovarianceStatus.INSUFFICIENT_SAMPLE,
                n_observations=T, sample_start=None, sample_end=returns_end_time,
                notes=(
                    f"Only {T} observations; minimum required is "
                    f"{cfg.min_observations}."
                ),
            )

        # ── Estimate covariance ───────────────────────────────────────────────
        shrinkage_coeff: Optional[float] = None
        shrinkage_method = "none"

        if cfg.method == CovarianceMethod.HISTORICAL:
            cov = np.cov(R, rowvar=False, ddof=1)

        elif cfg.method == CovarianceMethod.EWMA:
            cov = _ewma_covariance(R, lam=cfg.ewma_lambda)
            shrinkage_method = f"ewma_lambda={cfg.ewma_lambda}"

        elif cfg.method == CovarianceMethod.LEDOIT_WOLF:
            cov, shrinkage_coeff = _ledoit_wolf_shrinkage(R)
            shrinkage_method = "ledoit_wolf_analytical"

        elif cfg.method == CovarianceMethod.OAS:
            cov, shrinkage_coeff = _oas_shrinkage(R)
            shrinkage_method = "oas_analytical"

        else:
            # Default to Ledoit-Wolf
            cov, shrinkage_coeff = _ledoit_wolf_shrinkage(R)
            shrinkage_method = "ledoit_wolf_analytical"

        # ── Symmetry enforcement ──────────────────────────────────────────────
        cov = (cov + cov.T) / 2.0

        # ── PSD check and repair ──────────────────────────────────────────────
        cov, psd_repaired, min_pre_eig, min_post_eig = _ensure_psd(
            cov, floor=cfg.psd_floor
        )
        status = CovarianceStatus.PSD_REPAIRED if psd_repaired else CovarianceStatus.VALID

        # ── Condition number check ────────────────────────────────────────────
        try:
            cond = float(np.linalg.cond(cov))
        except np.linalg.LinAlgError:
            cond = float("inf")

        if cond > cfg.max_condition_number:
            status = CovarianceStatus.ILL_CONDITIONED

        # ── Derive volatilities and correlation ───────────────────────────────
        vol = np.sqrt(np.diag(cov))
        with np.errstate(divide="ignore", invalid="ignore"):
            outer_vol = np.outer(vol, vol)
            corr = np.where(outer_vol > 0, cov / outer_vol, 0.0)
        np.fill_diagonal(corr, 1.0)
        corr = np.clip(corr, -1.0, 1.0)

        return CovarianceResult(
            instruments=instruments,
            cov_matrix=cov,
            corr_matrix=corr,
            volatilities=vol,
            method=cfg.method,
            status=status,
            n_observations=T,
            sample_start=None,
            sample_end=returns_end_time,
            shrinkage_coeff=shrinkage_coeff,
            shrinkage_method=shrinkage_method,
            psd_repair_applied=psd_repaired,
            min_pre_eigenvalue=min_pre_eig,
            min_post_eigenvalue=min_post_eig,
            projection_method="eigenvalue_floor" if psd_repaired else "",
            condition_number=cond,
            missingness_pct=missingness_pct,
            notes="" if not psd_repaired else (
                f"PSD repair applied. Minimum eigenvalue floored from "
                f"{min_pre_eig:.2e} to {min_post_eig:.2e}."
            ),
        )

    def portfolio_variance(
        self,
        weights: np.ndarray,
        cov: np.ndarray,
    ) -> float:
        """Compute portfolio variance: w^T Σ w."""
        return float(weights @ cov @ weights)

    def portfolio_volatility(
        self,
        weights: np.ndarray,
        cov: np.ndarray,
    ) -> float:
        """Compute portfolio daily volatility: sqrt(w^T Σ w)."""
        var = self.portfolio_variance(weights, cov)
        return float(math.sqrt(max(var, 0.0)))

    def marginal_risk(
        self,
        weights: np.ndarray,
        cov: np.ndarray,
    ) -> np.ndarray:
        """Marginal risk: ∂σ_p / ∂w_i = (Σw)_i / σ_p."""
        port_vol = self.portfolio_volatility(weights, cov)
        if port_vol < 1e-12:
            return np.zeros_like(weights)
        return (cov @ weights) / port_vol

    def component_risk(
        self,
        weights: np.ndarray,
        cov: np.ndarray,
        instruments: list[str],
    ) -> list[dict]:
        """
        Per-position risk decomposition.
        sum(component_risk) = portfolio_risk (Euler decomposition).
        """
        port_vol = self.portfolio_volatility(weights, cov)
        mr = self.marginal_risk(weights, cov)
        cr = weights * mr  # component risk = w_i × MR_i

        result = []
        for i, inst in enumerate(instruments):
            contrib_pct = (cr[i] / port_vol * 100.0) if port_vol > 1e-12 else 0.0
            result.append({
                "instrument_id":       inst,
                "weight":              float(weights[i]),
                "marginal_risk":       float(mr[i]),
                "component_risk":      float(cr[i]),
                "risk_contribution_pct": float(contrib_pct),
            })
        return result

    def historical_cvar(
        self,
        weights: np.ndarray,
        returns: np.ndarray,
        alpha: float = 0.05,
    ) -> float:
        """
        Historical simulation CVaR at confidence level (1-alpha).

        Parameters
        ----------
        weights  : portfolio weights (n,)
        returns  : return matrix (T × n)
        alpha    : tail probability (default 0.05 → 95% CVaR)

        Returns positive CVaR (loss magnitude).
        """
        port_returns = returns @ weights
        n = len(port_returns)
        k = max(1, int(math.floor(alpha * n)))
        sorted_ret = np.sort(port_returns)
        return float(-np.mean(sorted_ret[:k]))
