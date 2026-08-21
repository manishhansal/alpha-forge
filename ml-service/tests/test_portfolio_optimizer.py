"""
Failing tests for Task 12.1 — Riskfolio-Lib portfolio optimizer.

These tests are written BEFORE Task 12.2 migrates the optimizer to
Riskfolio-Lib. They will fail until:
  - Riskfolio-Lib==6.* is installed (Task 12.2)
  - `portfolio_optimizer.py` is updated to support the new `method` parameter
    ('hrp' and 'cvar') and returns risk metrics (volatility, cvar, sharpe,
    maxDrawdown)

Requirements covered: 10.1, 10.2, 10.3, 10.4

Validates: Requirements 10.1, 10.2, 10.3, 10.4
"""

import numpy as np
import pandas as pd
import pytest

# This import will raise ModuleNotFoundError until Task 12.2 installs
# Riskfolio-Lib. That is intentional — it makes all tests that depend on
# `riskfolio` fail at collection time, confirming the TDD red phase.
import riskfolio as rp  # noqa: E402  (fails until Riskfolio-Lib is installed)

# ---------------------------------------------------------------------------
# Synthetic returns fixture
# 50 stocks × 252 trading days, seeded for determinism.
# ---------------------------------------------------------------------------

N_STOCKS = 50
N_DAYS = 252
RNG_SEED = 42


def _make_returns(n_stocks: int = N_STOCKS, n_days: int = N_DAYS, seed: int = RNG_SEED) -> pd.DataFrame:
    """
    Generate a synthetic returns DataFrame (n_stocks columns × n_days rows).

    Uses a geometric random walk so the series resembles real daily returns.
    Stocks are named STOCK_00 … STOCK_49.
    """
    rng = np.random.default_rng(seed)
    # Annualised vol ~ 25%, daily vol ~ 25%/√252 ≈ 1.57%
    daily_vol = 0.25 / np.sqrt(252)
    # Small positive drift so some strategies look better than others
    daily_drift = rng.uniform(-0.0002, 0.0003, n_stocks)
    raw = rng.normal(0, daily_vol, size=(n_days, n_stocks)) + daily_drift
    columns = [f"STOCK_{i:02d}" for i in range(n_stocks)]
    return pd.DataFrame(raw, columns=columns)


@pytest.fixture(scope="module")
def returns_df() -> pd.DataFrame:
    return _make_returns()


# ---------------------------------------------------------------------------
# Helper: build a Riskfolio Portfolio object from a returns DataFrame
# (used for CVaR Classic MVO optimisation)
# ---------------------------------------------------------------------------

def _build_portfolio(returns: pd.DataFrame) -> rp.Portfolio:
    """
    Construct a Riskfolio Portfolio from a returns DataFrame, fit the
    statistical moments, and return it ready for Classic MVO optimisation.

    Note: In Riskfolio-Lib 6.x, HRP-based hierarchical optimisation
    (model="HRP", codependence=...) is exposed through rp.HCPortfolio,
    not rp.Portfolio.  Use _build_hc_portfolio() for HRP.
    """
    port = rp.Portfolio(returns=returns)
    port.assets_stats(method_mu="hist", method_cov="ledoit")
    return port


def _build_hc_portfolio(returns: pd.DataFrame) -> rp.HCPortfolio:
    """
    Construct a Riskfolio HCPortfolio from a returns DataFrame, ready for
    hierarchical optimisation (HRP, HERC, etc.).

    In Riskfolio-Lib 6.x the HRP model — including the `codependence`
    parameter — lives on HCPortfolio, not Portfolio.
    """
    return rp.HCPortfolio(returns=returns)


# ---------------------------------------------------------------------------
# Test class 1: HRP weights
# ---------------------------------------------------------------------------

class TestHRPWeights:
    """
    Validates: Requirements 10.1, 10.2

    HRP (Hierarchical Risk Parity) must produce non-negative weights that
    sum to exactly 1.0 within floating-point tolerance.
    """

    def test_hrp_weights_sum_to_one(self, returns_df: pd.DataFrame) -> None:
        """
        HRP allocation weights must sum to 1.0 within 1e-6.

        Validates: Requirement 10.2
        """
        port = _build_hc_portfolio(returns_df)
        w = port.optimization(model="HRP", codependence="pearson", rm="MV", rf=0)

        weight_sum = float(w["weights"].sum())
        assert abs(weight_sum - 1.0) < 1e-6, (
            f"HRP weights sum to {weight_sum:.8f}, expected 1.0 ± 1e-6"
        )

    def test_hrp_all_weights_non_negative(self, returns_df: pd.DataFrame) -> None:
        """
        All HRP weights must be ≥ 0 (long-only constraint).

        Validates: Requirement 10.2
        """
        port = _build_hc_portfolio(returns_df)
        w = port.optimization(model="HRP", codependence="pearson", rm="MV", rf=0)

        weights = w["weights"].values
        assert (weights >= 0).all(), (
            f"HRP produced negative weights: {weights[weights < 0]}"
        )

    def test_hrp_weights_cover_all_assets(self, returns_df: pd.DataFrame) -> None:
        """
        HRP result must have one weight entry per input asset.

        Validates: Requirement 10.1
        """
        port = _build_hc_portfolio(returns_df)
        w = port.optimization(model="HRP", codependence="pearson", rm="MV", rf=0)

        assert len(w) == returns_df.shape[1], (
            f"Expected {returns_df.shape[1]} weight entries, got {len(w)}"
        )


