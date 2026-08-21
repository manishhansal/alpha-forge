"""
Stock Ranking Model (LightGBM).

Ranks all F&O stocks by their probability of outperforming over the next
trading session. Instead of predicting exact prices, the model learns to
score each stock's expected relative return conditional on the current
market regime.

Architecture:
  - LightGBM with lambdarank objective (listwise learning-to-rank)
  - Alternative: regression on forward relative returns (point-wise fallback)
  - 60+ per-stock features from the feature engineering layer
  - Regime-conditioned: the current MarketRegime is fed as a feature so the
    model learns that momentum stocks rank higher in bulls, mean-reversion
    setups rank higher in sideways, etc.
  - SHAP explanations per stock showing which features drove the ranking

Output:
  symbol | score (0-100) | rank | top SHAP factors
  HAL    |      97       |   1  | +18 Relative Volume, +15 Sector Strength, ...
  BEL    |      95       |   2  | +14 ADX, +12 Market Breadth, ...
"""

from pathlib import Path
from typing import Any

import numpy as np
import structlog

from ..features.engineer import RANKING_FEATURES
from ..schemas import MarketRegime, RankingResponse, StockRank

logger = structlog.get_logger()

# Default LightGBM hyperparameters (tuned via Optuna)
DEFAULT_PARAMS = {
    "objective": "regression",  # Predict forward return magnitude
    "metric": "rmse",
    "boosting_type": "gbdt",
    "num_leaves": 63,
    "max_depth": 8,
    "learning_rate": 0.03,
    "n_estimators": 500,
    "min_child_samples": 20,
    "subsample": 0.8,
    "colsample_bytree": 0.8,
    "reg_alpha": 0.1,
    "reg_lambda": 1.0,
    "importance_type": "gain",
    "random_state": 42,
    "verbose": -1,
}

# LambdaRank params (used when group-based training data is available)
LAMBDARANK_PARAMS = {
    "objective": "lambdarank",
    "metric": "ndcg",
    "ndcg_eval_at": [5, 10, 20],
    "boosting_type": "gbdt",
    "num_leaves": 63,
    "max_depth": 8,
    "learning_rate": 0.03,
    "n_estimators": 500,
    "min_child_samples": 20,
    "subsample": 0.8,
    "colsample_bytree": 0.8,
    "reg_alpha": 0.1,
    "reg_lambda": 1.0,
    "random_state": 42,
    "verbose": -1,
}

# Regime-specific scoring adjustments (applied as post-hoc multipliers
# to emphasize different factors per regime when no trained model exists)
REGIME_FACTOR_WEIGHTS = {
    MarketRegime.STRONG_BULL: {
        "momentum": 1.3,
        "breakout": 1.2,
        "volume": 1.1,
        "mean_reversion": 0.5,
    },
    MarketRegime.BULL: {
        "momentum": 1.2,
        "breakout": 1.1,
        "volume": 1.0,
        "mean_reversion": 0.7,
    },
    MarketRegime.SIDEWAYS: {
        "momentum": 0.7,
        "breakout": 0.8,
        "volume": 0.9,
        "mean_reversion": 1.3,
    },
    MarketRegime.VOLATILE: {
        "momentum": 0.8,
        "breakout": 1.0,
        "volume": 1.2,
        "mean_reversion": 1.1,
    },
    MarketRegime.BEAR: {
        "momentum": 0.6,
        "breakout": 0.7,
        "volume": 1.0,
        "mean_reversion": 1.2,
    },
    MarketRegime.CRASH: {
        "momentum": 0.3,
        "breakout": 0.5,
        "volume": 1.0,
        "mean_reversion": 1.4,
    },
}


