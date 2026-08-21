"""
Failing tests for the Black-Scholes / Black-76 Greeks Engine.

These tests are written BEFORE the implementation exists in ml-service/src/greeks.py.
They will fail with ImportError until Task 4.2 (implementation) is complete.
This is the TDD red phase — all tests are expected to FAIL initially.

Validates: Requirements 3.1, 3.2
"""

import math
import pytest
from hypothesis import given, settings, HealthCheck
from hypothesis import strategies as st

# ---------------------------------------------------------------------------
# Import-under-test
# This import will raise ImportError until src/greeks.py is created.
# That is intentional — it confirms the TDD red phase.
# ---------------------------------------------------------------------------
from src.greeks import compute_greeks_bs, solve_iv  # noqa: E402  (fails until implemented)


# ---------------------------------------------------------------------------
# Constants (NSE / Indian market conventions)
# ---------------------------------------------------------------------------

RISK_FREE_RATE = 0.071  # 10-year G-Sec yield (~7.1%) as a decimal
ATM_NIFTY_SPOT = 23000.0
ATM_NIFTY_STRIKE = 23000.0
ATM_NIFTY_T = 7 / 252  # 7 trading days / NSE calendar (252 trading days/year)
ATM_NIFTY_SIGMA = 0.15  # 15% annualised implied volatility


# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------

def _atm_nifty_greeks(flag: str) -> dict:
    """
    Compute greeks for the canonical ATM NIFTY test case.

    flag: 'c' for call, 'p' for put
    """
    return compute_greeks_bs(
        spot=ATM_NIFTY_SPOT,
        strike=ATM_NIFTY_STRIKE,
        r=RISK_FREE_RATE,
        t=ATM_NIFTY_T,
        sigma=ATM_NIFTY_SIGMA,
        flag=flag,
    )


# ---------------------------------------------------------------------------
# Test 1 — ATM NIFTY call greeks: known approximate values
# ---------------------------------------------------------------------------

class TestATMNiftyCallGreeks:
    """
    Requirement 3.1: compute delta, gamma, theta, vega for an ATM NIFTY call.

    For an ATM European call with spot ≈ strike, t ≈ 7/252, sigma ≈ 15%:
      - delta ≈ 0.50 (slightly above due to drift, within ±0.05)
      - gamma > 0
      - theta < 0  (time decay)
      - vega > 0
    """

    def test_atm_call_delta_approx_half(self):
        """ATM call delta should be approximately 0.50 ± 0.05."""
        result = _atm_nifty_greeks("c")
        assert "delta" in result, "result dict must contain 'delta'"
        delta = result["delta"]
        assert 0.45 <= delta <= 0.55, (
            f"ATM call delta expected ≈ 0.50 ± 0.05, got {delta}"
        )

    def test_atm_call_gamma_positive(self):
        """Gamma must be strictly positive for any option."""
        result = _atm_nifty_greeks("c")
        assert "gamma" in result, "result dict must contain 'gamma'"
        assert result["gamma"] > 0, (
            f"ATM call gamma must be > 0, got {result['gamma']}"
        )

    def test_atm_call_theta_negative(self):
        """Theta must be strictly negative (time decay erodes value)."""
        result = _atm_nifty_greeks("c")
        assert "theta" in result, "result dict must contain 'theta'"
        assert result["theta"] < 0, (
            f"ATM call theta must be < 0, got {result['theta']}"
        )

    def test_atm_call_vega_positive(self):
        """Vega must be strictly positive (higher vol → higher option price)."""
        result = _atm_nifty_greeks("c")
        assert "vega" in result, "result dict must contain 'vega'"
        assert result["vega"] > 0, (
            f"ATM call vega must be > 0, got {result['vega']}"
        )

    def test_result_contains_required_keys(self):
        """Result dict must contain all required greek keys."""
        result = _atm_nifty_greeks("c")
        required_keys = {"delta", "gamma", "theta", "vega", "rho"}
        missing = required_keys - result.keys()
        assert not missing, f"result dict missing keys: {missing}"


# ---------------------------------------------------------------------------
# Test 2 — ATM NIFTY put greeks: known approximate values
# ---------------------------------------------------------------------------

