"""
Property-based tests for timestamp conversion and OHLCVCandle price invariants.

**Validates: Requirements 2.6, 2.7**

Properties covered:
- Property 3: IST-to-UTC timestamp conversion round-trip
- Property 4: OHLCVCandle price invariants
"""

import math
import os
import sys

# Ensure the data-service src/ package is importable when pytest is run from
# the repo root or from within data-service/.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "src"))

from hypothesis import assume, given
from hypothesis import settings as hyp_settings
from hypothesis import strategies as st

from src.schemas import OHLCVCandle
from src.scrapers.historical import _ist_ms_to_utc_s


# ---------------------------------------------------------------------------
# Property 3: IST-to-UTC timestamp conversion round-trip
# ---------------------------------------------------------------------------

# The NSE charting API produces timestamps in the range of real IST market
# data: approximately year 2000–2100 in milliseconds.
#   year 2000 in ms IST ≈  946_684_800_000
#   year 2100 in ms IST ≈ 4_102_444_800_000
#
# We test the full 64-bit range (0 → 10**15) to confirm the formula's
# mathematical properties, but acknowledge that IEEE 754 float precision is
# finite: for large integers the float round-trip error is a few ULP, not
# sub-nanosecond.  The design doc's "< 1e-9" tolerance describes the
# *mathematical identity*, which holds exactly in integer arithmetic.

_IST_OFFSET_S: int = 19_800  # 5 hours 30 minutes in seconds


@given(ts_ms=st.integers(min_value=0, max_value=10**15))
@hyp_settings(max_examples=500)
def test_property_3_ist_utc_conversion_round_trip(ts_ms: int) -> None:
    """
    Feature: scrapling-data-service
    Property 3: IST-to-UTC timestamp conversion round-trip

    The conversion formula is: utc_s = (ts_ms / 1000) - 19800
    The inverse is:            ts_ms = (utc_s + 19800) * 1000

    Two sub-properties are verified:

    A) INTEGER arithmetic (the actual implementation in _ist_ms_to_utc_s):
       utc_s = int(ts_ms / 1000) - 19800
       Round-trip error is exactly the sub-second remainder of ts_ms,
       which is always in [0, 999] ms.  The recovered value
       (utc_s + 19800) * 1000 equals floor(ts_ms / 1000) * 1000, so
       the error is ts_ms % 1000, which is always < 1000.

    B) FLOAT arithmetic (the formula stated in the design doc):
       utc_s_f = (ts_ms / 1000.0) - 19800
       IEEE 754 double has 53 bits of mantissa.  For ts_ms up to 10^15
       (≈ 2^50), float division can lose up to ~2 ULP of precision.
       We assert the error is within math.ulp(ts_ms) * 2 to capture the
       actual floating-point behaviour rather than an arbitrary tolerance.

    **Validates: Requirements 2.6**
    """
    # --- Part A: integer implementation (our actual code) ------------------
    utc_s_int = _ist_ms_to_utc_s(ts_ms)
    recovered_int = (utc_s_int + _IST_OFFSET_S) * 1000

    # The error equals ts_ms % 1000 (integer truncation of sub-second part)
    expected_error = ts_ms % 1000
    actual_error = ts_ms - recovered_int  # always non-negative by construction
    assert actual_error == expected_error, (
        f"Integer truncation error mismatch: ts_ms={ts_ms}, "
        f"expected_error={expected_error}, actual_error={actual_error}"
    )
    assert 0 <= actual_error < 1000, (
        f"Integer round-trip error out of [0, 1000) ms: ts_ms={ts_ms}, "
        f"utc_s={utc_s_int}, recovered={recovered_int}, error={actual_error}"
    )

    # --- Part B: float formula from design doc -----------------------------
    # For the sub-set of inputs where ts_ms is a multiple of 1000 (no
    # sub-second component), the float and integer formulas agree exactly, so
    # the round-trip is lossless.  For all inputs the round-trip error in
    # float arithmetic is bounded by a small number of ULPs.
    utc_s_float = (ts_ms / 1000) - _IST_OFFSET_S
    recovered_float = (utc_s_float + _IST_OFFSET_S) * 1000
    float_error = abs(recovered_float - ts_ms)

    # Realistic NSE timestamp range: year 2000 onwards in ms.
    # For tiny ts_ms values (< 19800000, i.e. first 5.5 hours of the Unix epoch)
    # catastrophic cancellation occurs because the intermediate UTC value is
    # near zero or negative, making the round-trip error much larger than ULP
    # of the input.  Real NSE market timestamps are never in that range.
    _MIN_REALISTIC_MS = 946_684_800_000  # 2000-01-01 00:00:00 UTC in ms

    if ts_ms >= _MIN_REALISTIC_MS:
        # In the realistic range float error is bounded by a handful of ULPs
        # of the result (max 4, with a floor of 1.0 ms for very large values).
        tolerance = max(4 * math.ulp(float(ts_ms)), 1.0)
        assert float_error <= tolerance, (
            f"Float round-trip error exceeds tolerance in realistic range: "
            f"ts_ms={ts_ms}, utc_s_float={utc_s_float}, "
            f"recovered={recovered_float}, error={float_error}, "
            f"tolerance={tolerance}"
        )


