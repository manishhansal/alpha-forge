"""
Model Training Script — trains all models end-to-end.

Loads the prepared training data (from data_pipeline.py), trains each model
with Optuna hyperparameter tuning, evaluates on a holdout set, and saves
the artifacts to the artifacts/ directory.

Usage:
  # Train all models:
  python -m src.training.train_all

  # Train a specific model:
  python -m src.training.train_all --model regime

  # Train with HPO (slower but better):
  python -m src.training.train_all --hpo --n-trials 50

  # Quick training (no HPO, fewer estimators):
  python -m src.training.train_all --quick
"""

import argparse
from pathlib import Path

import numpy as np
import structlog

from ..config import settings

logger = structlog.get_logger()


def train_regime_model(
    data_path: Path,
    artifacts_path: Path,
    use_hpo: bool = False,
    n_trials: int = 30,
    quick: bool = False,
) -> dict:
    """Train the Market Regime Classifier."""
    from sklearn.model_selection import train_test_split

    from ..models.market_regime import MarketRegimeClassifier, DEFAULT_PARAMS

    logger.info("training_regime_model")

    data = np.load(data_path)
    X, y = data["X"], data["y"]

    X_train, X_val, y_train, y_val = train_test_split(
        X, y, test_size=0.2, random_state=42, stratify=y
    )

    params = dict(DEFAULT_PARAMS)
    if quick:
        params["n_estimators"] = 100
        params["max_depth"] = 4

    if use_hpo:
        params = _hpo_xgboost(X_train, y_train, X_val, y_val, n_trials, "multi:softprob")

    model = MarketRegimeClassifier()
    metrics = model.train(X_train, y_train, params=params, eval_set=(X_val, y_val))

    save_path = artifacts_path / "market_regime.json"
    model.save(save_path)

    logger.info("regime_model_trained", metrics=metrics)
    return {"model": "regime", "metrics": metrics, "path": str(save_path)}


def train_ranking_model(
    data_path: Path,
    artifacts_path: Path,
    use_hpo: bool = False,
    n_trials: int = 30,
    quick: bool = False,
) -> dict:
    """Train the Stock Ranker."""
    from ..models.stock_ranker import StockRanker, DEFAULT_PARAMS

    logger.info("training_ranking_model")

    data = np.load(data_path)
    X, y = data["X"], data["y"]
    groups = data["groups"] if "groups" in data else None

    # Time-based split (last 20% of data is validation)
    split_idx = int(len(X) * 0.8)
    X_train, X_val = X[:split_idx], X[split_idx:]
    y_train, y_val = y[:split_idx], y[split_idx:]

    params = dict(DEFAULT_PARAMS)
    if quick:
        params["n_estimators"] = 150
        params["num_leaves"] = 31

    model = StockRanker()
    metrics = model.train(
        X_train, y_train,
        params=params,
        eval_set=(X_val, y_val),
        use_lambdarank=False,
    )

    save_path = artifacts_path / "stock_ranker.txt"
    model.save(save_path)

    logger.info("ranking_model_trained", metrics=metrics)
    return {"model": "ranker", "metrics": metrics, "path": str(save_path)}


def train_strategy_model(
    data_path: Path,
    artifacts_path: Path,
    use_hpo: bool = False,
    n_trials: int = 30,
    quick: bool = False,
) -> dict:
    """Train the Strategy Selector."""
    from sklearn.model_selection import train_test_split

    from ..models.strategy_selector import StrategySelector, DEFAULT_PARAMS

    logger.info("training_strategy_model")

    data = np.load(data_path)
    X, y = data["X"], data["y"]

    X_train, X_val, y_train, y_val = train_test_split(
        X, y, test_size=0.2, random_state=42, stratify=y
    )

    params = dict(DEFAULT_PARAMS)
    if quick:
        params["iterations"] = 150
        params["depth"] = 4

    model = StrategySelector()
    metrics = model.train(X_train, y_train, params=params, eval_set=(X_val, y_val))

    save_path = artifacts_path / "strategy_selector.cbm"
    model.save(save_path)

    logger.info("strategy_model_trained", metrics=metrics)
    return {"model": "strategy", "metrics": metrics, "path": str(save_path)}


