"""
Failing tests for Task 8.1 — TA-Lib migration of technical.py.

These tests compare talib.* vectorised outputs against the existing pure-Python
implementations in src/features/technical.py. They are EXPECTED TO FAIL until
Task 8.2 installs the TA-Lib C library (TA-Lib==0.6.*).

Validates: Requirements 6.1, 6.6
"""

import numpy as np
import pandas as pd
import pytest

# This import will raise ModuleNotFoundError until Task 8.2 installs TA-Lib.
# That is intentional — it makes all tests in this file fail at collection time,
# confirming the TDD red phase.
import talib  # noqa: E402  (fails until TA-Lib is installed)

from src.features.technical import compute_atr, compute_rsi

# ---------------------------------------------------------------------------
# Synthetic price series fixture
# ---------------------------------------------------------------------------

N_BARS = 1000
RNG_SEED = 42


def _make_ohlcv(n: int = N_BARS, seed: int = RNG_SEED) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """
    Generate a deterministic 1000-bar synthetic OHLCV series.

    Uses a geometric random walk for close prices so the series resembles
    real market data (no artificial periodicity).

    Returns (high, low, close, volume) as float64 numpy arrays.
    """
    rng = np.random.default_rng(seed)
    returns = rng.normal(0.0, 0.01, n)
    close = 1000.0 * np.cumprod(1 + returns)

    # Intrabar ranges: high = close * (1 + small positive), low = close * (1 - small positive)
    high_offset = np.abs(rng.normal(0.005, 0.003, n))
    low_offset = np.abs(rng.normal(0.005, 0.003, n))
    high = close * (1 + high_offset)
    low = close * (1 - low_offset)

    # Ensure high >= close >= low always holds
    high = np.maximum(high, close)
    low = np.minimum(low, close)

    volume = rng.uniform(1e5, 1e7, n)

    return high.astype(np.float64), low.astype(np.float64), close.astype(np.float64), volume.astype(np.float64)


@pytest.fixture(scope="module")
def ohlcv_arrays() -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    return _make_ohlcv(N_BARS, RNG_SEED)


# ---------------------------------------------------------------------------
# Helper to drop leading NaN values from both arrays before comparison
# ---------------------------------------------------------------------------

