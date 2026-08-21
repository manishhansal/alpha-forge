"""
Failing performance tests for Task 8.1 — TA-Lib feature engineering throughput.

Tests that scoring 100 stocks completes in < 1 second after the TA-Lib
migration in Task 8.2. These tests import talib and are EXPECTED TO FAIL
until Task 8.2 installs the TA-Lib C library (TA-Lib==0.6.*).

Validates: Requirement 6.4
"""

import time

import numpy as np
import pandas as pd
import pytest

# This import will raise ModuleNotFoundError until Task 8.2 installs TA-Lib.
# That is intentional — it makes all tests in this file fail at collection time,
# confirming the TDD red phase.
import talib  # noqa: E402  (fails until TA-Lib is installed)

# ---------------------------------------------------------------------------
# Synthetic stock data helpers
# ---------------------------------------------------------------------------

N_STOCKS = 100
N_BARS = 500
RNG_SEED = 123


def _make_stock_ohlcv(n_bars: int, seed: int) -> pd.DataFrame:
    """
    Generate a single stock's OHLCV DataFrame of n_bars rows.

    Uses a geometric random walk for close, then derives OHLV from it.
    """
    rng = np.random.default_rng(seed)
    returns = rng.normal(0.0, 0.01, n_bars)
    close = 500.0 * np.cumprod(1 + returns)

    high_offset = np.abs(rng.normal(0.005, 0.003, n_bars))
    low_offset = np.abs(rng.normal(0.005, 0.003, n_bars))
    high = np.maximum(close * (1 + high_offset), close)
    low = np.minimum(close * (1 - low_offset), close)
    open_ = close * (1 + rng.normal(0.0, 0.003, n_bars))
    volume = rng.uniform(1e5, 1e7, n_bars)

    return pd.DataFrame(
        {
            "open": open_.astype(np.float64),
            "high": high.astype(np.float64),
            "low": low.astype(np.float64),
            "close": close.astype(np.float64),
            "volume": volume.astype(np.float64),
        }
    )


def _compute_talib_features_for_stock(ohlcv: pd.DataFrame) -> dict[str, float]:
    """
    Compute the TA-Lib feature set for a single stock's OHLCV DataFrame.

    This mirrors what technical.py will do after the Task 8.2 migration:
    replace pure-Python loops with talib.* vectorised calls.

    Returns a flat dict of the last bar's feature values (as used by the
    feature engineering pipeline).
    """
    close = ohlcv["close"].to_numpy(dtype=np.float64)
    high = ohlcv["high"].to_numpy(dtype=np.float64)
    low = ohlcv["low"].to_numpy(dtype=np.float64)
    volume = ohlcv["volume"].to_numpy(dtype=np.float64)

    def _last(arr: np.ndarray) -> float:
        """Return the last finite value, or 0.0."""
        for val in reversed(arr):
            if np.isfinite(val):
                return float(val)
        return 0.0

    features: dict[str, float] = {}

    # Core indicators (replacing pure-Python implementations per Req 6.1)
    features["rsi_14"] = _last(talib.RSI(close, timeperiod=14))
    features["rsi_7"] = _last(talib.RSI(close, timeperiod=7))

    macd_line, macd_signal, macd_hist = talib.MACD(close, fastperiod=12, slowperiod=26, signalperiod=9)
    features["macd_line"] = _last(macd_line)
    features["macd_signal"] = _last(macd_signal)
    features["macd_histogram"] = _last(macd_hist)

    features["adx_14"] = _last(talib.ADX(high, low, close, timeperiod=14))
    features["atr_14"] = _last(talib.ATR(high, low, close, timeperiod=14))

    upper, middle, lower = talib.BBANDS(close, timeperiod=20, nbdevup=2, nbdevdn=2, matype=0)
    band_width = upper[-1] - lower[-1]
    if np.isfinite(band_width) and band_width > 0:
        features["bollinger_position"] = float((close[-1] - lower[-1]) / band_width)
    else:
        features["bollinger_position"] = 0.5

    # EMA stack score using talib.EMA (replaces ewm-based implementation)
    emas = {}
    for period in [8, 13, 21, 55, 200]:
        emas[period] = talib.EMA(close, timeperiod=period)

    pairs = [(8, 13), (13, 21), (21, 55), (55, 200)]
    stack_score = 0.0
    for fast, slow in pairs:
        f_last = _last(emas[fast])
        s_last = _last(emas[slow])
        if f_last > s_last:
            stack_score += 1.0
        elif f_last < s_last:
            stack_score -= 1.0
    features["ema_stack_score"] = stack_score / len(pairs)

    # Stochastic RSI (talib.STOCHRSI)
    fastk, fastd = talib.STOCHRSI(close, timeperiod=14, fastk_period=3, fastd_period=3, fastd_matype=0)
    features["stoch_rsi"] = _last(fastk)

    # CCI
    features["cci"] = _last(talib.CCI(high, low, close, timeperiod=20))

    # MFI
    features["mfi"] = _last(talib.MFI(high, low, close, volume, timeperiod=14))

    # OBV (replaces pure-Python cumsum loop)
    obv = talib.OBV(close, volume)
    features["obv_last"] = _last(obv)

    # New candlestick pattern features (Req 6.2)
    features["cdl_engulfing"] = float(1 if talib.CDLENGULFING(
        ohlcv["open"].to_numpy(dtype=np.float64), high, low, close
    )[-1] != 0 else 0)
    features["cdl_hammer"] = float(1 if talib.CDLHAMMER(
        ohlcv["open"].to_numpy(dtype=np.float64), high, low, close
    )[-1] != 0 else 0)
    features["cdl_doji"] = float(1 if talib.CDLDOJI(
        ohlcv["open"].to_numpy(dtype=np.float64), high, low, close
    )[-1] != 0 else 0)

    # HT_TRENDLINE deviation (Req 6.2)
    ht = talib.HT_TRENDLINE(close)
    ht_last = _last(ht)
    features["ht_trendline_dev"] = float((close[-1] - ht_last) / ht_last) if ht_last != 0.0 else 0.0

    return features