def train_risk_model(
    data_path: Path,
    artifacts_path: Path,
    use_hpo: bool = False,
    n_trials: int = 30,
    quick: bool = False,
) -> dict:
    """Train the Risk Predictor (3 sub-models)."""
    from ..models.risk_predictor import RiskPredictor

    logger.info("training_risk_model")

    data = np.load(data_path)
    X = data["X"]
    y_stop = data["y_stop"]
    y_target = data["y_target"]
    y_dd = data["y_drawdown"]

    # Time-based split
    split_idx = int(len(X) * 0.8)
    X_train, X_val = X[:split_idx], X[split_idx:]
    y_stop_train, y_stop_val = y_stop[:split_idx], y_stop[split_idx:]
    y_target_train, y_target_val = y_target[:split_idx], y_target[split_idx:]
    y_dd_train, y_dd_val = y_dd[:split_idx], y_dd[split_idx:]

    model = RiskPredictor()
    metrics = model.train(
        X_train, y_stop_train, y_target_train, y_dd_train,
        eval_set=(X_val, y_stop_val, y_target_val, y_dd_val),
    )

    risk_dir = artifacts_path / "risk"
    model.save(risk_dir)

    logger.info("risk_model_trained", metrics=metrics)
    return {"model": "risk", "metrics": metrics, "path": str(risk_dir)}


def train_rl_executor(
    artifacts_path: Path,
    total_timesteps: int = 500_000,
    quick: bool = False,
) -> dict:
    """Train the RL Execution Agent."""
    from ..models.rl_executor import RLExecutor

    logger.info("training_rl_executor")

    if quick:
        total_timesteps = 50_000

    model = RLExecutor()
    save_path = artifacts_path / "rl_executor"

    try:
        metrics = model.train(
            total_timesteps=total_timesteps,
            save_path=save_path,
        )
        logger.info("rl_executor_trained", metrics=metrics)
        return {"model": "rl_executor", "metrics": metrics, "path": str(save_path)}
    except Exception as e:
        logger.warning("rl_training_failed", error=str(e))
        return {"model": "rl_executor", "metrics": {}, "error": str(e)}


def _hpo_xgboost(
    X_train: np.ndarray,
    y_train: np.ndarray,
    X_val: np.ndarray,
    y_val: np.ndarray,
    n_trials: int,
    objective: str,
) -> dict:
    """Optuna hyperparameter optimization for XGBoost."""
    import optuna
    import xgboost as xgb
    from sklearn.metrics import accuracy_score, log_loss

    optuna.logging.set_verbosity(optuna.logging.WARNING)

    def objective_fn(trial):
        params = {
            "objective": objective,
            "num_class": len(np.unique(y_train)) if "multi" in objective else None,
            "max_depth": trial.suggest_int("max_depth", 3, 8),
            "learning_rate": trial.suggest_float("learning_rate", 0.01, 0.15, log=True),
            "n_estimators": trial.suggest_int("n_estimators", 100, 500),
            "min_child_weight": trial.suggest_int("min_child_weight", 3, 15),
            "subsample": trial.suggest_float("subsample", 0.6, 1.0),
            "colsample_bytree": trial.suggest_float("colsample_bytree", 0.6, 1.0),
            "gamma": trial.suggest_float("gamma", 0, 0.5),
            "reg_alpha": trial.suggest_float("reg_alpha", 0.01, 1.0, log=True),
            "reg_lambda": trial.suggest_float("reg_lambda", 0.1, 5.0, log=True),
            "tree_method": "hist",
            "random_state": 42,
            "verbosity": 0,
        }

        # Remove None values
        params = {k: v for k, v in params.items() if v is not None}

        n_est = params.pop("n_estimators")
        model = xgb.XGBClassifier(n_estimators=n_est, **params)
        model.fit(X_train, y_train, eval_set=[(X_val, y_val)], verbose=False)

        y_pred = model.predict(X_val)
        return accuracy_score(y_val, y_pred)

    study = optuna.create_study(direction="maximize")
    study.optimize(objective_fn, n_trials=n_trials)

    best = study.best_params
    best["tree_method"] = "hist"
    best["random_state"] = 42
    best["verbosity"] = 0
    best["objective"] = objective

    if "multi" in objective:
        best["num_class"] = len(np.unique(y_train))

    logger.info("hpo_complete", best_accuracy=study.best_value, params=best)
    return best


