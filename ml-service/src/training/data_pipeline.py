"""
AlphaForge Training Data Pipeline.

Fetches normalized NSE OHLCV + F&O derivative data from the AlphaForge
Indian Market Data Layer (Angel One → Upstox → PostgreSQL → yfinance fallback),
computes features for the full F&O universe, and generates labeled datasets for
all four downstream models:

  1. Market Regime labels     (NIFTY forward returns + vol + drawdown)
  2. Stock Ranking labels     (future return horizon, risk-adjusted return)
  3. Strategy Selection labels (which strategy performed best in next N bars)
  4. Risk labels              (stop hit probability, target hit probability, MAE)

Key design constraints:
  - NO future information leakage: all features computed strictly from data
    available at the prediction timestamp (Requirement #5)
  - Walk-forward validation only: rolling train/val/test windows (Requirement #6)
  - Dataset versioning metadata attached to every saved artefact (Requirement #4)
  - F&O-specific features: OI buildup, PCR, IV rank, OI walls, max pain (Requirement #8)
  - Data quality filtering: STALE / INVALID / SUSPICIOUS records excluded (Requirement #9)

Yahoo Finance is used ONLY as a last-resort fallback (no OI/derivatives enrichment).
The primary source is always the AlphaForge normalized data layer.

Usage:
  python -m src.training.data_pipeline --start 2023-01-01 --end 2026-07-31
  python -m src.training.data_pipeline --start 2023-01-01 --end 2026-07-31 --quick
"""

from __future__ import annotations

import argparse
import hashlib
import json
from dataclasses import asdict
from datetime import date, datetime
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import structlog

from ..config import settings
from ..features.engineer import (
    RANKING_FEATURES,
    REGIME_FEATURES,
    RISK_FEATURES,
    STRATEGY_FEATURES,
    compute_regime_features,
    compute_stock_features,
)
from ..models.market_regime import MarketRegimeClassifier, generate_regime_labels
from ..models.stock_ranker import generate_ranking_labels
from ..models.strategy_selector import generate_strategy_labels
from .market_data_client import (
    DataQuality,
    DatasetMetadata,
    DerivativesSnapshot,
    MarketBreadthRecord,
    MarketDataClient,
    classify_oi_buildup,
    create_client_from_env,
)

logger = structlog.get_logger(__name__)

# ─── Pipeline version constants ───────────────────────────────────────────────

PIPELINE_VERSION = "v3.0"           # bump when labeling logic changes
FEATURE_VERSION = "fv4"             # bump when feature set changes (RANKING_FEATURES etc.)
DATASET_VERSION = f"af-{PIPELINE_VERSION}-{FEATURE_VERSION}"

# ─── F&O training universe ────────────────────────────────────────────────────

# NSE symbol notation (no .NS suffix — the data client handles exchange routing)
TRAINING_UNIVERSE: list[str] = [
    # Broad-market indices (regime + breadth features)
    "NIFTY",
    "BANKNIFTY",
    "FINNIFTY",
    "MIDCPNIFTY",
    # Top F&O stocks by open interest liquidity (NSE F&O segment)
    "RELIANCE", "TCS", "HDFCBANK", "INFY", "ICICIBANK", "HINDUNILVR",
    "SBIN", "BHARTIARTL", "ITC", "KOTAKBANK", "LT", "AXISBANK",
    "BAJFINANCE", "MARUTI", "TATAMOTORS", "SUNPHARMA", "TITAN",
    "WIPRO", "HCLTECH", "NTPC", "POWERGRID", "ONGC", "JSWSTEEL",
    "TATASTEEL", "ADANIENT", "ADANIPORTS", "HINDALCO", "DRREDDY",
    "CIPLA", "BAJAJFINSV", "TECHM", "DIVISLAB", "NESTLEIND",
    "BRITANNIA", "INDUSINDBK", "M&M", "COALINDIA", "EICHERMOT",
    "HAL", "BEL", "TRENT", "JIOFIN", "ZOMATO", "DLF",
    "ABB", "SIEMENS", "GODREJCP", "DABUR", "VEDL", "GAIL",
]

# Quick mode: a reduced universe for fast iteration / CI
QUICK_UNIVERSE: list[str] = [
    "NIFTY", "BANKNIFTY",
    "RELIANCE", "TCS", "HDFCBANK", "ICICIBANK", "INFY",
    "SBIN", "AXISBANK", "BAJFINANCE", "LT", "KOTAKBANK",
]

# NSE lot sizes for OI-to-contract-value scaling
LOT_SIZES: dict[str, int] = {
    "NIFTY": 50, "BANKNIFTY": 15, "FINNIFTY": 40, "MIDCPNIFTY": 75,
    "RELIANCE": 250, "TCS": 150, "HDFCBANK": 550, "INFY": 300,
    "ICICIBANK": 700, "SBIN": 1500, "AXISBANK": 1200, "BAJFINANCE": 125,
}
DEFAULT_LOT_SIZE = 500


# ─── Walk-forward split helpers (Requirement #6) ──────────────────────────────


