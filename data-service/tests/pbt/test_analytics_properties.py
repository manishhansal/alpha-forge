"""
Property-based tests for option chain analytics pure functions.

Property 7:  PCR ratio computation
    Validates: Requirements 4.5, 4.8

Property 8:  Max pain minimises ITM option value
    Validates: Requirements 4.6

Property 9:  ATM IV is average of 5 nearest-to-spot IVs
    Validates: Requirements 4.7

Property 10: OI wall strikes are correct argmax
    Validates: Requirements 4.9
"""

from __future__ import annotations

from typing import List, Optional, Tuple

import pytest
from hypothesis import assume, given, settings as hyp_settings
from hypothesis import strategies as st

from src.schemas import Greeks, OptionChainRow, OptionContract
from src.scrapers.option_chain import (
    compute_atm_iv,
    compute_max_pain,
    compute_oi_walls,
    compute_pcr_oi,
    compute_pcr_volume,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_FETCHED_AT = "2025-01-01T00:00:00.000Z"
_EXPIRY = "2025-01-30"


def _make_contract(
    underlying: str,
    strike: float,
    option_type: str,
    oi: int,
    volume: int = 0,
    iv: Optional[float] = None,
) -> OptionContract:
    """Build a minimal OptionContract for testing analytics functions."""
    return OptionContract(
        token=f"{underlying}{strike}{option_type}",
        tradingSymbol=f"{underlying}{strike}{option_type}",
        underlying=underlying,
        expiry=_EXPIRY,
        strike=strike,
        optionType=option_type,
        ltp=None,
        bid=None,
        ask=None,
        oi=oi,
        oiChange=0,
        volume=volume,
        greeks=Greeks(iv=iv),
        fetchedAt=_FETCHED_AT,
    )


def _build_rows(
    strikes_and_oi: List[Tuple[float, int, int]],
) -> List[OptionChainRow]:
    """Build OptionChainRow list from (strike, ce_oi, pe_oi) triples.

    Duplicate strike values are deduplicated by summing their OI values so
    that every row has a unique strike (required for clean argmax assertions).
    """
    merged: dict[float, Tuple[int, int]] = {}
    for strike, ce_oi, pe_oi in strikes_and_oi:
        existing_ce, existing_pe = merged.get(strike, (0, 0))
        merged[strike] = (existing_ce + ce_oi, existing_pe + pe_oi)

    rows: List[OptionChainRow] = []
    for strike in sorted(merged):
        ce_oi, pe_oi = merged[strike]
        ce = _make_contract("TEST", strike, "CE", ce_oi) if ce_oi > 0 else None
        pe = _make_contract("TEST", strike, "PE", pe_oi) if pe_oi > 0 else None
        rows.append(OptionChainRow(strike=strike, ce=ce, pe=pe))
    return rows


def _build_rows_with_iv(
    strikes_and_oi: List[Tuple[float, int, int]],
    iv_value: float = 20.0,
) -> List[OptionChainRow]:
    """Build rows where every contract with OI > 0 also has an IV value."""
    merged: dict[float, Tuple[int, int]] = {}
    for strike, ce_oi, pe_oi in strikes_and_oi:
        existing_ce, existing_pe = merged.get(strike, (0, 0))
        merged[strike] = (existing_ce + ce_oi, existing_pe + pe_oi)

    rows: List[OptionChainRow] = []
    for strike in sorted(merged):
        ce_oi, pe_oi = merged[strike]
        ce = (
            _make_contract("TEST", strike, "CE", ce_oi, iv=iv_value)
            if ce_oi > 0
            else None
        )
        pe = (
            _make_contract("TEST", strike, "PE", pe_oi, iv=iv_value)
            if pe_oi > 0
            else None
        )
        rows.append(OptionChainRow(strike=strike, ce=ce, pe=pe))
    return rows


def _total_itm_value(rows: List[OptionChainRow], s: float) -> float:
    """Reference implementation of the ITM pain function.

    pain(S) = Σ_k [ max(0, S - k) × CE_OI_k  +  max(0, k - S) × PE_OI_k ]
    """
    total = 0.0
    for row in rows:
        ce_oi = row.ce.oi if row.ce else 0
        pe_oi = row.pe.oi if row.pe else 0
        total += max(0.0, s - row.strike) * ce_oi
        total += max(0.0, row.strike - s) * pe_oi
    return total


# ---------------------------------------------------------------------------
# Property 7: PCR ratio computation
# ---------------------------------------------------------------------------


@given(
    ce_oi=st.integers(min_value=0, max_value=10**9),
    pe_oi=st.integers(min_value=0, max_value=10**9),
)
@hyp_settings(max_examples=200)
def test_property_7a_pcr_oi_computation(ce_oi: int, pe_oi: int) -> None:
    """**Validates: Requirements 4.5**

    Feature: scrapling-data-service, Property 7: PCR ratio computation

    For any option chain with rows where totalCeOi > 0, analytics.pcrOi SHALL
    equal round(totalPeOi / totalCeOi, 2) and SHALL be non-negative.
    When totalCeOi == 0, pcrOi SHALL be None.
    """
    # Build a minimal single-row chain that produces the exact totals.
    # CE row carries ce_oi; PE row carries pe_oi.
    rows: List[OptionChainRow] = []
    if ce_oi > 0 or pe_oi > 0:
        ce = _make_contract("TEST", 100.0, "CE", ce_oi) if ce_oi > 0 else None
        pe = _make_contract("TEST", 100.0, "PE", pe_oi) if pe_oi > 0 else None
        rows = [OptionChainRow(strike=100.0, ce=ce, pe=pe)]
    # else: empty rows — ce_oi == pe_oi == 0

    result = compute_pcr_oi(rows)

    if ce_oi == 0:
        assert result is None, (
            f"Expected None when ce_oi=0, got {result}"
        )
    else:
        expected = round(pe_oi / ce_oi, 2)
        assert result == expected, (
            f"PCR OI mismatch: got {result}, expected {expected} "
            f"(pe_oi={pe_oi}, ce_oi={ce_oi})"
        )
        assert result >= 0, f"PCR OI must be non-negative, got {result}"


@given(
    ce_vol=st.integers(min_value=0, max_value=10**9),
    pe_vol=st.integers(min_value=0, max_value=10**9),
)
@hyp_settings(max_examples=200)
def test_property_7b_pcr_volume_computation(ce_vol: int, pe_vol: int) -> None:
    """**Validates: Requirements 4.8**

    Feature: scrapling-data-service, Property 7: PCR ratio computation (volume)

    The same rule applies to pcrVolume: when totalCeVolume > 0,
    pcrVolume = round(totalPeVolume / totalCeVolume, 2);
    when totalCeVolume == 0, pcrVolume is None.
    """
    rows: List[OptionChainRow] = []
    if ce_vol > 0 or pe_vol > 0:
        ce = (
            _make_contract("TEST", 100.0, "CE", oi=1, volume=ce_vol)
            if ce_vol > 0
            else None
        )
        pe = (
            _make_contract("TEST", 100.0, "PE", oi=1, volume=pe_vol)
            if pe_vol > 0
            else None
        )
        rows = [OptionChainRow(strike=100.0, ce=ce, pe=pe)]

    result = compute_pcr_volume(rows)

    if ce_vol == 0:
        assert result is None, (
            f"Expected None when ce_vol=0, got {result}"
        )
    else:
        expected = round(pe_vol / ce_vol, 2)
        assert result == expected, (
            f"PCR Volume mismatch: got {result}, expected {expected} "
            f"(pe_vol={pe_vol}, ce_vol={ce_vol})"
        )
        assert result >= 0, f"PCR Volume must be non-negative, got {result}"


# ---------------------------------------------------------------------------
# Property 8: Max pain minimises ITM option value
# ---------------------------------------------------------------------------


@given(
    strikes_and_oi=st.lists(
        st.tuples(
            st.floats(
                min_value=100,
                max_value=100_000,
                allow_nan=False,
                allow_infinity=False,
            ),
            st.integers(min_value=0, max_value=10**7),  # CE OI
            st.integers(min_value=0, max_value=10**7),  # PE OI
        ),
        min_size=1,
        max_size=50,
    )
)
@hyp_settings(max_examples=200)
def test_property_8_max_pain_minimises_itm_value(
    strikes_and_oi: List[Tuple[float, int, int]],
) -> None:
    """**Validates: Requirements 4.6**

    Feature: scrapling-data-service, Property 8: max pain minimises ITM option value

    For any option chain with at least one strike, analytics.maxPain SHALL be
    the strike price S* such that pain(S*) <= pain(S) for all other strikes S.
    When multiple strikes share the minimum pain, the one with the highest CE
    OI is selected; lowest strike wins on a further tie.
    """
    rows = _build_rows(strikes_and_oi)
    max_pain_strike = compute_max_pain(rows)

    # compute_max_pain returns None only for empty rows; rows is non-empty here.
    assert max_pain_strike is not None, "Expected a strike, got None for non-empty rows"

    pain_at_winner = _total_itm_value(rows, max_pain_strike)

    for row in rows:
        pain_at_candidate = _total_itm_value(rows, row.strike)
        assert pain_at_winner <= pain_at_candidate, (
            f"Max pain violation: pain({max_pain_strike}) = {pain_at_winner:.2f} "
            f"> pain({row.strike}) = {pain_at_candidate:.2f}"
        )


@given(
    strikes_and_oi=st.lists(
        st.tuples(
            st.floats(
                min_value=100,
                max_value=100_000,
                allow_nan=False,
                allow_infinity=False,
            ),
            st.integers(min_value=0, max_value=10**7),
            st.integers(min_value=0, max_value=10**7),
        ),
        min_size=2,
        max_size=50,
    )
)
@hyp_settings(max_examples=200)
def test_property_8_max_pain_tiebreak_uses_highest_ce_oi(
    strikes_and_oi: List[Tuple[float, int, int]],
) -> None:
    """**Validates: Requirements 4.6**

    When multiple strikes share the minimum pain value, compute_max_pain
    SHALL return the one with the highest CE OI.  When CE OI is also tied,
    it SHALL return the lowest strike among the tied candidates.
    """
    rows = _build_rows(strikes_and_oi)
    max_pain_strike = compute_max_pain(rows)
    assert max_pain_strike is not None

    min_pain = _total_itm_value(rows, max_pain_strike)
    # Collect all strikes that achieve minimum pain.
    candidates = [
        row.strike
        for row in rows
        if _total_itm_value(rows, row.strike) == min_pain
    ]

    if len(candidates) == 1:
        return  # No tie — nothing to verify beyond Property 8a.

    # Among tied candidates, the one with the highest CE OI should win.
    def ce_oi_at(s: float) -> int:
        row = next((r for r in rows if r.strike == s), None)
        return row.ce.oi if row and row.ce else 0

    max_ce_oi = max(ce_oi_at(s) for s in candidates)
    tied_by_ce = [s for s in candidates if ce_oi_at(s) == max_ce_oi]

    # Final tie-break: lowest strike wins.
    expected = min(tied_by_ce)
    assert max_pain_strike == expected, (
        f"Tie-break failure: expected strike {expected} (highest CE OI among "
        f"min-pain candidates), got {max_pain_strike}. "
        f"Candidates: {candidates}, CE OIs: {[ce_oi_at(s) for s in candidates]}"
    )


# ---------------------------------------------------------------------------
# Property 9: ATM IV is average of 5 nearest-to-spot IVs
# ---------------------------------------------------------------------------


@given(
    spot=st.floats(
        min_value=1_000,
        max_value=100_000,
        allow_nan=False,
        allow_infinity=False,
    ),
    num_rows=st.integers(min_value=3, max_value=20),
)
@hyp_settings(max_examples=100)
def test_property_9_atm_iv_is_mean_of_nearest_5(
    spot: float, num_rows: int
) -> None:
    """**Validates: Requirements 4.7**

    Feature: scrapling-data-service, Property 9: ATM IV is average of 5 nearest-to-spot IVs

    For any option chain with a known spot price and at least 2 option
    contracts with non-zero OI and non-null IV within the 5 nearest strikes,
    analytics.atmIv SHALL equal the simple arithmetic mean of those contracts'
    IV values, rounded to 2 decimal places.  When fewer than 2 qualifying
    contracts exist, atmIv SHALL be None.
    """
    # Build rows centred around spot with evenly spaced strikes.
    step = spot / (num_rows + 1)
    base = spot - (num_rows // 2) * step
    strikes_and_oi = [
        (round(base + i * step, 2), 1, 1)  # CE OI=1, PE OI=1
        for i in range(num_rows)
    ]
    assume(len({s for s, _, _ in strikes_and_oi}) == len(strikes_and_oi))

    # Use a unique IV per row so we can verify the exact mean.
    # IV values: 10.0, 11.0, 12.0, ... (one per row)
    iv_values = [10.0 + i for i in range(num_rows)]

    merged: dict[float, float] = {}
    for (strike, _, _), iv in zip(strikes_and_oi, iv_values):
        merged[strike] = iv

    rows: List[OptionChainRow] = []
    for strike in sorted(merged):
        iv = merged[strike]
        ce = _make_contract("TEST", strike, "CE", oi=1, iv=iv)
        pe = _make_contract("TEST", strike, "PE", oi=1, iv=iv)
        rows.append(OptionChainRow(strike=strike, ce=ce, pe=pe))

    result = compute_atm_iv(rows, spot)

    # Manually replicate the reference algorithm from the design doc:
    # sort by |strike - spot|, take up to 5 nearest, collect IVs from
    # contracts with OI > 0 and non-null IV.
    sorted_rows = sorted(rows, key=lambda r: abs(r.strike - spot))
    expected_ivs: List[float] = []
    for row in sorted_rows[:5]:
        if row.ce and row.ce.greeks.iv is not None and row.ce.oi > 0:
            expected_ivs.append(row.ce.greeks.iv)
        if row.pe and row.pe.greeks.iv is not None and row.pe.oi > 0:
            expected_ivs.append(row.pe.greeks.iv)

    if len(expected_ivs) < 2:
        assert result is None, (
            f"Expected None (< 2 qualifying IVs), got {result}"
        )
    else:
        expected = round(sum(expected_ivs) / len(expected_ivs), 2)
        assert result == expected, (
            f"ATM IV mismatch: got {result}, expected {expected} "
            f"(spot={spot}, qualifying IVs={expected_ivs})"
        )


def test_property_9_atm_iv_none_when_spot_is_none() -> None:
    """ATM IV SHALL be None when spot is None."""
    rows = _build_rows_with_iv([(1000.0, 1, 1), (2000.0, 1, 1)], iv_value=15.0)
    assert compute_atm_iv(rows, None) is None


def test_property_9_atm_iv_none_when_fewer_than_2_valid_ivs() -> None:
    """ATM IV SHALL be None when fewer than 2 qualifying (OI>0, IV non-null) contracts exist."""
    rows: List[OptionChainRow] = [
        # Only one contract with OI > 0 and a real IV — not enough.
        OptionChainRow(
            strike=100.0,
            ce=_make_contract("TEST", 100.0, "CE", oi=1, iv=20.0),
            pe=None,
        )
    ]
    assert compute_atm_iv(rows, 100.0) is None


@given(
    spot=st.floats(
        min_value=1_000,
        max_value=100_000,
        allow_nan=False,
        allow_infinity=False,
    ),
)
@hyp_settings(max_examples=100)
def test_property_9_atm_iv_uses_only_5_nearest_strikes(spot: float) -> None:
    """**Validates: Requirements 4.7**

    When more than 5 strikes are present, only the 5 nearest to spot
    contribute IVs.  Contracts beyond the 5th nearest MUST be excluded.
    """
    # Place 10 strikes in a known pattern.  Strikes 1-5 are very close to
    # spot (within ±50); strikes 6-10 are far away (>5000).
    near_offsets = [10.0 * i for i in range(1, 6)]   # 10, 20, 30, 40, 50
    far_offsets = [6_000.0 + 100.0 * i for i in range(5)]

    near_iv = 15.0
    far_iv = 99.0   # Must NOT appear in the computed ATM IV

    rows: List[OptionChainRow] = []
    for offset in near_offsets:
        strike = round(spot + offset, 2)
        rows.append(
            OptionChainRow(
                strike=strike,
                ce=_make_contract("TEST", strike, "CE", oi=1, iv=near_iv),
                pe=_make_contract("TEST", strike, "PE", oi=1, iv=near_iv),
            )
        )
    for offset in far_offsets:
        strike = round(spot + offset, 2)
        rows.append(
            OptionChainRow(
                strike=strike,
                ce=_make_contract("TEST", strike, "CE", oi=1, iv=far_iv),
                pe=_make_contract("TEST", strike, "PE", oi=1, iv=far_iv),
            )
        )

    result = compute_atm_iv(rows, spot)

    # All contributing IVs should be near_iv (15.0); mean is 15.0 rounded to 2dp.
    assert result == round(near_iv, 2), (
        f"ATM IV included far-strike IVs: got {result}, expected {near_iv}. "
        f"Far IV was {far_iv} (spot={spot})"
    )


# ---------------------------------------------------------------------------
# Property 10: OI wall strikes are correct argmax
# ---------------------------------------------------------------------------


@given(
    strike_oi_data=st.lists(
        st.tuples(
            st.floats(
                min_value=100,
                max_value=100_000,
                allow_nan=False,
                allow_infinity=False,
            ),
            st.integers(min_value=0, max_value=10**7),  # CE OI
            st.integers(min_value=0, max_value=10**7),  # PE OI
        ),
        min_size=1,
        max_size=30,
    )
)
@hyp_settings(max_examples=200)
def test_property_10_oi_wall_strikes_are_argmax(
    strike_oi_data: List[Tuple[float, int, int]],
) -> None:
    """**Validates: Requirements 4.9**

    Feature: scrapling-data-service, Property 10: OI wall strikes are correct argmax

    maxCeOiStrike SHALL be the strike with the strictly highest CE open
    interest across all rows with a non-null CE contract.  Tie-break: lowest
    strike.  Same rule applies to maxPeOiStrike for PE.
    """
    rows = _build_rows(strike_oi_data)
    max_ce_strike, max_pe_strike = compute_oi_walls(rows)

    # --- CE wall ---
    ce_rows = [(r.strike, r.ce.oi) for r in rows if r.ce]
    if not ce_rows:
        assert max_ce_strike is None, (
            f"Expected None for maxCeOiStrike when no CE contracts exist, "
            f"got {max_ce_strike}"
        )
    else:
        assert max_ce_strike is not None
        winner_ce_oi = next(
            r.ce.oi for r in rows if r.ce and r.strike == max_ce_strike
        )
        max_possible_ce_oi = max(oi for _, oi in ce_rows)

        # The winner must achieve the maximum CE OI.
        assert winner_ce_oi == max_possible_ce_oi, (
            f"maxCeOiStrike {max_ce_strike} has CE OI {winner_ce_oi}, "
            f"but max possible is {max_possible_ce_oi}"
        )

        # Among all strikes that achieve the max CE OI, the lowest strike wins.
        tied_strikes = [s for s, oi in ce_rows if oi == max_possible_ce_oi]
        assert max_ce_strike == min(tied_strikes), (
            f"Tie-break failure for maxCeOiStrike: got {max_ce_strike}, "
            f"expected {min(tied_strikes)} (tied at OI={max_possible_ce_oi})"
        )

    # --- PE wall ---
    pe_rows = [(r.strike, r.pe.oi) for r in rows if r.pe]
    if not pe_rows:
        assert max_pe_strike is None, (
            f"Expected None for maxPeOiStrike when no PE contracts exist, "
            f"got {max_pe_strike}"
        )
    else:
        assert max_pe_strike is not None
        winner_pe_oi = next(
            r.pe.oi for r in rows if r.pe and r.strike == max_pe_strike
        )
        max_possible_pe_oi = max(oi for _, oi in pe_rows)

        assert winner_pe_oi == max_possible_pe_oi, (
            f"maxPeOiStrike {max_pe_strike} has PE OI {winner_pe_oi}, "
            f"but max possible is {max_possible_pe_oi}"
        )

        tied_strikes = [s for s, oi in pe_rows if oi == max_possible_pe_oi]
        assert max_pe_strike == min(tied_strikes), (
            f"Tie-break failure for maxPeOiStrike: got {max_pe_strike}, "
            f"expected {min(tied_strikes)} (tied at OI={max_possible_pe_oi})"
        )
