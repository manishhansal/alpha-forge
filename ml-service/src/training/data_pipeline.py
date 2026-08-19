"""
Training Data Pipeline.

Fetches historical NSE OHLCV data, computes features for the full F&O
universe, and generates labeled datasets for all models:

  1. Market Regime labels (from NIFTY forward returns + vol + drawdown)
  2. Stock Ranking labels (forward relative returns vs NIFTY)
  3. Strategy Selection labels (which strategy worked best)
  4. Risk labels (stop hit / target hit / max adverse excursion)

Output: Parquet files in the data/ directory ready for model training.

Usage:
  python -m src.training.data_pipeline --start 2023-01-01 --end 2026-07-31
"""

import argparse
from datetime import datetime, timedelta
from pathlib import Path

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

logger = structlog.get_logger()

# F&O Universe (top liquid names for training — expand as data allows)
TRAINING_UNIVERSE = [
    # Indices
    "^NSEI", "^NSEBANK",
    # Top 50 F&O stocks by liquidity
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


def fetch_historical_ohlcv(
    symbol: str,
    start_date: str,
    end_date: str,
) -> pd.DataFrame | None:
    """
    Fetch historical OHLCV data for a symbol.

    Uses Yahoo Finance via yfinance library (for training — not live trading).
    Returns DataFrame with columns [open, high, low, close, volume] and DatetimeIndex.
    """
    try:
        import yfinance as yf

        # Add .NS suffix for NSE stocks (indices already have ^ prefix)
        ticker = symbol if symbol.startswith("^") else f"{symbol}.NS"

        df = yf.download(
            ticker,
            start=start_date,
            end=end_date,
            interval="1d",
            progress=False,
            auto_adjust=True,
        )

        if df is None or df.empty:
            logger.warning("no_data", symbol=symbol)
            return None

        # Normalize column names (yfinance >=1.0 returns MultiIndex columns)
        if isinstance(df.columns, pd.MultiIndex):
            df.columns = [c[0].lower() for c in df.columns]
        else:
            df.columns = [c.lower() for c in df.columns]
        required = ["open", "high", "low", "close", "volume"]
        if not all(c in df.columns for c in required):
            return None

        return df[required].dropna()

    except Exception as e:
        logger.warning("fetch_failed", symbol=symbol, error=str(e))
        return None


def build_regime_training_data(
    nifty_df: pd.DataFrame,
    banknifty_df: pd.DataFrame | None,
    market_data: dict | None = None,
) -> tuple[np.ndarray, np.ndarray]:
    """
    Build training data for the Market Regime Classifier.

    For each trading day, computes the regime features and assigns a label
    based on the forward-looking market behavior.
    """
    # Generate labels from NIFTY forward returns
    labels = generate_regime_labels(nifty_df, lookforward=5)

    # Compute features for each day
    features_list = []
    valid_indices = []

    for i in range(50, len(nifty_df) - 5):  # Need 50 bars lookback, 5 bars forward
        try:
            nifty_window = nifty_df.iloc[max(0, i - 200):i + 1]
            bn_window = banknifty_df.iloc[max(0, i - 200):i + 1] if banknifty_df is not None else None

            feats = compute_regime_features(
                nifty_window,
                bn_window,
                market_data,
            )

            feature_vector = [feats.get(f, 0.0) for f in REGIME_FEATURES]
            features_list.append(feature_vector)
            valid_indices.append(i)
        except Exception:
            continue

    X = np.array(features_list, dtype=np.float32)
    y = labels.iloc[valid_indices].values.astype(np.int32)

    # Remove any NaN rows
    valid_mask = ~np.any(np.isnan(X), axis=1)
    X = X[valid_mask]
    y = y[valid_mask]

    logger.info("regime_data_built", samples=len(X), features=X.shape[1])
    return X, y


def build_ranking_training_data(
    stock_data: dict[str, pd.DataFrame],
    nifty_df: pd.DataFrame,
) -> tuple[np.ndarray, np.ndarray, list[int]]:
    """
    Build training data for the Stock Ranker.

    For each trading day, computes per-stock features and assigns labels
    based on the next-day relative return vs NIFTY.

    Returns:
        X: Feature matrix (n_total_stock_days, n_features)
        y: Forward relative returns (regression target)
        groups: Number of stocks per day (for LambdaRank)
    """
    nifty_close = nifty_df["close"]
    nifty_returns = nifty_close.pct_change()

    all_features = []
    all_targets = []
    groups = []

    # Process day by day
    common_dates = None
    for sym, df in stock_data.items():
        if common_dates is None:
            common_dates = set(df.index)
        else:
            common_dates &= set(df.index)

    if not common_dates:
        return np.array([]), np.array([]), []

    sorted_dates = sorted(common_dates)

    for i, date in enumerate(sorted_dates[200:-2]):  # Need lookback + forward
        day_features = []
        day_targets = []

        # NIFTY forward return
        date_idx = nifty_df.index.get_loc(date) if date in nifty_df.index else None
        if date_idx is None or date_idx + 1 >= len(nifty_df):
            continue
        nifty_fwd = nifty_returns.iloc[date_idx + 1] if date_idx + 1 < len(nifty_returns) else 0

        for sym, df in stock_data.items():
            if date not in df.index:
                continue

            try:
                loc = df.index.get_loc(date)
                if loc < 200 or loc + 1 >= len(df):
                    continue

                window = df.iloc[max(0, loc - 200):loc + 1]
                nifty_window = nifty_df["close"].iloc[max(0, loc - 200):loc + 1]

                feats = compute_stock_features(
                    window,
                    index_close=nifty_window,
                )

                feature_vector = [feats.get(f, 0.0) for f in RANKING_FEATURES]

                # Forward relative return
                stock_fwd = (df["close"].iloc[loc + 1] - df["close"].iloc[loc]) / df["close"].iloc[loc]
                relative_return = stock_fwd - nifty_fwd

                day_features.append(feature_vector)
                day_targets.append(relative_return)
            except Exception:
                continue

        if len(day_features) >= 5:  # Need at least 5 stocks per day for ranking
            all_features.extend(day_features)
            all_targets.extend(day_targets)
            groups.append(len(day_features))

    X = np.array(all_features, dtype=np.float32)
    y = np.array(all_targets, dtype=np.float32)

    # Clean NaN
    valid_mask = ~(np.any(np.isnan(X), axis=1) | np.isnan(y))
    X = X[valid_mask]
    y = y[valid_mask]

    logger.info("ranking_data_built", samples=len(X), days=len(groups))
    return X, y, groups


def build_strategy_training_data(
    stock_data: dict[str, pd.DataFrame],
    regime_labels: pd.Series,
) -> tuple[np.ndarray, np.ndarray]:
    """
    Build training data for the Strategy Selector.

    For each stock-day, computes strategy features and labels with the
    strategy that would have performed best over the next 5 bars.
    """
    all_features = []
    all_labels = []

    for sym, df in stock_data.items():
        if len(df) < 250:
            continue

        try:
            # Generate strategy labels for this stock
            strategy_labels = generate_strategy_labels(df, regime_labels, lookforward=5)

            for i in range(50, len(df) - 5):
                window = df.iloc[max(0, i - 200):i + 1]
                feats = compute_stock_features(window)

                feature_vector = [feats.get(f, 0.0) for f in STRATEGY_FEATURES]
                all_features.append(feature_vector)
                all_labels.append(strategy_labels.iloc[i])
        except Exception:
            continue

    X = np.array(all_features, dtype=np.float32)
    y = np.array(all_labels, dtype=np.int32)

    valid_mask = ~np.any(np.isnan(X), axis=1)
    X = X[valid_mask]
    y = y[valid_mask]

    logger.info("strategy_data_built", samples=len(X))
    return X, y


def build_risk_training_data(
    stock_data: dict[str, pd.DataFrame],
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """
    Build training data for the Risk Predictor.

    Simulates trades at each bar (using ATR-based stop/target) and records
    whether the stop or target was hit, plus the max adverse excursion.
    """
    from ..features.technical import compute_atr

    all_features = []
    y_stop_list = []
    y_target_list = []
    y_drawdown_list = []

    for sym, df in stock_data.items():
        if len(df) < 100:
            continue

        try:
            atr = compute_atr(df["high"], df["low"], df["close"], 14)

            for i in range(50, len(df) - 20):
                entry = df["close"].iloc[i]
                atr_val = atr.iloc[i]
                if atr_val <= 0 or entry <= 0:
                    continue

                # Simulate a long trade
                stop = entry - 1.4 * atr_val
                target = entry + 2.0 * atr_val

                # Look forward 20 bars
                future = df["close"].iloc[i + 1:i + 21]
                future_low = df["low"].iloc[i + 1:i + 21]
                future_high = df["high"].iloc[i + 1:i + 21]

                # Check outcomes
                stop_hit = (future_low <= stop).any()
                target_hit = (future_high >= target).any()

                # Max adverse excursion
                mae = ((future_low.min() - entry) / entry) * 100
                mae = abs(min(mae, 0))

                # Compute features
                window = df.iloc[max(0, i - 200):i + 1]
                feats = compute_stock_features(window)
                feats["stop_distance_atr"] = 1.4
                feats["target_distance_atr"] = 2.0
                feats["risk_reward_ratio"] = 2.0 / 1.4
                feats["trend_alignment"] = feats.get("trend_strength", 0)

                feature_vector = [feats.get(f, 0.0) for f in RISK_FEATURES]

                all_features.append(feature_vector)
                y_stop_list.append(1 if stop_hit else 0)
                y_target_list.append(1 if target_hit else 0)
                y_drawdown_list.append(min(mae, 20.0))
        except Exception:
            continue

    X = np.array(all_features, dtype=np.float32)
    y_stop = np.array(y_stop_list, dtype=np.int32)
    y_target = np.array(y_target_list, dtype=np.int32)
    y_dd = np.array(y_drawdown_list, dtype=np.float32)

    valid_mask = ~np.any(np.isnan(X), axis=1)
    X = X[valid_mask]
    y_stop = y_stop[valid_mask]
    y_target = y_target[valid_mask]
    y_dd = y_dd[valid_mask]

    logger.info("risk_data_built", samples=len(X))
    return X, y_stop, y_target, y_dd


def run_pipeline(
    start_date: str = "2023-01-01",
    end_date: str = "2026-07-31",
    output_dir: Path | None = None,
) -> dict[str, Path]:
    """
    Run the full training data pipeline.

    Fetches data, computes features, generates labels, saves to parquet.
    """
    if output_dir is None:
        output_dir = settings.training_data_path
    output_dir.mkdir(parents=True, exist_ok=True)

    logger.info("pipeline_started", start=start_date, end=end_date)

    # 1. Fetch NIFTY (required for all models)
    logger.info("fetching_nifty")
    nifty_df = fetch_historical_ohlcv("^NSEI", start_date, end_date)
    if nifty_df is None or len(nifty_df) < 200:
        raise RuntimeError("Cannot fetch sufficient NIFTY data")

    banknifty_df = fetch_historical_ohlcv("^NSEBANK", start_date, end_date)

    # 2. Fetch stock universe
    logger.info("fetching_stocks", n=len(TRAINING_UNIVERSE))
    stock_data: dict[str, pd.DataFrame] = {}
    for sym in TRAINING_UNIVERSE:
        if sym.startswith("^"):
            continue  # Already fetched indices
        df = fetch_historical_ohlcv(sym, start_date, end_date)
        if df is not None and len(df) >= 200:
            stock_data[sym] = df
            logger.info("fetched", symbol=sym, bars=len(df))

    logger.info("stocks_fetched", count=len(stock_data))

    outputs: dict[str, Path] = {}

    # 3. Build Regime training data
    logger.info("building_regime_data")
    X_regime, y_regime = build_regime_training_data(nifty_df, banknifty_df)
    regime_path = output_dir / "regime_train.npz"
    np.savez(regime_path, X=X_regime, y=y_regime)
    outputs["regime"] = regime_path
    logger.info("regime_data_saved", path=str(regime_path), samples=len(X_regime))

    # 4. Build Ranking training data
    logger.info("building_ranking_data")
    X_rank, y_rank, groups = build_ranking_training_data(stock_data, nifty_df)
    ranking_path = output_dir / "ranking_train.npz"
    np.savez(ranking_path, X=X_rank, y=y_rank, groups=np.array(groups))
    outputs["ranking"] = ranking_path
    logger.info("ranking_data_saved", path=str(ranking_path), samples=len(X_rank))

    # 5. Build Strategy training data
    logger.info("building_strategy_data")
    regime_labels = generate_regime_labels(nifty_df, lookforward=5)
    X_strat, y_strat = build_strategy_training_data(stock_data, regime_labels)
    strategy_path = output_dir / "strategy_train.npz"
    np.savez(strategy_path, X=X_strat, y=y_strat)
    outputs["strategy"] = strategy_path
    logger.info("strategy_data_saved", path=str(strategy_path), samples=len(X_strat))

    # 6. Build Risk training data
    logger.info("building_risk_data")
    X_risk, y_stop, y_target, y_dd = build_risk_training_data(stock_data)
    risk_path = output_dir / "risk_train.npz"
    np.savez(risk_path, X=X_risk, y_stop=y_stop, y_target=y_target, y_drawdown=y_dd)
    outputs["risk"] = risk_path
    logger.info("risk_data_saved", path=str(risk_path), samples=len(X_risk))

    logger.info("pipeline_complete", outputs={k: str(v) for k, v in outputs.items()})
    return outputs


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Generate training data for ML models")
    parser.add_argument("--start", default="2023-01-01", help="Start date (YYYY-MM-DD)")
    parser.add_argument("--end", default="2026-07-31", help="End date (YYYY-MM-DD)")
    parser.add_argument("--output", default=None, help="Output directory")
    args = parser.parse_args()

    output = Path(args.output) if args.output else None
    run_pipeline(args.start, args.end, output)
