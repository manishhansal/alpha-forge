"""
Technical indicator features computed from OHLCV data.

Covers: RSI, MACD, ADX, Bollinger Bands, EMA stack, Stochastic RSI,
Williams %R, CCI, MFI, ATR, OBV, and custom derived indicators.
"""

import numpy as np
import pandas as pd


def compute_rsi(closes: pd.Series, period: int = 14) -> pd.Series:
    """Wilder RSI."""
    delta = closes.diff()
    gain = delta.where(delta > 0, 0.0)
    loss = -delta.where(delta < 0, 0.0)
    avg_gain = gain.ewm(alpha=1 / period, min_periods=period).mean()
    avg_loss = loss.ewm(alpha=1 / period, min_periods=period).mean()
    rs = avg_gain / avg_loss.replace(0, np.nan)
    return 100 - (100 / (1 + rs))


def compute_macd(
    closes: pd.Series, fast: int = 12, slow: int = 26, signal: int = 9
) -> tuple[pd.Series, pd.Series, pd.Series]:
    """MACD line, signal line, histogram."""
    ema_fast = closes.ewm(span=fast, adjust=False).mean()
    ema_slow = closes.ewm(span=slow, adjust=False).mean()
    macd_line = ema_fast - ema_slow
    signal_line = macd_line.ewm(span=signal, adjust=False).mean()
    histogram = macd_line - signal_line
    return macd_line, signal_line, histogram


def compute_adx(
    high: pd.Series, low: pd.Series, close: pd.Series, period: int = 14
) -> pd.Series:
    """Average Directional Index (ADX)."""
    tr1 = high - low
    tr2 = (high - close.shift(1)).abs()
    tr3 = (low - close.shift(1)).abs()
    true_range = pd.concat([tr1, tr2, tr3], axis=1).max(axis=1)

    plus_dm = high.diff()
    minus_dm = -low.diff()
    plus_dm = plus_dm.where((plus_dm > minus_dm) & (plus_dm > 0), 0.0)
    minus_dm = minus_dm.where((minus_dm > plus_dm) & (minus_dm > 0), 0.0)

    atr = true_range.ewm(alpha=1 / period, min_periods=period).mean()
    plus_di = 100 * (plus_dm.ewm(alpha=1 / period, min_periods=period).mean() / atr)
    minus_di = 100 * (minus_dm.ewm(alpha=1 / period, min_periods=period).mean() / atr)

    dx = 100 * (plus_di - minus_di).abs() / (plus_di + minus_di).replace(0, np.nan)
    adx = dx.ewm(alpha=1 / period, min_periods=period).mean()
    return adx


def compute_atr(
    high: pd.Series, low: pd.Series, close: pd.Series, period: int = 14
) -> pd.Series:
    """Wilder ATR."""
    tr1 = high - low
    tr2 = (high - close.shift(1)).abs()
    tr3 = (low - close.shift(1)).abs()
    true_range = pd.concat([tr1, tr2, tr3], axis=1).max(axis=1)
    return true_range.ewm(alpha=1 / period, min_periods=period).mean()


def compute_bollinger_bands(
    closes: pd.Series, period: int = 20, num_std: float = 2.0
) -> tuple[pd.Series, pd.Series, pd.Series]:
    """Upper band, middle band, lower band."""
    middle = closes.rolling(window=period).mean()
    std = closes.rolling(window=period).std()
    upper = middle + num_std * std
    lower = middle - num_std * std
    return upper, middle, lower


def compute_bollinger_position(closes: pd.Series, period: int = 20) -> pd.Series:
    """Position within Bollinger Bands: 0 = lower, 1 = upper."""
    upper, _, lower = compute_bollinger_bands(closes, period)
    band_width = upper - lower
    return (closes - lower) / band_width.replace(0, np.nan)


def compute_ema_stack_score(closes: pd.Series) -> pd.Series:
    """
    EMA alignment score in [-1, 1].
    +1 = perfect bull stack (8 > 13 > 21 > 55 > 200)
    -1 = perfect bear stack (8 < 13 < 21 < 55 < 200)
    """
    emas = {}
    for period in [8, 13, 21, 55, 200]:
        emas[period] = closes.ewm(span=period, adjust=False).mean()

    pairs = [(8, 13), (13, 21), (21, 55), (55, 200)]
    score = pd.Series(0.0, index=closes.index)
    for fast, slow in pairs:
        score += (emas[fast] > emas[slow]).astype(float) - (emas[fast] < emas[slow]).astype(float)
    return score / len(pairs)