def train_all(
    data_dir: Path | None = None,
    artifacts_dir: Path | None = None,
    use_hpo: bool = False,
    n_trials: int = 30,
    quick: bool = False,
    models: list[str] | None = None,
) -> list[dict]:
    """
    Train all models end-to-end.

    Args:
        data_dir: Directory containing .npz training data files.
        artifacts_dir: Directory to save model artifacts.
        use_hpo: Whether to run Optuna HPO.
        n_trials: Number of Optuna trials.
        quick: Quick training mode (fewer estimators, no HPO).
        models: List of specific models to train (None = all).

    Returns:
        List of training result dicts.
    """
    if data_dir is None:
        data_dir = settings.training_data_path
    if artifacts_dir is None:
        artifacts_dir = settings.model_artifacts_path

    artifacts_dir.mkdir(parents=True, exist_ok=True)
    results = []

    all_models = ["regime", "ranker", "strategy", "risk", "rl"]
    to_train = models if models else all_models

    if "regime" in to_train:
        regime_data = data_dir / "regime_train.npz"
        if regime_data.exists():
            r = train_regime_model(regime_data, artifacts_dir, use_hpo, n_trials, quick)
            results.append(r)
        else:
            logger.warning("regime_data_missing", path=str(regime_data))

    if "ranker" in to_train:
        ranking_data = data_dir / "ranking_train.npz"
        if ranking_data.exists():
            r = train_ranking_model(ranking_data, artifacts_dir, use_hpo, n_trials, quick)
            results.append(r)
        else:
            logger.warning("ranking_data_missing", path=str(ranking_data))

    if "strategy" in to_train:
        strategy_data = data_dir / "strategy_train.npz"
        if strategy_data.exists():
            r = train_strategy_model(strategy_data, artifacts_dir, use_hpo, n_trials, quick)
            results.append(r)
        else:
            logger.warning("strategy_data_missing", path=str(strategy_data))

    if "risk" in to_train:
        risk_data = data_dir / "risk_train.npz"
        if risk_data.exists():
            r = train_risk_model(risk_data, artifacts_dir, use_hpo, n_trials, quick)
            results.append(r)
        else:
            logger.warning("risk_data_missing", path=str(risk_data))

    if "rl" in to_train:
        timesteps = 50_000 if quick else 500_000
        r = train_rl_executor(artifacts_dir, timesteps, quick)
        results.append(r)

    logger.info("training_complete", models_trained=len(results))
    return results


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Train ML models")
    parser.add_argument("--model", default=None, help="Specific model to train (regime/ranker/strategy/risk/rl)")
    parser.add_argument("--hpo", action="store_true", help="Run Optuna HPO")
    parser.add_argument("--n-trials", type=int, default=30, help="Number of Optuna trials")
    parser.add_argument("--quick", action="store_true", help="Quick training mode")
    parser.add_argument("--data-dir", default=None, help="Training data directory")
    parser.add_argument("--artifacts-dir", default=None, help="Model artifacts directory")
    args = parser.parse_args()

    data_dir = Path(args.data_dir) if args.data_dir else None
    artifacts_dir = Path(args.artifacts_dir) if args.artifacts_dir else None
    models = [args.model] if args.model else None

    results = train_all(
        data_dir=data_dir,
        artifacts_dir=artifacts_dir,
        use_hpo=args.hpo,
        n_trials=args.n_trials,
        quick=args.quick,
        models=models,
    )

    print("\n" + "=" * 60)
    print("TRAINING RESULTS")
    print("=" * 60)
    for r in results:
        print(f"\n  {r['model']}:")
        if "metrics" in r:
            for k, v in r["metrics"].items():
                print(f"    {k}: {v:.4f}" if isinstance(v, float) else f"    {k}: {v}")
        if "path" in r:
            print(f"    saved: {r['path']}")
        if "error" in r:
            print(f"    ERROR: {r['error']}")
    print("\n" + "=" * 60)