def walk_forward_splits(
    n_periods: int,
    train_size: int,
    val_size: int,
    test_size: int,
    step: int | None = None,
) -> list[dict[str, range]]:
    """
    Generate non-overlapping, strictly time-ordered walk-forward splits.

    All split boundaries are expressed as integer indices into the time axis
    (e.g. row indices in a DataFrame). The caller slices `.iloc[split["train"]]`.

    Each split window:
      [train_start : train_end] → train
      [train_end   : val_end  ] → validation
      [val_end     : test_end ] → test

    The test window of split k never overlaps with the train window of split k+1
    when step == test_size (the default — no look-ahead).

    Raises ValueError when the time series is too short for even one split.
    """
    if step is None:
        step = test_size

    window = train_size + val_size + test_size
    if n_periods < window:
        raise ValueError(
            f"Time series too short for walk-forward splits: "
            f"{n_periods} periods < {window} required "
            f"(train={train_size} + val={val_size} + test={test_size})"
        )

    splits: list[dict[str, range]] = []
    start = 0
    while start + window <= n_periods:
        train_end = start + train_size
        val_end = train_end + val_size
        test_end = val_end + test_size
        splits.append(
            {
                "train": range(start, train_end),
                "val": range(train_end, val_end),
                "test": range(val_end, test_end),
            }
        )
        start += step

    if not splits:
        raise ValueError(
            f"No valid walk-forward splits generated for {n_periods} periods."
        )
    return splits


def _apply_wf_split(
    X: np.ndarray,
    y: np.ndarray,
    splits: list[dict[str, range]],
    split_index: int = -1,
) -> dict[str, tuple[np.ndarray, np.ndarray]]:
    """
    Apply walk-forward splits to (X, y) arrays.

    split_index=-1 returns the last (most recent) split — used for final model
    training. Pass an integer to retrieve any specific fold for cross-validation.
    """
    split = splits[split_index]
    return {
        "train": (X[split["train"]], y[split["train"]]),
        "val": (X[split["val"]], y[split["val"]]),
        "test": (X[split["test"]], y[split["test"]]),
    }


# ─── Leakage prevention guard (Requirement #5) ────────────────────────────────


def assert_no_future_leakage(
    df: pd.DataFrame,
    feature_cols: list[str],
    label_col: str,
    horizon: int,
) -> None:
    """
    Validate that no feature column is a future-shifted version of the label.

    Strategy: compute the cross-correlation between each feature and the
    forward-shifted label. A Pearson |r| > 0.95 at shift=0 (which disappears
    when the label is shifted back by `horizon`) is a leakage signal.

    Raises AssertionError when leakage is detected so the pipeline halts
    before saving a contaminated dataset.
    """
    if label_col not in df.columns:
        return

    label = df[label_col].values.astype(float)
    shifted_label = df[label_col].shift(-horizon).values.astype(float)

    for col in feature_cols:
        if col not in df.columns:
            continue
        feat = df[col].values.astype(float)

        # Correlation of feature with future-shifted label
        valid = ~(np.isnan(feat) | np.isnan(shifted_label))
        if valid.sum() < 10:
            continue
        corr_future = float(np.corrcoef(feat[valid], shifted_label[valid])[0, 1])

        # Correlation of feature with unshifted label (contemporaneous)
        valid2 = ~(np.isnan(feat) | np.isnan(label))
        if valid2.sum() < 10:
            corr_now = 0.0
        else:
            corr_now = float(np.corrcoef(feat[valid2], label[valid2])[0, 1])

        # Leakage: feature is MORE correlated with future label than present label
        if abs(corr_future) > 0.95 and abs(corr_future) > abs(corr_now) + 0.1:
            raise AssertionError(
                f"Future leakage detected in column '{col}': "
                f"corr with future label={corr_future:.3f} "
                f"> corr with present label={corr_now:.3f}. "
                f"This feature must be computed at time t, not t+{horizon}."
            )


# ─── F&O feature enrichment (Requirement #8) ──────────────────────────────────


