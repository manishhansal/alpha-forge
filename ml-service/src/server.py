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

import pydantic
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


# ─── Riskfolio-Lib Portfolio Endpoint (v2) ───────────────────────────────────


class PortfolioV2Request(pydantic.BaseModel):
    """
    Request body for POST /predict/portfolio-v2.

    Accepts a list of symbols + daily return series, and a method selector.
    """

    symbols: list[str]
    method: str = "hrp"   # "hrp" | "cvar" | "max_diversification" | "factor"
    # Optional: pre-computed daily returns as {symbol: [r1, r2, ...]}
    # If omitted, a synthetic return series is generated (for smoke-testing).
    returns: dict[str, list[float]] | None = None
    alpha: float = 0.05   # CVaR tail probability


@app.post("/predict/portfolio-v2")
async def predict_portfolio_v2(req: PortfolioV2Request):
    """
    Riskfolio-Lib portfolio optimisation endpoint.

    Supports HRP (Hierarchical Risk Parity) and CVaR-minimised MVO.

    Input:
      symbols — list of asset names
      method  — "hrp" or "cvar" (default "hrp")
      returns — optional dict of {symbol: [daily_returns, ...]}
                If omitted, a synthetic 252-day series is generated.
      alpha   — CVaR tail probability (default 0.05)

    Output:
      {
        method:      str,
        weights:     {symbol: weight},   # sum to 1, all ≥ 0
        riskMetrics: { volatility, cvar, sharpe, maxDrawdown },
        available:   true,
      }

    On any error → { available: false, reason: "..." }

    Validates: Requirements 10.1, 10.2, 10.3, 10.4, 10.5
    """
    import numpy as np
    import pandas as pd

    if portfolio_optimizer is None:
        return {"available": False, "reason": "Portfolio optimizer not loaded"}

    if not req.symbols:
        return {"available": False, "reason": "No symbols provided"}

    try:
        # Build returns DataFrame
        if req.returns:
            returns_df = pd.DataFrame(req.returns, columns=req.symbols)
        else:
            # Synthetic returns for smoke-testing / when returns not supplied
            rng = np.random.default_rng(42)
            n = len(req.symbols)
            daily_vol = 0.25 / np.sqrt(252)
            raw = rng.normal(0, daily_vol, size=(252, n))
            returns_df = pd.DataFrame(raw, columns=req.symbols)

        start = time.perf_counter()

        method = req.method.lower()
        if method == "hrp":
            result = portfolio_optimizer.hrp_allocation(returns_df)
        elif method == "cvar":
            result = portfolio_optimizer.cvar_allocation(returns_df, alpha=req.alpha)
        else:
            # Fallback to HRP for unsupported methods (max_diversification, factor)
            # until those methods are fully implemented
            result = portfolio_optimizer.hrp_allocation(returns_df)
            method = "hrp"

        latency_ms = (time.perf_counter() - start) * 1000

        logger.info(
            "portfolio_v2_optimized",
            method=method,
            n_symbols=len(req.symbols),
            latency_ms=round(latency_ms, 1),
        )

        risk = result["risk_metrics"]
        return {
            "method": method,
            "weights": result["weights"],
            "riskMetrics": {
                "volatility": risk["volatility"],
                "cvar": risk["cvar"],
                "sharpe": risk["sharpe"],
                "maxDrawdown": risk["max_dd"],
            },
            "available": True,
        }

    except Exception as exc:
        logger.error("portfolio_v2_failed", error=str(exc))
        return {"available": False, "reason": str(exc)}


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


# ─── Analytics Endpoints ─────────────────────────────────────────────────────


class GreeksRequest(pydantic.BaseModel):
    """Request body for POST /analytics/greeks."""

    chain: list[dict]
    spot: float
    india_vix: float
    expiry_dt: str  # ISO format date string (e.g. "2025-01-30T15:30:00")