def compute_stochastic_rsi(
    closes: pd.Series, rsi_period: int = 14, stoch_period: int = 14
) -> pd.Series:
    """Stochastic RSI in [0, 100]."""
    rsi = compute_rsi(closes, rsi_period)
    rsi_min = rsi.rolling(window=stoch_period).min()
    rsi_max = rsi.rolling(window=stoch_period).max()
    stoch_rsi = (rsi - rsi_min) / (rsi_max - rsi_min).replace(0, np.nan)
    return stoch_rsi * 100


def compute_williams_r(
    high: pd.Series, low: pd.Series, close: pd.Series, period: int = 14
) -> pd.Series:
    """Williams %R in [-100, 0]."""
    highest = high.rolling(window=period).max()
    lowest = low.rolling(window=period).min()
    return -100 * (highest - close) / (highest - lowest).replace(0, np.nan)


def compute_cci(
    high: pd.Series, low: pd.Series, close: pd.Series, period: int = 20
) -> pd.Series:
    """Commodity Channel Index."""
    typical_price = (high + low + close) / 3
    sma = typical_price.rolling(window=period).mean()
    mean_deviation = typical_price.rolling(window=period).apply(
        lambda x: np.abs(x - x.mean()).mean(), raw=True
    )
    return (typical_price - sma) / (0.015 * mean_deviation).replace(0, np.nan)


def compute_mfi(
    high: pd.Series, low: pd.Series, close: pd.Series, volume: pd.Series, period: int = 14
) -> pd.Series:
    """Money Flow Index (volume-weighted RSI)."""
    typical_price = (high + low + close) / 3
    money_flow = typical_price * volume
    positive_flow = money_flow.where(typical_price > typical_price.shift(1), 0.0)
    negative_flow = money_flow.where(typical_price < typical_price.shift(1), 0.0)
    pos_sum = positive_flow.rolling(window=period).sum()
    neg_sum = negative_flow.rolling(window=period).sum()
    mfr = pos_sum / neg_sum.replace(0, np.nan)
    return 100 - (100 / (1 + mfr))


def compute_cmf(
    high: pd.Series, low: pd.Series, close: pd.Series, volume: pd.Series, period: int = 20
) -> pd.Series:
    """Chaikin Money Flow."""
    hl_range = high - low
    mf_multiplier = ((close - low) - (high - close)) / hl_range.replace(0, np.nan)
    mf_volume = mf_multiplier * volume
    return mf_volume.rolling(window=period).sum() / volume.rolling(window=period).sum()


def compute_obv(close: pd.Series, volume: pd.Series) -> pd.Series:
    """On-Balance Volume."""
    direction = close.diff().apply(lambda x: 1 if x > 0 else (-1 if x < 0 else 0))
    return (direction * volume).cumsum()


def compute_obv_trend(close: pd.Series, volume: pd.Series, period: int = 20) -> pd.Series:
    """OBV trend: slope of OBV over `period` bars, normalized."""
    obv = compute_obv(close, volume)
    obv_sma = obv.rolling(window=period).mean()
    obv_std = obv.rolling(window=period).std().replace(0, np.nan)
    return (obv - obv_sma) / obv_std


def compute_vwap(
    high: pd.Series, low: pd.Series, close: pd.Series, volume: pd.Series
) -> pd.Series:
    """
    Cumulative VWAP (intraday reset assumed by caller grouping by day).
    For daily bars this is an approximation using typical price * volume.
    """
    typical_price = (high + low + close) / 3
    cum_tp_vol = (typical_price * volume).cumsum()
    cum_vol = volume.cumsum()
    return cum_tp_vol / cum_vol.replace(0, np.nan)


def compute_supertrend(
    high: pd.Series, low: pd.Series, close: pd.Series,
    period: int = 10, multiplier: float = 3.0
) -> pd.Series:
    """
    Supertrend indicator: returns +1 for uptrend, -1 for downtrend.
    """
    atr = compute_atr(high, low, close, period)
    hl2 = (high + low) / 2
    upper_band = hl2 + multiplier * atr
    lower_band = hl2 - multiplier * atr

    supertrend = pd.Series(0.0, index=close.index)
    direction = pd.Series(1, index=close.index)

    for i in range(1, len(close)):
        if close.iloc[i] > upper_band.iloc[i - 1]:
            direction.iloc[i] = 1
        elif close.iloc[i] < lower_band.iloc[i - 1]:
            direction.iloc[i] = -1
        else:
            direction.iloc[i] = direction.iloc[i - 1]
            if direction.iloc[i] == 1 and lower_band.iloc[i] < lower_band.iloc[i - 1]:
                lower_band.iloc[i] = lower_band.iloc[i - 1]
            if direction.iloc[i] == -1 and upper_band.iloc[i] > upper_band.iloc[i - 1]:
                upper_band.iloc[i] = upper_band.iloc[i - 1]

    supertrend = direction.astype(float)
    return supertrend