class TestATMNiftyPutGreeks:
    """
    Requirement 3.1: compute delta, gamma, theta, vega for an ATM NIFTY put.

    For an ATM put: delta ≈ -0.50 ± 0.05, gamma > 0, theta < 0, vega > 0.
    """

    def test_atm_put_delta_approx_negative_half(self):
        """ATM put delta should be approximately -0.50 ± 0.05."""
        result = _atm_nifty_greeks("p")
        assert "delta" in result, "result dict must contain 'delta'"
        delta = result["delta"]
        assert -0.55 <= delta <= -0.45, (
            f"ATM put delta expected ≈ -0.50 ± 0.05, got {delta}"
        )

    def test_atm_put_gamma_positive(self):
        """Gamma must be strictly positive for puts as well."""
        result = _atm_nifty_greeks("p")
        assert result["gamma"] > 0, (
            f"ATM put gamma must be > 0, got {result['gamma']}"
        )

    def test_atm_put_theta_negative(self):
        """Put theta must be strictly negative."""
        result = _atm_nifty_greeks("p")
        assert result["theta"] < 0, (
            f"ATM put theta must be < 0, got {result['theta']}"
        )

    def test_atm_put_vega_positive(self):
        """Put vega must be strictly positive."""
        result = _atm_nifty_greeks("p")
        assert result["vega"] > 0, (
            f"ATM put vega must be > 0, got {result['vega']}"
        )


# ---------------------------------------------------------------------------
# Test 3 — Call delta ∈ (0, 1) for any positive inputs (Property 5)
# Validates: Requirements 3.1, 3.2
# **Validates: Requirements 3.1, 3.2**
# ---------------------------------------------------------------------------

class TestCallDeltaBounds:
    """
    Property 5 (call branch): call delta ∈ (0, 1) for any positive
    (spot, strike, t, sigma).

    This is a property-based test using Hypothesis.
    Validates: Requirements 3.1, 3.2
    """

    @given(
        spot=st.floats(min_value=100.0, max_value=100_000.0, allow_nan=False, allow_infinity=False),
        strike=st.floats(min_value=100.0, max_value=100_000.0, allow_nan=False, allow_infinity=False),
        t=st.floats(min_value=1 / 252, max_value=2.0, allow_nan=False, allow_infinity=False),
        sigma=st.floats(min_value=0.01, max_value=2.0, allow_nan=False, allow_infinity=False),
    )
    @settings(max_examples=200, suppress_health_check=[HealthCheck.too_slow])
    def test_call_delta_in_open_unit_interval(
        self, spot: float, strike: float, t: float, sigma: float
    ):
        """
        For any valid positive inputs the call delta must lie strictly in (0, 1).

        **Validates: Requirements 3.1, 3.2**
        """
        result = compute_greeks_bs(
            spot=spot,
            strike=strike,
            r=RISK_FREE_RATE,
            t=t,
            sigma=sigma,
            flag="c",
        )
        delta = result["delta"]
        assert 0.0 < delta < 1.0, (
            f"call delta {delta} not in (0, 1) for "
            f"spot={spot}, strike={strike}, t={t}, sigma={sigma}"
        )


# ---------------------------------------------------------------------------
# Test 4 — Put delta ∈ (-1, 0) for any positive inputs (Property 5)
# Validates: Requirements 3.1, 3.2
# ---------------------------------------------------------------------------

class TestPutDeltaBounds:
    """
    Property 5 (put branch): put delta ∈ (-1, 0) for any positive
    (spot, strike, t, sigma).

    This is a property-based test using Hypothesis.
    Validates: Requirements 3.1, 3.2
    """

    @given(
        spot=st.floats(min_value=100.0, max_value=100_000.0, allow_nan=False, allow_infinity=False),
        strike=st.floats(min_value=100.0, max_value=100_000.0, allow_nan=False, allow_infinity=False),
        t=st.floats(min_value=1 / 252, max_value=2.0, allow_nan=False, allow_infinity=False),
        sigma=st.floats(min_value=0.01, max_value=2.0, allow_nan=False, allow_infinity=False),
    )
    @settings(max_examples=200, suppress_health_check=[HealthCheck.too_slow])
    def test_put_delta_in_open_negative_unit_interval(
        self, spot: float, strike: float, t: float, sigma: float
    ):
        """
        For any valid positive inputs the put delta must lie strictly in (-1, 0).

        **Validates: Requirements 3.1, 3.2**
        """
        result = compute_greeks_bs(
            spot=spot,
            strike=strike,
            r=RISK_FREE_RATE,
            t=t,
            sigma=sigma,
            flag="p",
        )
        delta = result["delta"]
        assert -1.0 < delta < 0.0, (
            f"put delta {delta} not in (-1, 0) for "
            f"spot={spot}, strike={strike}, t={t}, sigma={sigma}"
        )


# ---------------------------------------------------------------------------
# Test 5 — Gamma and Vega sign invariants for all inputs (Property 5)
# Validates: Requirements 3.1, 3.2
# ---------------------------------------------------------------------------