class StockRanker:
    """
    LightGBM-based stock ranking model.

    Produces a 0-100 outperformance score for each stock in the F&O universe,
    conditioned on the current market regime. Falls back to a multi-factor
    heuristic scoring when no trained model is available.
    """

    def __init__(self, model_path: Path | None = None):
        self.model = None
        self.model_version = "ranker-lgbm-v1"
        self.feature_names = RANKING_FEATURES

        if model_path and model_path.exists():
            self._load_model(model_path)

    def _load_model(self, path: Path) -> None:
        """Load a trained LightGBM model from disk."""
        try:
            import lightgbm as lgb

            self.model = lgb.Booster(model_file=str(path))
            logger.info("stock_ranker_model_loaded", path=str(path))
        except Exception as e:
            logger.warning("stock_ranker_model_load_failed", error=str(e))
            self.model = None

    def rank(
        self,
        stocks: list[dict[str, float]],
        symbols: list[str],
        regime: MarketRegime,
        top_n: int = 20,
    ) -> RankingResponse:
        """
        Rank stocks by outperformance probability.

        Args:
            stocks: List of feature dicts (one per stock), in RANKING_FEATURES order.
            symbols: Corresponding stock symbols.
            regime: Current market regime (conditions the ranking).
            top_n: Number of top stocks to return.

        Returns:
            RankingResponse with scored and sorted stocks.
        """
        if self.model is not None:
            return self._rank_ml(stocks, symbols, regime, top_n)
        return self._rank_heuristic(stocks, symbols, regime, top_n)

    def _rank_ml(
        self,
        stocks: list[dict[str, float]],
        symbols: list[str],
        regime: MarketRegime,
        top_n: int,
    ) -> RankingResponse:
        """ML-based ranking using the trained LightGBM model.

        Falls back to the heuristic when the model raises any exception
        (e.g. feature count mismatch after the feature engineering layer
        added new columns since the artifact was trained). This prevents
        the intermittent 500 errors while preserving the heuristic path.
        """
        try:
            # Build feature matrix in canonical order
            X = np.array([
                [feat.get(f, 0.0) for f in self.feature_names]
                for feat in stocks
            ])

            # Get raw scores from the model
            raw_scores = self.model.predict(X)

            # Normalize to 0-100 scale using percentile ranking
            rankings = self._scores_to_rankings(raw_scores, symbols, stocks, top_n)

            return RankingResponse(
                rankings=rankings,
                model_version=self.model_version,
                regime_used=regime,
            )
        except Exception as exc:
            logger.warning(
                "stock_ranker_ml_predict_failed_falling_back",
                error=str(exc),
            )
            return self._rank_heuristic(stocks, symbols, regime, top_n)

    def _rank_heuristic(
        self,
        stocks: list[dict[str, float]],
        symbols: list[str],
        regime: MarketRegime,
        top_n: int,
    ) -> RankingResponse:
        """
        Multi-factor heuristic ranking when no trained model is available.

        Computes a weighted composite score from the key ranking factors,
        adjusted by the current regime to emphasize the right characteristics.
        """
        regime_weights = REGIME_FACTOR_WEIGHTS.get(
            regime, REGIME_FACTOR_WEIGHTS[MarketRegime.SIDEWAYS]
        )

        raw_scores = []
        for feat in stocks:
            score = self._compute_heuristic_score(feat, regime_weights)
            raw_scores.append(score)

        raw_scores_arr = np.array(raw_scores)
        rankings = self._scores_to_rankings(raw_scores_arr, symbols, stocks, top_n)

        return RankingResponse(
            rankings=rankings,
            model_version=f"{self.model_version}-heuristic",
            regime_used=regime,
        )

    def _compute_heuristic_score(
        self, feat: dict[str, float], regime_weights: dict[str, float]
    ) -> float:
        """
        Compute a composite ranking score from individual factors.

        Quant upgrade: increased weight on derivatives positioning (key for
        NSE F&O predictability), added relative-strength-vs-sector component,
        and higher-highs/higher-lows structural filter for trend quality.

        The score blends:
          - Momentum signals (return, trend, RSI alignment)
          - Volume confirmation (relative vol, breakout, OBV)
          - Breakout potential (ATR expansion, breakout score, structure)
          - Derivatives positioning (OI, PCR, IV rank) — highest weight for India
          - Mean-reversion opportunity (Bollinger position, RSI extremes)
          - Relative strength (vs NIFTY, vs sector peers)
          - Structure quality (higher-highs/lows, order block, FVG)
        """
        # Momentum component
        momentum_score = (
            _clip_norm(feat.get("return_5d", 0), -5, 5) * 0.22
            + _clip_norm(feat.get("trend_strength", 0), -1, 1) * 0.20
            + _clip_norm(feat.get("ema_stack_score", 0), -1, 1) * 0.20
            + _clip_norm(feat.get("rate_of_change_12", 0), -10, 10) * 0.16
            + _clip_norm(feat.get("adx_14", 0) - 20, -20, 40) * 0.15
            + _clip_norm(feat.get("supertrend", 0), -1, 1) * 0.07
        )

        # Volume component — delivery % added as quality gate
        vol_ratio = feat.get("relative_volume", 1.0)
        delivery = feat.get("delivery_pct", 40.0)
        delivery_norm = _clip_norm(delivery - 40, -40, 60)  # >40% is good
        volume_score = (
            _clip_norm(vol_ratio - 1, -1, 3) * 0.28
            + feat.get("volume_breakout", 0) * 0.18
            + _clip_norm(feat.get("obv_trend", 0), -2, 2) * 0.18
            + _clip_norm(feat.get("volume_price_confirm", 0), -1, 1) * 0.20
            + _clip_norm(feat.get("cmf", 0), -0.5, 0.5) * 0.08
            + delivery_norm * 0.08           # NSE delivery quality gate
        )

        # Breakout component — higher-highs/lows given more weight
        breakout_score = (
            _clip_norm(feat.get("breakout_score", 0), -1, 1) * 0.24
            + _clip_norm(feat.get("atr_expansion", 0) - 1, -0.5, 2) * 0.18
            + _clip_norm(feat.get("structure_score", 0), -1, 1) * 0.18
            + _clip_norm(feat.get("fvg_score", 0), -1, 1) * 0.14
            + _clip_norm(feat.get("higher_highs_lows", 0), -1, 1) * 0.26  # boosted
        )

        # Derivatives component — highest weight for India F&O (key predictor)
        deriv_score = (
            _clip_norm(feat.get("oi_buildup_score", 0), -1, 1) * 0.34
            + _clip_norm(feat.get("pcr_score", 0), -1, 1) * 0.26
            + _clip_norm(feat.get("oi_wall_score", 0), -1, 1) * 0.20
            + _clip_norm(feat.get("max_pain_distance_pct", 0), -3, 3) * 0.12
            + _clip_norm(50 - feat.get("iv_rank", 50), -50, 50) * 0.08
        )

        # Mean-reversion component (inverse signals for regime where this matters)
        rsi = feat.get("rsi_14", 50)
        bb_pos = feat.get("bollinger_position", 0.5)
        mean_rev_score = (
            _clip_norm(50 - abs(rsi - 50), 0, 30) * 0.3   # RSI near 50 = stable
            + _clip_norm(0.5 - abs(bb_pos - 0.5), -0.5, 0.5) * 0.25
            + _clip_norm(feat.get("liquidity_sweep", 0), -1, 1) * 0.25
            + _clip_norm(-feat.get("distance_from_52w_high", 0), -20, 0) * 0.20
        )

        # Relative strength vs NIFTY AND sector peers (new: sector RS)
        sector_rs = feat.get("sector_relative_strength", 1.0)
        rel_strength_score = (
            _clip_norm(feat.get("relative_strength_vs_nifty", 1) - 1, -0.2, 0.3) * 0.35
            + _clip_norm(feat.get("sector_momentum", 0), -3, 3) * 0.30
            + _clip_norm(feat.get("delivery_pct", 0) - 40, -40, 60) * 0.20
            + _clip_norm(sector_rs - 1, -0.2, 0.3) * 0.15  # vs sector (new)
        )

        # Weighted composite with regime adjustments
        # Derivatives weight raised from 0.17 → 0.22 for India F&O universe
        composite = (
            momentum_score * 0.22 * regime_weights.get("momentum", 1.0)
            + volume_score * 0.16 * regime_weights.get("volume", 1.0)
            + breakout_score * 0.18 * regime_weights.get("breakout", 1.0)
            + deriv_score * 0.22                              # raised for India
            + mean_rev_score * 0.10 * regime_weights.get("mean_reversion", 1.0)
            + rel_strength_score * 0.12
        )

        return composite

    def _scores_to_rankings(
        self,
        raw_scores: np.ndarray,
        symbols: list[str],
        stocks: list[dict[str, float]],
        top_n: int,
    ) -> list[StockRank]:
        """Convert raw scores to normalized 0-100 rankings with SHAP-like factors."""
        # Percentile-rank normalization to 0-100
        n = len(raw_scores)
        if n == 0:
            return []

        # Rank-based scoring (avoid outlier sensitivity)
        sorted_indices = np.argsort(raw_scores)
        percentile_scores = np.zeros(n)
        for rank_pos, idx in enumerate(sorted_indices):
            percentile_scores[idx] = (rank_pos / max(n - 1, 1)) * 100

        # Build ranked output
        results = []
        for i in range(n):
            results.append({
                "symbol": symbols[i],
                "score": round(float(percentile_scores[i]), 1),
                "features": stocks[i],
            })

        # Sort descending by score
        results.sort(key=lambda x: x["score"], reverse=True)

        # Take top N and build response
        rankings = []
        for rank_idx, item in enumerate(results[:top_n]):
            factors = self._extract_top_factors(item["features"])
            rankings.append(
                StockRank(
                    symbol=item["symbol"],
                    score=item["score"],
                    rank=rank_idx + 1,
                    factors=factors,
                )
            )

        return rankings

    def _extract_top_factors(
        self, features: dict[str, float], top_k: int = 6
    ) -> dict[str, float]:
        """
        Extract the top contributing factors for a stock's ranking.

        When no SHAP is available, approximate by taking the highest-magnitude
        features from key signal categories.
        """
        factor_map = {
            "Relative Volume": features.get("relative_volume", 1.0) - 1.0,
            "Momentum (5d)": features.get("return_5d", 0) / 5,
            "Trend Strength": features.get("trend_strength", 0) * 15,
            "ADX": (features.get("adx_14", 20) - 20) / 3,
            "EMA Stack": features.get("ema_stack_score", 0) * 12,
            "Breakout": features.get("breakout_score", 0) * 14,
            "ATR Expansion": (features.get("atr_expansion", 1) - 1) * 10,
            "OI Build-up": features.get("oi_buildup_score", 0) * 14,    # boosted
            "PCR": features.get("pcr_score", 0) * 12,                    # boosted
            "Volume Thrust": max(features.get("relative_volume", 1) - 1.2, 0) * 10,
            "RS vs NIFTY": (features.get("relative_strength_vs_nifty", 1) - 1) * 50,
            "RS vs Sector": (features.get("sector_relative_strength", 1) - 1) * 40,  # new
            "Sector Momentum": features.get("sector_momentum", 0) * 5,
            "Market Breadth": (features.get("market_breadth_score", 0)) * 8,
            "Structure": features.get("structure_score", 0) * 10,
            "Higher Highs/Lows": features.get("higher_highs_lows", 0) * 12,   # new
            "Delivery %": (features.get("delivery_pct", 40) - 40) / 4,        # boosted
            "FVG": features.get("fvg_score", 0) * 8,
            "IV Rank": (50 - features.get("iv_rank", 50)) / 5,
            "OI Wall": features.get("oi_wall_score", 0) * 10,                # boosted
        }

        # Sort by absolute magnitude, keep top K
        sorted_factors = sorted(
            factor_map.items(), key=lambda x: abs(x[1]), reverse=True
        )
        return {k: round(v, 1) for k, v in sorted_factors[:top_k]}

    def train(
        self,
        X: np.ndarray,
        y: np.ndarray,
        params: dict[str, Any] | None = None,
        eval_set: tuple[np.ndarray, np.ndarray] | None = None,
        use_lambdarank: bool = False,
        groups: list[int] | None = None,
    ) -> dict[str, float]:
        """
        Train the LightGBM ranker.

        Args:
            X: Feature matrix (n_samples, n_features) in RANKING_FEATURES order.
            y: Target values (forward relative returns or relevance labels).
            params: LightGBM hyperparameters.
            eval_set: Optional validation set (X_val, y_val).
            use_lambdarank: If True, use LambdaRank objective (requires groups).
            groups: Query group sizes for LambdaRank (number of stocks per day).

        Returns:
            Training metrics dict.
        """
        import lightgbm as lgb

        if use_lambdarank and groups is not None:
            hp = {**LAMBDARANK_PARAMS, **(params or {})}
        else:
            hp = {**DEFAULT_PARAMS, **(params or {})}

        n_estimators = hp.pop("n_estimators", 500)

        train_data = lgb.Dataset(
            X, label=y, feature_name=self.feature_names,
            group=groups if use_lambdarank else None,
        )

        valid_sets = [train_data]
        valid_names = ["train"]

        if eval_set is not None:
            X_val, y_val = eval_set
            val_data = lgb.Dataset(X_val, label=y_val, reference=train_data)
            valid_sets.append(val_data)
            valid_names.append("valid")

        callbacks = [lgb.log_evaluation(period=50)]

        self.model = lgb.train(
            hp,
            train_data,
            num_boost_round=n_estimators,
            valid_sets=valid_sets,
            valid_names=valid_names,
            callbacks=callbacks,
        )

        # Compute metrics
        train_pred = self.model.predict(X)
        from scipy.stats import spearmanr

        correlation, _ = spearmanr(y, train_pred)
        metrics = {"train_spearman": float(correlation)}

        if eval_set is not None:
            X_val, y_val = eval_set
            val_pred = self.model.predict(X_val)
            val_corr, _ = spearmanr(y_val, val_pred)
            metrics["val_spearman"] = float(val_corr)

        logger.info("stock_ranker_trained", metrics=metrics)
        return metrics

    def save(self, path: Path) -> None:
        """Save the trained model to disk."""
        if self.model is None:
            raise RuntimeError("No model to save — train first.")
        path.parent.mkdir(parents=True, exist_ok=True)
        self.model.save_model(str(path))
        logger.info("stock_ranker_saved", path=str(path))

    def get_feature_importance(self) -> dict[str, float]:
        """Get feature importance from the trained model."""
        if self.model is None:
            return {}
        importance = self.model.feature_importance(importance_type="gain")
        names = self.model.feature_name()
        return {name: float(imp) for name, imp in zip(names, importance)}