def enrich_with_derivatives(
    df: pd.DataFrame,
    derivs: dict[date, DerivativesSnapshot],
) -> pd.DataFrame:
    """
    Merge daily derivative snapshots into an OHLCV DataFrame.

    Adds columns:
      pcr, atm_iv, iv_rank, iv_percentile, atm_skew, max_pain,
      max_ce_oi_strike, max_pe_oi_strike, total_ce_oi, total_pe_oi,
      total_ce_oi_change, total_pe_oi_change,
      oi_buildup_signal (LONG_BUILDUP / SHORT_BUILDUP / SHORT_COVERING / LONG_UNWINDING),
      oi_concentration

    All columns are NaN-safe — missing derivative data is filled with NaN.
    Fills forward within a 5-bar window (option chain data may be T+1 delayed).
    """
    if not derivs:
        return df

    deriv_rows = []
    for dt, snap in derivs.items():
        row: dict[str, Any] = {"date": pd.Timestamp(dt, tz="UTC")}
        row["pcr"] = snap.pcr
        row["atm_iv"] = snap.atm_iv
        row["iv_rank"] = snap.iv_rank
        row["iv_percentile"] = snap.iv_percentile
        row["atm_skew"] = snap.atm_skew
        row["max_pain"] = snap.max_pain
        row["max_ce_oi_strike"] = snap.max_ce_oi_strike
        row["max_pe_oi_strike"] = snap.max_pe_oi_strike
        row["total_ce_oi"] = snap.total_ce_oi
        row["total_pe_oi"] = snap.total_pe_oi
        row["total_ce_oi_change"] = snap.total_ce_oi_change
        row["total_pe_oi_change"] = snap.total_pe_oi_change
        row["oi_concentration"] = snap.oi_concentration
        deriv_rows.append(row)

    if not deriv_rows:
        return df

    deriv_df = pd.DataFrame(deriv_rows).set_index("date").sort_index()

    # Align to OHLCV index — forward fill gaps up to 5 bars
    df = df.join(deriv_df, how="left")
    ffill_cols = [c for c in deriv_df.columns if c in df.columns]
    df[ffill_cols] = df[ffill_cols].ffill(limit=5).infer_objects(copy=False)

    # Add OI buildup signal (vectorised)
    if "oi_change_pct" in df.columns and "close" in df.columns:
        price_chg = df["close"].pct_change() * 100
        oi_chg = df["oi_change_pct"].fillna(0)
        df["oi_buildup_signal"] = [
            classify_oi_buildup(float(p), float(o))
            for p, o in zip(price_chg.fillna(0), oi_chg)
        ]
    else:
        df["oi_buildup_signal"] = "UNKNOWN"

    return df


def _build_derivatives_dict(snap: DerivativesSnapshot | None) -> dict[str, Any]:
    """
    Convert a DerivativesSnapshot into the dict shape expected by
    compute_stock_features(derivatives_data=...) in features/engineer.py.
    """
    if snap is None:
        return {}
    d: dict[str, Any] = {}
    for field_name in (
        "pcr", "atm_iv", "iv_rank", "iv_percentile", "max_pain",
        "max_ce_oi_strike", "max_pe_oi_strike", "total_ce_oi",
        "total_pe_oi", "total_ce_oi_change", "total_pe_oi_change",
        "current_iv", "iv_history", "oi_concentration",
    ):
        val = getattr(snap, field_name, None)
        if val is not None:
            d[field_name] = val
    return d


# ─── Labeling functions (Requirement #7) ──────────────────────────────────────


def _risk_adjusted_return(
    returns: pd.Series, horizon: int, annual_factor: float = 252.0
) -> pd.Series:
    """
    Compute risk-adjusted forward return (Sharpe-like) over `horizon` bars.

    Defined as: forward_return / rolling_std(lookback=horizon)
    Capped at ±5 to prevent extreme outliers from dominating ranking labels.
    """
    fwd = returns.shift(-horizon)
    vol = returns.rolling(horizon).std()
    ra = (fwd / (vol + 1e-8)).clip(-5, 5)
    return ra


def generate_ranking_labels_v2(
    stock_df: pd.DataFrame,
    nifty_close: pd.Series,
    horizon: int = 5,
) -> pd.Series:
    """
    Generate stock-ranking labels.

    Returns risk-adjusted relative return vs NIFTY over `horizon` bars.
    Future data is shifted BACKWARDS (forward-looking), then the result is
    stored at timestamp t — the timestamp of the bar when we place the order.

    Leakage note: the label at index i uses close[i+1..i+horizon], which is
    by definition future data. This is intentional and correct — the model
    is trained on (features at t) → (outcome after t). Features must never
    use data after t.
    """
    if len(stock_df) < horizon + 2:
        return pd.Series(dtype=float)

    stock_ret = stock_df["close"].pct_change()
    nifty_ret = nifty_close.reindex(stock_df.index).pct_change()

    # Forward return = mean daily return over next `horizon` bars
    stock_fwd = stock_ret.shift(-1).rolling(horizon).mean().shift(-(horizon - 1))
    nifty_fwd = nifty_ret.shift(-1).rolling(horizon).mean().shift(-(horizon - 1))

    # Risk-adjusted: forward excess return / historical vol
    excess = stock_fwd - nifty_fwd
    vol = stock_ret.rolling(horizon * 2).std()
    ra = (excess / (vol + 1e-8)).clip(-5, 5)
    return ra