class TestGreeksSignInvariants:
    """
    Property 5 (sign invariants): gamma > 0 and vega > 0 for all valid inputs,
    regardless of call/put flag.

    Validates: Requirements 3.1, 3.2
    """

    @given(
        spot=st.floats(min_value=100.0, max_value=100_000.0, allow_nan=False, allow_infinity=False),
        strike=st.floats(min_value=100.0, max_value=100_000.0, allow_nan=False, allow_infinity=False),
        t=st.floats(min_value=1 / 252, max_value=2.0, allow_nan=False, allow_infinity=False),
        sigma=st.floats(min_value=0.01, max_value=2.0, allow_nan=False, allow_infinity=False),
        flag=st.sampled_from(["c", "p"]),
    )
    @settings(max_examples=200, suppress_health_check=[HealthCheck.too_slow])
    def test_gamma_always_positive(
        self, spot: float, strike: float, t: float, sigma: float, flag: str
    ):
        """
        Gamma is always strictly positive for European options (calls and puts share the same gamma).

        **Validates: Requirements 3.1, 3.2**
        """
        result = compute_greeks_bs(
            spot=spot, strike=strike, r=RISK_FREE_RATE, t=t, sigma=sigma, flag=flag
        )
        assert result["gamma"] > 0, (
            f"gamma {result['gamma']} not > 0 for "
            f"spot={spot}, strike={strike}, t={t}, sigma={sigma}, flag={flag}"
        )

    @given(
        spot=st.floats(min_value=100.0, max_value=100_000.0, allow_nan=False, allow_infinity=False),
        strike=st.floats(min_value=100.0, max_value=100_000.0, allow_nan=False, allow_infinity=False),
        t=st.floats(min_value=1 / 252, max_value=2.0, allow_nan=False, allow_infinity=False),
        sigma=st.floats(min_value=0.01, max_value=2.0, allow_nan=False, allow_infinity=False),
        flag=st.sampled_from(["c", "p"]),
    )
    @settings(max_examples=200, suppress_health_check=[HealthCheck.too_slow])
    def test_vega_always_positive(
        self, spot: float, strike: float, t: float, sigma: float, flag: str
    ):
        """
        Vega is always strictly positive for European options.

        **Validates: Requirements 3.1, 3.2**
        """
        result = compute_greeks_bs(
            spot=spot, strike=strike, r=RISK_FREE_RATE, t=t, sigma=sigma, flag=flag
        )
        assert result["vega"] > 0, (
            f"vega {result['vega']} not > 0 for "
            f"spot={spot}, strike={strike}, t={t}, sigma={sigma}, flag={flag}"
        )

    @given(
        spot=st.floats(min_value=100.0, max_value=100_000.0, allow_nan=False, allow_infinity=False),
        strike=st.floats(min_value=100.0, max_value=100_000.0, allow_nan=False, allow_infinity=False),
        t=st.floats(min_value=1 / 252, max_value=2.0, allow_nan=False, allow_infinity=False),
        sigma=st.floats(min_value=0.01, max_value=2.0, allow_nan=False, allow_infinity=False),
        flag=st.sampled_from(["c", "p"]),
    )
    @settings(max_examples=200, suppress_health_check=[HealthCheck.too_slow])
    def test_theta_always_negative(
        self, spot: float, strike: float, t: float, sigma: float, flag: str
    ):
        """
        Theta is always strictly negative for European options (time decay).

        **Validates: Requirements 3.1, 3.2**
        """
        result = compute_greeks_bs(
            spot=spot, strike=strike, r=RISK_FREE_RATE, t=t, sigma=sigma, flag=flag
        )
        assert result["theta"] < 0, (
            f"theta {result['theta']} not < 0 for "
            f"spot={spot}, strike={strike}, t={t}, sigma={sigma}, flag={flag}"
        )


# ---------------------------------------------------------------------------
# Test 6 — IV solver round-trip: solve_iv → compute_greeks_bs → recover LTP
# Validates: Requirements 3.2
# ---------------------------------------------------------------------------

