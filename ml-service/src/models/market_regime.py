"""
Market Regime Classification Model (XGBoost).

Classifies the current market state into one of 6 regimes:
  - STRONG_BULL: Broad participation rally, VIX low, breadth expanding
  - BULL: Trending up with moderate breadth
  - SIDEWAYS: Range-bound, low ADX, mixed signals
  - VOLATILE: High VIX, wide ranges, no clear trend
  - BEAR: Trending down, breadth contracting
  - CRASH: Panic selling, VIX extreme, breadth collapse

The regime determines which downstream strategies are appropriate and
conditions the stock ranking model's behavior.

Architecture:
  - XGBoost multi-class classifier (softmax)
  - 27 macro/market features from the feature engineering layer
  - Optuna hyperparameter tuning
  - SHAP explainability for each prediction
"""

from pathlib import Path
from typing import Any

import numpy as np
import structlog

from ..features.engineer import REGIME_FEATURES
from ..schemas import MarketRegime, RegimePredictionResponse

logger = structlog.get_logger()

# Regime class mapping (int → enum)
REGIME_CLASSES = [
    MarketRegime.STRONG_BULL,
    MarketRegime.BULL,
    MarketRegime.SIDEWAYS,
    MarketRegime.VOLATILE,
    MarketRegime.BEAR,
    MarketRegime.CRASH,
]

REGIME_TO_INT = {regime: i for i, regime in enumerate(REGIME_CLASSES)}

# Default XGBoost hyperparameters (tuned via Optuna on historical NSE data)
DEFAULT_PARAMS = {
    "objective": "multi:softprob",
    "num_class": 6,
    "eval_metric": "mlogloss",
    "max_depth": 6,
    "learning_rate": 0.05,
    "n_estimators": 300,
    "min_child_weight": 5,
    "subsample": 0.8,
    "colsample_bytree": 0.8,
    "gamma": 0.1,
    "reg_alpha": 0.1,
    "reg_lambda": 1.0,
    "scale_pos_weight": 1,
    "tree_method": "hist",
    "random_state": 42,
    "verbosity": 0,
}

# Rule-based regime thresholds for the heuristic fallback
# (used when no trained model is available)
REGIME_THRESHOLDS = {
    "crash": {
        "nifty_change_pct": -3.0,
        "india_vix": 28.0,
        "advance_decline_ratio": -0.6,
    },
    "bear": {
        "nifty_change_pct": -1.0,
        "india_vix": 20.0,
        "advance_decline_ratio": -0.3,
        "market_breadth": 35.0,
    },
    "volatile": {
        "india_vix": 22.0,
        "nifty_atr_pct": 1.5,
    },
    "strong_bull": {
        "nifty_change_pct": 1.0,
        "india_vix_max": 15.0,
        "advance_decline_ratio": 0.5,
        "market_breadth": 70.0,
    },
    "bull": {
        "nifty_change_pct": 0.3,
        "advance_decline_ratio": 0.15,
        "market_breadth": 55.0,
    },
}


