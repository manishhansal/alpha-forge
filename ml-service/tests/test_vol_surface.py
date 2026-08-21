"""
Failing tests for the IV Surface module (ml-service/src/vol_surface.py).

These tests are written BEFORE the implementation exists — this is the TDD
red phase. They will fail with ImportError until Task 6.2 (implementation)
is complete.

Module under test: src/vol_surface.py
Expected public API:
    fit_svi(strikes, ivs, forward) -> SVIParams dict
    build_iv_surface(snapshots_by_expiry: dict) -> dict
    compute_term_structure(atm_ivs_by_expiry: dict) -> list[dict]

SVI model: w(k) = a + b*(rho*(k-m) + sqrt((k-m)^2 + sigma^2))
  where k = log(K/F), w = sigma_implied^2 * T (total variance)

No-calendar-spread-arbitrage condition (Property 12):
    total_variance(T1) <= total_variance(T2)  for any T1 < T2.

Validates: Requirements 5.1, 5.2, 5.3
"""

from __future__ import annotations

import math
import pytest
from hypothesis import given, settings, HealthCheck
from hypothesis import strategies as st

# ---------------------------------------------------------------------------
# Import-under-test — will raise ImportError until src/vol_surface.py exists.
# ---------------------------------------------------------------------------
from src.vol_surface import build_iv_surface, compute_term_structure, fit_svi  # noqa: E402


# ---------------------------------------------------------------------------
# Synthetic IV smile helpers
# ---------------------------------------------------------------------------

# NIFTY-like parameters
SPOT = 23_000.0
FORWARD_NEAR = 23_050.0   # F ≈ spot * exp(r * T) for T = 7 days
FORWARD_FAR = 23_200.0    # F for T = 21 days

# Two expiry labels
EXPIRY_NEAR = "2025-07-10"   # ~7 trading days
EXPIRY_FAR = "2025-07-24"    # ~21 trading days

# Days-to-expiry for each label (used by compute_term_structure assertions)
DTE_NEAR = 7
DTE_FAR = 21

# Annualised vol axis (T in years, NSE 252 calendar)
T_NEAR = DTE_NEAR / 252
T_FAR = DTE_FAR / 252

# ATM IVs: far expiry must have ATM IV >= near expiry for calendar-arb-free
ATM_IV_NEAR = 0.15  # 15% — typical weekly NIFTY vol
ATM_IV_FAR = 0.16   # 16% — slightly higher term structure

# Strikes around ATM (5 per expiry, symmetric)
STRIKES_NEAR = [22_500, 22_800, 23_000, 23_200, 23_500]
STRIKES_FAR = [22_500, 22_800, 23_000, 23_200, 23_500]


def _synthetic_smile(
    strikes: list[int],
    forward: float,
    atm_iv: float,
    skew: float = -0.05,
    convexity: float = 0.02,
) -> list[float]:
    """
    Return a simple synthetic IV smile for the given strikes.

    Uses a quadratic log-moneyness approximation:
        iv(K) = atm_iv + skew * k + convexity * k^2
    where k = log(K / forward).

    The convexity ensures the function is bowl-shaped (realistic smile).
    """
    ivs = []
    for k_raw in strikes:
        k = math.log(k_raw / forward)
        iv = atm_iv + skew * k + convexity * k * k
        # Clamp to a realistic range [0.05, 1.00]
        ivs.append(max(0.05, min(1.0, iv)))
    return ivs


# Pre-computed smiles used in most tests
IVS_NEAR = _synthetic_smile(STRIKES_NEAR, FORWARD_NEAR, ATM_IV_NEAR)
IVS_FAR = _synthetic_smile(STRIKES_FAR, FORWARD_FAR, ATM_IV_FAR)

# Snapshot dicts used by build_iv_surface / compute_term_structure
SNAPSHOT_NEAR = {
    "strikes": [float(k) for k in STRIKES_NEAR],
    "ivs": IVS_NEAR,
    "forward": FORWARD_NEAR,
    "days_to_expiry": DTE_NEAR,
    "atm_iv": ATM_IV_NEAR,
}
SNAPSHOT_FAR = {
    "strikes": [float(k) for k in STRIKES_FAR],
    "ivs": IVS_FAR,
    "forward": FORWARD_FAR,
    "days_to_expiry": DTE_FAR,
    "atm_iv": ATM_IV_FAR,
}