@app.post("/analytics/greeks")
async def analytics_greeks(req: GreeksRequest):
    """
    Compute Black-Scholes / Black-76 greeks and IV for an NSE option chain.

    Input:  chain snapshot + spot + India VIX + expiry date
    Output: list of enriched rows — original fields plus {delta, gamma, theta, vega, rho, iv}

    Validates: Requirements 3.1, 3.2, 3.6
    """
    from datetime import datetime
    from .greeks import compute_chain_greeks

    try:
        expiry = datetime.fromisoformat(req.expiry_dt)
    except ValueError as exc:
        raise HTTPException(
            status_code=422,
            detail=f"Invalid expiry_dt format — expected ISO 8601: {exc}",
        ) from exc

    result = compute_chain_greeks(req.chain, req.spot, req.india_vix, expiry)
    return result


# ─── GEX Endpoint ────────────────────────────────────────────────────────────


class GexRequest(pydantic.BaseModel):
    """Request body for POST /analytics/gex."""

    chain_snapshot: list[dict]
    spot: float
    symbol: str = "NIFTY"


@app.post("/analytics/gex")
async def analytics_gex(req: GexRequest):
    """
    Compute Dealer Gamma Exposure (GEX) from an NSE option chain snapshot.

    Input:  chain_snapshot — list of {strike, ce_gamma, pe_gamma, ce_oi, pe_oi}
            spot           — current spot / index level
            symbol         — NSE symbol name (used to resolve canonical lot size)

    Output: {strikes, gex_per_strike, aggregate_gex, gamma_flip,
             expected_move_pct, positive_gex_wall, negative_gex_wall}

    When gamma fields are absent from the chain rows, the caller should
    pre-enrich the chain via POST /analytics/greeks (Requirement 4.4).

    Validates: Requirements 4.1, 4.2, 4.3, 4.4
    """
    from .gex import LOT_SIZES, compute_gex

    if not req.chain_snapshot:
        raise HTTPException(
            status_code=422, detail="chain_snapshot must not be empty"
        )

    lot_size = LOT_SIZES.get(req.symbol.upper(), LOT_SIZES["NIFTY"])

    start = time.perf_counter()
    result = compute_gex(req.chain_snapshot, req.spot, lot_size)
    latency_ms = (time.perf_counter() - start) * 1000

    logger.info(
        "gex_computed",
        symbol=req.symbol,
        aggregate_gex=round(result["aggregate_gex"], 2),
        gamma_flip=result["gamma_flip"],
        latency_ms=round(latency_ms, 3),
    )

    return {**result, "symbol": req.symbol, "spot": req.spot}


# ─── VPIN Endpoint ────────────────────────────────────────────────────────────


@app.get("/analytics/vpin")
async def analytics_vpin(symbol: str = "NIFTY"):
    """
    Compute VPIN (Volume-synchronized Probability of Informed Trading)
    for the requested symbol.

    This endpoint accepts pre-fetched OHLCV bars via query parameters in
    production; for the analytics API the caller POSTs bars in the body.
    Since this is a GET endpoint keyed by symbol, the actual bar data must
    be fetched by the caller and passed through the POST variant, or this
    endpoint returns a classification based on the most recent cached VPIN.

    For now this returns a stub response so the route is available for
    caching/proxying by the Next.js layer.  The real computation is
    triggered by POST /analytics/vpin when bars are available.

    GET /analytics/vpin?symbol=NIFTY → VpinResponse

    Validates: Requirements 7.1, 7.2, 7.5
    """
    return {
        "symbol": symbol,
        "vpin": 0.0,
        "bucketHistory": [],
        "classification": "benign",
        "available": False,
        "reason": "Use POST /analytics/vpin with OHLCV bars to compute VPIN",
    }


class VpinRequest(pydantic.BaseModel):
    """Request body for POST /analytics/vpin."""

    symbol: str = "NIFTY"
    bars: list[dict]          # list of {open, high, low, close, volume} dicts
    bucket_size: float = 50.0
    n_buckets: int = 50