# ---------------------------------------------------------------------------
# Test suite
# ---------------------------------------------------------------------------

class TestTALibPerformance:
    """
    Tests that the TA-Lib-backed feature engineering pipeline can score
    100 stocks (each with 500 bars) in under 1 second.

    Validates: Requirement 6.4
    """

    STOCK_COUNT = N_STOCKS
    BAR_COUNT = N_BARS
    TIME_LIMIT_SECONDS = 1.0

    @pytest.fixture(scope="class")
    def stock_dataframes(self):
        """Generate 100 stock DataFrames of 500 bars each (deterministic)."""
        return [
            _make_stock_ohlcv(self.BAR_COUNT, seed=RNG_SEED + i)
            for i in range(self.STOCK_COUNT)
        ]

    def test_scoring_100_stocks_completes_under_1_second(self, stock_dataframes):
        """
        Feature engineering for 100 stocks of 500 bars each must complete
        in less than 1 second using the TA-Lib vectorised pipeline.

        Validates: Requirement 6.4
        """
        t0 = time.time()

        results = []
        for df in stock_dataframes:
            features = _compute_talib_features_for_stock(df)
            results.append(features)

        elapsed = time.time() - t0

        assert len(results) == self.STOCK_COUNT, (
            f"Expected {self.STOCK_COUNT} feature dicts, got {len(results)}"
        )
        assert elapsed < self.TIME_LIMIT_SECONDS, (
            f"Feature engineering for {self.STOCK_COUNT} stocks took {elapsed:.3f}s, "
            f"which exceeds the {self.TIME_LIMIT_SECONDS}s limit (Requirement 6.4). "
            f"Ensure TA-Lib C library is installed (Task 8.2)."
        )

    def test_all_feature_dicts_contain_expected_keys(self, stock_dataframes):
        """Every stock's feature dict must contain the core TA-Lib indicator keys."""
        required_keys = {
            "rsi_14", "rsi_7", "macd_line", "macd_histogram",
            "adx_14", "atr_14", "bollinger_position", "ema_stack_score",
            "stoch_rsi", "cci", "mfi", "obv_last",
            # New candle pattern features (Req 6.2)
            "cdl_engulfing", "cdl_hammer", "cdl_doji", "ht_trendline_dev",
        }
        for i, df in enumerate(stock_dataframes[:5]):  # spot-check first 5
            features = _compute_talib_features_for_stock(df)
            missing = required_keys - features.keys()
            assert not missing, (
                f"Stock {i}: missing feature keys after TA-Lib migration: {missing}"
            )

    def test_feature_values_are_finite_floats(self, stock_dataframes):
        """
        Every value in the feature dict must be a finite float (no NaN or Inf),
        consistent with the existing _last() / NaN-cleanup contract in engineer.py.
        """
        for i, df in enumerate(stock_dataframes[:10]):  # spot-check first 10
            features = _compute_talib_features_for_stock(df)
            for key, val in features.items():
                assert np.isfinite(val), (
                    f"Stock {i}: feature '{key}' = {val} is not finite"
                )

    def test_rsi_values_in_valid_range(self, stock_dataframes):
        """RSI values must be in [0, 100] for all 100 stocks."""
        for i, df in enumerate(stock_dataframes):
            features = _compute_talib_features_for_stock(df)
            assert 0.0 <= features["rsi_14"] <= 100.0, (
                f"Stock {i}: rsi_14 = {features['rsi_14']} out of [0, 100]"
            )

    def test_atr_values_are_positive(self, stock_dataframes):
        """ATR values must be strictly positive for all 100 stocks."""
        for i, df in enumerate(stock_dataframes):
            features = _compute_talib_features_for_stock(df)
            assert features["atr_14"] > 0.0, (
                f"Stock {i}: atr_14 = {features['atr_14']} is not positive"
            )

    def test_candlestick_features_are_binary(self, stock_dataframes):
        """Candlestick pattern features must be 0.0 or 1.0 (binary)."""
        binary_keys = {"cdl_engulfing", "cdl_hammer", "cdl_doji"}
        for i, df in enumerate(stock_dataframes):
            features = _compute_talib_features_for_stock(df)
            for key in binary_keys:
                assert features[key] in (0.0, 1.0), (
                    f"Stock {i}: '{key}' = {features[key]} is not binary (0 or 1)"
                )