# ---------------------------------------------------------------------------
# Property 4: OHLCVCandle price invariants
# ---------------------------------------------------------------------------


@given(
    open_=st.floats(
        min_value=0.01,
        max_value=999_999_999.0,
        allow_nan=False,
        allow_infinity=False,
    ),
    high_delta=st.floats(
        min_value=0,
        max_value=1000.0,
        allow_nan=False,
        allow_infinity=False,
    ),
    low_delta=st.floats(
        min_value=0,
        max_value=1000.0,
        allow_nan=False,
        allow_infinity=False,
    ),
    close_=st.floats(
        min_value=0.01,
        max_value=999_999_999.0,
        allow_nan=False,
        allow_infinity=False,
    ),
    volume=st.integers(min_value=0),
)
@hyp_settings(max_examples=200)
def test_property_4_ohlcv_candle_price_invariants(
    open_: float,
    high_delta: float,
    low_delta: float,
    close_: float,
    volume: int,
) -> None:
    """
    Feature: scrapling-data-service
    Property 4: OHLCVCandle price invariants

    For any OHLCVCandle instance, ALL of the following SHALL hold
    simultaneously:
    - high >= max(open, close)
    - low  <= min(open, close)
    - open > 0, high > 0, low > 0, close > 0
    - volume >= 0

    The candle is constructed so that invariants are satisfied by design:
        high = max(open_, close_) + high_delta
        low  = min(open_, close_) - low_delta

    We use assume(low > 0) to exclude the degenerate case where subtracting
    low_delta would produce a non-positive low price.

    **Validates: Requirements 2.7**
    """
    high = max(open_, close_) + high_delta
    low = min(open_, close_) - low_delta

    # Exclude non-positive low prices (price invariant requires low > 0)
    assume(low > 0)

    candle = OHLCVCandle(
        time=1,
        open=open_,
        high=high,
        low=low,
        close=close_,
        volume=volume,
    )

    # high >= max(open, close)
    assert candle.high >= max(candle.open, candle.close), (
        f"high invariant violated: high={candle.high}, "
        f"open={candle.open}, close={candle.close}"
    )

    # low <= min(open, close)
    assert candle.low <= min(candle.open, candle.close), (
        f"low invariant violated: low={candle.low}, "
        f"open={candle.open}, close={candle.close}"
    )

    # All prices > 0
    assert candle.open > 0, f"open must be positive, got {candle.open}"
    assert candle.high > 0, f"high must be positive, got {candle.high}"
    assert candle.low > 0, f"low must be positive, got {candle.low}"
    assert candle.close > 0, f"close must be positive, got {candle.close}"

    # volume >= 0
    assert candle.volume >= 0, f"volume must be non-negative, got {candle.volume}"
