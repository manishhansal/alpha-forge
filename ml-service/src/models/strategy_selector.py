"""
Strategy Selection Model (CatBoost).

Selects the optimal trading strategy for a given stock given the current
market regime and per-stock technical conditions.

This is a multiclass classification problem:

    Bull Market → Breakout, Momentum, Trend Following
    Sideways   → Mean Reversion, VWAP Bounce, Range Trading
    Volatile   → Scalping, Volatility Breakout

Architecture:
  - CatBoost multiclass classifier (handles categorical features natively)
  - Regime + per-stock technical features as input
  - Learns historical patterns: "when RSI was at X, ADX at Y, and regime was
    BULL, the best outcome came from a Momentum strategy"
  - Outputs strategy probabilities + a rationale string

CatBoost chosen because:
  - Native categorical feature handling (regime as a category)
  - Strong performance on small/medium tabular datasets
  - Built-in regularization reduces overfitting
  - Fast inference (important for per-stock evaluation)
"""

from pathlib import Path
from typing import Any

import numpy as np
import structlog

from ..features.engineer import STRATEGY_FEATURES
from ..schemas import MarketRegime, StrategyResponse, TradingStrategy

logger = structlog.get_logger()

# Strategy classes (int ↔ enum mapping)
STRATEGY_CLASSES = [
    TradingStrategy.BREAKOUT,
    TradingStrategy.MOMENTUM,
    TradingStrategy.TREND_FOLLOWING,
    TradingStrategy.MEAN_REVERSION,
    TradingStrategy.VWAP_BOUNCE,
    TradingStrategy.RANGE_TRADING,
    TradingStrategy.SCALPING,
    TradingStrategy.VOLATILITY_BREAKOUT,
]

STRATEGY_TO_INT = {s: i for i, s in enumerate(STRATEGY_CLASSES)}

# Default CatBoost hyperparameters
DEFAULT_PARAMS = {
    "iterations": 400,
    "depth": 6,
    "learning_rate": 0.05,
    "l2_leaf_reg": 3.0,
    "border_count": 128,
    "loss_function": "MultiClass",
    "eval_metric": "MultiClass",
    "random_seed": 42,
    "verbose": 0,
    "task_type": "CPU",
    "auto_class_weights": "Balanced",
}

