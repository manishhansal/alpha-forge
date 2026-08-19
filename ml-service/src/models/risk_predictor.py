"""
Risk Prediction Model (XGBoost).

Estimates per-trade risk metrics before entry:
  - P(stop loss hit): probability the stop is triggered before target
  - P(target hit): probability TP1 is reached before stop
  - Expected max drawdown %: worst intra-trade adverse excursion
  - Suggested position size %: Kelly-informed dynamic sizing

These outputs drive dynamic position sizing — a trade with high P(stop)
gets smaller size regardless of the signal strength, while a trade with
low P(stop) and strong confluence can be sized more aggressively.

Architecture:
  - Two XGBoost binary classifiers: one for stop-hit, one for target-hit
  - One XGBoost regressor: expected max drawdown %
  - 18 features from RISK_FEATURES (ATR, VIX, ADX, regime, entry/stop geometry)
  - Position sizing derived from predicted probabilities + Kelly criterion
"""

from pathlib import Path
from typing import Any

import numpy as np
import structlog

from ..features.engineer import RISK_FEATURES
from ..schemas import MarketRegime, RiskResponse

logger = structlog.get_logger()

# Default XGBoost hyperparameters for risk models
STOP_HIT_PARAMS = {
    "objective": "binary:logistic",
    "eval_metric": "auc",
    "max_depth": 5,
    "learning_rate": 0.05,
    "n_estimators": 250,
    "min_child_weight": 10,
    "subsample": 0.8,
    "colsample_bytree": 0.8,
    "gamma": 0.2,
    "reg_alpha": 0.1,
    "reg_lambda": 1.5,
    "scale_pos_weight": 1,
    "tree_method": "hist",
    "random_state": 42,
    "verbosity": 0,
}

TARGET_HIT_PARAMS = {
    **STOP_HIT_PARAMS,
    "scale_pos_weight": 1.2,  # Slight upweight for target hits (less frequent)
}

DRAWDOWN_PARAMS = {
    "objective": "reg:squarederror",
    "eval_metric": "rmse",
    "max_depth": 5,
    "learning_rate": 0.04,
    "n_estimators": 300,
    "min_child_weight": 10,
    "subsample": 0.8,
    "colsample_bytree": 0.8,
    "gamma": 0.15,
    "reg_alpha": 0.1,
    "reg_lambda": 1.5,
    "tree_method": "hist",
    "random_state": 42,
    "verbosity": 0,
}

# Risk score thresholds
RISK_SCORE_THRESHOLDS = {
    "very_low": (0, 2),
    "low": (2, 4),
    "moderate": (4, 6),
    "high": (6, 8),
    "extreme": (8, 10),
}