def _valid_overlap(a: np.ndarray, b: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Return the suffix of a and b where both are finite (non-NaN, non-Inf)."""
    valid = np.isfinite(a) & np.isfinite(b)
    return a[valid], b[valid]


# ---------------------------------------------------------------------------
# Test 1: EMA(20) — talib vs existing ewm(span=20, adjust=False)
# Tolerance: 1e-6 (Requirement 6.6)
# ---------------------------------------------------------------------------

class TestEMAEquivalence:
    """
    talib.EMA uses the standard exponential moving average with
    multiplier k = 2 / (period + 1), which corresponds to pandas
    ewm(span=period, adjust=False). The existing implementation in
    compute_ema_stack_score uses the same formula.

    Note: TA-Lib seeds EMA with SMA(period) at bar `period-1`, while pandas
    ewm(adjust=False) seeds from bar 0. This causes a difference in the
    warm-up region that decays exponentially. The tolerance in Requirement 6.6
    applies to the post-warm-up stable region (after 5× the period = 100 bars).

    Validates: Requirements 6.1, 6.6
    """

    EMA_PERIOD = 20
    TOLERANCE = 1e-6
    WARMUP_BARS = 200  # TA-Lib seeds with SMA(period); convergence to 1e-6 requires ~200 bars

    def test_ema_matches_pandas_ewm_on_1000_bar_series(self, ohlcv_arrays):
        """
        talib.EMA(close, 20) must match pandas ewm(span=20, adjust=False)
        to within 1e-6 on the stable (post-warm-up) portion of a 1000-bar series.

        TA-Lib seeds with SMA(period) while pandas starts from bar 0; the two
        converge to machine-epsilon after ~200 bars (10× the period). The
        1e-6 tolerance applies to the post-warm-up region.

        Validates: Requirement 6.6
        """
        _, _, close, _ = ohlcv_arrays
        close_series = pd.Series(close)

        # TA-Lib vectorised EMA
        talib_ema = talib.EMA(close, timeperiod=self.EMA_PERIOD)

        # Existing pandas implementation (same formula as compute_ema_stack_score)
        pandas_ema = close_series.ewm(span=self.EMA_PERIOD, adjust=False).mean().to_numpy()

        # Compare only the post-warm-up region where both implementations have converged
        talib_stable = talib_ema[self.WARMUP_BARS:]
        pandas_stable = pandas_ema[self.WARMUP_BARS:]

        talib_valid, pandas_valid = _valid_overlap(talib_stable, pandas_stable)

        assert len(talib_valid) > 0, "No valid (non-NaN) overlap between talib and pandas EMA"
        max_abs_diff = np.max(np.abs(talib_valid - pandas_valid))
        assert max_abs_diff <= self.TOLERANCE, (
            f"EMA(20) max absolute difference {max_abs_diff:.2e} exceeds tolerance {self.TOLERANCE:.0e} "
            f"in the post-warm-up region (bars {self.WARMUP_BARS}+). "
            f"talib and pandas ewm implementations diverge."
        )

    def test_ema_output_length_matches_input(self, ohlcv_arrays):
        """talib.EMA output length must equal input length."""
        _, _, close, _ = ohlcv_arrays
        result = talib.EMA(close, timeperiod=self.EMA_PERIOD)
        assert len(result) == len(close), (
            f"talib.EMA output length {len(result)} != input length {len(close)}"
        )

    def test_ema_first_valid_bar_index(self, ohlcv_arrays):
        """
        talib.EMA(close, 20) should produce its first non-NaN value at index 19
        (0-indexed), consistent with a 20-period lookback.
        """
        _, _, close, _ = ohlcv_arrays
        result = talib.EMA(close, timeperiod=self.EMA_PERIOD)
        first_valid = np.argmax(np.isfinite(result))
        assert first_valid == self.EMA_PERIOD - 1, (
            f"First valid EMA bar at index {first_valid}, expected {self.EMA_PERIOD - 1}"
        )


# ---------------------------------------------------------------------------
# Test 2: RSI(14) — talib vs compute_rsi
# Tolerance: 0.01% relative (Requirement 6.1)
# ---------------------------------------------------------------------------

class TestRSIEquivalence:
    """
    Both talib.RSI and compute_rsi implement Wilder's RSI using an exponential
    moving average with alpha = 1/period (Wilder's smoothing).

    The comparison is made only on bars where both series have settled
    (skip the first 2*period bars to allow warm-up to converge).

    Validates: Requirement 6.1
    """

    RSI_PERIOD = 14
    RELATIVE_TOLERANCE = 0.0001  # 0.01%
    WARMUP_BARS = 100  # skip first 100 bars to ensure both implementations have converged

    def test_rsi_matches_existing_implementation_to_0_01_pct(self, ohlcv_arrays):
        """
        talib.RSI(close, 14) must match compute_rsi(close_series, 14) to within
        0.01% on the stable (post-warm-up) portion of a 1000-bar series.

        Validates: Requirement 6.1
        """
        _, _, close, _ = ohlcv_arrays
        close_series = pd.Series(close)

        talib_rsi = talib.RSI(close, timeperiod=self.RSI_PERIOD)
        legacy_rsi = compute_rsi(close_series, self.RSI_PERIOD).to_numpy()

        # Restrict comparison to the post-warmup stable region
        talib_stable = talib_rsi[self.WARMUP_BARS:]
        legacy_stable = legacy_rsi[self.WARMUP_BARS:]

        valid_mask = np.isfinite(talib_stable) & np.isfinite(legacy_stable)
        assert valid_mask.sum() > 0, "No valid overlap after warmup period"

        talib_v = talib_stable[valid_mask]
        legacy_v = legacy_stable[valid_mask]

        # Relative tolerance: |a - b| / max(|b|, 1) <= tol
        # Use max(|b|, 1) to avoid division-by-zero for near-zero RSI values
        rel_diff = np.abs(talib_v - legacy_v) / np.maximum(np.abs(legacy_v), 1.0)
        max_rel_diff = np.max(rel_diff)

        assert max_rel_diff <= self.RELATIVE_TOLERANCE, (
            f"RSI(14) max relative difference {max_rel_diff:.4%} exceeds 0.01% tolerance. "
            f"talib and legacy implementations diverge after warm-up."
        )

    def test_rsi_values_in_valid_range(self, ohlcv_arrays):
        """talib.RSI output must be in [0, 100] on all finite values."""
        _, _, close, _ = ohlcv_arrays
        result = talib.RSI(close, timeperiod=self.RSI_PERIOD)
        finite = result[np.isfinite(result)]
        assert np.all(finite >= 0.0), "RSI has values below 0"
        assert np.all(finite <= 100.0), "RSI has values above 100"

    def test_rsi_output_length_matches_input(self, ohlcv_arrays):
        """talib.RSI output length must equal input length."""
        _, _, close, _ = ohlcv_arrays
        result = talib.RSI(close, timeperiod=self.RSI_PERIOD)
        assert len(result) == len(close)


# ---------------------------------------------------------------------------
# Test 3: ATR(14) — talib vs compute_atr
# Tolerance: 0.01% relative (Requirement 6.1)
# ---------------------------------------------------------------------------

class TestATREquivalence:
    """
    Both talib.ATR and compute_atr implement Wilder's ATR using an exponential
    moving average of true range with alpha = 1/period.

    Validates: Requirement 6.1
    """

    ATR_PERIOD = 14
    RELATIVE_TOLERANCE = 0.0001  # 0.01%
    WARMUP_BARS = 100  # allow warm-up to converge

    def test_atr_matches_existing_implementation_to_0_01_pct(self, ohlcv_arrays):
        """
        talib.ATR(high, low, close, 14) must match compute_atr(h, l, c, 14)
        to within 0.01% on the stable (post-warm-up) portion of a 1000-bar series.

        Validates: Requirement 6.1
        """
        high, low, close, _ = ohlcv_arrays
        close_series = pd.Series(close)
        high_series = pd.Series(high)
        low_series = pd.Series(low)

        talib_atr = talib.ATR(high, low, close, timeperiod=self.ATR_PERIOD)
        legacy_atr = compute_atr(high_series, low_series, close_series, self.ATR_PERIOD).to_numpy()

        # Restrict to post-warmup stable region
        talib_stable = talib_atr[self.WARMUP_BARS:]
        legacy_stable = legacy_atr[self.WARMUP_BARS:]

        valid_mask = np.isfinite(talib_stable) & np.isfinite(legacy_stable)
        assert valid_mask.sum() > 0, "No valid overlap after warmup period"

        talib_v = talib_stable[valid_mask]
        legacy_v = legacy_stable[valid_mask]

        # Relative tolerance: |a - b| / max(|b|, epsilon)
        rel_diff = np.abs(talib_v - legacy_v) / np.maximum(np.abs(legacy_v), 1e-10)
        max_rel_diff = np.max(rel_diff)

        assert max_rel_diff <= self.RELATIVE_TOLERANCE, (
            f"ATR(14) max relative difference {max_rel_diff:.4%} exceeds 0.01% tolerance. "
            f"talib and legacy implementations diverge after warm-up."
        )

    def test_atr_values_are_positive(self, ohlcv_arrays):
        """talib.ATR output must be strictly positive on all finite values."""
        high, low, close, _ = ohlcv_arrays
        result = talib.ATR(high, low, close, timeperiod=self.ATR_PERIOD)
        finite = result[np.isfinite(result)]
        assert np.all(finite > 0.0), "ATR has non-positive values"

    def test_atr_output_length_matches_input(self, ohlcv_arrays):
        """talib.ATR output length must equal input length."""
        high, low, close, _ = ohlcv_arrays
        result = talib.ATR(high, low, close, timeperiod=self.ATR_PERIOD)
        assert len(result) == len(close)