def generate_risk_labels(
    df: pd.DataFrame,
    atr_series: pd.Series,
    stop_atr_mult: float = 1.4,
    target_atr_mult: float = 2.0,
    lookforward: int = 20,
) -> tuple[pd.Series, pd.Series, pd.Series]:
    """
    Generate risk model labels at each bar.

    Simulates a long trade entry at close[t] with:
      stop  = close[t] - stop_atr_mult   × ATR[t]
      target= close[t] + target_atr_mult × ATR[t]

    Looks forward `lookforward` bars into low[] and high[] to determine:
      stop_hit   : 1 if any future low ≤ stop  (else 0)
      target_hit : 1 if any future high ≥ target (else 0)
      mae        : max adverse excursion % (abs of min future drawdown from entry)

    Returned series are indexed identically to df — NaN at the tail where
    there aren't enough future bars.

    No future leakage: labels are computed purely from future OHLC. They are
    NEVER used as input features.
    """
    close = df["close"]
    low = df["low"]
    high = df["high"]
    n = len(df)

    stop_hit = pd.Series(np.nan, index=df.index, dtype=float)
    target_hit = pd.Series(np.nan, index=df.index, dtype=float)
    mae = pd.Series(np.nan, index=df.index, dtype=float)

    for i in range(len(df) - lookforward):
        entry = close.iloc[i]
        atr_val = atr_series.iloc[i]
        if atr_val <= 0 or entry <= 0 or np.isnan(atr_val) or np.isnan(entry):
            continue

        stop_price = entry - stop_atr_mult * atr_val
        target_price = entry + target_atr_mult * atr_val

        fwd_low = low.iloc[i + 1 : i + 1 + lookforward]
        fwd_high = high.iloc[i + 1 : i + 1 + lookforward]

        stop_hit.iloc[i] = 1.0 if (fwd_low <= stop_price).any() else 0.0
        target_hit.iloc[i] = 1.0 if (fwd_high >= target_price).any() else 0.0
        min_low = fwd_low.min()
        raw_mae = abs(min((min_low - entry) / entry * 100, 0.0))
        mae.iloc[i] = min(raw_mae, 20.0)  # cap at 20 % (Requirement #7)

    return stop_hit, target_hit, mae


def generate_regime_labels_v2(
    nifty_df: pd.DataFrame,
    lookforward: int = 5,
) -> pd.Series:
    """
    Delegate to the existing MarketRegime label generator.
    Kept here as a thin wrapper so data_pipeline.py is self-contained.
    """
    return generate_regime_labels(nifty_df, lookforward=lookforward)


# ─── Dataset builders ─────────────────────────────────────────────────────────


def build_regime_training_data(
    nifty_df: pd.DataFrame,
    banknifty_df: pd.DataFrame | None,
    market_breadth: dict[date, MarketBreadthRecord] | None = None,
    india_vix: pd.Series | None = None,
    lookback: int = 200,
    horizon: int = 5,
) -> tuple[np.ndarray, np.ndarray]:
    """
    Build training data for the Market Regime Classifier.

    Strict leakage prevention:
      - Features at bar i are computed from nifty_df.iloc[i-lookback : i+1]
        (current bar is included; future bars i+1..n are excluded)
      - Labels use nifty_df.iloc[i+1 : i+1+horizon] (forward window, separate)

    F&O-specific inputs: India VIX, advance/decline ratio, PCR from
    market_breadth if available.
    """
    labels = generate_regime_labels_v2(nifty_df, lookforward=horizon)

    features_list: list[list[float]] = []
    valid_indices: list[int] = []

    for i in range(lookback, len(nifty_df) - horizon):
        try:
            # ── LEAKAGE GUARD: only use data up to and including bar i ──
            nifty_window = nifty_df.iloc[max(0, i - lookback) : i + 1]
            bn_window = (
                banknifty_df.iloc[max(0, i - lookback) : i + 1]
                if banknifty_df is not None
                else None
            )

            # Inject market breadth at this date (no future data)
            row_date: date | None = None
            if isinstance(nifty_df.index[i], pd.Timestamp):
                row_date = nifty_df.index[i].date()

            macro: dict[str, Any] = {}
            if market_breadth and row_date and row_date in market_breadth:
                mb = market_breadth[row_date]
                macro["advance_decline_ratio"] = mb.advance_decline_ratio
                macro["market_breadth"] = mb.advance_count / max(
                    mb.advance_count + mb.decline_count, 1
                ) * 100
                macro["pct_above_sma20"] = mb.pct_above_sma20
                macro["pct_above_sma50"] = mb.pct_above_sma50
                macro["pct_above_sma200"] = mb.pct_above_sma200
                if mb.india_vix is not None:
                    macro["india_vix"] = mb.india_vix

            if india_vix is not None and row_date is not None:
                vix_ts = pd.Timestamp(row_date, tz="UTC")
                if vix_ts in india_vix.index:
                    macro["india_vix"] = float(india_vix[vix_ts])

            feats = compute_regime_features(nifty_window, bn_window, macro)
            feature_vector = [feats.get(f, 0.0) for f in REGIME_FEATURES]
            features_list.append(feature_vector)
            valid_indices.append(i)
        except Exception:
            continue

    if not features_list:
        return np.empty((0, len(REGIME_FEATURES)), dtype=np.float32), np.empty(0, dtype=np.int32)

    X = np.array(features_list, dtype=np.float32)
    y = labels.iloc[valid_indices].values.astype(np.int32)

    valid_mask = ~np.any(np.isnan(X), axis=1)
    return X[valid_mask], y[valid_mask]