class MarketRegimeClassifier:
    """
    XGBoost-based market regime classifier.

    Falls back to a deterministic rule-based heuristic when no trained
    model artifact is available — this ensures the system always produces
    a regime prediction even before the first training run.
    """

    def __init__(self, model_path: Path | None = None):
        self.model = None
        self.model_version = "regime-xgb-v1"
        self.feature_names = REGIME_FEATURES

        if model_path and model_path.exists():
            self._load_model(model_path)

    def _load_model(self, path: Path) -> None:
        """Load a trained XGBoost model from disk."""
        try:
            import xgboost as xgb

            self.model = xgb.XGBClassifier()
            self.model.load_model(str(path))
            logger.info("market_regime_model_loaded", path=str(path))
        except Exception as e:
            logger.warning("market_regime_model_load_failed", error=str(e))
            self.model = None

    def predict(self, features: dict[str, float]) -> RegimePredictionResponse:
        """
        Predict the current market regime from feature dict.

        Uses the trained XGBoost model if available, otherwise falls back
        to a deterministic heuristic based on VIX/breadth/change thresholds.
        """
        if self.model is not None:
            return self._predict_ml(features)
        return self._predict_heuristic(features)

    def _predict_ml(self, features: dict[str, float]) -> RegimePredictionResponse:
        """ML-based prediction using the trained XGBoost model.

        Falls back to the heuristic when the model raises any exception
        (e.g. feature-shape mismatch after a partial reload, corrupt artifact,
        or an XGBoost version mismatch). This prevents the intermittent 500
        errors that surface when the XGBoost model is loaded but prediction
        fails — the heuristic always produces a valid response.
        """
        import numpy as np

        try:
            # Build feature vector in canonical order
            feature_vector = np.array(
                [[features.get(f, 0.0) for f in self.feature_names]]
            )

            # Get class probabilities
            probabilities = self.model.predict_proba(feature_vector)[0]
            predicted_class = int(np.argmax(probabilities))
            confidence = float(probabilities[predicted_class])

            regime = REGIME_CLASSES[predicted_class]
            prob_dict = {
                r.value: float(probabilities[i]) for i, r in enumerate(REGIME_CLASSES)
            }

            return RegimePredictionResponse(
                regime=regime,
                confidence=confidence,
                probabilities=prob_dict,
                features_used=len(self.feature_names),
                model_version=self.model_version,
            )
        except Exception as exc:
            logger.warning(
                "market_regime_ml_predict_failed_falling_back",
                error=str(exc),
            )
            return self._predict_heuristic(features)

    def _predict_heuristic(self, features: dict[str, float]) -> RegimePredictionResponse:
        """
        Rule-based fallback when no trained model is available.

        Quant v2: tightened thresholds, added PCR, OI delta skew, pct_above_sma
        surfaces, and sectoral RSI to improve regime sensitivity.

        Uses a priority-ordered rule set based on VIX, breadth, change %,
        ADX, PCR and OI skew to classify the regime.
        """
        nifty_change = features.get("nifty_change_pct", 0.0)
        vix = features.get("india_vix", 15.0)
        ad_ratio = features.get("advance_decline_ratio", 0.0)
        breadth = features.get("market_breadth", 50.0)
        adx = features.get("nifty_adx", 20.0)
        atr_pct = features.get("nifty_atr_pct", 1.0)
        vix_change = features.get("vix_change_pct", 0.0)
        rsi = features.get("nifty_rsi", 50.0)
        # New quant inputs
        pcr = features.get("put_call_ratio", 1.0)
        oi_skew = features.get("nifty_oi_delta_skew_norm", 0.0)
        pct_sma20 = features.get("pct_above_sma20", 50.0)
        pct_sma200 = features.get("pct_above_sma200", 50.0)
        rotation = features.get("rotation_score", 0.0)

        # Score each regime based on how well conditions match
        scores: dict[MarketRegime, float] = {}

        # CRASH: extreme selling + VIX spike + breadth collapse + PCR spike
        crash_score = 0.0
        if nifty_change < -3.0:
            crash_score += 0.30
        if vix > 30:                          # tightened from 28
            crash_score += 0.25
        elif vix > 26:
            crash_score += 0.12
        if ad_ratio < -0.65:                  # tightened
            crash_score += 0.20
        if vix_change > 25:                   # tightened
            crash_score += 0.15
        if pcr > 1.8:                         # high put buying = panic
            crash_score += 0.10
        scores[MarketRegime.CRASH] = min(crash_score, 1.0)

        # BEAR: sustained selling + weak breadth + majority of stocks below SMA
        bear_score = 0.0
        if nifty_change < -1.2:               # tightened
            bear_score += 0.22
        elif nifty_change < -0.4:
            bear_score += 0.08
        if vix > 20:                          # tightened from 18
            bear_score += 0.14
        if ad_ratio < -0.25:                  # tightened
            bear_score += 0.18
        if breadth < 38:                      # tightened
            bear_score += 0.18
        if rsi < 38:                          # tightened
            bear_score += 0.18
        if pct_sma200 < 40:                   # new: majority below long-term MA
            bear_score += 0.10
        scores[MarketRegime.BEAR] = min(bear_score, 1.0)

        # VOLATILE: high VIX + wide ranges but no clear direction + OI skew flip
        volatile_score = 0.0
        if vix > 22:                          # tightened
            volatile_score += 0.28
        if atr_pct > 1.6:                     # tightened
            volatile_score += 0.22
        if abs(nifty_change) > 1.5 and adx < 22:
            volatile_score += 0.18
        if abs(vix_change) > 12:              # tightened
            volatile_score += 0.22
        if abs(oi_skew) > 0.3:               # new: large OI skew = uncertainty
            volatile_score += 0.10
        scores[MarketRegime.VOLATILE] = min(volatile_score, 1.0)

        # STRONG_BULL: broad rally + low VIX + high participation + PCR supportive
        strong_bull_score = 0.0
        if nifty_change > 1.2:               # tightened
            strong_bull_score += 0.22
        if vix < 13:                          # tightened
            strong_bull_score += 0.20
        elif vix < 15:
            strong_bull_score += 0.10
        if ad_ratio > 0.55:                   # tightened
            strong_bull_score += 0.18
        if breadth > 72:                      # tightened
            strong_bull_score += 0.18
        if rsi > 62 and rsi < 78:            # tightened
            strong_bull_score += 0.12
        if pcr > 1.2 and pcr < 1.6:         # new: heavy PE writing = bullish hedge
            strong_bull_score += 0.05
        if pct_sma20 > 70:                   # new: most stocks in near-term uptrend
            strong_bull_score += 0.05
        scores[MarketRegime.STRONG_BULL] = min(strong_bull_score, 1.0)

        # BULL: moderate up trend + decent breadth + rotation healthy
        bull_score = 0.0
        if nifty_change > 0.4:               # tightened
            bull_score += 0.18
        elif nifty_change > 0.1:
            bull_score += 0.08
        if vix < 17:                          # tightened
            bull_score += 0.14
        if ad_ratio > 0.12:                   # tightened
            bull_score += 0.18
        if breadth > 57:                      # tightened
            bull_score += 0.18
        if adx > 22:                          # tightened
            bull_score += 0.12
        if rsi > 52:                          # tightened
            bull_score += 0.10
        if rotation > 0.1:                    # new: healthy sector rotation
            bull_score += 0.10
        scores[MarketRegime.BULL] = min(bull_score, 1.0)

        # SIDEWAYS: low ADX + range-bound + mixed signals + balanced PCR
        sideways_score = 0.0
        if abs(nifty_change) < 0.4:          # tightened
            sideways_score += 0.22
        if adx < 18:                          # tightened
            sideways_score += 0.22
        if 42 < breadth < 58:                # tightened
            sideways_score += 0.18
        if abs(ad_ratio) < 0.12:             # tightened
            sideways_score += 0.14
        if 13 < vix < 19:                    # tightened
            sideways_score += 0.14
        if 0.85 < pcr < 1.15:               # new: balanced PCR = no clear bias
            sideways_score += 0.10
        scores[MarketRegime.SIDEWAYS] = min(sideways_score, 1.0)

        # Normalize to probabilities
        total = sum(scores.values())
        if total == 0:
            probs = {r: 1.0 / 6 for r in REGIME_CLASSES}
            probs[MarketRegime.SIDEWAYS] = 0.4
        else:
            probs = {r: s / total for r, s in scores.items()}

        # Pick the winner
        predicted = max(probs, key=probs.get)  # type: ignore
        confidence = probs[predicted]

        prob_dict = {r.value: round(p, 4) for r, p in probs.items()}

        return RegimePredictionResponse(
            regime=predicted,
            confidence=round(confidence, 4),
            probabilities=prob_dict,
            features_used=sum(1 for f in self.feature_names if f in features),
            model_version=f"{self.model_version}-heuristic",
        )

    def train(
        self,
        X: np.ndarray,
        y: np.ndarray,
        params: dict[str, Any] | None = None,
        eval_set: tuple[np.ndarray, np.ndarray] | None = None,
    ) -> dict[str, float]:
        """
        Train the XGBoost regime classifier.

        Args:
            X: Feature matrix (n_samples, n_features) in REGIME_FEATURES order.
            y: Integer labels (0-5 mapping to REGIME_CLASSES).
            params: XGBoost hyperparameters (defaults to DEFAULT_PARAMS).
            eval_set: Optional validation set (X_val, y_val).

        Returns:
            Training metrics dict.
        """
        import xgboost as xgb
        from sklearn.metrics import accuracy_score, classification_report

        hp = {**DEFAULT_PARAMS, **(params or {})}
        n_estimators = hp.pop("n_estimators", 300)

        self.model = xgb.XGBClassifier(
            n_estimators=n_estimators, **hp
        )

        fit_params: dict[str, Any] = {}
        if eval_set is not None:
            X_val, y_val = eval_set
            fit_params["eval_set"] = [(X_val, y_val)]
            fit_params["verbose"] = False

        self.model.fit(X, y, **fit_params)

        # Compute training metrics
        y_pred = self.model.predict(X)
        train_acc = accuracy_score(y, y_pred)

        metrics = {"train_accuracy": train_acc}

        if eval_set is not None:
            X_val, y_val = eval_set
            y_val_pred = self.model.predict(X_val)
            val_acc = accuracy_score(y_val, y_val_pred)
            metrics["val_accuracy"] = val_acc

        logger.info("market_regime_model_trained", metrics=metrics)
        return metrics

    def save(self, path: Path) -> None:
        """Save the trained model to disk."""
        if self.model is None:
            raise RuntimeError("No model to save — train first.")
        path.parent.mkdir(parents=True, exist_ok=True)
        self.model.save_model(str(path))
        logger.info("market_regime_model_saved", path=str(path))

    def get_feature_importance(self) -> dict[str, float]:
        """Get feature importance scores from the trained model."""
        if self.model is None:
            return {}
        importance = self.model.feature_importances_
        return {
            name: float(imp)
            for name, imp in zip(self.feature_names, importance)
        }

    @staticmethod
    def regime_to_score(regime: MarketRegime) -> float:
        """
        Convert regime to a directional score in [-1, 1] for downstream use.
        This feeds into the stock ranking and strategy selection models.
        """
        mapping = {
            MarketRegime.STRONG_BULL: 1.0,
            MarketRegime.BULL: 0.5,
            MarketRegime.SIDEWAYS: 0.0,
            MarketRegime.VOLATILE: -0.2,
            MarketRegime.BEAR: -0.6,
            MarketRegime.CRASH: -1.0,
        }
        return mapping.get(regime, 0.0)

    @staticmethod
    def regime_to_encoded(regime: MarketRegime) -> float:
        """Ordinal encoding for use as a feature in downstream models."""
        mapping = {
            MarketRegime.CRASH: 0.0,
            MarketRegime.BEAR: 1.0,
            MarketRegime.VOLATILE: 2.0,
            MarketRegime.SIDEWAYS: 3.0,
            MarketRegime.BULL: 4.0,
            MarketRegime.STRONG_BULL: 5.0,
        }
        return mapping.get(regime, 3.0)


