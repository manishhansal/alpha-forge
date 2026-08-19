"""
Macro and market-wide features.

Covers: Market breadth, advance/decline ratio, sector rotation,
VIX regime, FII/DII flows, and inter-market signals.
"""

import numpy as np
import pandas as pd


def compute_market_breadth(
    stock_closes: dict[str, pd.Series], sma_period: int = 20
) -> dict[str, float]:
    """
    Market breadth indicators from the F&O universe.

    Returns:
        pct_above_sma20: % of stocks above their 20-day SMA
        pct_above_sma50: % of stocks above their 50-day SMA
        pct_above_sma200: % of stocks above their 200-day SMA
        breadth_thrust: rate of change of breadth (momentum of participation)
    """
    above_20 = 0
    above_50 = 0
    above_200 = 0
    total = 0

    for sym, closes in stock_closes.items():
        if len(closes) < 200:
            continue
        total += 1
        current = closes.iloc[-1]
        if current > closes.rolling(20).mean().iloc[-1]:
            above_20 += 1
        if current > closes.rolling(50).mean().iloc[-1]:
            above_50 += 1
        if current > closes.rolling(200).mean().iloc[-1]:
            above_200 += 1

    if total == 0:
        return {
            "pct_above_sma20": 50.0,
            "pct_above_sma50": 50.0,
            "pct_above_sma200": 50.0,
            "breadth_thrust": 0.0,
        }

    return {
        "pct_above_sma20": (above_20 / total) * 100,
        "pct_above_sma50": (above_50 / total) * 100,
        "pct_above_sma200": (above_200 / total) * 100,
        "breadth_thrust": 0.0,  # Requires historical breadth data
    }


def compute_advance_decline_ratio(advances: int, declines: int) -> float:
    """
    Advance/Decline ratio. > 1 = more stocks advancing.
    Normalized to [-1, 1] using (A-D)/(A+D).
    """
    total = advances + declines
    if total == 0:
        return 0.0
    return (advances - declines) / total


def compute_sector_rotation_score(
    sector_returns: dict[str, float]
) -> dict[str, float]:
    """
    Sector rotation features derived from relative performance.

    Returns per-sector normalized Z-scores and overall rotation signal.
    """
    if not sector_returns:
        return {"rotation_score": 0.0, "dispersion": 0.0}

    values = list(sector_returns.values())
    mean_ret = np.mean(values)
    std_ret = np.std(values) if len(values) > 1 else 1.0

    result = {}
    for sector, ret in sector_returns.items():
        z = (ret - mean_ret) / std_ret if std_ret > 0 else 0.0
        result[f"sector_z_{sector.lower().replace(' ', '_')}"] = z

    # Dispersion: high dispersion = sector rotation active
    result["sector_dispersion"] = std_ret
    # Rotation score: positive when cyclicals outperform defensives
    cyclicals = ["Auto", "Metal", "Realty", "Infra", "Energy"]
    defensives = ["FMCG", "Pharma", "IT"]

    cyc_avg = np.mean([sector_returns.get(s, 0) for s in cyclicals])
    def_avg = np.mean([sector_returns.get(s, 0) for s in defensives])
    result["rotation_score"] = np.clip(cyc_avg - def_avg, -5, 5)

    return result


def compute_vix_features(
    current_vix: float | None,
    vix_history: list[float] | None = None,
) -> dict[str, float]:
    """
    India VIX regime and derived features.
    """
    features: dict[str, float] = {}

    if current_vix is None:
        return {
            "vix_level": 15.0,
            "vix_regime": 1.0,  # moderate
            "vix_percentile": 50.0,
            "vix_change_pct": 0.0,
            "vix_mean_reversion": 0.0,
        }

    features["vix_level"] = current_vix

    # Regime: 0=low, 1=moderate, 2=high, 3=extreme
    if current_vix < 13:
        features["vix_regime"] = 0.0
    elif current_vix < 18:
        features["vix_regime"] = 1.0
    elif current_vix < 25:
        features["vix_regime"] = 2.0
    else:
        features["vix_regime"] = 3.0

    if vix_history and len(vix_history) >= 5:
        history = vix_history[-252:]  # Last year
        features["vix_percentile"] = (
            sum(1 for v in history if v < current_vix) / len(history)
        ) * 100

        # VIX change
        if len(history) >= 2:
            features["vix_change_pct"] = (
                (current_vix - history[-2]) / history[-2]
            ) * 100
        else:
            features["vix_change_pct"] = 0.0

        # Mean reversion signal: how far from historical mean
        vix_mean = np.mean(history)
        vix_std = np.std(history) if len(history) > 1 else 1.0
        features["vix_mean_reversion"] = np.clip(
            (current_vix - vix_mean) / vix_std, -3, 3
        )
    else:
        features["vix_percentile"] = 50.0
        features["vix_change_pct"] = 0.0
        features["vix_mean_reversion"] = 0.0

    return features