# Strategy suitability rules per regime (used by heuristic fallback)
REGIME_STRATEGY_AFFINITY: dict[MarketRegime, dict[TradingStrategy, float]] = {
    MarketRegime.STRONG_BULL: {
        TradingStrategy.BREAKOUT: 0.30,
        TradingStrategy.MOMENTUM: 0.35,
        TradingStrategy.TREND_FOLLOWING: 0.25,
        TradingStrategy.MEAN_REVERSION: 0.02,
        TradingStrategy.VWAP_BOUNCE: 0.03,
        TradingStrategy.RANGE_TRADING: 0.01,
        TradingStrategy.SCALPING: 0.02,
        TradingStrategy.VOLATILITY_BREAKOUT: 0.02,
    },
    MarketRegime.BULL: {
        TradingStrategy.BREAKOUT: 0.22,
        TradingStrategy.MOMENTUM: 0.28,
        TradingStrategy.TREND_FOLLOWING: 0.25,
        TradingStrategy.MEAN_REVERSION: 0.05,
        TradingStrategy.VWAP_BOUNCE: 0.08,
        TradingStrategy.RANGE_TRADING: 0.04,
        TradingStrategy.SCALPING: 0.04,
        TradingStrategy.VOLATILITY_BREAKOUT: 0.04,
    },
    MarketRegime.SIDEWAYS: {
        TradingStrategy.BREAKOUT: 0.05,
        TradingStrategy.MOMENTUM: 0.05,
        TradingStrategy.TREND_FOLLOWING: 0.05,
        TradingStrategy.MEAN_REVERSION: 0.30,
        TradingStrategy.VWAP_BOUNCE: 0.25,
        TradingStrategy.RANGE_TRADING: 0.22,
        TradingStrategy.SCALPING: 0.05,
        TradingStrategy.VOLATILITY_BREAKOUT: 0.03,
    },
    MarketRegime.VOLATILE: {
        TradingStrategy.BREAKOUT: 0.08,
        TradingStrategy.MOMENTUM: 0.08,
        TradingStrategy.TREND_FOLLOWING: 0.05,
        TradingStrategy.MEAN_REVERSION: 0.12,
        TradingStrategy.VWAP_BOUNCE: 0.10,
        TradingStrategy.RANGE_TRADING: 0.07,
        TradingStrategy.SCALPING: 0.30,
        TradingStrategy.VOLATILITY_BREAKOUT: 0.20,
    },
    MarketRegime.BEAR: {
        TradingStrategy.BREAKOUT: 0.10,
        TradingStrategy.MOMENTUM: 0.15,
        TradingStrategy.TREND_FOLLOWING: 0.20,
        TradingStrategy.MEAN_REVERSION: 0.20,
        TradingStrategy.VWAP_BOUNCE: 0.12,
        TradingStrategy.RANGE_TRADING: 0.10,
        TradingStrategy.SCALPING: 0.08,
        TradingStrategy.VOLATILITY_BREAKOUT: 0.05,
    },
    MarketRegime.CRASH: {
        TradingStrategy.BREAKOUT: 0.05,
        TradingStrategy.MOMENTUM: 0.10,
        TradingStrategy.TREND_FOLLOWING: 0.15,
        TradingStrategy.MEAN_REVERSION: 0.25,
        TradingStrategy.VWAP_BOUNCE: 0.05,
        TradingStrategy.RANGE_TRADING: 0.05,
        TradingStrategy.SCALPING: 0.25,
        TradingStrategy.VOLATILITY_BREAKOUT: 0.10,
    },
}

# Technical condition modifiers: boost strategy probability based on features
STRATEGY_TECHNICAL_CONDITIONS: dict[TradingStrategy, dict[str, tuple[str, float, float]]] = {
    # strategy: { feature: (comparison, threshold, boost) }
    TradingStrategy.BREAKOUT: {
        "breakout_score": ("gt", 0.4, 0.25),
        "atr_pct": ("gt", 1.2, 0.15),
        "relative_volume": ("gt", 1.5, 0.2),
        "adx_14": ("gt", 25, 0.15),
    },
    TradingStrategy.MOMENTUM: {
        "trend_strength": ("gt", 0.4, 0.25),
        "ema_stack_score": ("gt", 0.5, 0.2),
        "adx_14": ("gt", 22, 0.15),
        "macd_histogram": ("gt", 0, 0.1),
    },
    TradingStrategy.TREND_FOLLOWING: {
        "ema_stack_score": ("gt", 0.6, 0.3),
        "adx_14": ("gt", 25, 0.2),
        "trend_strength": ("gt", 0.5, 0.2),
    },
    TradingStrategy.MEAN_REVERSION: {
        "rsi_14": ("extreme", 30, 0.25),  # RSI < 30 or > 70
        "bollinger_position": ("extreme_bb", 0.1, 0.2),  # < 0.1 or > 0.9
        "vwap_distance_pct": ("abs_gt", 1.5, 0.15),
    },
    TradingStrategy.VWAP_BOUNCE: {
        "vwap_distance_pct": ("abs_range", 0.3, 0.25),  # Near VWAP
        "relative_volume": ("gt", 1.0, 0.1),
        "session_progress": ("range", 0.15, 0.15),  # Mid-session
    },
    TradingStrategy.RANGE_TRADING: {
        "adx_14": ("lt", 20, 0.3),
        "bollinger_position": ("range_mid", 0.3, 0.2),  # 0.3 - 0.7
        "atr_pct": ("lt", 1.0, 0.15),
    },
    TradingStrategy.SCALPING: {
        "relative_volume": ("gt", 1.3, 0.2),
        "atr_pct": ("gt", 1.0, 0.2),
        "session_progress": ("early_or_late", 0, 0.15),
    },
    TradingStrategy.VOLATILITY_BREAKOUT: {
        "atr_pct": ("gt", 1.5, 0.25),
        "breakout_score": ("abs_gt", 0.3, 0.2),
        "relative_volume": ("gt", 1.5, 0.2),
    },
}