class RiskPredictor:
    """
    XGBoost-based per-trade risk prediction model.

    Estimates the probability of hitting stop/target and the expected
    intra-trade drawdown. Falls back to a formula-based heuristic when
    no trained models are available.
    """

    def __init__(self, model_dir: Path | None = None):
        self.stop_model = None
        self.target_model = None
        self.drawdown_model = None
        self.model_version = "risk-xgb-v1"
        self.feature_names = RISK_FEATURES

        if model_dir and model_dir.exists():
            self._load_models(model_dir)

    def _load_models(self, model_dir: Path) -> None:
        """Load all three risk sub-models from a directory."""
        import xgboost as xgb

        stop_path = model_dir / "risk_stop_hit.json"
        target_path = model_dir / "risk_target_hit.json"
        dd_path = model_dir / "risk_drawdown.json"

        try:
            if stop_path.exists():
                self.stop_model = xgb.XGBClassifier()
                self.stop_model.load_model(str(stop_path))
            if target_path.exists():
                self.target_model = xgb.XGBClassifier()
                self.target_model.load_model(str(target_path))
            if dd_path.exists():
                self.drawdown_model = xgb.XGBRegressor()
                self.drawdown_model.load_model(str(dd_path))
            logger.info("risk_models_loaded", dir=str(model_dir))
        except Exception as e:
            logger.warning("risk_models_load_failed", error=str(e))

    def predict(self, features: dict[str, float]) -> RiskResponse:
        """
        Predict risk metrics for a proposed trade.

        Args:
            features: Dict with RISK_FEATURES keys plus trade geometry
                     (stop_distance_atr, target_distance_atr, risk_reward_ratio,
                      trend_alignment).

        Returns:
            RiskResponse with probabilities, drawdown, position size, risk score.
        """
        if self.stop_model is not None:
            return self._predict_ml(features)
        return self._predict_heuristic(features)

    def _predict_ml(self, features: dict[str, float]) -> RiskResponse:
        """ML-based risk prediction."""
        feature_vector = np.array(
            [[features.get(f, 0.0) for f in self.feature_names]]
        )

        # P(stop hit)
        prob_stop = float(self.stop_model.predict_proba(feature_vector)[0][1])

        # P(target hit)
        if self.target_model is not None:
            prob_target = float(self.target_model.predict_proba(feature_vector)[0][1])
        else:
            prob_target = 1.0 - prob_stop

        # Expected drawdown
        if self.drawdown_model is not None:
            expected_dd = float(self.drawdown_model.predict(feature_vector)[0])
            expected_dd = max(0.0, min(expected_dd, 20.0))
        else:
            expected_dd = self._estimate_drawdown_heuristic(features)

        # Position sizing
        position_size = self._compute_position_size(
            prob_stop, prob_target, features
        )

        # Risk score (0-10)
        risk_score = self._compute_risk_score(
            prob_stop, prob_target, expected_dd, features
        )

        # Factor contributions
        factors = self._extract_risk_factors(features, prob_stop)

        return RiskResponse(
            prob_stop_hit=round(prob_stop, 4),
            prob_target_hit=round(prob_target, 4),
            expected_drawdown_pct=round(expected_dd, 2),
            suggested_position_size_pct=round(position_size, 2),
            risk_score=round(risk_score, 1),
            factors=factors,
        )

    def _predict_heuristic(self, features: dict[str, float]) -> RiskResponse:
        """
        Formula-based risk estimation when no trained model is available.

        Uses a Bayesian-inspired approach combining:
          - Trade geometry (risk/reward ratio, stop distance in ATR)
          - Market conditions (VIX regime, ADX, volume)
          - Trend alignment (is the trade with or against the trend?)
          - Time risk (session progress, expiry proximity)
        """
        # Extract key features
        atr_pct = features.get("atr_pct", 1.0)
        vix_regime = features.get("vix_regime", 1.0)
        adx = features.get("adx_14", 20.0)
        rsi = features.get("rsi_14", 50.0)
        rel_vol = features.get("relative_volume", 1.0)
        regime_encoded = features.get("regime_encoded", 3.0)
        stop_dist_atr = features.get("stop_distance_atr", 1.4)
        target_dist_atr = features.get("target_distance_atr", 2.0)
        rr_ratio = features.get("risk_reward_ratio", 1.5)
        trend_alignment = features.get("trend_alignment", 0.0)
        pcr_score = features.get("pcr_score", 0.0)
        oi_score = features.get("oi_buildup_score", 0.0)
        session_progress = features.get("session_progress", 0.5)
        is_expiry = features.get("is_expiry_day", 0.0)
        bb_position = features.get("bollinger_position", 0.5)
        vol_confirm = features.get("volume_price_confirm", 0.0)
        breakout = features.get("breakout_score", 0.0)
        structure = features.get("structure_score", 0.0)

        # ─── P(stop hit) estimation ──────────────────────────────────────
        # Base rate: ~40% of intraday trades hit their stop (empirical NSE)
        base_stop_rate = 0.40

        # Stop distance factor: tighter stop → higher P(stop)
        stop_factor = 1.0
        if stop_dist_atr < 1.0:
            stop_factor = 1.3  # Tight stop, likely whipsawed
        elif stop_dist_atr > 2.0:
            stop_factor = 0.7  # Wide stop, harder to hit
        else:
            stop_factor = 1.0 + (1.0 - stop_dist_atr) * 0.3

        # VIX factor: higher VIX → more random moves → higher P(stop)
        vix_factor = 1.0 + (vix_regime - 1.0) * 0.15

        # Trend alignment: trading with the trend reduces stop risk
        trend_factor = 1.0 - trend_alignment * 0.2

        # ADX factor: strong trends protect directional trades
        adx_factor = 1.0 - max(0, adx - 20) / 100

        # Derivatives positioning: aligned OI/PCR reduces risk
        deriv_alignment = (pcr_score + oi_score) / 2
        deriv_factor = 1.0 - deriv_alignment * 0.1

        # Volume confirmation
        vol_factor = 1.0 - max(0, vol_confirm) * 0.1

        # Expiry day risk (gamma exposure makes stops more likely)
        expiry_factor = 1.0 + is_expiry * 0.15

        # Time risk: later in session → less time for target, but also
        # established trends are clearer
        time_factor = 1.0 + max(0, session_progress - 0.7) * 0.1

        prob_stop = base_stop_rate * (
            stop_factor * vix_factor * trend_factor * adx_factor
            * deriv_factor * vol_factor * expiry_factor * time_factor
        )
        prob_stop = np.clip(prob_stop, 0.1, 0.85)

        # ─── P(target hit) estimation ────────────────────────────────────
        # Base: inverse of stop, adjusted by R:R (higher RR → harder to hit)
        base_target_rate = 0.45

        # R:R factor: ambitious targets are harder to reach
        rr_factor = 1.0
        if rr_ratio > 2.5:
            rr_factor = 0.7  # Ambitious
        elif rr_ratio < 1.5:
            rr_factor = 1.2  # Conservative, likely hit
        else:
            rr_factor = 1.0 - (rr_ratio - 1.5) * 0.2

        # Trend alignment boosts target probability
        target_trend_factor = 1.0 + trend_alignment * 0.25

        # Breakout and structure confirmation
        confirmation_factor = 1.0 + max(0, breakout) * 0.15 + max(0, structure) * 0.1

        prob_target = base_target_rate * rr_factor * target_trend_factor * confirmation_factor
        prob_target = np.clip(prob_target, 0.15, 0.80)

        # Ensure stop + target don't exceed 1 by much (normalize)
        total_prob = prob_stop + prob_target
        if total_prob > 0.95:
            scale = 0.95 / total_prob
            prob_stop *= scale
            prob_target *= scale

        # ─── Expected drawdown ────────────────────────────────────────────
        expected_dd = self._estimate_drawdown_heuristic(features)

        # ─── Position sizing ─────────────────────────────────────────────
        position_size = self._compute_position_size(
            prob_stop, prob_target, features
        )

        # ─── Risk score ──────────────────────────────────────────────────
        risk_score = self._compute_risk_score(
            prob_stop, prob_target, expected_dd, features
        )

        # ─── Factor contributions ────────────────────────────────────────
        factors = self._extract_risk_factors(features, prob_stop)

        return RiskResponse(
            prob_stop_hit=round(float(prob_stop), 4),
            prob_target_hit=round(float(prob_target), 4),
            expected_drawdown_pct=round(float(expected_dd), 2),
            suggested_position_size_pct=round(float(position_size), 2),
            risk_score=round(float(risk_score), 1),
            factors=factors,
        )

    def _estimate_drawdown_heuristic(self, features: dict[str, float]) -> float:
        """Estimate max adverse excursion from trade geometry + volatility."""
        atr_pct = features.get("atr_pct", 1.0)
        stop_dist_atr = features.get("stop_distance_atr", 1.4)
        vix_regime = features.get("vix_regime", 1.0)

        # Expected drawdown scales with ATR and stop distance
        # Empirically ~60-80% of stop distance is typical MAE for winners
        base_dd = atr_pct * stop_dist_atr * 0.7

        # VIX amplifies
        vix_mult = 1.0 + (vix_regime - 1.0) * 0.2

        return float(np.clip(base_dd * vix_mult, 0.2, 15.0))

    def _compute_position_size(
        self,
        prob_stop: float,
        prob_target: float,
        features: dict[str, float],
    ) -> float:
        """
        Kelly criterion-informed position sizing.

        Kelly fraction = (p * b - q) / b
        where p = win prob, q = loss prob, b = win/loss ratio (R:R)

        We use a half-Kelly (50% of full Kelly) for safety and cap at
        the horizon-appropriate limit.
        """
        rr_ratio = features.get("risk_reward_ratio", 1.5)
        stop_dist_pct = features.get("atr_pct", 1.0) * features.get("stop_distance_atr", 1.4)

        # Kelly
        p = prob_target
        q = 1 - p
        b = rr_ratio

        if b <= 0:
            return 1.0

        kelly = (p * b - q) / b
        half_kelly = max(kelly * 0.5, 0.0)

        # Convert to position size given fixed risk budget (1% of equity)
        risk_budget_pct = 1.0
        if stop_dist_pct > 0:
            position_from_risk = (risk_budget_pct / stop_dist_pct) * 100
        else:
            position_from_risk = 5.0

        # Scale by Kelly fraction
        position_size = position_from_risk * min(half_kelly * 2, 1.0)

        # Cap based on risk conditions
        vix_regime = features.get("vix_regime", 1.0)
        max_size = 10.0 - vix_regime * 1.5  # Lower cap in high-VIX
        max_size = max(max_size, 2.0)

        return float(np.clip(position_size, 0.5, max_size))

    def _compute_risk_score(
        self,
        prob_stop: float,
        prob_target: float,
        expected_dd: float,
        features: dict[str, float],
    ) -> float:
        """
        Composite risk score 0-10 (10 = maximum risk).

        Factors:
          - P(stop) contributes 35%
          - Expected drawdown contributes 25%
          - VIX regime contributes 20%
          - Expiry/time risk contributes 10%
          - Trend misalignment contributes 10%
        """
        # P(stop) component (0-10)
        stop_component = prob_stop * 10

        # Drawdown component (0-10, scaled by 5% as "dangerous")
        dd_component = min(expected_dd / 5.0, 1.0) * 10

        # VIX component
        vix_regime = features.get("vix_regime", 1.0)
        vix_component = (vix_regime / 3.0) * 10

        # Time/expiry component
        is_expiry = features.get("is_expiry_day", 0.0)
        session_progress = features.get("session_progress", 0.5)
        time_component = (is_expiry * 5 + max(0, session_progress - 0.7) * 5)

        # Trend misalignment
        trend_alignment = features.get("trend_alignment", 0.0)
        misalignment_component = max(0, -trend_alignment) * 10

        risk_score = (
            stop_component * 0.35
            + dd_component * 0.25
            + vix_component * 0.20
            + time_component * 0.10
            + misalignment_component * 0.10
        )

        return float(np.clip(risk_score, 0.0, 10.0))

    def _extract_risk_factors(
        self, features: dict[str, float], prob_stop: float
    ) -> dict[str, float]:
        """Extract the key factors driving the risk assessment."""
        factors = {}

        # Trade geometry
        rr = features.get("risk_reward_ratio", 1.5)
        factors["Risk/Reward"] = round(rr, 2)

        # Stop tightness
        stop_atr = features.get("stop_distance_atr", 1.4)
        factors["Stop Distance (ATR)"] = round(stop_atr, 2)

        # VIX contribution
        vix = features.get("vix_regime", 1.0)
        vix_labels = {0: "Low", 1: "Moderate", 2: "High", 3: "Extreme"}
        factors["VIX Regime"] = vix

        # Trend alignment
        trend = features.get("trend_alignment", 0.0)
        factors["Trend Alignment"] = round(trend, 2)

        # Volume confirmation
        vol_conf = features.get("volume_price_confirm", 0.0)
        factors["Volume Confirmation"] = round(vol_conf, 2)

        # Derivatives support
        oi = features.get("oi_buildup_score", 0.0)
        factors["OI Support"] = round(oi, 2)

        return factors

    def train(
        self,
        X: np.ndarray,
        y_stop: np.ndarray,
        y_target: np.ndarray,
        y_drawdown: np.ndarray,
        params: dict[str, dict[str, Any]] | None = None,
        eval_set: tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray] | None = None,
    ) -> dict[str, float]:
        """
        Train all three risk sub-models.

        Args:
            X: Feature matrix (n_samples, n_features).
            y_stop: Binary labels (1 = stop was hit).
            y_target: Binary labels (1 = target was hit).
            y_drawdown: Continuous (max adverse excursion %).
            params: Optional per-model params dict with keys 'stop', 'target', 'drawdown'.
            eval_set: Optional (X_val, y_stop_val, y_target_val, y_drawdown_val).

        Returns:
            Combined training metrics.
        """
        import xgboost as xgb
        from sklearn.metrics import accuracy_score, roc_auc_score, mean_squared_error

        custom_params = params or {}

        # Train stop-hit classifier
        stop_params = {**STOP_HIT_PARAMS, **custom_params.get("stop", {})}
        n_est = stop_params.pop("n_estimators", 250)
        self.stop_model = xgb.XGBClassifier(n_estimators=n_est, **stop_params)
        self.stop_model.fit(X, y_stop)

        # Train target-hit classifier
        target_params = {**TARGET_HIT_PARAMS, **custom_params.get("target", {})}
        n_est = target_params.pop("n_estimators", 250)
        self.target_model = xgb.XGBClassifier(n_estimators=n_est, **target_params)
        self.target_model.fit(X, y_target)

        # Train drawdown regressor
        dd_params = {**DRAWDOWN_PARAMS, **custom_params.get("drawdown", {})}
        n_est = dd_params.pop("n_estimators", 300)
        self.drawdown_model = xgb.XGBRegressor(n_estimators=n_est, **dd_params)
        self.drawdown_model.fit(X, y_drawdown)

        # Compute metrics
        metrics: dict[str, float] = {}

        stop_pred = self.stop_model.predict_proba(X)[:, 1]
        metrics["train_stop_auc"] = float(roc_auc_score(y_stop, stop_pred))

        target_pred = self.target_model.predict_proba(X)[:, 1]
        metrics["train_target_auc"] = float(roc_auc_score(y_target, target_pred))

        dd_pred = self.drawdown_model.predict(X)
        metrics["train_dd_rmse"] = float(np.sqrt(mean_squared_error(y_drawdown, dd_pred)))

        if eval_set is not None:
            X_val, y_stop_val, y_target_val, y_dd_val = eval_set

            stop_val_pred = self.stop_model.predict_proba(X_val)[:, 1]
            metrics["val_stop_auc"] = float(roc_auc_score(y_stop_val, stop_val_pred))

            target_val_pred = self.target_model.predict_proba(X_val)[:, 1]
            metrics["val_target_auc"] = float(roc_auc_score(y_target_val, target_val_pred))

            dd_val_pred = self.drawdown_model.predict(X_val)
            metrics["val_dd_rmse"] = float(np.sqrt(mean_squared_error(y_dd_val, dd_val_pred)))

        logger.info("risk_predictor_trained", metrics=metrics)
        return metrics

    def save(self, model_dir: Path) -> None:
        """Save all sub-models to a directory."""
        model_dir.mkdir(parents=True, exist_ok=True)

        if self.stop_model:
            self.stop_model.save_model(str(model_dir / "risk_stop_hit.json"))
        if self.target_model:
            self.target_model.save_model(str(model_dir / "risk_target_hit.json"))
        if self.drawdown_model:
            self.drawdown_model.save_model(str(model_dir / "risk_drawdown.json"))

        logger.info("risk_predictor_saved", dir=str(model_dir))


def generate_risk_labels(
    trades_df: "pd.DataFrame",
) -> tuple["np.ndarray", "np.ndarray", "np.ndarray"]:
    """
    Generate ground-truth risk labels from historical trade data.

    Args:
        trades_df: DataFrame with columns:
            - entry, stop_loss, target (price levels)
            - max_adverse_excursion_pct (worst drawdown during trade)
            - outcome: 'STOP_HIT' | 'TARGET_HIT' | 'EXPIRED' | 'CLOSED'

    Returns:
        (y_stop, y_target, y_drawdown) arrays for training.
    """
    y_stop = (trades_df["outcome"] == "STOP_HIT").astype(int).values
    y_target = (trades_df["outcome"] == "TARGET_HIT").astype(int).values
    y_drawdown = trades_df["max_adverse_excursion_pct"].clip(0, 20).values

    return y_stop, y_target, y_drawdown