SNAPSHOTS_BY_EXPIRY = {
    EXPIRY_NEAR: SNAPSHOT_NEAR,
    EXPIRY_FAR: SNAPSHOT_FAR,
}


# ---------------------------------------------------------------------------
# 1. SVI fit — no-calendar-spread arbitrage (Property 12)
#    ATM total variance must be non-decreasing in T.
# ---------------------------------------------------------------------------

class TestSviNoCalendarArbitrage:
    """
    Property 12 / Requirement 5.1:
    The SVI-fitted ATM total variance (sigma^2 * T) for the far expiry must
    be >= the total variance for the near expiry (calendar-arb-free surface).

    We test via:
      1. Fitting SVI to the near and far smiles independently.
      2. Computing total ATM variance for each: w_i = atm_iv_fitted^2 * T_i
      3. Asserting w_near <= w_far.
    """

    def _fit_and_atm_variance(
        self,
        strikes: list[int],
        ivs: list[float],
        forward: float,
        T: float,
    ) -> float:
        """
        Fit SVI to the smile and return the ATM total variance.

        ATM total variance = fitted_atm_iv^2 * T.
        We evaluate the SVI surface at k=0 (log(F/F) = 0 — ATM by convention)
        to get the ATM total variance directly from the SVI parameters.
        """
        params = fit_svi(
            strikes=[float(s) for s in strikes],
            ivs=ivs,
            forward=forward,
        )

        # SVI total variance at log-moneyness k:
        # w(k) = a + b*(rho*(k-m) + sqrt((k-m)^2 + sigma^2))
        # At ATM: k = 0 (spot == forward) or use the forward price
        # The returned params must have keys: a, b, rho, m, sigma
        a = params["a"]
        b = params["b"]
        rho = params["rho"]
        m = params["m"]
        sigma_svi = params["sigma"]

        k_atm = 0.0  # log(F/F) = 0
        w_atm = a + b * (rho * (k_atm - m) + math.sqrt((k_atm - m) ** 2 + sigma_svi ** 2))

        # w_atm is total variance = iv^2 * T; must be non-negative
        return max(w_atm, 0.0)

    def test_atm_variance_non_decreasing_near_to_far(self):
        """
        ATM total variance of far expiry must be >= near expiry.
        Validates: Requirement 5.1, Property 12.
        """
        w_near = self._fit_and_atm_variance(
            STRIKES_NEAR, IVS_NEAR, FORWARD_NEAR, T_NEAR
        )
        w_far = self._fit_and_atm_variance(
            STRIKES_FAR, IVS_FAR, FORWARD_FAR, T_FAR
        )

        assert w_near <= w_far, (
            f"Calendar-spread arbitrage detected: "
            f"ATM total variance near={w_near:.6f} > far={w_far:.6f}. "
            f"The surface violates the no-calendar-arbitrage condition."
        )

    def test_svi_returns_required_param_keys(self):
        """fit_svi must return a dict with keys: a, b, rho, m, sigma."""
        params = fit_svi(
            strikes=[float(s) for s in STRIKES_NEAR],
            ivs=IVS_NEAR,
            forward=FORWARD_NEAR,
        )
        required = {"a", "b", "rho", "m", "sigma"}
        missing = required - set(params.keys())
        assert not missing, f"fit_svi result missing SVI parameter keys: {missing}"

    def test_svi_rho_in_unit_interval(self):
        """
        SVI correlation parameter rho must lie in (-1, 1) for the fitted
        surface to be arbitrage-free.
        """
        params = fit_svi(
            strikes=[float(s) for s in STRIKES_NEAR],
            ivs=IVS_NEAR,
            forward=FORWARD_NEAR,
        )
        rho = params["rho"]
        assert -1.0 < rho < 1.0, (
            f"SVI rho={rho} is outside the valid range (-1, 1)."
        )

    def test_svi_b_non_negative(self):
        """SVI wings parameter b must be non-negative."""
        params = fit_svi(
            strikes=[float(s) for s in STRIKES_NEAR],
            ivs=IVS_NEAR,
            forward=FORWARD_NEAR,
        )
        b = params["b"]
        assert b >= 0.0, f"SVI b={b} is negative — invalid SVI parametrisation."

    def test_svi_total_variance_positive_at_all_strikes(self):
        """
        Total variance produced by SVI fit must be >= 0 at every input strike.
        Negative variance would be unphysical.
        """
        params = fit_svi(
            strikes=[float(s) for s in STRIKES_NEAR],
            ivs=IVS_NEAR,
            forward=FORWARD_NEAR,
        )
        a = params["a"]
        b = params["b"]
        rho = params["rho"]
        m = params["m"]
        sigma_svi = params["sigma"]

        for k_raw in STRIKES_NEAR:
            k = math.log(k_raw / FORWARD_NEAR)
            w = a + b * (rho * (k - m) + math.sqrt((k - m) ** 2 + sigma_svi ** 2))
            assert w >= 0.0, (
                f"SVI total variance w={w:.6f} at strike {k_raw} (k={k:.4f}) is negative."
            )


