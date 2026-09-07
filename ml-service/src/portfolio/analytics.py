"""
Phase 3H — Portfolio Analytics.

Computes attribution, concentration, diversification, stability,
benchmark-relative metrics, and exposure diagnostics.

Design rules
------------
1. All metrics that require returns data report INSUFFICIENT_EVIDENCE
   when returns are unavailable — no fabrication.
2. Benchmark-relative metrics require explicit benchmark_returns.
3. No uncontrolled randomness.
4. Stability analysis perturbs inputs without randomness (grid perturbation).
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional

import numpy as np

from .schemas import ExposureSummary, PortfolioCandidate, PortfolioTarget


# ══════════════════════════════════════════════════════════════════════════════
# Performance metrics
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class PerformanceMetrics:
    """Portfolio performance metrics computed from return series."""
    gross_return:           Optional[float] = None
    net_return:             Optional[float] = None
    annualized_return:      Optional[float] = None
    volatility_ann:         Optional[float] = None
    sharpe_ratio:           Optional[float] = None
    sortino_ratio:          Optional[float] = None
    calmar_ratio:           Optional[float] = None
    max_drawdown:           Optional[float] = None
    cvar_95:                Optional[float] = None
    hit_rate:               Optional[float] = None
    expectancy:             Optional[float] = None
    turnover:               Optional[float] = None
    transaction_cost:       Optional[float] = None
    n_observations:         int = 0
    observation_period:     str = "INSUFFICIENT_EVIDENCE"
    n_rebalances:           int = 0
    n_positions_avg:        Optional[float] = None
    notes:                  str = ""


@dataclass
class BenchmarkRelativeMetrics:
    """Benchmark-relative performance metrics."""
    active_return:          Optional[float] = None
    active_volatility:      Optional[float] = None
    tracking_error_ann:     Optional[float] = None
    information_ratio:      Optional[float] = None
    active_beta:            Optional[float] = None
    benchmark_id:           str = "NIFTY50"
    benchmark_version:      str = "NIFTY50-v1"
    notes:                  str = "INSUFFICIENT_EVIDENCE"


@dataclass
class ConcentrationMetrics:
    """Portfolio concentration diagnostics."""
    hhi:                    Optional[float] = None
    effective_n:            Optional[float] = None
    top_1_weight:           Optional[float] = None
    top_5_weight:           Optional[float] = None
    top_10_weight:          Optional[float] = None
    sector_hhi:             Optional[float] = None
    n_positions:            int = 0
    diversification_ratio:  Optional[float] = None


@dataclass
class StabilityMetrics:
    """Portfolio weight stability under input perturbations."""
    # Average weight change under perturbation (smaller = more stable)
    mean_weight_change_ev:      Optional[float] = None  # EV ± 10% perturbation
    mean_weight_change_vol:     Optional[float] = None  # volatility ± 10%
    mean_weight_change_corr:    Optional[float] = None  # correlation ± 5%
    rank_stability:             Optional[float] = None  # Spearman corr of weight ranks
    turnover_sensitivity:       Optional[float] = None  # d(turnover)/d(EV_shock)
    notes:                      str = "STABILITY_NOT_COMPUTED"


@dataclass
class AttributionRecord:
    """Single attribution factor row."""
    factor:             str
    contribution_pct:   Optional[float] = None
    notes:              str = ""


@dataclass
class PortfolioAttribution:
    """
    Portfolio return attribution.
    Each factor's contribution sums to total return (approximately).
    """
    total_return:       Optional[float] = None
    alpha_contribution:         Optional[float] = None   # contribution from signal edge
    sector_contribution:        Optional[float] = None
    factor_contribution:        Optional[float] = None
    market_contribution:        Optional[float] = None
    risk_contribution:          Optional[float] = None
    transaction_cost_drag:      Optional[float] = None
    slippage_drag:              Optional[float] = None
    factors:                    list[AttributionRecord] = field(default_factory=list)
    notes:                      str = "INSUFFICIENT_EVIDENCE"


# ══════════════════════════════════════════════════════════════════════════════
# Analytics engine
# ══════════════════════════════════════════════════════════════════════════════

class PortfolioAnalytics:
    """
    Computes portfolio analytics.

    Usage
    -----
    ::
        analytics = PortfolioAnalytics(risk_free_rate_annual=0.07)
        metrics = analytics.performance_metrics(portfolio_returns, cost_inr, capital)
        bench   = analytics.benchmark_relative(portfolio_returns, benchmark_returns)
        conc    = analytics.concentration(target)
        stab    = analytics.stability(candidates, cov_matrix, optimizer_fn)
    """

    def __init__(
        self,
        risk_free_rate_annual: float = 0.07,   # RBI repo ~7% (configurable)
        ann_factor: float = 252.0,
    ) -> None:
        self.rf_ann = risk_free_rate_annual
        self.rf_daily = risk_free_rate_annual / ann_factor
        self.ann_factor = ann_factor

    # ── Performance metrics ───────────────────────────────────────────────────

    def performance_metrics(
        self,
        portfolio_returns: np.ndarray,          # daily net returns (fraction)
        n_rebalances: int = 0,
        n_positions_per_period: Optional[list[int]] = None,
        total_cost_fraction: float = 0.0,        # total cost as fraction of capital
    ) -> PerformanceMetrics:
        """
        Compute portfolio performance metrics from a daily return series.

        All metrics report INSUFFICIENT_EVIDENCE if fewer than 20 observations.
        """
        n = len(portfolio_returns)
        if n < 20:
            return PerformanceMetrics(
                n_observations=n,
                observation_period="INSUFFICIENT_EVIDENCE",
                notes=f"Only {n} observations; minimum 20 required.",
            )

        ret = np.array(portfolio_returns, dtype=float)
        gross_total = float(np.prod(1.0 + ret) - 1.0)
        net_total   = gross_total - total_cost_fraction
        ann_ret     = float((1.0 + gross_total) ** (self.ann_factor / n) - 1.0)
        vol         = float(np.std(ret, ddof=1) * math.sqrt(self.ann_factor))
        excess      = ret - self.rf_daily
        sharpe      = (float(np.mean(excess)) / float(np.std(excess, ddof=1))
                       * math.sqrt(self.ann_factor)) if float(np.std(excess, ddof=1)) > 0 else None

        # Sortino
        downside = ret[ret < 0]
        downside_std = float(np.std(downside, ddof=1)) if len(downside) > 1 else 0.0
        sortino = (
            float(np.mean(excess)) / downside_std * math.sqrt(self.ann_factor)
            if downside_std > 0 else None
        )

        # Max drawdown
        cum = np.cumprod(1.0 + ret)
        running_max = np.maximum.accumulate(cum)
        dd = (cum - running_max) / running_max
        max_dd = float(np.min(dd))

        # Calmar
        calmar = ann_ret / abs(max_dd) if abs(max_dd) > 1e-8 else None

        # CVaR 95%
        k = max(1, int(math.floor(0.05 * n)))
        cvar_95 = float(-np.mean(np.sort(ret)[:k]))

        # Hit rate
        hit_rate = float(np.mean(ret > 0))
        expectancy = float(np.mean(ret))

        avg_n_pos = (
            float(np.mean(n_positions_per_period)) if n_positions_per_period else None
        )

        return PerformanceMetrics(
            gross_return=round(gross_total, 6),
            net_return=round(net_total, 6),
            annualized_return=round(ann_ret, 6),
            volatility_ann=round(vol, 6),
            sharpe_ratio=round(sharpe, 4) if sharpe else None,
            sortino_ratio=round(sortino, 4) if sortino else None,
            calmar_ratio=round(calmar, 4) if calmar else None,
            max_drawdown=round(max_dd, 6),
            cvar_95=round(cvar_95, 6),
            hit_rate=round(hit_rate, 4),
            expectancy=round(expectancy, 6),
            transaction_cost=round(total_cost_fraction, 6),
            n_observations=n,
            observation_period=f"{n} trading days",
            n_rebalances=n_rebalances,
            n_positions_avg=avg_n_pos,
        )

    # ── Benchmark-relative ────────────────────────────────────────────────────

    def benchmark_relative(
        self,
        portfolio_returns: np.ndarray,
        benchmark_returns: Optional[np.ndarray],
        benchmark_id: str = "NIFTY50",
        benchmark_version: str = "NIFTY50-v1",
    ) -> BenchmarkRelativeMetrics:
        """Compute benchmark-relative metrics."""
        if benchmark_returns is None:
            return BenchmarkRelativeMetrics(
                benchmark_id=benchmark_id,
                benchmark_version=benchmark_version,
                notes="INSUFFICIENT_EVIDENCE: benchmark returns not supplied.",
            )

        n = min(len(portfolio_returns), len(benchmark_returns))
        if n < 20:
            return BenchmarkRelativeMetrics(
                benchmark_id=benchmark_id,
                notes=f"INSUFFICIENT_EVIDENCE: only {n} aligned observations.",
            )

        pr = np.array(portfolio_returns[:n])
        br = np.array(benchmark_returns[:n])

        active = pr - br
        active_ret  = float(np.mean(active) * self.ann_factor)
        active_vol  = float(np.std(active, ddof=1) * math.sqrt(self.ann_factor))
        tracking_err = active_vol
        ir = active_ret / tracking_err if tracking_err > 0 else None

        # Active beta
        cov_ab = float(np.cov(pr, br, ddof=1)[0, 1])
        var_b  = float(np.var(br, ddof=1))
        active_beta = cov_ab / var_b if var_b > 0 else None

        return BenchmarkRelativeMetrics(
            active_return=round(active_ret, 6),
            active_volatility=round(active_vol, 6),
            tracking_error_ann=round(tracking_err, 6),
            information_ratio=round(ir, 4) if ir else None,
            active_beta=round(active_beta, 4) if active_beta else None,
            benchmark_id=benchmark_id,
            benchmark_version=benchmark_version,
            notes="OK",
        )

    # ── Concentration metrics ─────────────────────────────────────────────────

    def concentration(
        self,
        target: PortfolioTarget,
        candidates: Optional[list[PortfolioCandidate]] = None,
        cov: Optional[np.ndarray] = None,
        vols: Optional[np.ndarray] = None,
    ) -> ConcentrationMetrics:
        """Compute concentration and diversification metrics."""
        w_arr = np.array(list(target.weights.values()))
        w_abs = np.abs(w_arr)
        gross = w_abs.sum()

        n_pos = int(np.sum(w_abs > 1e-6))
        if gross < 1e-12 or n_pos == 0:
            return ConcentrationMetrics(n_positions=0)

        # Normalise for HHI
        w_norm = w_abs / gross
        hhi   = float(np.sum(w_norm ** 2))
        eff_n = 1.0 / hhi if hhi > 0 else float(n_pos)

        sorted_w = np.sort(w_abs)[::-1]
        top1  = float(sorted_w[0]) if len(sorted_w) >= 1 else None
        top5  = float(sorted_w[:5].sum()) if len(sorted_w) >= 5 else None
        top10 = float(sorted_w[:10].sum()) if len(sorted_w) >= 10 else None

        # Sector HHI
        sec_hhi = None
        if target.exposure and target.exposure.sector_weights:
            sw = np.array(list(target.exposure.sector_weights.values()))
            sw_g = sw.sum()
            if sw_g > 0:
                sec_hhi = float(np.sum((sw / sw_g) ** 2))

        # Diversification ratio (requires cov and vols)
        div_ratio = None
        if cov is not None and vols is not None and len(w_arr) == len(vols):
            port_vol = math.sqrt(max(float(w_arr @ cov @ w_arr), 1e-16))
            weighted_vols = float(w_arr @ vols)
            div_ratio = weighted_vols / port_vol if port_vol > 1e-12 else None

        return ConcentrationMetrics(
            hhi=round(hhi, 6),
            effective_n=round(eff_n, 2),
            top_1_weight=round(top1, 4) if top1 else None,
            top_5_weight=round(top5, 4) if top5 else None,
            top_10_weight=round(top10, 4) if top10 else None,
            sector_hhi=round(sec_hhi, 4) if sec_hhi else None,
            n_positions=n_pos,
            diversification_ratio=round(div_ratio, 4) if div_ratio else None,
        )

    # ── Stability analysis ────────────────────────────────────────────────────

    def stability(
        self,
        base_weights: dict[str, float],
        candidates: list[PortfolioCandidate],
        cov: Optional[np.ndarray],
        optimizer_fn,    # callable(candidates, cov) -> dict[str, float]
        perturbation_grid: tuple = (-0.10, 0.10),  # ±10%
    ) -> StabilityMetrics:
        """
        Measure weight stability under small input perturbations.

        For each perturbation point in perturbation_grid:
        - Perturb expected_values by ±10% (EV sensitivity)
        - Compute perturbed weights via optimizer_fn
        - Measure L1 distance from base weights

        No randomness — deterministic grid.
        """
        if not candidates or cov is None or optimizer_fn is None:
            return StabilityMetrics()

        import copy
        n = len(candidates)
        base_arr = np.array([base_weights.get(c.instrument_id, 0.0) for c in candidates])

        ev_changes = []
        for delta in perturbation_grid:
            perturbed = copy.deepcopy(candidates)
            for c in perturbed:
                if c.expected_value is not None:
                    c.expected_value = c.expected_value * (1.0 + delta)
            try:
                perturbed_w = optimizer_fn(perturbed, cov)
                p_arr = np.array([perturbed_w.get(c.instrument_id, 0.0) for c in perturbed])
                ev_changes.append(float(np.mean(np.abs(p_arr - base_arr))))
            except Exception:
                pass

        mean_ev = float(np.mean(ev_changes)) if ev_changes else None

        # Volatility perturbation
        vol_changes = []
        for delta in perturbation_grid:
            perturbed_cov = cov * (1.0 + delta) ** 2  # scale variances
            try:
                perturbed_w = optimizer_fn(candidates, perturbed_cov)
                p_arr = np.array([
                    perturbed_w.get(c.instrument_id, 0.0) for c in candidates
                ])
                vol_changes.append(float(np.mean(np.abs(p_arr - base_arr))))
            except Exception:
                pass

        mean_vol = float(np.mean(vol_changes)) if vol_changes else None

        # Rank stability: Spearman rank correlation
        if n >= 4:
            base_ranks = np.argsort(np.argsort(-base_arr))
            if ev_changes and len(ev_changes) > 0:
                # Use last EV perturbation rank
                try:
                    last_ev_w = optimizer_fn(candidates, cov)
                    last_arr = np.array([
                        last_ev_w.get(c.instrument_id, 0.0) for c in candidates
                    ])
                    last_ranks = np.argsort(np.argsort(-last_arr))
                    n_r = len(base_ranks)
                    d2 = float(np.sum((base_ranks - last_ranks) ** 2))
                    spearman = 1.0 - 6.0 * d2 / (n_r * (n_r ** 2 - 1))
                    rank_stab = round(float(spearman), 4)
                except Exception:
                    rank_stab = None
            else:
                rank_stab = None
        else:
            rank_stab = None

        return StabilityMetrics(
            mean_weight_change_ev=round(mean_ev, 6) if mean_ev is not None else None,
            mean_weight_change_vol=round(mean_vol, 6) if mean_vol is not None else None,
            rank_stability=rank_stab,
            notes="Deterministic grid perturbation; no randomness.",
        )

    # ── Attribution ───────────────────────────────────────────────────────────

    def attribution(
        self,
        portfolio_returns: Optional[np.ndarray],
        total_cost_fraction: float = 0.0,
        slippage_fraction: float = 0.0,
    ) -> PortfolioAttribution:
        """
        Compute simple return attribution.
        Full factor attribution requires factor return series (DATA_UNAVAILABLE).
        """
        if portfolio_returns is None or len(portfolio_returns) < 5:
            return PortfolioAttribution(
                notes="INSUFFICIENT_EVIDENCE: fewer than 5 observations.",
            )

        total = float(np.prod(1.0 + portfolio_returns) - 1.0)
        return PortfolioAttribution(
            total_return=round(total, 6),
            transaction_cost_drag=round(-total_cost_fraction, 6),
            slippage_drag=round(-slippage_fraction, 6),
            notes=(
                "Full factor attribution requires factor return series "
                "(DATA_UNAVAILABLE). Cost and slippage drag computed."
            ),
        )

    # ── Regime analysis ───────────────────────────────────────────────────────

    def regime_performance(
        self,
        portfolio_returns: np.ndarray,
        regime_labels: np.ndarray,   # string labels per period
        risk_free_rate_annual: Optional[float] = None,
    ) -> dict[str, PerformanceMetrics]:
        """
        Evaluate portfolio performance by market regime.

        Parameters
        ----------
        portfolio_returns : daily returns
        regime_labels     : regime label per period (same length as returns)

        Returns
        -------
        {regime_label: PerformanceMetrics}
        """
        rf = risk_free_rate_annual or self.rf_ann
        result = {}
        regimes = np.unique(regime_labels)
        for regime in regimes:
            mask = regime_labels == regime
            reg_ret = portfolio_returns[mask]
            metrics = self.performance_metrics(reg_ret)
            metrics.observation_period = f"regime={regime}, n={int(mask.sum())}"
            result[str(regime)] = metrics
        return result