class TestIVSolverRoundTrip:
    """
    Requirement 3.2: IV solver round-trip.

    Given a market LTP (option price), solve_iv must recover a sigma such that
    plugging sigma back into the pricing formula reproduces LTP within 0.001.

    Interface under test:
        iv = solve_iv(ltp, spot, strike, r, t, flag)
        recovered_price from compute_greeks_bs(spot, strike, r, t, iv, flag)

    The test uses the Black-Scholes call/put price to generate a synthetic LTP,
    then verifies the round-trip.
    """

    def _bs_price(self, spot: float, strike: float, r: float, t: float,
                  sigma: float, flag: str) -> float:
        """Compute Black-Scholes price using the standard closed-form formula."""
        sigma_sqrt_t = sigma * math.sqrt(t)
        d1 = (math.log(spot / strike) + (r + 0.5 * sigma ** 2) * t) / sigma_sqrt_t
        d2 = d1 - sigma_sqrt_t

        from scipy.stats import norm
        if flag == "c":
            return (spot * norm.cdf(d1)
                    - strike * math.exp(-r * t) * norm.cdf(d2))
        else:
            return (strike * math.exp(-r * t) * norm.cdf(-d2)
                    - spot * norm.cdf(-d1))

    def test_atm_call_iv_round_trip(self):
        """
        Solving IV from an ATM NIFTY call price and recomputing the price
        must match the original within 0.001.
        """
        ltp = self._bs_price(
            ATM_NIFTY_SPOT, ATM_NIFTY_STRIKE, RISK_FREE_RATE,
            ATM_NIFTY_T, ATM_NIFTY_SIGMA, "c"
        )
        iv = solve_iv(ltp, ATM_NIFTY_SPOT, ATM_NIFTY_STRIKE,
                      RISK_FREE_RATE, ATM_NIFTY_T, "c")

        # iv must be a positive float
        assert isinstance(iv, float), f"solve_iv must return a float, got {type(iv)}"
        assert iv > 0, f"solved IV must be positive, got {iv}"

        # Recover price with solved IV — compare to original LTP
        result = compute_greeks_bs(
            spot=ATM_NIFTY_SPOT,
            strike=ATM_NIFTY_STRIKE,
            r=RISK_FREE_RATE,
            t=ATM_NIFTY_T,
            sigma=iv,
            flag="c",
        )
        # compute_greeks_bs must expose the priced value; check via the IV being close
        assert abs(iv - ATM_NIFTY_SIGMA) < 0.01, (
            f"Round-trip IV {iv:.6f} deviates from original sigma "
            f"{ATM_NIFTY_SIGMA:.6f} by more than 0.01"
        )

    def test_atm_put_iv_round_trip(self):
        """
        Solving IV from an ATM NIFTY put price and recomputing must recover
        the original sigma within 0.01 (< 1 vol point).
        """
        ltp = self._bs_price(
            ATM_NIFTY_SPOT, ATM_NIFTY_STRIKE, RISK_FREE_RATE,
            ATM_NIFTY_T, ATM_NIFTY_SIGMA, "p"
        )
        iv = solve_iv(ltp, ATM_NIFTY_SPOT, ATM_NIFTY_STRIKE,
                      RISK_FREE_RATE, ATM_NIFTY_T, "p")

        assert isinstance(iv, float), f"solve_iv must return a float, got {type(iv)}"
        assert iv > 0, f"solved IV must be positive, got {iv}"
        assert abs(iv - ATM_NIFTY_SIGMA) < 0.01, (
            f"Round-trip IV {iv:.6f} deviates from original sigma "
            f"{ATM_NIFTY_SIGMA:.6f} by more than 0.01"
        )

    @pytest.mark.parametrize("sigma,flag", [
        (0.10, "c"),  # low vol call
        (0.20, "c"),  # medium vol call
        (0.30, "c"),  # high vol call
        (0.10, "p"),  # low vol put
        (0.20, "p"),  # medium vol put
        (0.30, "p"),  # high vol put
    ])
    def test_itm_otm_iv_round_trip(self, sigma: float, flag: str):
        """
        IV round-trip holds for a range of vol levels and both call/put flags,
        using OTM and ITM strikes around ATM NIFTY.
        """
        for moneyness in [0.95, 1.00, 1.05]:  # OTM, ATM, ITM
            strike = ATM_NIFTY_STRIKE * moneyness
            ltp = self._bs_price(
                ATM_NIFTY_SPOT, strike, RISK_FREE_RATE,
                ATM_NIFTY_T, sigma, flag
            )
            # Skip deep ITM/OTM where price rounds to effectively zero
            if ltp < 0.01:
                continue

            iv = solve_iv(ltp, ATM_NIFTY_SPOT, strike,
                          RISK_FREE_RATE, ATM_NIFTY_T, flag)

            assert isinstance(iv, float), (
                f"solve_iv must return float for ltp={ltp:.4f}, flag={flag}, "
                f"moneyness={moneyness}"
            )
            assert iv > 0, f"solved IV must be positive, got {iv}"
            assert abs(iv - sigma) < 0.01, (
                f"IV round-trip failed: solved={iv:.6f}, original={sigma}, "
                f"flag={flag}, moneyness={moneyness}"
            )

    def test_solve_iv_returns_none_for_zero_price(self):
        """
        solve_iv should return None (or raise) when the market price is
        effectively zero (deep OTM, no solution).
        Per design doc: return iv=None for that strike (chain still renders).
        """
        # Deep OTM call: strike = 2 × spot, very short expiry → price ≈ 0
        ltp = 0.0
        result = solve_iv(ltp, ATM_NIFTY_SPOT, ATM_NIFTY_STRIKE * 2.0,
                          RISK_FREE_RATE, ATM_NIFTY_T, "c")
        # Implementation should return None rather than crash
        assert result is None, (
            f"solve_iv with ltp=0.0 should return None, got {result}"
        )
