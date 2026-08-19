"""Pydantic schemas for API request/response validation."""

from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field


# ─── Market Regime ────────────────────────────────────────────────────────────


class MarketRegime(str, Enum):
    """Market regime classifications."""

    STRONG_BULL = "strong_bull"
    BULL = "bull"
    SIDEWAYS = "sideways"
    VOLATILE = "volatile"
    BEAR = "bear"
    CRASH = "crash"


class RegimePredictionRequest(BaseModel):
    """Input features for market regime classification."""

    nifty_change_pct: float = Field(description="NIFTY 50 intraday % change")
    banknifty_change_pct: float = Field(description="BANKNIFTY intraday % change")
    india_vix: float = Field(description="India VIX level")
    nifty_atr_pct: float = Field(description="NIFTY ATR(14) as % of price")
    nifty_adx: float = Field(description="NIFTY ADX(14)")
    advance_decline_ratio: float = Field(description="NSE advance/decline ratio")
    market_breadth: float = Field(description="% of F&O stocks above 20 SMA")
    sector_strength: float = Field(description="Avg sector % change")
    volume_ratio: float = Field(description="Market volume vs 20-day avg")
    gap_pct: float = Field(description="Opening gap % from previous close")
    # Additional engineered features
    vix_change_pct: Optional[float] = Field(default=None)
    nifty_rsi: Optional[float] = Field(default=None)
    nifty_macd_hist: Optional[float] = Field(default=None)
    fii_net_cr: Optional[float] = Field(default=None)
    put_call_ratio: Optional[float] = Field(default=None)


class RegimePredictionResponse(BaseModel):
    """Market regime prediction with probabilities."""

    regime: MarketRegime
    confidence: float = Field(ge=0, le=1)
    probabilities: dict[str, float] = Field(
        description="Probability for each regime class"
    )
    features_used: int
    model_version: str


# ─── Stock Ranking ────────────────────────────────────────────────────────────


class StockFeatures(BaseModel):
    """Per-stock feature vector for the ranking model."""

    symbol: str
    relative_volume: float = Field(description="Volume vs 20-day avg")
    atr_expansion: float = Field(description="ATR expansion rate (today vs 20-day)")
    momentum_5d: float = Field(description="5-day return %")
    momentum_10d: float = Field(description="10-day return %")
    vwap_distance_pct: float = Field(description="% distance from VWAP")
    ema_stack_score: float = Field(description="EMA alignment score [-1,1]")
    rsi_14: float = Field(description="RSI(14)")
    macd_histogram: float = Field(description="MACD histogram value")
    adx_14: float = Field(description="ADX(14)")
    delivery_pct: Optional[float] = Field(default=None, description="Delivery %")
    sector_momentum: float = Field(description="Sector avg momentum")
    relative_strength_vs_nifty: float = Field(description="RS ratio vs NIFTY")
    options_oi_score: Optional[float] = Field(default=None, description="OI build-up score")
    pcr: Optional[float] = Field(default=None, description="Put-Call Ratio")
    iv_rank: Optional[float] = Field(default=None, description="IV percentile rank")
    market_breadth: float = Field(description="Market breadth score")
    volume_profile_score: Optional[float] = Field(default=None)
    gap_pct: float = Field(description="Gap % from prev close")
    # Additional features
    bollinger_position: Optional[float] = Field(default=None)
    atr_pct: Optional[float] = Field(default=None)
    obv_trend: Optional[float] = Field(default=None)
    stoch_rsi: Optional[float] = Field(default=None)
    williams_r: Optional[float] = Field(default=None)
    cci: Optional[float] = Field(default=None)
    mfi: Optional[float] = Field(default=None)
    cmf: Optional[float] = Field(default=None)


class RankingRequest(BaseModel):
    """Batch ranking request for the full F&O universe."""

    stocks: list[StockFeatures]
    regime: MarketRegime = Field(description="Current market regime (conditions the ranking)")
    top_n: int = Field(default=20, description="Number of top stocks to return")


class StockRank(BaseModel):
    """A single stock's ranking result."""

    symbol: str
    score: float = Field(ge=0, le=100, description="Outperformance score 0-100")
    rank: int
    factors: dict[str, float] = Field(description="SHAP-based factor contributions")


class RankingResponse(BaseModel):
    """Ranked stock universe with explanations."""

    rankings: list[StockRank]
    model_version: str
    regime_used: MarketRegime


# ─── Strategy Selection ───────────────────────────────────────────────────────


class TradingStrategy(str, Enum):
    """Available trading strategies."""

    BREAKOUT = "breakout"
    MOMENTUM = "momentum"
    TREND_FOLLOWING = "trend_following"
    MEAN_REVERSION = "mean_reversion"
    VWAP_BOUNCE = "vwap_bounce"
    RANGE_TRADING = "range_trading"
    SCALPING = "scalping"
    VOLATILITY_BREAKOUT = "volatility_breakout"