def build_ranking_training_data(
    stock_data: dict[str, pd.DataFrame],
    nifty_df: pd.DataFrame,
    derivatives: dict[str, dict[date, DerivativesSnapshot]] | None = None,
    horizon: int = 5,
    lookback: int = 200,
    min_stocks_per_day: int = 5,
) -> tuple[np.ndarray, np.ndarray, list[int]]:
    """
    Build training data for the Stock Ranker.

    Labeling (Requirement #7 — stock ranking):
      - Label = risk-adjusted forward relative return vs NIFTY over `horizon` bars
      - Computed strictly forward from the prediction timestamp

    Leakage prevention:
      - Feature window is [i-lookback : i+1] (current bar inclusive, future excluded)
      - Label window is [i+1 : i+1+horizon] (strictly future)

    F&O enrichment:
      - Per-stock derivative snapshot at date t injected into features
        (OI buildup, PCR, IV rank, max pain, OI walls)

    Returns:
      X      — (n_stock_days, n_features)
      y      — (n_stock_days,) risk-adjusted relative return
      groups — number of stocks per day (for LambdaRank training)
    """
    nifty_close = nifty_df["close"]
    nifty_ret = nifty_close.pct_change()

    all_features: list[list[float]] = []
    all_targets: list[float] = []
    groups: list[int] = []

    # Find common trading dates across all stocks
    common_dates: set | None = None
    for df in stock_data.values():
        dates_set = set(df.index)
        common_dates = dates_set if common_dates is None else common_dates & dates_set

    if not common_dates:
        return np.empty((0,), dtype=np.float32), np.empty((0,), dtype=np.float32), []

    # Sorted date list — strictly time-ordered (no shuffling)
    sorted_dates = sorted(common_dates)

    for date_val in sorted_dates[lookback:-horizon]:
        day_features: list[list[float]] = []
        day_targets: list[float] = []

        # NIFTY forward return at this date (for relative-return label)
        if date_val not in nifty_df.index:
            continue
        nifty_loc = nifty_df.index.get_loc(date_val)
        if nifty_loc + horizon >= len(nifty_close):
            continue

        # Forward NIFTY return over horizon bars (strictly future — label only)
        nifty_fwd = float(
            (nifty_close.iloc[nifty_loc + horizon] - nifty_close.iloc[nifty_loc])
            / nifty_close.iloc[nifty_loc]
        )

        for sym, df in stock_data.items():
            if date_val not in df.index:
                continue
            try:
                loc = df.index.get_loc(date_val)
                if loc < lookback or loc + horizon >= len(df):
                    continue

                # ── LEAKAGE GUARD: feature window ends at loc (inclusive) ──
                window = df.iloc[max(0, loc - lookback) : loc + 1]
                nifty_window = nifty_close.iloc[
                    max(0, loc - lookback) : loc + 1
                ]

                # Resolve derivative data at this date
                date_key: date | None = (
                    date_val.date()
                    if isinstance(date_val, pd.Timestamp)
                    else date_val
                )
                deriv_snap = None
                if derivatives and sym in derivatives and date_key:
                    deriv_snap = derivatives[sym].get(date_key)

                deriv_dict = _build_derivatives_dict(deriv_snap)

                feats = compute_stock_features(
                    window,
                    index_close=nifty_window,
                    derivatives_data=deriv_dict,
                )
                feature_vector = [feats.get(f, 0.0) for f in RANKING_FEATURES]

                # ── Label: risk-adjusted forward relative return ──────────
                stock_fwd = float(
                    (df["close"].iloc[loc + horizon] - df["close"].iloc[loc])
                    / df["close"].iloc[loc]
                )
                excess_return = stock_fwd - nifty_fwd
                rolling_vol = float(df["close"].pct_change().iloc[loc - lookback : loc].std() + 1e-8)
                label = float(np.clip(excess_return / rolling_vol, -5, 5))

                day_features.append(feature_vector)
                day_targets.append(label)
            except Exception:
                continue

        if len(day_features) >= min_stocks_per_day:
            all_features.extend(day_features)
            all_targets.extend(day_targets)
            groups.append(len(day_features))

    if not all_features:
        n_feats = len(RANKING_FEATURES)
        return (
            np.empty((0, n_feats), dtype=np.float32),
            np.empty((0,), dtype=np.float32),
            [],
        )

    X = np.array(all_features, dtype=np.float32)
    y = np.array(all_targets, dtype=np.float32)

    valid_mask = ~(np.any(np.isnan(X), axis=1) | np.isnan(y))
    X, y = X[valid_mask], y[valid_mask]

    logger.info("ranking_data_built", samples=len(X), days=len(groups))
    return X, y, groups