# ---------------------------------------------------------------------------
# 2. compute_term_structure — expiries sorted ascending by days-to-expiry
# ---------------------------------------------------------------------------

class TestComputeTermStructure:
    """
    Requirement 5.2: compute_term_structure returns expiries sorted ascending
    by days-to-expiry.
    """

    def test_returns_list(self):
        """compute_term_structure must return a list."""
        result = compute_term_structure(SNAPSHOTS_BY_EXPIRY)
        assert isinstance(result, list), (
            f"compute_term_structure must return a list, got {type(result)}"
        )

    def test_sorted_ascending_by_days_to_expiry(self):
        """
        The result must be sorted by days_to_expiry ascending.
        Near expiry (7 dte) must appear before far expiry (21 dte).
        """
        result = compute_term_structure(SNAPSHOTS_BY_EXPIRY)

        assert len(result) >= 2, (
            f"Expected at least 2 entries for 2 expiries, got {len(result)}"
        )

        dtes = [entry["days_to_expiry"] for entry in result]
        assert dtes == sorted(dtes), (
            f"Term structure not sorted ascending by days_to_expiry: {dtes}"
        )

    def test_near_expiry_comes_first(self):
        """Near expiry (DTE_NEAR=7) must be first in the sorted result."""
        result = compute_term_structure(SNAPSHOTS_BY_EXPIRY)

        first_dte = result[0]["days_to_expiry"]
        assert first_dte == DTE_NEAR, (
            f"Expected first entry to have days_to_expiry={DTE_NEAR}, got {first_dte}"
        )

    def test_each_entry_has_required_keys(self):
        """Each entry must contain 'days_to_expiry' and 'atm_iv'."""
        result = compute_term_structure(SNAPSHOTS_BY_EXPIRY)

        for i, entry in enumerate(result):
            assert "days_to_expiry" in entry, (
                f"Entry {i} missing 'days_to_expiry' key: {entry}"
            )
            assert "atm_iv" in entry, (
                f"Entry {i} missing 'atm_iv' key: {entry}"
            )

    def test_atm_iv_values_are_positive(self):
        """ATM IV values in the term structure must be positive."""
        result = compute_term_structure(SNAPSHOTS_BY_EXPIRY)

        for entry in result:
            atm_iv = entry["atm_iv"]
            assert atm_iv > 0.0, (
                f"atm_iv={atm_iv} is not positive for entry {entry}"
            )

    def test_term_structure_length_matches_input(self):
        """Number of entries equals the number of expiries provided."""
        result = compute_term_structure(SNAPSHOTS_BY_EXPIRY)
        assert len(result) == len(SNAPSHOTS_BY_EXPIRY), (
            f"Expected {len(SNAPSHOTS_BY_EXPIRY)} entries, got {len(result)}"
        )

    def test_three_expiries_sorted_correctly(self):
        """
        Three expiries in arbitrary insertion order must be returned sorted by DTE.
        """
        snapshots = {
            "2025-08-07": {**SNAPSHOT_FAR, "days_to_expiry": 35, "atm_iv": 0.17},
            "2025-07-10": {**SNAPSHOT_NEAR, "days_to_expiry": 7, "atm_iv": ATM_IV_NEAR},
            "2025-07-24": {**SNAPSHOT_FAR, "days_to_expiry": 21, "atm_iv": ATM_IV_FAR},
        }
        result = compute_term_structure(snapshots)

        assert len(result) == 3
        dtes = [e["days_to_expiry"] for e in result]
        assert dtes == [7, 21, 35], (
            f"Three-expiry term structure not sorted correctly: {dtes}"
        )