def generate_regime_labels(
    nifty_ohlcv: "pd.DataFrame", lookforward: int = 5
) -> "pd.Series":
    """
    Generate ground-truth regime labels from historical NIFTY data.

    Uses a combination of forward return, realized volatility, and drawdown
    over the next `lookforward` bars to label each point in time.

    This is used by the training pipeline to create labeled data.
    """
    import pandas as pd

    close = nifty_ohlcv["close"]
    high = nifty_ohlcv["high"]
    low = nifty_ohlcv["low"]

    # Forward metrics
    fwd_return = close.shift(-lookforward) / close - 1
    fwd_vol = close.pct_change().rolling(lookforward).std().shift(-lookforward)
    fwd_max_dd = pd.Series(0.0, index=close.index)

    for i in range(len(close) - lookforward):
        window = close.iloc[i:i + lookforward + 1]
        peak = window.cummax()
        drawdown = (window - peak) / peak
        fwd_max_dd.iloc[i] = drawdown.min()

    # ATR-based realized vol
    tr = pd.concat([
        high - low,
        (high - close.shift(1)).abs(),
        (low - close.shift(1)).abs(),
    ], axis=1).max(axis=1)
    realized_atr_pct = tr.rolling(lookforward).mean() / close * 100

    # Label rules
    labels = pd.Series(REGIME_TO_INT[MarketRegime.SIDEWAYS], index=close.index)

    # CRASH: severe drawdown + extreme vol
    crash_mask = (fwd_return < -0.05) & (fwd_max_dd < -0.06)
    labels[crash_mask] = REGIME_TO_INT[MarketRegime.CRASH]

    # BEAR: negative forward return + some drawdown
    bear_mask = (fwd_return < -0.02) & (fwd_max_dd < -0.03) & ~crash_mask
    labels[bear_mask] = REGIME_TO_INT[MarketRegime.BEAR]

    # VOLATILE: high ATR but mixed direction
    volatile_mask = (realized_atr_pct > 1.8) & (fwd_return.abs() < 0.03) & ~crash_mask & ~bear_mask
    labels[volatile_mask] = REGIME_TO_INT[MarketRegime.VOLATILE]

    # STRONG_BULL: strong forward return + low vol
    strong_bull_mask = (fwd_return > 0.03) & (fwd_max_dd > -0.015)
    labels[strong_bull_mask] = REGIME_TO_INT[MarketRegime.STRONG_BULL]

    # BULL: positive forward return
    bull_mask = (fwd_return > 0.01) & (fwd_return <= 0.03) & ~strong_bull_mask
    labels[bull_mask] = REGIME_TO_INT[MarketRegime.BULL]

    return labels
