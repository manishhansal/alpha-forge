"""
SHAP-based Model Explainability.

Provides transparent, human-readable explanations for every prediction
from the multi-model decision engine. Avoids black-box decisions for
live trading by showing exactly what drove each signal.

Example output:
  Trade Score = 94
    +18 Relative Volume
    +15 Sector Strength
    +14 ADX
    +12 Market Breadth
    +10 FVG
    +9 Order Block
    +8 RSI
    +8 Delivery %

Supports:
  - TreeExplainer for XGBoost / LightGBM / CatBoost (exact SHAP)
  - KernelExplainer fallback for any model
  - Per-prediction explanations (local)
  - Global feature importance (across all predictions)
  - Human-readable contribution formatting
"""

from typing import Any

import numpy as np
import structlog

from ..schemas import ExplainResponse, FeatureContribution

logger = structlog.get_logger()

# Human-readable feature labels (maps raw feature names → display names)
FEATURE_LABELS: dict[str, str] = {
    "relative_volume": "Relative Volume",
    "return_5d": "5-Day Momentum",
    "return_1d": "Intraday Change",
    "trend_strength": "Trend Strength",
    "adx_14": "ADX (Trend Power)",
    "rsi_14": "RSI(14)",
    "rsi_7": "RSI(7)",
    "macd_histogram": "MACD Histogram",
    "macd_line": "MACD Line",
    "ema_stack_score": "EMA Stack Alignment",
    "bollinger_position": "Bollinger Position",
    "stoch_rsi": "Stochastic RSI",
    "williams_r": "Williams %R",
    "cci": "CCI",
    "mfi": "Money Flow Index",
    "cmf": "Chaikin Money Flow",
    "obv_trend": "OBV Trend",
    "supertrend": "Supertrend",
    "volume_breakout": "Volume Breakout",
    "volume_trend": "Volume Trend",
    "volume_price_confirm": "Volume-Price Confirmation",
    "vwap_distance_pct": "VWAP Distance",
    "volume_profile_score": "Volume Profile",
    "force_index_norm": "Force Index",
    "volume_oscillator": "Volume Oscillator",
    "rate_of_change_12": "Rate of Change",
    "atr_expansion": "ATR Expansion",
    "breakout_score": "Breakout Score",
    "gap_pct": "Gap %",
    "distance_from_52w_high": "Distance from 52W High",
    "distance_from_52w_low": "Distance from 52W Low",
    "higher_highs_lows": "Higher Highs/Lows Structure",
    "pcr_score": "Put-Call Ratio",
    "oi_buildup_score": "OI Build-up",
    "iv_rank": "IV Rank",
    "max_pain_distance_pct": "Max-Pain Distance",
    "ce_wall_distance_pct": "CE Wall Distance",
    "pe_wall_distance_pct": "PE Wall Distance",
    "oi_wall_score": "OI Wall Score",
    "oi_delta_skew_norm": "OI Delta Skew",
    "atm_iv": "ATM IV",
    "fvg_score": "Fair Value Gap",
    "ob_score": "Order Block",
    "structure_score": "Market Structure (BOS/CHOCH)",
    "liquidity_sweep": "Liquidity Sweep",
    "relative_strength_vs_nifty": "RS vs NIFTY",
    "sector_momentum": "Sector Momentum",
    "delivery_pct": "Delivery %",
    "atr_pct": "ATR %",
    "atr_14": "ATR(14)",
    "regime_encoded": "Market Regime",
    "vix_regime": "VIX Regime",
    "market_breadth_score": "Market Breadth",
    "nifty_change_pct": "NIFTY Change %",
    "banknifty_change_pct": "BANKNIFTY Change %",
    "india_vix": "India VIX",
    "advance_decline_ratio": "Advance/Decline Ratio",
    "market_breadth": "Market Breadth",
    "pct_above_sma20": "% Above SMA20",
    "sector_dispersion": "Sector Dispersion",
    "rotation_score": "Sector Rotation",
    "session_progress": "Session Progress",
    "is_expiry_day": "Expiry Day",
    "global_sentiment": "Global Sentiment",
    "put_call_ratio": "PCR (NIFTY)",
    "stop_distance_atr": "Stop Distance (ATR)",
    "target_distance_atr": "Target Distance (ATR)",
    "risk_reward_ratio": "Risk/Reward Ratio",
    "trend_alignment": "Trend Alignment",
}


