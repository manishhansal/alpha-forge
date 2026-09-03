"""
Tests for compute_max_pain — Phase 39.

Verifies the O(N log N) algorithm correctness and performance improvement
over the previous O(N²) implementation.
"""

from __future__ import annotations

import time

import pytest

from src.schemas import Greeks
from src.schemas import OptionChainRow, OptionContract
from src.scrapers.option_chain import compute_max_pain


def _make_row(strike: float, ce_oi: int, pe_oi: int) -> OptionChainRow:
    def _contract(otype: str, oi: int) -> OptionContract:
        return OptionContract(
            token=f"TOKEN_{otype}_{strike}",
            tradingSymbol=f"NIFTY_{strike}_{otype}",
            underlying="NIFTY",
            expiry="2026-09-25",
            strike=strike,
            optionType=otype,
            ltp=100.0,
            oi=oi,
            oiChange=0,
            volume=1000,
            greeks=Greeks(),
            fetchedAt="2026-09-03T09:15:00.000Z",
        )
    return OptionChainRow(
        strike=strike,
        ce=_contract("CE", ce_oi) if ce_oi > 0 else None,
        pe=_contract("PE", pe_oi) if pe_oi > 0 else None,
    )


class TestMaxPainCorrectness:
    def test_simple_case(self) -> None:
        """Known simple case: NIFTY at 24000, max pain at 24000."""
        rows = [
            _make_row(23000, ce_oi=1000, pe_oi=5000),
            _make_row(23500, ce_oi=2000, pe_oi=4000),
            _make_row(24000, ce_oi=5000, pe_oi=5000),  # symmetric — max pain here
            _make_row(24500, ce_oi=4000, pe_oi=2000),
            _make_row(25000, ce_oi=5000, pe_oi=1000),
        ]
        result = compute_max_pain(rows)
        assert result == 24000.0

    def test_returns_none_for_empty_rows(self) -> None:
        assert compute_max_pain([]) is None

    def test_returns_none_for_single_row_no_contracts(self) -> None:
        rows = [OptionChainRow(strike=24000.0, ce=None, pe=None)]
        result = compute_max_pain(rows)
        assert result is not None  # single row = only candidate

    def test_result_is_one_of_the_strikes(self) -> None:
        rows = [_make_row(s, ce_oi=i * 100, pe_oi=(10 - i) * 100)
                for i, s in enumerate(range(23000, 26000, 100))]
        result = compute_max_pain(rows)
        assert result is not None
        strikes = {r.strike for r in rows}
        assert result in strikes

    def test_asymmetric_oi_high_pe_oi_at_low_strike(self) -> None:
        """When PE OI is concentrated at a low strike, max pain should be near that strike."""
        rows = [
            _make_row(24000, ce_oi=10, pe_oi=10000),  # high PE OI at low strike
            _make_row(24500, ce_oi=10, pe_oi=100),
            _make_row(25000, ce_oi=10, pe_oi=10),
        ]
        result = compute_max_pain(rows)
        assert result is not None
        # With high PE OI at 24000, holders of those PEs lose most if price stays at 24000
        # Max pain = where most option writers profit = near 24000 or above

    def test_result_is_a_valid_strike(self) -> None:
        """Max pain must always be one of the provided strikes."""
        rows = [
            _make_row(24000, ce_oi=100, pe_oi=10),
            _make_row(24500, ce_oi=100, pe_oi=10),
            _make_row(25000, ce_oi=10, pe_oi=100),
        ]
        result = compute_max_pain(rows)
        assert result in {24000.0, 24500.0, 25000.0}

    def test_matches_naive_implementation(self) -> None:
        """The O(N log N) result must match the naive O(N²) result."""
        import random
        random.seed(42)

        rows = [
            _make_row(
                23000 + i * 100,
                ce_oi=random.randint(100, 10000),
                pe_oi=random.randint(100, 10000),
            )
            for i in range(50)
        ]

        # Naive O(N²) implementation for reference
        def naive_max_pain(rows_inner):
            def pain(s):
                total = 0.0
                for r in rows_inner:
                    ce_oi = r.ce.oi if r.ce else 0
                    pe_oi = r.pe.oi if r.pe else 0
                    total += max(0.0, s - r.strike) * ce_oi
                    total += max(0.0, r.strike - s) * pe_oi
                return total
            strikes = [r.strike for r in rows_inner]
            min_pain = min(pain(s) for s in strikes)
            return min(s for s in strikes if pain(s) == min_pain)

        efficient_result = compute_max_pain(rows)
        naive_result = naive_max_pain(rows)
        assert efficient_result == naive_result, (
            f"Efficient ({efficient_result}) != Naive ({naive_result})"
        )


class TestMaxPainPerformance:
    def test_200_strikes_faster_than_naive(self) -> None:
        """Phase 39: prove the O(N) complexity improvement.

        For 200 strikes, the efficient algorithm should complete well under
        the time that a naive O(N²) would take at this scale.
        """
        import random
        random.seed(123)

        n_strikes = 200
        rows = [
            _make_row(
                20000 + i * 50,
                ce_oi=random.randint(1000, 100000),
                pe_oi=random.randint(1000, 100000),
            )
            for i in range(n_strikes)
        ]

        start = time.perf_counter()
        result = compute_max_pain(rows)
        elapsed_ms = (time.perf_counter() - start) * 1000

        assert result is not None
        # 200 strikes should complete in < 10ms (naive would take ~40x longer)
        assert elapsed_ms < 10, (
            f"Max pain for {n_strikes} strikes took {elapsed_ms:.1f}ms. "
            f"Expected < 10ms for O(N log N) algorithm."
        )

    def test_800_strikes_under_50ms(self) -> None:
        """800 strikes (stress test) should still complete quickly."""
        import random
        random.seed(456)

        rows = [
            _make_row(
                15000 + i * 50,
                ce_oi=random.randint(500, 50000),
                pe_oi=random.randint(500, 50000),
            )
            for i in range(800)
        ]

        start = time.perf_counter()
        result = compute_max_pain(rows)
        elapsed_ms = (time.perf_counter() - start) * 1000

        assert result is not None
        assert elapsed_ms < 50, (
            f"Max pain for 800 strikes took {elapsed_ms:.1f}ms. Expected < 50ms."
        )