def generate_ranking_labels(
    stock_returns: dict[str, "pd.Series"],
    index_returns: "pd.Series",
    lookforward: int = 1,
) -> "pd.DataFrame":
    """
    Generate ground-truth ranking labels from historical returns.

    For each trading day, compute the forward relative return (stock return
    minus index return) over the next `lookforward` days. This becomes the
    regression target — the model learns to predict which stocks will
    outperform the index tomorrow.

    Args:
        stock_returns: Dict of {symbol: daily_return_series}.
        index_returns: NIFTY 50 daily return series.
        lookforward: Number of days forward to compute return.

    Returns:
        DataFrame with columns [date, symbol, forward_relative_return, rank_label].
    """
    import pandas as pd

    rows = []
    dates = index_returns.index[:-lookforward]

    for date in dates:
        idx_fwd = index_returns.shift(-lookforward).get(date, 0)

        day_stocks = []
        for symbol, returns in stock_returns.items():
            if date in returns.index:
                stock_fwd = returns.shift(-lookforward).get(date, None)
                if stock_fwd is not None and np.isfinite(stock_fwd):
                    relative_return = stock_fwd - idx_fwd
                    day_stocks.append({
                        "date": date,
                        "symbol": symbol,
                        "forward_relative_return": relative_return,
                    })

        # Assign rank labels within the day (for LambdaRank)
        day_stocks.sort(key=lambda x: x["forward_relative_return"], reverse=True)
        for rank_pos, item in enumerate(day_stocks):
            # Relevance label: 4 = top quintile, 3 = second, ..., 0 = bottom
            quintile = int(rank_pos / max(len(day_stocks), 1) * 5)
            item["rank_label"] = max(4 - quintile, 0)
            rows.append(item)

    return pd.DataFrame(rows)


def _clip_norm(value: float, lo: float, hi: float) -> float:
    """Clip value to [lo, hi] and normalize to [-1, 1]."""
    clipped = max(lo, min(hi, value))
    mid = (lo + hi) / 2
    half_range = (hi - lo) / 2
    if half_range == 0:
        return 0.0
    return (clipped - mid) / half_range