def get_feature_label(feature_name: str) -> str:
    """Get human-readable label for a feature name."""
    return FEATURE_LABELS.get(feature_name, feature_name.replace("_", " ").title())


class ModelExplainer:
    """
    Unified SHAP explainer for all models in the decision engine.

    Lazily initializes SHAP explainers per model to avoid loading
    overhead until explanations are actually requested.
    """

    def __init__(self):
        self._explainers: dict[str, Any] = {}
        self._background_data: dict[str, np.ndarray] = {}

    def register_model(
        self,
        model_name: str,
        model: Any,
        feature_names: list[str],
        background_data: np.ndarray | None = None,
    ) -> None:
        """
        Register a model for SHAP explanations.

        Args:
            model_name: Identifier ('regime', 'ranker', 'strategy', 'risk').
            model: The trained model object.
            feature_names: Ordered list of feature names.
            background_data: Optional reference dataset for KernelExplainer.
        """
        self._explainers[model_name] = {
            "model": model,
            "feature_names": feature_names,
            "shap_explainer": None,  # Lazily initialized
        }
        if background_data is not None:
            self._background_data[model_name] = background_data

    def explain(
        self,
        model_name: str,
        features: dict[str, float],
        prediction: str,
        top_k: int = 10,
    ) -> ExplainResponse:
        """
        Generate SHAP explanation for a single prediction.

        Args:
            model_name: Which model to explain.
            features: Input feature dict.
            prediction: The prediction string (for context).
            top_k: Number of top contributors to highlight.

        Returns:
            ExplainResponse with sorted contributions.
        """
        if model_name in self._explainers and self._explainers[model_name]["model"] is not None:
            return self._explain_shap(model_name, features, prediction, top_k)
        return self._explain_heuristic(model_name, features, prediction, top_k)

    def _explain_shap(
        self,
        model_name: str,
        features: dict[str, float],
        prediction: str,
        top_k: int,
    ) -> ExplainResponse:
        """Generate explanation using SHAP TreeExplainer."""
        try:
            import shap

            entry = self._explainers[model_name]
            model = entry["model"]
            feature_names = entry["feature_names"]

            # Initialize explainer lazily
            if entry["shap_explainer"] is None:
                try:
                    entry["shap_explainer"] = shap.TreeExplainer(model)
                except Exception:
                    # Fallback to Kernel if Tree doesn't work
                    bg = self._background_data.get(model_name)
                    if bg is not None:
                        entry["shap_explainer"] = shap.KernelExplainer(
                            model.predict_proba if hasattr(model, "predict_proba") else model.predict,
                            bg[:100],
                        )
                    else:
                        return self._explain_heuristic(model_name, features, prediction, top_k)

            explainer = entry["shap_explainer"]

            # Build feature vector
            feature_vector = np.array(
                [[features.get(f, 0.0) for f in feature_names]]
            )

            # Get SHAP values
            shap_values = explainer.shap_values(feature_vector)

            # Handle multi-class (pick the predicted class values)
            if isinstance(shap_values, list):
                # Multi-class: shap_values is list of arrays per class
                # Use the max-contribution class
                shap_arr = np.array(shap_values)
                class_contributions = np.abs(shap_arr[:, 0, :]).sum(axis=1)
                best_class = int(np.argmax(class_contributions))
                values = shap_values[best_class][0]
            elif shap_values.ndim == 3:
                # Shape (n_samples, n_features, n_classes)
                class_contributions = np.abs(shap_values[0]).sum(axis=0)
                best_class = int(np.argmax(class_contributions))
                values = shap_values[0, :, best_class]
            else:
                values = shap_values[0]

            base_value = float(explainer.expected_value) if np.isscalar(explainer.expected_value) else float(explainer.expected_value[0])

            # Build contributions
            contributions = []
            for i, fname in enumerate(feature_names):
                contrib = float(values[i])
                if abs(contrib) < 1e-6:
                    continue
                contributions.append(
                    FeatureContribution(
                        feature=get_feature_label(fname),
                        value=round(features.get(fname, 0.0), 4),
                        contribution=round(contrib, 4),
                        direction="positive" if contrib > 0 else "negative",
                    )
                )

            # Sort by absolute contribution
            contributions.sort(key=lambda c: abs(c.contribution), reverse=True)

            total_pos = sum(c.contribution for c in contributions if c.contribution > 0)
            total_neg = sum(c.contribution for c in contributions if c.contribution < 0)

            top_drivers = [c.feature for c in contributions[:5]]

            return ExplainResponse(
                model=model_name,
                prediction=prediction,
                base_value=round(base_value, 4),
                contributions=contributions[:top_k],
                total_positive=round(total_pos, 4),
                total_negative=round(total_neg, 4),
                top_drivers=top_drivers,
            )

        except Exception as e:
            logger.warning("shap_explain_failed", model=model_name, error=str(e))
            return self._explain_heuristic(model_name, features, prediction, top_k)

    def _explain_heuristic(
        self,
        model_name: str,
        features: dict[str, float],
        prediction: str,
        top_k: int,
    ) -> ExplainResponse:
        """
        Heuristic explanation when SHAP is unavailable.

        Uses feature magnitude × known importance weight to approximate
        contributions. Not as accurate as SHAP but provides useful signal.
        """
        # Importance weights per model (approximate, domain-informed)
        importance_weights = _get_model_importance_weights(model_name)

        contributions = []
        for fname, weight in importance_weights.items():
            value = features.get(fname, 0.0)
            if abs(value) < 1e-6 and fname not in ("is_expiry_day",):
                continue

            # Contribution = value magnitude × importance weight
            # Normalize by typical scale of the feature
            scale = _feature_scale(fname)
            normalized = value / scale if scale != 0 else 0.0
            contribution = normalized * weight

            contributions.append(
                FeatureContribution(
                    feature=get_feature_label(fname),
                    value=round(value, 4),
                    contribution=round(contribution, 4),
                    direction="positive" if contribution > 0 else "negative",
                )
            )

        # Sort by absolute contribution
        contributions.sort(key=lambda c: abs(c.contribution), reverse=True)

        total_pos = sum(c.contribution for c in contributions if c.contribution > 0)
        total_neg = sum(c.contribution for c in contributions if c.contribution < 0)
        top_drivers = [c.feature for c in contributions[:5]]

        return ExplainResponse(
            model=model_name,
            prediction=prediction,
            base_value=0.0,
            contributions=contributions[:top_k],
            total_positive=round(total_pos, 4),
            total_negative=round(total_neg, 4),
            top_drivers=top_drivers,
        )

    def global_importance(self, model_name: str) -> dict[str, float]:
        """
        Get global feature importance across all predictions for a model.

        Uses the model's built-in feature importance if available,
        falls back to the domain-informed importance weights.
        """
        if model_name in self._explainers:
            model = self._explainers[model_name]["model"]
            feature_names = self._explainers[model_name]["feature_names"]

            if hasattr(model, "feature_importances_"):
                importance = model.feature_importances_
                return {
                    get_feature_label(name): float(imp)
                    for name, imp in zip(feature_names, importance)
                }
            elif hasattr(model, "feature_importance"):
                importance = model.feature_importance(importance_type="gain")
                names = model.feature_name()
                return {
                    get_feature_label(name): float(imp)
                    for name, imp in zip(names, importance)
                }

        # Fallback to domain weights
        weights = _get_model_importance_weights(model_name)
        return {get_feature_label(k): v for k, v in weights.items()}