class StrategyRequest(BaseModel):
    """Context for strategy selection."""

    regime: MarketRegime
    symbol: str
    rsi: float
    adx: float
    atr_pct: float
    volume_ratio: float
    vwap_distance_pct: float
    bollinger_position: float
    trend_strength: float = Field(description="[-1, 1] from SMA stack")
    volatility_rank: float = Field(description="Percentile of current vol vs history")
    time_of_day_minutes: int = Field(description="Minutes since market open (0-375)")


class StrategyResponse(BaseModel):
    """Selected strategy with confidence breakdown."""

    strategy: TradingStrategy
    confidence: float = Field(ge=0, le=1)
    alternatives: list[dict[str, float]] = Field(
        description="Other strategies with their probabilities"
    )
    rationale: str


# ─── Risk Prediction ──────────────────────────────────────────────────────────


class RiskRequest(BaseModel):
    """Input for per-trade risk estimation."""

    symbol: str
    direction: str = Field(description="LONG or SHORT")
    entry: float
    stop_loss: float
    target: float
    atr: float
    regime: MarketRegime
    rsi: float
    adx: float
    volume_ratio: float
    vix: float
    time_to_expiry_minutes: Optional[int] = Field(default=None)
    pcr: Optional[float] = Field(default=None)
    oi_buildup_score: Optional[float] = Field(default=None)


class RiskResponse(BaseModel):
    """Risk prediction output."""

    prob_stop_hit: float = Field(ge=0, le=1, description="P(stop loss hit)")
    prob_target_hit: float = Field(ge=0, le=1, description="P(target hit)")
    expected_drawdown_pct: float = Field(description="Expected max drawdown %")
    suggested_position_size_pct: float = Field(description="Optimal position size %")
    risk_score: float = Field(ge=0, le=10, description="Overall risk score 0-10")
    factors: dict[str, float] = Field(description="Risk factor contributions")


# ─── Portfolio Optimization ───────────────────────────────────────────────────


class PortfolioAsset(BaseModel):
    """Single asset for portfolio optimization."""

    symbol: str
    expected_return: float
    risk_score: float
    sector: str
    rank_score: float


class PortfolioRequest(BaseModel):
    """Portfolio optimization request."""

    assets: list[PortfolioAsset]
    max_positions: int = Field(default=10)
    max_sector_weight: float = Field(default=0.4, description="Max weight per sector")
    risk_budget_pct: float = Field(default=2.0, description="Total portfolio risk %")


class PortfolioAllocation(BaseModel):
    """Single asset allocation in the optimized portfolio."""

    symbol: str
    weight: float = Field(ge=0, le=1)
    sector: str
    rationale: str


class PortfolioResponse(BaseModel):
    """Optimized portfolio with allocations."""

    allocations: list[PortfolioAllocation]
    expected_return: float
    portfolio_risk: float
    sharpe_ratio: float
    diversification_ratio: float


# ─── RL Execution ─────────────────────────────────────────────────────────────


class ExecutionAction(str, Enum):
    """RL agent execution actions."""

    ENTER_NOW = "enter_now"
    WAIT = "wait"
    SCALE_IN = "scale_in"
    PARTIAL_EXIT = "partial_exit"
    FULL_EXIT = "full_exit"
    TIGHTEN_STOP = "tighten_stop"
    TRAIL_STOP = "trail_stop"


class ExecutionState(BaseModel):
    """Current trade state for the RL execution agent."""

    symbol: str
    direction: str
    entry: float
    current_price: float
    stop_loss: float
    target: float
    unrealized_pnl_pct: float
    time_in_trade_minutes: int
    regime: MarketRegime
    volume_ratio: float
    price_vs_vwap: float
    atr: float
    momentum: float


class ExecutionDecision(BaseModel):
    """RL agent's execution recommendation."""

    action: ExecutionAction
    confidence: float = Field(ge=0, le=1)
    new_stop_loss: Optional[float] = Field(default=None)
    exit_pct: Optional[float] = Field(default=None, description="% of position to exit")
    rationale: str


# ─── SHAP Explainability ──────────────────────────────────────────────────────


class ExplainRequest(BaseModel):
    """Request explanation for a specific prediction."""

    model: str = Field(description="Model name: regime, ranker, strategy, risk")
    features: dict[str, float] = Field(description="Input features used for prediction")
    prediction: str = Field(description="The prediction that was made")


class FeatureContribution(BaseModel):
    """A single feature's contribution to the prediction."""

    feature: str
    value: float = Field(description="Raw feature value")
    contribution: float = Field(description="SHAP contribution score")
    direction: str = Field(description="positive or negative")


class ExplainResponse(BaseModel):
    """SHAP-based explanation for a prediction."""

    model: str
    prediction: str
    base_value: float
    contributions: list[FeatureContribution]
    total_positive: float
    total_negative: float
    top_drivers: list[str] = Field(description="Top 5 most influential features")