class StrategySelector:
    """
    CatBoost-based strategy selection model.

    Selects the optimal trading strategy for a stock given the current
    market conditions. Falls back to a rule-based selection engine when
    no trained model is available.
    """

    def __init__(self, model_path: Path | None = None):
        self.model = None
        self.model_version = "strategy-catboost-v1"
        self.feature_names = STRATEGY_FEATURES

        if model_path and model_path.exists():
            self._load_model(model_path)

    def _load_model(self, path: Path) -> None:
        """Load a trained CatBoost model from disk."""
        try:
            from catboost import CatBoostClassifier

            self.model = CatBoostClassifier()
            self.model.load_model(str(path))
            logger.info("strategy_selector_loaded", path=str(path))
        except Exception as e:
            logger.warning("strategy_selector_load_failed", error=str(e))
            self.model = None

    def select(
        self, features: dict[str, float], regime: MarketRegime
    ) -> StrategyResponse:
        """
        Select the optimal strategy for a stock.

        Args:
            features: Per-stock feature dict (STRATEGY_FEATURES subset).
            regime: Current market regime.

        Returns:
            StrategyResponse with selected strategy, confidence, alternatives.
        """
        if self.model is not None:
            return self._select_ml(features, regime)
        return self._select_heuristic(features, regime)

    def _select_ml(
        self, features: dict[str, float], regime: MarketRegime
    ) -> StrategyResponse:
        """ML-based strategy selection using trained CatBoost."""
        feature_vector = np.array(
            [[features.get(f, 0.0) for f in self.feature_names]]
        )

        probabilities = self.model.predict_proba(feature_vector)[0]
        predicted_class = int(np.argmax(probabilities))
        confidence = float(probabilities[predicted_class])

        strategy = STRATEGY_CLASSES[predicted_class]

        # Build alternatives (top 3 excluding winner)
        sorted_indices = np.argsort(probabilities)[::-1]
        alternatives = [
            {STRATEGY_CLASSES[idx].value: round(float(probabilities[idx]), 3)}
            for idx in sorted_indices[1:4]
        ]

        rationale = self._build_rationale(strategy, features, regime, confidence)

        return StrategyResponse(
            strategy=strategy,
            confidence=round(confidence, 4),
            alternatives=alternatives,
            rationale=rationale,
        )

    def _select_heuristic(
        self, features: dict[str, float], regime: MarketRegime
    ) -> StrategyResponse:
        """
        Rule-based strategy selection when no trained model is available.

        Starts with the regime-based prior probabilities, then adjusts
        based on the stock's technical conditions.
        """
        # Start with regime prior
        base_probs = dict(REGIME_STRATEGY_AFFINITY.get(
            regime, REGIME_STRATEGY_AFFINITY[MarketRegime.SIDEWAYS]
        ))

        # Apply technical condition modifiers
        for strategy, conditions in STRATEGY_TECHNICAL_CONDITIONS.items():
            boost = 0.0
            for feature_name, (comparison, threshold, weight) in conditions.items():
                value = features.get(feature_name, 0.0)
                if self._check_condition(value, comparison, threshold):
                    boost += weight
            # Apply boost (multiplicative + additive blend)
            current = base_probs.get(strategy, 0.05)
            base_probs[strategy] = current * (1 + boost) + boost * 0.1

        # Time-of-day adjustments
        session_progress = features.get("session_progress", 0.5)
        if session_progress < 0.1:  # First 37 minutes — opening volatility
            base_probs[TradingStrategy.SCALPING] *= 1.3
            base_probs[TradingStrategy.VOLATILITY_BREAKOUT] *= 1.2
            base_probs[TradingStrategy.BREAKOUT] *= 1.2
        elif session_progress > 0.8:  # Last 75 minutes — power hour
            base_probs[TradingStrategy.SCALPING] *= 1.2
            base_probs[TradingStrategy.MOMENTUM] *= 1.1
        elif 0.25 < session_progress < 0.55:  # Lunch lull
            base_probs[TradingStrategy.RANGE_TRADING] *= 1.2
            base_probs[TradingStrategy.MEAN_REVERSION] *= 1.1
            base_probs[TradingStrategy.SCALPING] *= 0.7

        # Normalize to probabilities
        total = sum(base_probs.values())
        if total > 0:
            probs = {s: v / total for s, v in base_probs.items()}
        else:
            probs = {s: 1.0 / len(STRATEGY_CLASSES) for s in STRATEGY_CLASSES}

        # Pick the winner
        best_strategy = max(probs, key=probs.get)  # type: ignore
        confidence = probs[best_strategy]

        # Alternatives
        sorted_strategies = sorted(probs.items(), key=lambda x: x[1], reverse=True)
        alternatives = [
            {s.value: round(p, 3)}
            for s, p in sorted_strategies[1:4]
        ]

        rationale = self._build_rationale(best_strategy, features, regime, confidence)

        return StrategyResponse(
            strategy=best_strategy,
            confidence=round(confidence, 4),
            alternatives=alternatives,
            rationale=rationale,
        )

    def _check_condition(
        self, value: float, comparison: str, threshold: float
    ) -> bool:
        """Check if a feature value meets a condition."""
        if comparison == "gt":
            return value > threshold
        elif comparison == "lt":
            return value < threshold
        elif comparison == "abs_gt":
            return abs(value) > threshold
        elif comparison == "extreme":
            # RSI extreme: < threshold or > (100 - threshold)
            return value < threshold or value > (100 - threshold)
        elif comparison == "extreme_bb":
            # Bollinger: < threshold or > (1 - threshold)
            return value < threshold or value > (1 - threshold)
        elif comparison == "abs_range":
            # Near zero (within ± threshold)
            return abs(value) < threshold
        elif comparison == "range_mid":
            # In middle range
            return threshold < value < (1 - threshold)
        elif comparison == "range":
            # Mid-session (0.15 - 0.85)
            return threshold < value < (1 - threshold)
        elif comparison == "early_or_late":
            # First 10% or last 20% of session
            return value < 0.1 or value > 0.8
        return False

    def _build_rationale(
        self,
        strategy: TradingStrategy,
        features: dict[str, float],
        regime: MarketRegime,
        confidence: float,
    ) -> str:
        """Build a human-readable rationale for the strategy selection."""
        regime_label = regime.value.replace("_", " ").title()
        strategy_label = strategy.value.replace("_", " ").title()

        rsi = features.get("rsi_14", 50)
        adx = features.get("adx_14", 20)
        vol = features.get("relative_volume", 1.0)
        atr = features.get("atr_pct", 1.0)
        trend = features.get("trend_strength", 0)
        bb = features.get("bollinger_position", 0.5)

        parts = [f"{strategy_label} selected in {regime_label} regime"]

        if strategy in (TradingStrategy.BREAKOUT, TradingStrategy.VOLATILITY_BREAKOUT):
            parts.append(f"ATR expansion {atr:.1f}%, volume {vol:.1f}x")
            if adx > 25:
                parts.append(f"strong directional movement (ADX {adx:.0f})")
        elif strategy == TradingStrategy.MOMENTUM:
            parts.append(f"trend strength {trend:.2f}, ADX {adx:.0f}")
            if vol > 1.3:
                parts.append(f"confirmed by volume {vol:.1f}x")
        elif strategy == TradingStrategy.TREND_FOLLOWING:
            parts.append(f"established trend (strength {trend:.2f})")
            parts.append(f"ADX {adx:.0f} with directional conviction")
        elif strategy == TradingStrategy.MEAN_REVERSION:
            if rsi < 35 or rsi > 65:
                parts.append(f"RSI at extreme ({rsi:.0f})")
            if bb < 0.15 or bb > 0.85:
                parts.append(f"price at Bollinger extreme ({bb:.2f})")
        elif strategy == TradingStrategy.VWAP_BOUNCE:
            vwap_dist = features.get("vwap_distance_pct", 0)
            parts.append(f"price {vwap_dist:+.2f}% from VWAP — reversion likely")
        elif strategy == TradingStrategy.RANGE_TRADING:
            parts.append(f"low ADX ({adx:.0f}) indicates range-bound conditions")
        elif strategy == TradingStrategy.SCALPING:
            parts.append(f"volatile conditions with volume {vol:.1f}x")
            parts.append("tight stops, quick targets")

        parts.append(f"Confidence: {confidence:.0%}")
        return ". ".join(parts) + "."

    def train(
        self,
        X: np.ndarray,
        y: np.ndarray,
        params: dict[str, Any] | None = None,
        eval_set: tuple[np.ndarray, np.ndarray] | None = None,
        cat_features: list[int] | None = None,
    ) -> dict[str, float]:
        """
        Train the CatBoost strategy selector.

        Args:
            X: Feature matrix (n_samples, n_features).
            y: Integer labels (0-7 mapping to STRATEGY_CLASSES).
            params: CatBoost hyperparameters.
            eval_set: Optional validation set (X_val, y_val).
            cat_features: Indices of categorical features (e.g. regime_encoded).

        Returns:
            Training metrics dict.
        """
        from catboost import CatBoostClassifier, Pool

        hp = {**DEFAULT_PARAMS, **(params or {})}

        self.model = CatBoostClassifier(**hp)

        train_pool = Pool(X, label=y, feature_names=self.feature_names, cat_features=cat_features)

        fit_params: dict[str, Any] = {}
        if eval_set is not None:
            X_val, y_val = eval_set
            val_pool = Pool(X_val, label=y_val, feature_names=self.feature_names, cat_features=cat_features)
            fit_params["eval_set"] = val_pool

        self.model.fit(train_pool, **fit_params)

        # Metrics
        from sklearn.metrics import accuracy_score

        y_pred = self.model.predict(X).flatten().astype(int)
        train_acc = accuracy_score(y, y_pred)
        metrics = {"train_accuracy": float(train_acc)}

        if eval_set is not None:
            X_val, y_val = eval_set
            y_val_pred = self.model.predict(X_val).flatten().astype(int)
            val_acc = accuracy_score(y_val, y_val_pred)
            metrics["val_accuracy"] = float(val_acc)

        logger.info("strategy_selector_trained", metrics=metrics)
        return metrics

    def save(self, path: Path) -> None:
        """Save the trained model to disk."""
        if self.model is None:
            raise RuntimeError("No model to save — train first.")
        path.parent.mkdir(parents=True, exist_ok=True)
        self.model.save_model(str(path))
        logger.info("strategy_selector_saved", path=str(path))

    def get_feature_importance(self) -> dict[str, float]:
        """Get feature importance from the trained model."""
        if self.model is None:
            return {}
        importance = self.model.get_feature_importance()
        names = self.model.feature_names_
        return {name: float(imp) for name, imp in zip(names, importance)}