def _get_model_importance_weights(model_name: str) -> dict[str, float]:
    """Domain-informed feature importance weights per model."""
    if model_name == "regime":
        return {
            "india_vix": 0.15,
            "nifty_change_pct": 0.12,
            "advance_decline_ratio": 0.11,
            "market_breadth": 0.10,
            "banknifty_change_pct": 0.08,
            "nifty_adx": 0.08,
            "sector_dispersion": 0.07,
            "vix_change_pct": 0.06,
            "gap_pct_nifty": 0.05,
            "put_call_ratio": 0.05,
            "volume_ratio_market": 0.05,
            "rotation_score": 0.04,
            "global_sentiment": 0.04,
        }
    elif model_name == "ranker":
        return {
            "relative_volume": 0.10,
            "trend_strength": 0.09,
            "breakout_score": 0.09,
            "oi_buildup_score": 0.08,
            "return_5d": 0.07,
            "adx_14": 0.07,
            "ema_stack_score": 0.06,
            "sector_momentum": 0.06,
            "relative_strength_vs_nifty": 0.06,
            "pcr_score": 0.05,
            "atr_expansion": 0.05,
            "structure_score": 0.05,
            "volume_price_confirm": 0.05,
            "delivery_pct": 0.04,
            "fvg_score": 0.04,
            "iv_rank": 0.04,
        }
    elif model_name == "strategy":
        return {
            "regime_encoded": 0.15,
            "adx_14": 0.12,
            "rsi_14": 0.10,
            "atr_pct": 0.10,
            "bollinger_position": 0.09,
            "trend_strength": 0.09,
            "relative_volume": 0.08,
            "vwap_distance_pct": 0.07,
            "breakout_score": 0.07,
            "session_progress": 0.06,
            "macd_histogram": 0.04,
            "pcr_score": 0.03,
        }
    elif model_name == "risk":
        return {
            "stop_distance_atr": 0.14,
            "vix_regime": 0.12,
            "risk_reward_ratio": 0.11,
            "trend_alignment": 0.10,
            "adx_14": 0.08,
            "relative_volume": 0.07,
            "oi_buildup_score": 0.07,
            "session_progress": 0.06,
            "bollinger_position": 0.06,
            "is_expiry_day": 0.05,
            "breakout_score": 0.05,
            "structure_score": 0.05,
            "volume_price_confirm": 0.04,
        }
    else:
        return {}


