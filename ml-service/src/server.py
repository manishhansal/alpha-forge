"""
FastAPI ML Service — serves predictions to the Next.js frontend.

Endpoints:
  POST /predict/regime       → Market regime classification
  POST /predict/rankings     → Stock ranking (batch)
  POST /predict/strategy     → Strategy selection (per stock)
  POST /predict/risk         → Risk prediction (per trade)
  POST /predict/portfolio    → Portfolio optimization
  POST /predict/execution    → RL execution decision
  POST /explain/{model}      → SHAP explanation for a prediction
  GET  /health               → Service health check
  GET  /models/status        → Model load status
"""

import time
from contextlib import asynccontextmanager
from pathlib import Path

import structlog
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from .config import settings
from .explainability import ModelExplainer
from .models.market_regime import MarketRegimeClassifier
from .models.portfolio_optimizer import PortfolioOptimizer
from .models.risk_predictor import RiskPredictor
from .models.stock_ranker import StockRanker
from .models.strategy_selector import StrategySelector
from .schemas import (
    ExplainRequest,
    ExplainResponse,
    ExecutionDecision,
    ExecutionState,
    MarketRegime,
    PortfolioRequest,
    PortfolioResponse,
    RankingRequest,
    RankingResponse,
    RegimePredictionRequest,
    RegimePredictionResponse,
    RiskRequest,
    RiskResponse,
    StrategyRequest,
    StrategyResponse,
)

logger = structlog.get_logger()

# ─── Global model instances ──────────────────────────────────────────────────

regime_classifier: MarketRegimeClassifier | None = None
stock_ranker: StockRanker | None = None
strategy_selector: StrategySelector | None = None
risk_predictor: RiskPredictor | None = None
portfolio_optimizer: PortfolioOptimizer | None = None
explainer: ModelExplainer | None = None


