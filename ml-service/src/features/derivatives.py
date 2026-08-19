"""
Derivatives / Options-based features.

Covers: PCR, OI build-up, IV rank, max-pain distance, OI walls,
delta-weighted OI, and options flow metrics.
"""

import numpy as np
import pandas as pd


def compute_pcr_score(pcr: float | None) -> float:
    """
    Normalize PCR into a [-1, 1] score.
    PCR > 1.3 → bullish (PE writers dominating → market supported)
    PCR < 0.7 → bearish (CE writers dominating → market capped)
    """
    if pcr is None or not np.isfinite(pcr):
        return 0.0
    # Center at 1.0, scale by 0.5
    return np.clip((pcr - 1.0) / 0.5, -1.0, 1.0)


def compute_oi_buildup_score(
    price_change_pct: float, oi_change_pct: float
) -> tuple[float, str]:
    """
    Classify OI build-up into 4 quadrants and return a directional score.

    Returns: (score in [-1, 1], buildup_kind)
      - Long Buildup: price up + OI up → +1.0
      - Short Covering: price up + OI down → +0.6
      - Short Buildup: price down + OI up → -1.0
      - Long Unwinding: price down + OI down → -0.6
    """
    if price_change_pct > 0 and oi_change_pct > 0:
        return 1.0, "LONG_BUILDUP"
    elif price_change_pct > 0 and oi_change_pct <= 0:
        return 0.6, "SHORT_COVERING"
    elif price_change_pct <= 0 and oi_change_pct > 0:
        return -1.0, "SHORT_BUILDUP"
    else:
        return -0.6, "LONG_UNWINDING"


def compute_iv_rank(current_iv: float, iv_history: list[float], period: int = 252) -> float:
    """
    IV Rank: where current IV sits in its N-day range [0, 100].
    0 = at the lowest IV of the period
    100 = at the highest IV of the period
    """
    if not iv_history or len(iv_history) < 5:
        return 50.0  # Default to middle when insufficient data

    history = iv_history[-period:]
    iv_min = min(history)
    iv_max = max(history)
    if iv_max == iv_min:
        return 50.0
    return ((current_iv - iv_min) / (iv_max - iv_min)) * 100


def compute_iv_percentile(current_iv: float, iv_history: list[float], period: int = 252) -> float:
    """
    IV Percentile: % of days where IV was lower than current.
    More robust than IV Rank for tail events.
    """
    if not iv_history or len(iv_history) < 5:
        return 50.0

    history = iv_history[-period:]
    below = sum(1 for iv in history if iv < current_iv)
    return (below / len(history)) * 100


def compute_max_pain_distance(spot: float, max_pain: float | None) -> float:
    """
    % distance from spot to max-pain strike.
    Positive: max pain above spot (bullish pull)
    Negative: max pain below spot (bearish pull)
    """
    if max_pain is None or spot <= 0:
        return 0.0
    return ((max_pain - spot) / spot) * 100


def compute_oi_wall_proximity(
    spot: float,
    max_ce_oi_strike: float | None,
    max_pe_oi_strike: float | None,
) -> dict[str, float]:
    """
    Distance from spot to the CE wall (resistance) and PE wall (support).
    Returns normalized distances as % of spot.
    """
    result = {"ce_wall_distance_pct": 0.0, "pe_wall_distance_pct": 0.0, "oi_wall_score": 0.0}

    if spot <= 0:
        return result

    if max_ce_oi_strike is not None:
        result["ce_wall_distance_pct"] = ((max_ce_oi_strike - spot) / spot) * 100

    if max_pe_oi_strike is not None:
        result["pe_wall_distance_pct"] = ((spot - max_pe_oi_strike) / spot) * 100

    # OI wall score: positive when PE wall is closer (support nearby = bullish)
    ce_dist = abs(result["ce_wall_distance_pct"])
    pe_dist = abs(result["pe_wall_distance_pct"])
    total = ce_dist + pe_dist
    if total > 0:
        # Score in [-1, 1]: +1 when sitting on PE floor (support), -1 at CE ceiling
        result["oi_wall_score"] = np.clip((ce_dist - pe_dist) / total, -1, 1)

    return result


def compute_options_flow_features(
    total_ce_oi: float | None,
    total_pe_oi: float | None,
    total_ce_oi_change: float | None,
    total_pe_oi_change: float | None,
    atm_iv: float | None,
) -> dict[str, float]:
    """
    Compute composite options flow features from chain-level aggregates.
    """
    features: dict[str, float] = {}

    # PCR from OI
    if total_ce_oi and total_pe_oi and total_ce_oi > 0:
        features["pcr_oi"] = total_pe_oi / total_ce_oi
    else:
        features["pcr_oi"] = 1.0

    # Delta OI skew: PE OI change - CE OI change (positive = bullish)
    ce_change = total_ce_oi_change or 0.0
    pe_change = total_pe_oi_change or 0.0
    features["oi_delta_skew"] = pe_change - ce_change

    # Normalized OI delta skew
    total_change = abs(ce_change) + abs(pe_change)
    if total_change > 0:
        features["oi_delta_skew_norm"] = (pe_change - ce_change) / total_change
    else:
        features["oi_delta_skew_norm"] = 0.0

    # ATM IV
    features["atm_iv"] = atm_iv if atm_iv is not None else 0.0

    return features


def compute_put_call_oi_ratio_change(
    current_pcr: float | None, prev_pcr: float | None
) -> float:
    """Change in PCR: positive means shift toward more PE writing (bullish)."""
    if current_pcr is None or prev_pcr is None:
        return 0.0
    return current_pcr - prev_pcr