def generate_strategy_labels(
    stock_ohlcv: "pd.DataFrame",
    regime_series: "pd.Series",
    lookforward: int = 5,
) -> "pd.Series":
    """
    Generate ground-truth strategy labels from historical data.

    For each point in time, evaluate which strategy would have performed
    best over the next `lookforward` bars, given the conditions at time t.

    Strategy evaluation:
      - BREAKOUT: highest return when today broke above 20-day high
      - MOMENTUM: highest return when trend was strong + volume confirmed
      - TREND_FOLLOWING: highest return on sustained EMA-stack alignment
      - MEAN_REVERSION: highest return when RSI was extreme → reverted
      - VWAP_BOUNCE: highest return when price bounced off VWAP
      - RANGE_TRADING: highest return in low-ADX environments
      - SCALPING: lowest max-adverse-excursion (tightest stop survived)
      - VOLATILITY_BREAKOUT: highest return on wide-range expansion days

    Returns:
        Series of integer labels (STRATEGY_TO_INT mapping).
    """
    import pandas as pd
    from ..features.technical import compute_adx, compute_atr, compute_rsi

    close = stock_ohlcv["close"]
    high = stock_ohlcv["high"]
    low = stock_ohlcv["low"]

    # Forward return
    fwd_return = close.shift(-lookforward) / close - 1

    # Features at time t
    rsi = compute_rsi(close, 14)
    adx = compute_adx(high, low, close, 14)
    atr = compute_atr(high, low, close, 14)
    atr_pct = atr / close * 100

    # 20-day high/low breakout
    rolling_high = high.rolling(20).max()
    rolling_low = low.rolling(20).min()
    above_resistance = close > rolling_high.shift(1)
    below_support = close < rolling_low.shift(1)

    labels = pd.Series(STRATEGY_TO_INT[TradingStrategy.MOMENTUM], index=close.index)

    # Assign based on conditions + best forward outcome
    for i in range(20, len(close) - lookforward):
        fwd = fwd_return.iloc[i]
        if not np.isfinite(fwd):
            continue

        _rsi = rsi.iloc[i] if i < len(rsi) else 50
        _adx = adx.iloc[i] if i < len(adx) else 20
        _atr_pct = atr_pct.iloc[i] if i < len(atr_pct) else 1.0

        # Score each strategy based on "would it have worked?"
        scores: dict[TradingStrategy, float] = {}

        # Breakout: above resistance + positive fwd return
        if above_resistance.iloc[i]:
            scores[TradingStrategy.BREAKOUT] = max(fwd, 0) * 2
        else:
            scores[TradingStrategy.BREAKOUT] = max(fwd, 0) * 0.5

        # Momentum: strong trend + positive fwd return
        if _adx > 25 and fwd > 0:
            scores[TradingStrategy.MOMENTUM] = fwd * 1.5
        else:
            scores[TradingStrategy.MOMENTUM] = max(fwd, 0) * 0.8

        # Trend following: same as momentum but with stronger ADX gate
        if _adx > 30:
            scores[TradingStrategy.TREND_FOLLOWING] = abs(fwd) * 1.3
        else:
            scores[TradingStrategy.TREND_FOLLOWING] = abs(fwd) * 0.5

        # Mean reversion: extreme RSI + reverting fwd return
        if _rsi < 30 and fwd > 0:
            scores[TradingStrategy.MEAN_REVERSION] = fwd * 2.5
        elif _rsi > 70 and fwd < 0:
            scores[TradingStrategy.MEAN_REVERSION] = abs(fwd) * 2.5
        else:
            scores[TradingStrategy.MEAN_REVERSION] = 0.0

        # VWAP bounce (proxy: small intraday range + next-day reversion)
        if abs(fwd) < 0.02:
            scores[TradingStrategy.VWAP_BOUNCE] = 0.5
        else:
            scores[TradingStrategy.VWAP_BOUNCE] = max(0, 0.02 - abs(fwd)) * 10

        # Range trading: low ADX + bounded return
        if _adx < 20:
            scores[TradingStrategy.RANGE_TRADING] = max(0, 0.03 - abs(fwd)) * 15
        else:
            scores[TradingStrategy.RANGE_TRADING] = 0.0

        # Scalping: high ATR but any direction
        if _atr_pct > 1.5:
            scores[TradingStrategy.SCALPING] = abs(fwd) * 1.2
        else:
            scores[TradingStrategy.SCALPING] = abs(fwd) * 0.5

        # Volatility breakout: big ATR + big move
        if _atr_pct > 1.5 and abs(fwd) > 0.02:
            scores[TradingStrategy.VOLATILITY_BREAKOUT] = abs(fwd) * 2.0
        else:
            scores[TradingStrategy.VOLATILITY_BREAKOUT] = 0.0

        # Pick best strategy
        if scores:
            best = max(scores, key=scores.get)  # type: ignore
            labels.iloc[i] = STRATEGY_TO_INT[best]

    return labels