@app.post("/analytics/vpin")
async def analytics_vpin_post(req: VpinRequest):
    """
    Compute VPIN from a list of 5-min OHLCV bars.

    Input:  symbol + bars (OHLCV list) + optional bucket_size + n_buckets
    Output: VpinResponse with current VPIN, bucket history, and classification

    Classification thresholds:
      - toxic:    vpin >= 0.7
      - elevated: 0.3 <= vpin < 0.7
      - benign:   vpin < 0.3

    Validates: Requirements 7.1, 7.2, 7.3, 7.4, 7.5, 7.8
    """
    from .features.volume import compute_vpin

    if not req.bars:
        return {
            "symbol": req.symbol,
            "vpin": 0.0,
            "bucketHistory": [],
            "classification": "benign",
            "available": True,
        }

    result = compute_vpin(req.bars, bucket_size=req.bucket_size, n_buckets=req.n_buckets)
    current_vpin = result["current_vpin"]
    bucket_history = result["vpin_series"][-20:]  # last 20 bucket values for sparkline

    if current_vpin >= 0.7:
        classification = "toxic"
    elif current_vpin >= 0.3:
        classification = "elevated"
    else:
        classification = "benign"

    logger.info(
        "vpin_computed",
        symbol=req.symbol,
        current_vpin=round(current_vpin, 4),
        classification=classification,
        n_buckets=len(result["vpin_series"]),
    )

    return {
        "symbol": req.symbol,
        "vpin": round(current_vpin, 6),
        "bucketHistory": [round(v, 6) for v in bucket_history],
        "classification": classification,
        "available": True,
    }


# ─── Vol Surface Endpoint ────────────────────────────────────────────────────


class VolSurfaceSnapshotItem(pydantic.BaseModel):
    """Per-expiry snapshot passed to POST /analytics/vol-surface."""

    strikes: list[float]
    ivs: list[float]
    forward: float
    days_to_expiry: float
    atm_iv: float


@app.get("/analytics/vol-surface")
async def analytics_vol_surface_get(symbol: str = "NIFTY"):
    """
    Stub GET endpoint for IV surface.

    Returns a not-yet-available response when called without snapshot data.
    The real computation is triggered by POST /analytics/vol-surface with
    per-expiry snapshots supplied by the caller.

    GET /analytics/vol-surface?symbol=NIFTY → VolSurfaceResponse (stub)

    Validates: Requirements 5.3, 5.4
    """
    return {
        "symbol": symbol,
        "expiries": [],
        "ivByExpiry": {},
        "termStructure": [],
        "sviParams": {},
        "available": False,
        "reason": "Use POST /analytics/vol-surface with snapshots_by_expiry to compute the surface",
    }


class VolSurfaceRequest(pydantic.BaseModel):
    """Request body for POST /analytics/vol-surface."""

    symbol: str = "NIFTY"
    snapshots_by_expiry: dict[str, VolSurfaceSnapshotItem]