def _load_models() -> None:
    """Load all model artifacts (if available) at startup."""
    global regime_classifier, stock_ranker, strategy_selector
    global risk_predictor, portfolio_optimizer, explainer

    artifacts = settings.model_artifacts_path

    # Market Regime Classifier (XGBoost)
    regime_path = artifacts / "market_regime.json"
    regime_classifier = MarketRegimeClassifier(
        model_path=regime_path if regime_path.exists() else None
    )

    # Stock Ranker (LightGBM)
    ranker_path = artifacts / "stock_ranker.txt"
    stock_ranker = StockRanker(
        model_path=ranker_path if ranker_path.exists() else None
    )

    # Strategy Selector (CatBoost)
    strategy_path = artifacts / "strategy_selector.cbm"
    strategy_selector = StrategySelector(
        model_path=strategy_path if strategy_path.exists() else None
    )

    # Risk Predictor (XGBoost × 3)
    risk_dir = artifacts / "risk"
    risk_predictor = RiskPredictor(
        model_dir=risk_dir if risk_dir.exists() else None
    )

    # Portfolio Optimizer (no model artifact — pure algorithm)
    portfolio_optimizer = PortfolioOptimizer()

    # SHAP Explainer
    explainer = ModelExplainer()

    # Register models with explainer for SHAP
    if regime_classifier.model is not None:
        explainer.register_model(
            "regime", regime_classifier.model, regime_classifier.feature_names
        )
    if stock_ranker.model is not None:
        explainer.register_model(
            "ranker", stock_ranker.model, stock_ranker.feature_names
        )
    if strategy_selector.model is not None:
        explainer.register_model(
            "strategy", strategy_selector.model, strategy_selector.feature_names
        )
    if risk_predictor.stop_model is not None:
        explainer.register_model(
            "risk", risk_predictor.stop_model, risk_predictor.feature_names
        )

    logger.info(
        "models_loaded",
        regime=regime_classifier.model is not None,
        ranker=stock_ranker.model is not None,
        strategy=strategy_selector.model is not None,
        risk=risk_predictor.stop_model is not None,
    )


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Load models on startup, cleanup on shutdown."""
    _load_models()
    logger.info("ml_service_started", port=settings.port)
    yield
    logger.info("ml_service_shutdown")


# ─── FastAPI App ──────────────────────────────────────────────────────────────

app = FastAPI(
    title="AlphaForge ML Service",
    description="Multi-model AI decision engine for Indian market trading",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─── Health / Status ──────────────────────────────────────────────────────────


@app.get("/health")
async def health():
    """Service health check."""
    return {
        "status": "healthy",
        "timestamp": int(time.time() * 1000),
        "version": "1.0.0",
    }


@app.get("/models/status")
async def models_status():
    """Status of all loaded models."""
    return {
        "regime_classifier": {
            "loaded": regime_classifier is not None,
            "has_trained_model": regime_classifier.model is not None if regime_classifier else False,
            "version": regime_classifier.model_version if regime_classifier else None,
        },
        "stock_ranker": {
            "loaded": stock_ranker is not None,
            "has_trained_model": stock_ranker.model is not None if stock_ranker else False,
            "version": stock_ranker.model_version if stock_ranker else None,
        },
        "strategy_selector": {
            "loaded": strategy_selector is not None,
            "has_trained_model": strategy_selector.model is not None if strategy_selector else False,
            "version": strategy_selector.model_version if strategy_selector else None,
        },
        "risk_predictor": {
            "loaded": risk_predictor is not None,
            "has_trained_model": risk_predictor.stop_model is not None if risk_predictor else False,
            "version": risk_predictor.model_version if risk_predictor else None,
        },
        "portfolio_optimizer": {
            "loaded": portfolio_optimizer is not None,
            "version": portfolio_optimizer.model_version if portfolio_optimizer else None,
        },
    }


# ─── Prediction Endpoints ────────────────────────────────────────────────────


@app.post("/predict/regime", response_model=RegimePredictionResponse)
async def predict_regime(request: RegimePredictionRequest):
    """
    Classify the current market regime.

    Input: macro features (VIX, NIFTY change, breadth, etc.)
    Output: regime class + probabilities + confidence
    """
    if regime_classifier is None:
        raise HTTPException(status_code=503, detail="Regime classifier not loaded")

    features = request.model_dump(exclude_none=True)
    start = time.perf_counter()
    result = regime_classifier.predict(features)
    latency_ms = (time.perf_counter() - start) * 1000

    logger.info(
        "regime_predicted",
        regime=result.regime.value,
        confidence=result.confidence,
        latency_ms=round(latency_ms, 1),
    )
    return result


@app.post("/predict/rankings", response_model=RankingResponse)
async def predict_rankings(request: RankingRequest):
    """
    Rank stocks by outperformance probability.

    Input: batch of per-stock feature vectors + current regime
    Output: sorted list with scores, ranks, and factor explanations
    """
    if stock_ranker is None:
        raise HTTPException(status_code=503, detail="Stock ranker not loaded")

    stocks = [s.model_dump(exclude_none=True) for s in request.stocks]
    symbols = [s.symbol for s in request.stocks]

    start = time.perf_counter()
    result = stock_ranker.rank(
        stocks=stocks,
        symbols=symbols,
        regime=request.regime,
        top_n=request.top_n,
    )
    latency_ms = (time.perf_counter() - start) * 1000

    logger.info(
        "rankings_predicted",
        n_stocks=len(stocks),
        top_n=request.top_n,
        top_symbol=result.rankings[0].symbol if result.rankings else None,
        latency_ms=round(latency_ms, 1),
    )
    return result


@app.post("/predict/strategy", response_model=StrategyResponse)
async def predict_strategy(request: StrategyRequest):
    """
    Select the optimal trading strategy for a stock.

    Input: regime + per-stock technical features
    Output: selected strategy + confidence + alternatives + rationale
    """
    if strategy_selector is None:
        raise HTTPException(status_code=503, detail="Strategy selector not loaded")

    features = request.model_dump(exclude_none=True)
    regime = request.regime

    start = time.perf_counter()
    result = strategy_selector.select(features=features, regime=regime)
    latency_ms = (time.perf_counter() - start) * 1000

    logger.info(
        "strategy_predicted",
        strategy=result.strategy.value,
        confidence=result.confidence,
        latency_ms=round(latency_ms, 1),
    )
    return result


@app.post("/predict/risk", response_model=RiskResponse)
async def predict_risk(request: RiskRequest):
    """
    Estimate per-trade risk before entry.

    Input: trade geometry (entry/stop/target) + market conditions
    Output: P(stop), P(target), expected drawdown, position size, risk score
    """
    if risk_predictor is None:
        raise HTTPException(status_code=503, detail="Risk predictor not loaded")

    features = request.model_dump(exclude_none=True)

    # Compute derived features from trade geometry
    atr = request.atr
    if atr > 0:
        features["stop_distance_atr"] = abs(request.entry - request.stop_loss) / atr
        features["target_distance_atr"] = abs(request.target - request.entry) / atr
    else:
        features["stop_distance_atr"] = 1.4
        features["target_distance_atr"] = 2.0

    stop_dist = abs(request.entry - request.stop_loss)
    target_dist = abs(request.target - request.entry)
    features["risk_reward_ratio"] = target_dist / stop_dist if stop_dist > 0 else 1.5

    # Trend alignment (positive if direction matches trend)
    features["trend_alignment"] = features.get("oi_buildup_score", 0.0)

    # Map regime to numeric
    from .models.market_regime import MarketRegimeClassifier
    features["regime_encoded"] = MarketRegimeClassifier.regime_to_encoded(request.regime)
    features["vix_regime"] = 1.0  # Default, overridden if VIX is high
    if request.vix > 25:
        features["vix_regime"] = 3.0
    elif request.vix > 18:
        features["vix_regime"] = 2.0
    elif request.vix < 13:
        features["vix_regime"] = 0.0

    features["atr_pct"] = (atr / request.entry * 100) if request.entry > 0 else 1.0

    start = time.perf_counter()
    result = risk_predictor.predict(features)
    latency_ms = (time.perf_counter() - start) * 1000

    logger.info(
        "risk_predicted",
        symbol=request.symbol,
        prob_stop=result.prob_stop_hit,
        risk_score=result.risk_score,
        latency_ms=round(latency_ms, 1),
    )
    return result


@app.post("/predict/portfolio", response_model=PortfolioResponse)
async def predict_portfolio(request: PortfolioRequest):
    """
    Optimize portfolio allocation across top-ranked stocks.

    Input: list of assets with expected returns, risk scores, sectors
    Output: HRP-optimized weights with diversification metrics
    """
    if portfolio_optimizer is None:
        raise HTTPException(status_code=503, detail="Portfolio optimizer not loaded")

    start = time.perf_counter()
    result = portfolio_optimizer.optimize(request)
    latency_ms = (time.perf_counter() - start) * 1000

    logger.info(
        "portfolio_optimized",
        n_assets=len(request.assets),
        n_allocations=len(result.allocations),
        sharpe=result.sharpe_ratio,
        latency_ms=round(latency_ms, 1),
    )
    return result


@app.post("/predict/execution", response_model=ExecutionDecision)
async def predict_execution(state: ExecutionState):
    """
    RL execution decision for an active trade.

    Input: current trade state (price, P&L, time in trade, regime)
    Output: action recommendation (hold, exit, trail stop, etc.)

    NOTE: Uses a rule-based policy until the RL agent is trained.
    """
    decision = _rule_based_execution(state)

    logger.info(
        "execution_decision",
        symbol=state.symbol,
        action=decision.action.value,
        confidence=decision.confidence,
    )
    return decision


@app.post("/explain/{model_name}", response_model=ExplainResponse)
async def explain_prediction(model_name: str, request: ExplainRequest):
    """
    SHAP-based explanation for a specific prediction.

    Input: model name + features + prediction
    Output: sorted feature contributions with direction indicators
    """
    if explainer is None:
        raise HTTPException(status_code=503, detail="Explainer not loaded")

    valid_models = {"regime", "ranker", "strategy", "risk"}
    if model_name not in valid_models:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid model: {model_name}. Must be one of {valid_models}",
        )

    result = explainer.explain(
        model_name=model_name,
        features=request.features,
        prediction=request.prediction,
        top_k=10,
    )
    return result


# ─── Rule-based execution policy (placeholder for RL) ────────────────────────


def _rule_based_execution(state: ExecutionState) -> ExecutionDecision:
    """
    Rule-based execution policy until the PPO agent is trained.

    Implements a basic trailing-stop + time-based exit strategy.
    """
    from .schemas import ExecutionAction

    pnl = state.unrealized_pnl_pct
    time_min = state.time_in_trade_minutes
    momentum = state.momentum

    # Emergency exit: large adverse move
    if pnl < -3.0:
        return ExecutionDecision(
            action=ExecutionAction.FULL_EXIT,
            confidence=0.9,
            rationale=f"Emergency exit — drawdown {pnl:.1f}% exceeds tolerance.",
        )

    # Time-based exit: approaching session end (last 15 min)
    session_remaining = 375 - time_min  # NSE session is 375 min
    if session_remaining < 15 and pnl > 0:
        return ExecutionDecision(
            action=ExecutionAction.FULL_EXIT,
            confidence=0.8,
            exit_pct=1.0,
            rationale="Session ending — booking profits before close.",
        )

    # Profitable: trail the stop
    if pnl > 2.0:
        # Move stop to breakeven + half the profit
        new_stop = state.entry + (state.current_price - state.entry) * 0.5
        if state.direction == "SHORT":
            new_stop = state.entry - (state.entry - state.current_price) * 0.5

        return ExecutionDecision(
            action=ExecutionAction.TRAIL_STOP,
            confidence=0.75,
            new_stop_loss=round(new_stop, 2),
            rationale=f"Trailing stop to lock in profits ({pnl:.1f}% unrealized).",
        )

    # Moderate profit: partial exit
    if pnl > 1.5 and time_min > 60:
        return ExecutionDecision(
            action=ExecutionAction.PARTIAL_EXIT,
            confidence=0.65,
            exit_pct=0.3,
            rationale="Partial profit booking — 30% at +1.5% after 1h hold.",
        )

    # Momentum fading against position
    if pnl > 0 and momentum < -0.3:
        return ExecutionDecision(
            action=ExecutionAction.TIGHTEN_STOP,
            confidence=0.6,
            new_stop_loss=round(state.stop_loss + (state.current_price - state.stop_loss) * 0.3, 2),
            rationale="Momentum fading — tightening stop to protect gains.",
        )

    # Scale in on strong continuation
    if pnl > 0.5 and momentum > 0.5 and state.volume_ratio > 1.3 and time_min < 120:
        return ExecutionDecision(
            action=ExecutionAction.SCALE_IN,
            confidence=0.55,
            rationale="Strong continuation with volume — scaling in.",
        )

    # Default: hold position
    return ExecutionDecision(
        action=ExecutionAction.WAIT,
        confidence=0.5,
        rationale="Holding — no action trigger met.",
    )