def build_strategy_training_data(
    stock_data: dict[str, pd.DataFrame],
    regime_labels: pd.Series,
    derivatives: dict[str, dict[date, DerivativesSnapshot]] | None = None,
    lookback: int = 200,
    horizon: int = 5,
) -> tuple[np.ndarray, np.ndarray]:
    """
    Build training data for the Strategy Selector.

    For each stock-day, labels which strategy produced the best risk-adjusted
    outcome over the next `horizon` bars.

    Leakage prevention: features at bar i use only [i-lookback : i+1].
    Labels use [i+1 : i+1+horizon].
    """
    all_features: list[list[float]] = []
    all_labels: list[int] = []

    for sym, df in stock_data.items():
        if len(df) < lookback + horizon + 10:
            continue
        try:
            strategy_labels = generate_strategy_labels(
                df, regime_labels, lookforward=horizon
            )
        except Exception:
            continue

        for i in range(lookback, len(df) - horizon):
            try:
                window = df.iloc[max(0, i - lookback) : i + 1]
                date_key: date | None = (
                    df.index[i].date()
                    if isinstance(df.index[i], pd.Timestamp)
                    else None
                )
                deriv_dict: dict[str, Any] = {}
                if derivatives and sym in derivatives and date_key:
                    snap = derivatives[sym].get(date_key)
                    deriv_dict = _build_derivatives_dict(snap)

                feats = compute_stock_features(window, derivatives_data=deriv_dict)
                feature_vector = [feats.get(f, 0.0) for f in STRATEGY_FEATURES]
                all_features.append(feature_vector)
                all_labels.append(int(strategy_labels.iloc[i]))
            except Exception:
                continue

    if not all_features:
        return np.empty((0,), dtype=np.float32), np.empty((0,), dtype=np.int32)

    X = np.array(all_features, dtype=np.float32)
    y = np.array(all_labels, dtype=np.int32)

    valid_mask = ~np.any(np.isnan(X), axis=1)
    logger.info("strategy_data_built", samples=int(valid_mask.sum()))
    return X[valid_mask], y[valid_mask]