@app.post("/analytics/vol-surface")
async def analytics_vol_surface_post(req: VolSurfaceRequest):
    """
    Build the full IV surface and term structure for a given symbol.

    Input:  symbol + per-expiry snapshots (strikes, ivs, forward, dte, atm_iv)
    Output: VolSurfaceResponse with per-expiry IV arrays, SVI params, and
            term structure sorted ascending by days-to-expiry.

    Validates: Requirements 5.1, 5.2, 5.3
    """
    from .vol_surface import build_iv_surface, compute_term_structure, fit_svi

    snapshots_raw = {k: v.model_dump() for k, v in req.snapshots_by_expiry.items()}

    start = time.perf_counter()

    # Build per-expiry IV arrays
    iv_by_expiry = build_iv_surface(snapshots_raw)

    # Fit SVI to each expiry smile
    svi_params: dict = {}
    for expiry, snapshot in snapshots_raw.items():
        try:
            svi_params[expiry] = fit_svi(
                strikes=snapshot["strikes"],
                ivs=snapshot["ivs"],
                forward=snapshot["forward"],
            )
        except Exception as exc:  # pragma: no cover
            logger.warning("svi_fit_failed", expiry=expiry, error=str(exc))
            svi_params[expiry] = None

    # Compute term structure
    term_structure = compute_term_structure(snapshots_raw)

    latency_ms = (time.perf_counter() - start) * 1000
    logger.info(
        "vol_surface_computed",
        symbol=req.symbol,
        n_expiries=len(snapshots_raw),
        latency_ms=round(latency_ms, 1),
    )

    return {
        "symbol": req.symbol,
        "expiries": list(snapshots_raw.keys()),
        "ivByExpiry": iv_by_expiry,
        "termStructure": [
            {"daysToExpiry": e["days_to_expiry"], "atmIv": e["atm_iv"]}
            for e in term_structure
        ],
        "sviParams": svi_params,
        "available": True,
    }


# ─── Price Regime Forecaster Endpoint ────────────────────────────────────────


class PriceRegimeRequest(pydantic.BaseModel):
    """Request body for POST /predict/price-regime."""

    last_60_bars: list[list[float]]
    """
    Multivariate input: shape [n_bars, 9].
    Each row: [open, high, low, close, volume, vpin, atm_iv, pcr, oi_buildup].
    Typically n_bars == 60 (last 5 hours of 5-min NIFTY/BANKNIFTY bars).
    """


@app.post("/predict/price-regime")
async def predict_price_regime(req: PriceRegimeRequest):
    """
    Forecast the 1-hour ahead price regime from the last 60 5-min bars.

    Input:  last_60_bars — shape [60, 9] multivariate OHLCV + derived features
    Output: {regime: "bull"|"bear"|"flat", probability: float, q10: float, q90: float}

    Falls back to a rule-based heuristic when no trained TFT artifact is available.
    The ML service returns a valid response in all cases; the Next.js layer handles
    the `available` flag.

    Validates: Requirements 8.1, 8.3, 8.4
    """
    from .price_forecaster import PriceForecaster

    forecaster = PriceForecaster()
    start = time.perf_counter()
    result = forecaster.predict(req.last_60_bars)
    latency_ms = (time.perf_counter() - start) * 1000

    logger.info(
        "price_regime_predicted",
        regime=result["regime"],
        probability=round(result["probability"], 4),
        latency_ms=round(latency_ms, 3),
    )

    return result


# ─── IV Regime Classifier Endpoint ───────────────────────────────────────────


class IVRegimeRequest(pydantic.BaseModel):
    """Request body for POST /predict/iv-regime."""

    data: list[list[float]]
    """
    Daily feature matrix: shape [n_days, 5].
    Each row: [atm_iv, pcr, oi_change, vix, spot_change].
    Typically n_days == 20 (last 20 calendar days of daily data).
    """


@app.post("/predict/iv-regime")
async def predict_iv_regime(req: IVRegimeRequest):
    """
    Classify the next-session IV regime from 20 days of daily option data.

    Input:  data — shape [20, 5]: [atm_iv, pcr, oi_change, vix, spot_change]
    Output: {iv_regime: "CRUSH"|"STABLE"|"SPIKE"}

    Falls back to a rule-based heuristic when no trained PatchTST artifact
    is available.  The ML service returns a valid response in all cases.

    Validates: Requirements 9.1, 9.2, 9.3
    """
    from .iv_regime_classifier import IVClassifier

    classifier = IVClassifier()
    start = time.perf_counter()
    iv_regime = classifier.predict(req.data)
    latency_ms = (time.perf_counter() - start) * 1000

    logger.info(
        "iv_regime_classified",
        iv_regime=iv_regime,
        latency_ms=round(latency_ms, 3),
    )

    return {"iv_regime": iv_regime}


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