def compute_intermarket_features(
    nifty_change: float | None,
    banknifty_change: float | None,
    us_futures_change: float | None = None,
    crude_change: float | None = None,
    dollar_inr_change: float | None = None,
) -> dict[str, float]:
    """
    Inter-market correlation features that influence Indian markets.
    """
    features: dict[str, float] = {}

    features["nifty_change_pct"] = nifty_change or 0.0
    features["banknifty_change_pct"] = banknifty_change or 0.0

    # Bank vs Nifty spread (Bank outperformance = risk-on)
    n = nifty_change or 0.0
    b = banknifty_change or 0.0
    features["bank_nifty_spread"] = b - n

    # Global influences
    features["us_futures_change"] = us_futures_change or 0.0
    features["crude_change"] = crude_change or 0.0
    features["dollar_inr_change"] = dollar_inr_change or 0.0

    # Composite global sentiment: positive = global risk-on
    global_sum = (us_futures_change or 0) - (crude_change or 0) * 0.3 - (dollar_inr_change or 0)
    features["global_sentiment"] = np.clip(global_sum, -5, 5)

    return features


def compute_time_features(minutes_since_open: int) -> dict[str, float]:
    """
    Time-of-day features for intraday prediction.
    NSE session: 09:15 - 15:30 (375 minutes).
    """
    total_session = 375
    progress = min(minutes_since_open / total_session, 1.0)

    features: dict[str, float] = {}
    features["session_progress"] = progress
    features["minutes_since_open"] = float(minutes_since_open)

    # Key session zones (one-hot-ish features)
    # Opening volatility: 0-30 min
    features["is_opening_zone"] = 1.0 if minutes_since_open <= 30 else 0.0
    # Mid-morning consolidation: 30-90 min
    features["is_mid_morning"] = 1.0 if 30 < minutes_since_open <= 90 else 0.0
    # Lunch lull: 90-210 min
    features["is_lunch_zone"] = 1.0 if 90 < minutes_since_open <= 210 else 0.0
    # Afternoon trend: 210-300 min
    features["is_afternoon"] = 1.0 if 210 < minutes_since_open <= 300 else 0.0
    # Power hour: 300-375 min (last 75 min)
    features["is_power_hour"] = 1.0 if minutes_since_open > 300 else 0.0

    # Cyclical encoding for neural models
    features["time_sin"] = float(np.sin(2 * np.pi * progress))
    features["time_cos"] = float(np.cos(2 * np.pi * progress))

    return features


def compute_expiry_features(
    days_to_weekly_expiry: int | None,
    days_to_monthly_expiry: int | None,
    is_expiry_day: bool = False,
) -> dict[str, float]:
    """
    Options expiry proximity features — decay effects intensify near expiry.
    """
    features: dict[str, float] = {}

    features["is_expiry_day"] = 1.0 if is_expiry_day else 0.0
    features["days_to_weekly_expiry"] = float(days_to_weekly_expiry or 5)
    features["days_to_monthly_expiry"] = float(days_to_monthly_expiry or 20)

    # Theta decay acceleration (inverse relationship)
    weekly = days_to_weekly_expiry or 5
    features["weekly_theta_pressure"] = 1.0 / max(weekly, 0.5)

    monthly = days_to_monthly_expiry or 20
    features["monthly_theta_pressure"] = 1.0 / max(monthly, 0.5)

    return features