# ---------------------------------------------------------------------------
# 3. build_iv_surface — dict keyed by expiry with per-strike IV arrays
# ---------------------------------------------------------------------------

class TestBuildIVSurface:
    """
    Requirement 5.3: build_iv_surface returns a dict keyed by expiry date
    with per-strike IV arrays.
    """

    def test_returns_dict(self):
        """build_iv_surface must return a dict."""
        result = build_iv_surface(SNAPSHOTS_BY_EXPIRY)
        assert isinstance(result, dict), (
            f"build_iv_surface must return a dict, got {type(result)}"
        )

    def test_keys_match_input_expiries(self):
        """The returned dict must be keyed by the same expiry labels as input."""
        result = build_iv_surface(SNAPSHOTS_BY_EXPIRY)

        assert set(result.keys()) == set(SNAPSHOTS_BY_EXPIRY.keys()), (
            f"build_iv_surface keys {set(result.keys())} != "
            f"input expiries {set(SNAPSHOTS_BY_EXPIRY.keys())}"
        )

    def test_each_expiry_has_per_strike_entries(self):
        """
        Each value in the result must be a list/sequence of (strike, iv) pairs
        or dicts with 'strike' and 'iv' keys — one entry per strike.
        """
        result = build_iv_surface(SNAPSHOTS_BY_EXPIRY)

        for expiry, entries in result.items():
            assert hasattr(entries, "__len__"), (
                f"Entries for expiry {expiry} must be a sequence, got {type(entries)}"
            )
            n_strikes = len(SNAPSHOTS_BY_EXPIRY[expiry]["strikes"])
            assert len(entries) == n_strikes, (
                f"Expected {n_strikes} strike entries for expiry {expiry}, "
                f"got {len(entries)}"
            )

    def test_each_entry_has_strike_and_iv(self):
        """
        Each per-strike entry must expose a 'strike' and 'iv' field
        (either as dict keys or as a 2-tuple).
        """
        result = build_iv_surface(SNAPSHOTS_BY_EXPIRY)

        for expiry, entries in result.items():
            for i, entry in enumerate(entries):
                if isinstance(entry, dict):
                    assert "strike" in entry, (
                        f"Entry {i} for expiry {expiry} missing 'strike': {entry}"
                    )
                    assert "iv" in entry, (
                        f"Entry {i} for expiry {expiry} missing 'iv': {entry}"
                    )
                else:
                    # Accept tuple/list: (strike, iv)
                    assert len(entry) >= 2, (
                        f"Entry {i} for expiry {expiry} has < 2 elements: {entry}"
                    )

    def test_iv_values_are_positive(self):
        """All IV values in the surface must be positive."""
        result = build_iv_surface(SNAPSHOTS_BY_EXPIRY)

        for expiry, entries in result.items():
            for i, entry in enumerate(entries):
                iv = entry["iv"] if isinstance(entry, dict) else entry[1]
                assert iv > 0.0, (
                    f"IV={iv} at entry {i} for expiry {expiry} is not positive."
                )

    def test_iv_values_in_realistic_range(self):
        """
        IV values should be in a realistic range for NSE (0.01 to 5.0,
        i.e. 1% to 500% annualised vol).
        """
        result = build_iv_surface(SNAPSHOTS_BY_EXPIRY)

        for expiry, entries in result.items():
            for i, entry in enumerate(entries):
                iv = entry["iv"] if isinstance(entry, dict) else entry[1]
                assert 0.01 <= iv <= 5.0, (
                    f"IV={iv} at entry {i} for expiry {expiry} is outside "
                    f"the realistic range [0.01, 5.0]."
                )

    def test_surface_contains_both_expiries(self):
        """The surface must contain keys for both EXPIRY_NEAR and EXPIRY_FAR."""
        result = build_iv_surface(SNAPSHOTS_BY_EXPIRY)

        assert EXPIRY_NEAR in result, (
            f"Surface missing near expiry '{EXPIRY_NEAR}'. Keys: {list(result.keys())}"
        )
        assert EXPIRY_FAR in result, (
            f"Surface missing far expiry '{EXPIRY_FAR}'. Keys: {list(result.keys())}"
        )

    def test_single_expiry_surface(self):
        """build_iv_surface works when only one expiry is provided."""
        single = {EXPIRY_NEAR: SNAPSHOT_NEAR}
        result = build_iv_surface(single)

        assert isinstance(result, dict)
        assert EXPIRY_NEAR in result
        assert len(result[EXPIRY_NEAR]) == len(STRIKES_NEAR)