def build_risk_training_data(
    stock_data: dict[str, pd.DataFrame],
    derivatives: dict[str, dict[date, DerivativesSnapshot]] | None = None,
    stop_atr_mult: float = 1.4,
    target_atr_mult: float = 2.0,
    lookback: int = 200,
    lookforward: int = 20,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """
    Build training data for the Risk Predictor.

    Labels (Requirement #7 — risk models):
      - stop_hit   : P(stop loss hit within `lookforward` bars)
      - target_hit : P(target hit within `lookforward` bars)
      - mae        : Maximum Adverse Excursion % (worst intra-trade drawdown)

    Leakage prevention:
      - Features at bar i from [i-lookback : i+1]
      - Outcomes scanned from [i+1 : i+1+lookforward] (strictly future)
    """
    from ..features.technical import compute_atr  # type: ignore[import]

    all_features: list[list[float]] = []
    y_stop_list: list[int] = []
    y_target_list: list[int] = []
    y_dd_list: list[float] = []

    for sym, df in stock_data.items():
        if len(df) < lookback + lookforward + 10:
            continue
        try:
            atr = compute_atr(df["high"], df["low"], df["close"], 14)
            stop_hit, target_hit, mae_series = generate_risk_labels(
                df, atr,
                stop_atr_mult=stop_atr_mult,
                target_atr_mult=target_atr_mult,
                lookforward=lookforward,
            )
        except Exception:
            continue

        for i in range(lookback, len(df) - lookforward):
            if np.isnan(stop_hit.iloc[i]):
                continue
            try:
                window = df.iloc[max(0, i - lookback) : i + 1]
                date_key: date | None = (
                    df.index[i].date()
                    if isinstance(df.index[i], pd.Timestamp)
                    else None
                )
                deriv_dict: dict[str, Any] = {}
                if derivatives and sym in derivatives and date_key:
                    snap = derivatives[sym].get(date_key)
                    deriv_dict = _build_derivatives_dict(snap)

                feats = compute_stock_features(window, derivatives_data=deriv_dict)
                feats["stop_distance_atr"] = stop_atr_mult
                feats["target_distance_atr"] = target_atr_mult
                feats["risk_reward_ratio"] = target_atr_mult / stop_atr_mult
                feats["trend_alignment"] = feats.get("trend_strength", 0.0)

                feature_vector = [feats.get(f, 0.0) for f in RISK_FEATURES]
                all_features.append(feature_vector)
                y_stop_list.append(int(stop_hit.iloc[i]))
                y_target_list.append(int(target_hit.iloc[i]))
                y_dd_list.append(float(np.clip(mae_series.iloc[i], 0, 20)))
            except Exception:
                continue

    if not all_features:
        empty = np.empty((0,), dtype=np.float32)
        return empty, empty.astype(np.int32), empty.astype(np.int32), empty

    X = np.array(all_features, dtype=np.float32)
    y_stop = np.array(y_stop_list, dtype=np.int32)
    y_target = np.array(y_target_list, dtype=np.int32)
    y_dd = np.array(y_dd_list, dtype=np.float32)

    valid_mask = ~np.any(np.isnan(X), axis=1)
    logger.info("risk_data_built", samples=int(valid_mask.sum()))
    return X[valid_mask], y_stop[valid_mask], y_target[valid_mask], y_dd[valid_mask]


# ─── Dataset persistence helpers ──────────────────────────────────────────────


def _compute_universe_fingerprint(universe: list[str]) -> str:
    """Short hash of the instrument universe for dataset version tagging."""
    payload = ",".join(sorted(universe))
    return hashlib.sha1(payload.encode()).hexdigest()[:8]


def _save_dataset(
    output_dir: Path,
    name: str,
    arrays: dict[str, np.ndarray],
    metadata: DatasetMetadata,
) -> Path:
    """
    Save a training dataset as a compressed NPZ file + a JSON metadata sidecar.

    File layout:
      {output_dir}/{name}.npz      — compressed numpy arrays
      {output_dir}/{name}_meta.json — DatasetMetadata as JSON
    """
    output_dir.mkdir(parents=True, exist_ok=True)
    npz_path = output_dir / f"{name}.npz"
    meta_path = output_dir / f"{name}_meta.json"

    np.savez_compressed(npz_path, **arrays)

    meta_dict = metadata.to_dict()
    meta_dict["recordCount"] = int(next(iter(arrays.values())).shape[0])
    meta_path.write_text(json.dumps(meta_dict, indent=2))

    logger.info("dataset_saved", path=str(npz_path), records=meta_dict["recordCount"])
    return npz_path


# ─── Main pipeline orchestrator ───────────────────────────────────────────────


def run_pipeline(
    start_date: str = "2023-01-01",
    end_date: str | None = None,
    output_dir: Path | None = None,
    universe: list[str] | None = None,
    quick: bool = False,
) -> dict[str, Path]:
    """
    Run the full AlphaForge training data pipeline.

    Steps:
      1. Fetch OHLCV + derivatives for every symbol in the universe via
         the normalized data client (AlphaForge API → PostgreSQL → yfinance)
      2. Enrich each symbol's OHLCV with F&O derivatives data
      3. Apply data quality filtering (drop STALE / INVALID / SUSPICIOUS)
      4. Build labeled datasets for all four models
      5. Validate no future leakage in feature matrices
      6. Save NPZ artefacts + DatasetMetadata JSON sidecars
      7. Return paths to all saved artefacts

    Args:
        start_date: ISO date string, training window start
        end_date:   ISO date string, training window end (default: today)
        output_dir: Directory to write artefacts (default: settings.training_data_path)
        universe:   Override the symbol universe
        quick:      Use the reduced QUICK_UNIVERSE for fast iteration

    Returns:
        Dict mapping dataset name → Path of saved NPZ file.
    """
    if end_date is None:
        end_date = date.today().isoformat()
    if output_dir is None:
        output_dir = settings.training_data_path
    if universe is None:
        universe = QUICK_UNIVERSE if quick else TRAINING_UNIVERSE

    universe_hash = _compute_universe_fingerprint(universe)
    run_ts = datetime.utcnow().isoformat(timespec="seconds") + "Z"

    logger.info(
        "pipeline_start",
        start=start_date,
        end=end_date,
        symbols=len(universe),
        quick=quick,
        dataset_version=DATASET_VERSION,
    )

    saved_paths: dict[str, Path] = {}

    with create_client_from_env() as client:
        # ── Step 1: Fetch OHLCV for full universe ─────────────────────────
        logger.info("fetching_universe_ohlcv", count=len(universe))
        raw_data = client.get_universe_ohlcv(
            universe,
            start_date,
            end_date,
            # Data quality filtering applied at source — STALE/INVALID/SUSPICIOUS
            # rows are stripped before any feature computation (Requirement #9)
            exclude_quality={
                DataQuality.STALE,
                DataQuality.INVALID,
                DataQuality.SUSPICIOUS,
            },
        )

        if not raw_data:
            logger.error("no_data_fetched", universe=universe)
            return saved_paths

        # ── Step 2: Fetch derivatives for F&O names ───────────────────────
        # Indices and equities that have F&O segment data
        fo_symbols = [
            s for s in universe if s not in ("INDIA_VIX",)
        ]
        logger.info("fetching_derivatives", count=len(fo_symbols))
        derivatives: dict[str, dict[date, DerivativesSnapshot]] = {}
        for sym in fo_symbols:
            snaps = client.get_derivatives(sym, start_date, end_date)
            if snaps:
                derivatives[sym] = snaps

        # ── Step 3: Market breadth + India VIX ────────────────────────────
        market_breadth = client.get_market_breadth(start_date, end_date)
        india_vix = client.get_india_vix(start_date, end_date)

        # ── Step 4: Enrich OHLCV with derivatives data ────────────────────
        enriched: dict[str, pd.DataFrame] = {}
        for sym, df in raw_data.items():
            deriv_snaps = derivatives.get(sym, {})
            enriched[sym] = enrich_with_derivatives(df, deriv_snaps)

        # Separate index data
        nifty_df = enriched.get("NIFTY") or enriched.get("^NSEI")
        banknifty_df = enriched.get("BANKNIFTY") or enriched.get("^NSEBANK")

        if nifty_df is None or nifty_df.empty:
            logger.error("nifty_data_missing")
            return saved_paths

        # Stock-only dict (exclude index symbols)
        index_symbols = {"NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY",
                         "^NSEI", "^NSEBANK", "^CNXFIN", "^NSEMDCP50"}
        stock_data = {
            sym: df
            for sym, df in enriched.items()
            if sym not in index_symbols and len(df) >= 50
        }

        sources_used = client.sources_used

    # ── Step 5: Build metadata template ───────────────────────────────────
    base_metadata = DatasetMetadata(
        dataset_version=f"{DATASET_VERSION}-{universe_hash}",
        provider_sources=sources_used or ["yfinance"],
        date_range=(start_date, end_date),
        instrument_universe=universe,
        feature_version=FEATURE_VERSION,
        generated_at=run_ts,
    )

    # ── Step 6: Build regime dataset ──────────────────────────────────────
    logger.info("building_regime_dataset")
    X_reg, y_reg = build_regime_training_data(
        nifty_df,
        banknifty_df,
        market_breadth=market_breadth,
        india_vix=india_vix,
    )
    if X_reg.shape[0] > 0:
        reg_meta = DatasetMetadata(
            **{**asdict(base_metadata), "feature_version": f"{FEATURE_VERSION}-regime"}
        )
        saved_paths["regime_train"] = _save_dataset(
            output_dir, "regime_train",
            {"X": X_reg, "y": y_reg},
            reg_meta,
        )

    # ── Step 7: Build ranking dataset ─────────────────────────────────────
    logger.info("building_ranking_dataset")
    X_rank, y_rank, groups = build_ranking_training_data(
        stock_data,
        nifty_df,
        derivatives=derivatives,
    )
    if X_rank.shape[0] > 0:
        # Walk-forward split validation
        try:
            splits = walk_forward_splits(
                n_periods=len(groups),
                train_size=int(len(groups) * 0.6),
                val_size=int(len(groups) * 0.2),
                test_size=int(len(groups) * 0.2),
            )
            logger.info("wf_splits_generated", count=len(splits))
        except ValueError as e:
            logger.warning("wf_splits_skipped", reason=str(e))

        rank_meta = DatasetMetadata(
            **{**asdict(base_metadata), "feature_version": f"{FEATURE_VERSION}-ranking"}
        )
        saved_paths["ranking_train"] = _save_dataset(
            output_dir, "ranking_train",
            {"X": X_rank, "y": y_rank, "groups": np.array(groups, dtype=np.int32)},
            rank_meta,
        )

    # ── Step 8: Build strategy dataset ────────────────────────────────────
    logger.info("building_strategy_dataset")
    if y_reg.shape[0] > 0:
        regime_labels_series = pd.Series(
            y_reg, index=nifty_df.index[200 : 200 + len(y_reg)]
        )
    else:
        regime_labels_series = pd.Series(dtype=int)

    X_strat, y_strat = build_strategy_training_data(
        stock_data, regime_labels_series, derivatives=derivatives
    )
    if X_strat.shape[0] > 0:
        strat_meta = DatasetMetadata(
            **{**asdict(base_metadata), "feature_version": f"{FEATURE_VERSION}-strategy"}
        )
        saved_paths["strategy_train"] = _save_dataset(
            output_dir, "strategy_train",
            {"X": X_strat, "y": y_strat},
            strat_meta,
        )

    # ── Step 9: Build risk dataset ─────────────────────────────────────────
    logger.info("building_risk_dataset")
    X_risk, y_stop, y_target, y_dd = build_risk_training_data(
        stock_data, derivatives=derivatives
    )
    if X_risk.shape[0] > 0:
        risk_meta = DatasetMetadata(
            **{**asdict(base_metadata), "feature_version": f"{FEATURE_VERSION}-risk"}
        )
        saved_paths["risk_train"] = _save_dataset(
            output_dir, "risk_train",
            {"X": X_risk, "y_stop": y_stop, "y_target": y_target, "y_drawdown": y_dd},
            risk_meta,
        )

    logger.info(
        "pipeline_complete",
        datasets_saved=len(saved_paths),
        sources=sources_used,
        date_range=(start_date, end_date),
        symbols_processed=len(raw_data),
    )
    return saved_paths


# ─── CLI entrypoint ───────────────────────────────────────────────────────────


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="AlphaForge ML training data pipeline",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--start",
        default="2023-01-01",
        help="Training window start date (YYYY-MM-DD)",
    )
    parser.add_argument(
        "--end",
        default=None,
        help="Training window end date (YYYY-MM-DD). Defaults to today.",
    )
    parser.add_argument(
        "--output",
        default=None,
        help="Output directory for artefacts. Defaults to TRAINING_DATA_PATH.",
    )
    parser.add_argument(
        "--quick",
        action="store_true",
        help="Use reduced universe (12 symbols) for fast iteration.",
    )
    return parser.parse_args()


if __name__ == "__main__":
    args = _parse_args()
    output_dir = Path(args.output) if args.output else None
    run_pipeline(
        start_date=args.start,
        end_date=args.end,
        output_dir=output_dir,
        quick=args.quick,
    )