# ---------------------------------------------------------------------------
# Test class 2: CVaR weights
# ---------------------------------------------------------------------------

class TestCVaRWeights:
    """
    Validates: Requirements 10.1, 10.2

    CVaR-constrained MVO (alpha=0.05) must produce non-negative weights that
    sum to exactly 1.0 within floating-point tolerance.
    """

    def test_cvar_weights_sum_to_one(self, returns_df: pd.DataFrame) -> None:
        """
        CVaR allocation weights must sum to 1.0 within 1e-6.

        Validates: Requirement 10.2
        """
        port = _build_portfolio(returns_df)
        w = port.optimization(
            model="Classic",
            rm="CVaR",
            obj="MinRisk",
            rf=0,
            l=0,
            hist=True,
        )

        weight_sum = float(w["weights"].sum())
        assert abs(weight_sum - 1.0) < 1e-6, (
            f"CVaR weights sum to {weight_sum:.8f}, expected 1.0 ± 1e-6"
        )

    def test_cvar_all_weights_non_negative(self, returns_df: pd.DataFrame) -> None:
        """
        All CVaR weights must be ≥ 0 (long-only constraint).

        Validates: Requirement 10.2
        """
        port = _build_portfolio(returns_df)
        w = port.optimization(
            model="Classic",
            rm="CVaR",
            obj="MinRisk",
            rf=0,
            l=0,
            hist=True,
        )

        weights = w["weights"].values
        assert (weights >= 0).all(), (
            f"CVaR produced negative weights: {weights[weights < 0]}"
        )

    def test_cvar_weights_cover_all_assets(self, returns_df: pd.DataFrame) -> None:
        """
        CVaR result must have one weight entry per input asset.

        Validates: Requirement 10.1
        """
        port = _build_portfolio(returns_df)
        w = port.optimization(
            model="Classic",
            rm="CVaR",
            obj="MinRisk",
            rf=0,
            l=0,
            hist=True,
        )

        assert len(w) == returns_df.shape[1], (
            f"Expected {returns_df.shape[1]} weight entries, got {len(w)}"
        )


# ---------------------------------------------------------------------------
# Test class 3: CVaR portfolio has lower CVaR than HRP portfolio
# ---------------------------------------------------------------------------

class TestCVaRBetterThanHRP:
    """
    Validates: Requirement 10.4

    The CVaR-minimised portfolio must achieve a lower realised CVaR (at
    alpha=0.05) than the HRP portfolio when evaluated on the same return series.

    CVaR at alpha = mean of the worst (alpha * 100)% of portfolio returns,
    sign-flipped to be positive (larger = more risk).
    """

    ALPHA = 0.05

    def _portfolio_cvar(self, weights: np.ndarray, returns: pd.DataFrame) -> float:
        """
        Compute the historical CVaR (alpha=0.05) for a portfolio.

        CVaR = mean of the (alpha * 100)% worst daily P&L observations,
        expressed as a positive number (loss magnitude).
        """
        port_returns = returns.values @ weights
        threshold_idx = max(int(np.floor(self.ALPHA * len(port_returns))), 1)
        sorted_returns = np.sort(port_returns)
        worst_tail = sorted_returns[:threshold_idx]
        return float(-worst_tail.mean())  # positive = loss

    def test_cvar_portfolio_cvar_less_than_hrp_portfolio_cvar(
        self, returns_df: pd.DataFrame
    ) -> None:
        """
        CVaR portfolio CVaR < HRP portfolio CVaR on the same return series.

        Validates: Requirement 10.4
        """
        # HRP optimisation — uses HCPortfolio in Riskfolio-Lib 6.x
        hc_port = _build_hc_portfolio(returns_df)
        hrp_w = hc_port.optimization(model="HRP", codependence="pearson", rm="MV", rf=0)
        hrp_weights = hrp_w["weights"].values

        # CVaR minimisation — uses Portfolio (Classic MVO)
        port = _build_portfolio(returns_df)
        cvar_w = port.optimization(
            model="Classic",
            rm="CVaR",
            obj="MinRisk",
            rf=0,
            l=0,
            hist=True,
        )
        cvar_weights = cvar_w["weights"].values

        hrp_cvar = self._portfolio_cvar(hrp_weights, returns_df)
        cvar_cvar = self._portfolio_cvar(cvar_weights, returns_df)

        assert cvar_cvar < hrp_cvar, (
            f"CVaR portfolio CVaR ({cvar_cvar:.6f}) is NOT less than "
            f"HRP portfolio CVaR ({hrp_cvar:.6f}). "
            "The CVaR optimiser should minimise tail risk."
        )