def _feature_scale(feature_name: str) -> float:
    """Typical scale of each feature (used to normalize heuristic contributions)."""
    scales: dict[str, float] = {
        "relative_volume": 1.0,
        "return_5d": 5.0,
        "return_1d": 2.0,
        "trend_strength": 1.0,
        "adx_14": 30.0,
        "rsi_14": 50.0,
        "macd_histogram": 5.0,
        "ema_stack_score": 1.0,
        "bollinger_position": 1.0,
        "vwap_distance_pct": 2.0,
        "breakout_score": 1.0,
        "gap_pct": 2.0,
        "pcr_score": 1.0,
        "oi_buildup_score": 1.0,
        "iv_rank": 50.0,
        "fvg_score": 1.0,
        "ob_score": 1.0,
        "structure_score": 1.0,
        "sector_momentum": 3.0,
        "relative_strength_vs_nifty": 0.2,
        "atr_pct": 2.0,
        "atr_expansion": 1.5,
        "india_vix": 15.0,
        "nifty_change_pct": 2.0,
        "banknifty_change_pct": 2.0,
        "advance_decline_ratio": 1.0,
        "market_breadth": 50.0,
        "volume_price_confirm": 1.0,
        "delivery_pct": 50.0,
        "regime_encoded": 3.0,
        "vix_regime": 2.0,
        "stop_distance_atr": 2.0,
        "risk_reward_ratio": 2.0,
        "trend_alignment": 1.0,
        "session_progress": 1.0,
        "is_expiry_day": 1.0,
    }
    return scales.get(feature_name, 1.0)


def format_explanation_text(response: ExplainResponse, max_items: int = 8) -> str:
    """
    Format an ExplainResponse into a human-readable text block.

    Example:
      Trade Score = 94
        +18 Relative Volume
        +15 Sector Strength
        +14 ADX
        -8  High VIX (risk)
    """
    lines = [f"Prediction: {response.prediction}"]
    lines.append("")

    for contrib in response.contributions[:max_items]:
        sign = "+" if contrib.contribution > 0 else ""
        # Scale contribution to a 0-20 display range
        display_val = int(abs(contrib.contribution) * 20)
        display_val = max(1, min(20, display_val))
        if contrib.contribution < 0:
            display_val = -display_val
        lines.append(f"  {sign}{display_val:>3} {contrib.feature}")

    lines.append("")
    lines.append(f"Top drivers: {', '.join(response.top_drivers)}")
    return "\n".join(lines)
