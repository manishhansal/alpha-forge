"""
Volume and flow-based features.

Covers: Relative Volume, Volume Breakout, Volume Profile approximation,
Delivery %, VWAP distance, volume-weighted momentum.
"""

import numpy as np
import pandas as pd


def compute_relative_volume(volume: pd.Series, period: int = 20) -> pd.Series:
    """Volume relative to N-day moving average."""
    avg_vol = volume.rolling(window=period).mean()
    return volume / avg_vol.replace(0, np.nan)


def compute_volume_breakout(volume: pd.Series, period: int = 20, threshold: float = 1.5) -> pd.Series:
    """Binary flag: 1 if volume >= threshold * avg, 0 otherwise."""
    rel_vol = compute_relative_volume(volume, period)
    return (rel_vol >= threshold).astype(float)


def compute_volume_trend(volume: pd.Series, period: int = 10) -> pd.Series:
    """Volume trend: ratio of recent avg volume to prior avg."""
    recent = volume.rolling(window=period).mean()
    prior = volume.shift(period).rolling(window=period).mean()
    return recent / prior.replace(0, np.nan)


def compute_volume_price_confirmation(
    close: pd.Series, volume: pd.Series, period: int = 20
) -> pd.Series:
    """
    Volume-price confirmation score.
    +1: rising price + rising volume (strong trend)
    -1: rising price + falling volume (weak/divergent trend)
    """
    price_direction = close.diff(period).apply(lambda x: 1 if x > 0 else -1)
    vol_direction = volume.rolling(period).mean().diff().apply(lambda x: 1 if x > 0 else -1)
    return (price_direction * vol_direction).astype(float)


def compute_vwap_distance_pct(
    close: pd.Series, high: pd.Series, low: pd.Series, volume: pd.Series
) -> pd.Series:
    """% distance from intraday VWAP (approximated for daily using typical price)."""
    typical_price = (high + low + close) / 3
    cum_tp_vol = (typical_price * volume).cumsum()
    cum_vol = volume.cumsum()
    vwap = cum_tp_vol / cum_vol.replace(0, np.nan)
    return ((close - vwap) / vwap) * 100


def compute_volume_profile_score(
    close: pd.Series, volume: pd.Series, high: pd.Series, low: pd.Series,
    lookback: int = 20
) -> pd.Series:
    """
    Simplified volume profile score.
    Measures where current price sits relative to the volume-weighted
    price distribution over the lookback period.
    +1: at the top of the high-volume zone (volume node support below)
    -1: at the bottom of the high-volume zone (volume node resistance above)
    """
    scores = pd.Series(0.0, index=close.index)

    for i in range(lookback, len(close)):
        window_close = close.iloc[i - lookback:i]
        window_vol = volume.iloc[i - lookback:i]
        window_high = high.iloc[i - lookback:i]
        window_low = low.iloc[i - lookback:i]

        # Volume-weighted average price in the window
        vwap_window = (window_close * window_vol).sum() / window_vol.sum()
        price_range = window_high.max() - window_low.min()

        if price_range > 0:
            position = (close.iloc[i] - window_low.min()) / price_range
            vwap_position = (vwap_window - window_low.min()) / price_range
            scores.iloc[i] = 2 * (position - vwap_position)

    return scores.clip(-1, 1)


def compute_accumulation_distribution(
    high: pd.Series, low: pd.Series, close: pd.Series, volume: pd.Series
) -> pd.Series:
    """Accumulation/Distribution Line."""
    hl_range = high - low
    mf_multiplier = ((close - low) - (high - close)) / hl_range.replace(0, np.nan)
    mf_multiplier = mf_multiplier.fillna(0)
    ad = (mf_multiplier * volume).cumsum()
    return ad


def compute_force_index(close: pd.Series, volume: pd.Series, period: int = 13) -> pd.Series:
    """Elder's Force Index smoothed over `period`."""
    fi = close.diff() * volume
    return fi.ewm(span=period, adjust=False).mean()


def compute_volume_oscillator(volume: pd.Series, fast: int = 5, slow: int = 20) -> pd.Series:
    """Volume Oscillator: (fast EMA - slow EMA) / slow EMA * 100."""
    fast_ema = volume.ewm(span=fast, adjust=False).mean()
    slow_ema = volume.ewm(span=slow, adjust=False).mean()
    return ((fast_ema - slow_ema) / slow_ema.replace(0, np.nan)) * 100