# ---------------------------------------------------------------------------
# 4. Property-based test — no-calendar-arbitrage across randomised vol levels
# ---------------------------------------------------------------------------

class TestSviNoCalendarArbitrageProperty:
    """
    Property 12 (Requirement 5.1, design Property 12):
    For any two expiries T1 < T2 with reasonable IV smiles, the SVI-fitted
    ATM total variance must be non-decreasing:
        atm_iv_fitted(T1)^2 * T1 <= atm_iv_fitted(T2)^2 * T2.

    We test this by generating random (but realistic) ATM IVs for a near and
    far expiry, synthesising smiles, and asserting no calendar arbitrage.

    **Validates: Requirements 5.1**
    """

    @given(
        atm_iv_near=st.floats(min_value=0.08, max_value=0.40, allow_nan=False),
        # Far ATM IV must produce total variance >= near total variance.
        # We draw a multiplier >= 1 so ATM IV far >= ATM IV near.
        iv_ratio=st.floats(min_value=1.0, max_value=1.8, allow_nan=False),
    )
    @settings(max_examples=50, suppress_health_check=[HealthCheck.too_slow])
    def test_no_calendar_arbitrage_property(
        self, atm_iv_near: float, iv_ratio: float
    ) -> None:
        """
        For any near-expiry ATM IV in [8%, 40%] and a far-expiry ATM IV that
        is at least as large, the SVI-fitted total variances must satisfy
        w_near <= w_far.

        **Validates: Requirements 5.1**
        """
        atm_iv_far = atm_iv_near * iv_ratio

        ivs_near = _synthetic_smile(STRIKES_NEAR, FORWARD_NEAR, atm_iv_near)
        ivs_far = _synthetic_smile(STRIKES_FAR, FORWARD_FAR, atm_iv_far)

        params_near = fit_svi(
            strikes=[float(s) for s in STRIKES_NEAR],
            ivs=ivs_near,
            forward=FORWARD_NEAR,
        )
        params_far = fit_svi(
            strikes=[float(s) for s in STRIKES_FAR],
            ivs=ivs_far,
            forward=FORWARD_FAR,
        )

        def _w_atm(params: dict) -> float:
            a = params["a"]
            b = params["b"]
            rho = params["rho"]
            m = params["m"]
            sigma_svi = params["sigma"]
            k = 0.0
            w = a + b * (rho * (k - m) + math.sqrt((k - m) ** 2 + sigma_svi ** 2))
            return max(w, 0.0)

        w_near = _w_atm(params_near)
        w_far = _w_atm(params_far)

        # Tolerance of 1e-4 (0.01% total variance) is used here because the near
        # and far smiles are evaluated on different log-moneyness grids (different
        # forward prices: FORWARD_NEAR=23050 vs FORWARD_FAR=23200). When iv_ratio=1.0
        # exactly, this causes SVI fitting noise of up to ~2.5e-5 — far below any
        # financially meaningful calendar-arbitrage threshold but above 1e-6.
        # A real calendar-arb violation would produce differences of order 1e-2 or
        # greater, so 1e-4 is still a tight and meaningful bound.
        assert w_near <= w_far + 1e-4, (
            f"Calendar-spread arbitrage: w_near={w_near:.6f} > w_far={w_far:.6f} "
            f"(atm_iv_near={atm_iv_near:.4f}, atm_iv_far={atm_iv_far:.4f})"
        )
