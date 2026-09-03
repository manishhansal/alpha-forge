"""
Canonical V2 Pydantic schemas for data-service.

These schemas implement the point-in-time data model required by AlphaForge's
quant engine. Every market observation must be traceable from source to signal.

Key design principles
---------------------
- Every datum carries eventTime / receivedAt / availableAt.
- Null fields are explicitly null — never silently converted to zero.
- Every observation carries a dataObservationId for lineage tracing.
- Quality and confidence are first-class fields, not afterthoughts.
- Semantic integrity: OI is never mapped from tradedValue.

Timestamp conventions
---------------------
- All internal timestamps are UTC milliseconds (int) for precision.
- ISO-8601 strings with Z suffix for human-readable fields.
- IST interpretation only inside MarketSessionEngine.

Version: 2.0.0
"""

from __future__ import annotations

import hashlib
import time
import uuid
from datetime import datetime, timezone
from enum import Enum
from typing import Annotated, Literal, Optional

from pydantic import BaseModel, Field, model_validator


# ---------------------------------------------------------------------------
# Helpers — defined FIRST so they can be used as default_factory throughout
# ---------------------------------------------------------------------------


def _utc_now_iso() -> str:
    """Return current UTC time as ISO 8601 with Z suffix."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


# ---------------------------------------------------------------------------
# Enumerations
# ---------------------------------------------------------------------------


class DataQuality(str, Enum):
    """Quality classification for a market data observation."""
    VALID = "VALID"
    DEGRADED = "DEGRADED"
    STALE = "STALE"
    INVALID = "INVALID"
    UNKNOWN = "UNKNOWN"
    PARTIAL = "PARTIAL"


class FreshnessClass(str, Enum):
    """Age classification of a market data observation."""
    FRESH = "FRESH"
    AGING = "AGING"
    STALE = "STALE"
    EXPIRED = "EXPIRED"
    UNKNOWN = "UNKNOWN"


class CandleState(str, Enum):
    """Lifecycle state of a candle bar."""
    OPEN = "OPEN"
    PARTIAL = "PARTIAL"
    CLOSED = "CLOSED"


class DeliverySemantics(str, Enum):
    """Transport delivery guarantee declaration."""
    AT_LEAST_ONCE = "AT_LEAST_ONCE"
    AT_MOST_ONCE = "AT_MOST_ONCE"
    EXACTLY_ONCE = "EXACTLY_ONCE"


class MetricTag(str, Enum):
    """Tag classifying the provenance of a computed analytics value."""
    OBSERVED = "OBSERVED"      # directly from exchange feed
    DERIVED = "DERIVED"        # computed from observed values
    MODELLED = "MODELLED"      # from a pricing model


class DataSource(str, Enum):
    """Canonical data source identifiers."""
    NSE_NEXTAPI = "NSE_NEXTAPI"
    NSE_XHR = "NSE_XHR"
    NSE_BHAVCOPY = "NSE_BHAVCOPY"
    NSE_CHARTING = "NSE_CHARTING"
    NSE_ARCHIVES = "NSE_ARCHIVES"
    BSE_XHR = "BSE_XHR"
    BSE_BHAVCOPY = "BSE_BHAVCOPY"
    BSE_CHARTING = "BSE_CHARTING"
    BROKER_ANGEL = "BROKER_ANGEL"
    BROKER_UPSTOX = "BROKER_UPSTOX"
    YAHOO_FINANCE = "YAHOO_FINANCE"
    CACHE = "CACHE"
    REPLAY = "REPLAY"
    GOLDEN_DATASET = "GOLDEN_DATASET"
    UNKNOWN = "UNKNOWN"


# ---------------------------------------------------------------------------
# Provenance — attached to every important observation
# ---------------------------------------------------------------------------


class DataProvenance(BaseModel):
    """Lineage record for a single market data observation.

    Answers: where did it come from, when was it observed, when received,
    when available, what normalization applied.
    """
    dataObservationId: str = Field(
        default_factory=lambda: str(uuid.uuid4()),
        description="Unique observation ID for lineage tracing."
    )
    source: DataSource = DataSource.UNKNOWN
    sourceVersion: str = "unknown"

    # Timestamps (UTC milliseconds)
    eventTimeMs: Optional[int] = Field(
        None,
        description="When the market event occurred (exchange time, UTC ms)."
    )
    receivedAtMs: int = Field(
        default_factory=lambda: int(time.time() * 1000),
        description="When AlphaForge received this datum (UTC ms)."
    )
    availableAtMs: int = Field(
        default_factory=lambda: int(time.time() * 1000),
        description="When downstream consumers may use this datum (UTC ms)."
    )

    # Normalization trace
    normalizationVersion: str = "2.0.0"
    validationApplied: bool = False
    isFallback: bool = Field(
        False,
        description="True when this observation came from a fallback/stale source."
    )
    fallbackReason: Optional[str] = None


# ---------------------------------------------------------------------------
# Data Quality Gate — consumed by signal engine
# ---------------------------------------------------------------------------


class DataQualityGate(BaseModel):
    """Signal-engine safety contract.

    The signal engine MUST check this before generating a signal.
    All gates must be True for SIGNAL_ENGINE_ALLOWED = True.
    """
    dataFresh: bool = False
    dataComplete: bool = False
    dataTimestampValid: bool = False
    dataProviderHealthy: bool = False
    dataSemanticallyValid: bool = False
    signalEngineAllowed: bool = False

    quoteAgeMs: Optional[int] = None
    confidenceScore: int = 0  # 0-100
    quality: DataQuality = DataQuality.UNKNOWN

    blockReason: Optional[str] = None

    @model_validator(mode="after")
    def compute_allowed(self) -> "DataQualityGate":
        allowed = (
            self.dataFresh
            and self.dataComplete
            and self.dataTimestampValid
            and self.dataProviderHealthy
            and self.dataSemanticallyValid
        )
        object.__setattr__(self, "signalEngineAllowed", allowed)
        return self


# ---------------------------------------------------------------------------
# MarketQuoteV2
# ---------------------------------------------------------------------------


class MarketQuoteV2(BaseModel):
    """Validated, point-in-time market quote.

    Semantic guarantees:
    - oi = open interest (contracts), never traded value
    - tradedValue = total traded value in INR crores, never OI
    - All missing fields are None, never 0 as a substitute
    - volume is share count, not value
    """
    # Identity
    instrumentId: str = Field(..., description="Canonical instrument ID.")
    symbol: str
    exchange: str
    segment: str = "EQ"  # EQ, FO, CD, etc.

    # Provenance
    provenance: DataProvenance = Field(default_factory=DataProvenance)

    # Price
    ltp: Optional[float] = Field(None, description="Last traded price (INR).")
    open: Optional[float] = None
    high: Optional[float] = None
    low: Optional[float] = None
    prevClose: Optional[float] = None
    change: Optional[float] = None
    changePct: Optional[float] = None
    upperCircuit: Optional[float] = None
    lowerCircuit: Optional[float] = None
    weekHigh52: Optional[float] = None
    weekLow52: Optional[float] = None

    # Volume — SEMANTIC INTEGRITY: these are distinct fields, never interchangeable
    volume: Optional[int] = Field(
        None, description="Traded quantity (number of shares/contracts)."
    )
    tradedValue: Optional[float] = Field(
        None, description="Total traded value in INR (rupees). NEVER mapped to OI."
    )

    # Open Interest — ONLY populated for F&O instruments
    oi: Optional[int] = Field(
        None,
        description=(
            "Open interest in contracts. "
            "Only for F&O. NEVER mapped from tradedValue."
        ),
    )
    oiChange: Optional[int] = Field(
        None, description="Change in OI from previous close."
    )

    # Market depth
    totalBuyQty: Optional[int] = None
    totalSellQty: Optional[int] = None
    lastTradeTime: Optional[str] = None  # UTC ISO-8601

    # Metadata
    name: Optional[str] = None
    token: Optional[str] = None

    # Quality
    quality: DataQuality = DataQuality.UNKNOWN
    freshness: FreshnessClass = FreshnessClass.UNKNOWN
    qualityGate: Optional[DataQualityGate] = None

    # Backward compatibility alias (same field as provenance.source)
    provider: str = "scrapling"
    fetchedAt: str = Field(
        default_factory=lambda: _utc_now_iso(),
        description="UTC ISO-8601 fetch time (backward compat)."
    )


# ---------------------------------------------------------------------------
# LiveTickV2
# ---------------------------------------------------------------------------


class LiveTickV2(BaseModel):
    """Single live price tick with full provenance.

    This is what the tick publisher emits to Redis af:ticks:{symbol}.
    Replaces LiveTick v1 with full point-in-time fields.
    """
    # Identity
    tickId: str = Field(
        default_factory=lambda: str(uuid.uuid4()),
        description="Unique tick ID for deduplication."
    )
    instrumentId: str
    symbol: str
    exchange: str
    segment: str = "EQ"

    # Provenance timestamps (UTC ms)
    eventTimeMs: int = Field(
        description="Exchange event time (UTC ms). Best approximation when not provided."
    )
    receivedAtMs: int = Field(
        default_factory=lambda: int(time.time() * 1000)
    )
    publishedAtMs: Optional[int] = None  # Set by publisher when enqueued

    # Price — SEMANTIC INTEGRITY
    ltp: float
    change: Optional[float] = None
    changePct: Optional[float] = None

    # Volume — explicitly separated from OI
    volume: Optional[int] = None
    tradedValue: Optional[float] = Field(
        None, description="Traded value in INR. NOT open interest."
    )
    oi: Optional[int] = Field(
        None, description="Open interest (F&O only). NOT traded value."
    )
    oiChange: Optional[int] = None

    # Sequence
    sequence: Optional[int] = None

    # Quality
    source: DataSource = DataSource.NSE_NEXTAPI
    quality: DataQuality = DataQuality.UNKNOWN
    isDuplicate: bool = False

    # Backward compat
    token: str = ""
    provider: Literal["scrapling"] = "scrapling"

    def compute_deterministic_id(self) -> str:
        """Compute a deterministic deduplication ID from key fields."""
        key = f"{self.instrumentId}:{self.eventTimeMs}:{self.source}:{self.ltp}:{self.volume}"
        return hashlib.sha256(key.encode()).hexdigest()[:32]


# ---------------------------------------------------------------------------
# CandleV2
# ---------------------------------------------------------------------------


class CandleV2(BaseModel):
    """OHLCV candle with source tracking and validation state.

    Enforces: high >= max(open, close), low <= min(open, close),
    volume >= 0, all prices > 0.
    """
    # Identity
    instrumentId: str
    symbol: str
    exchange: str
    interval: str  # 1m, 3m, 5m, 15m, 30m, 1h, 1d

    # Timestamps (UTC seconds for candle open time, matching existing schema)
    time: int  # UTC epoch seconds (candle open)
    closeTimeMs: Optional[int] = None  # UTC ms when this candle closes/closed

    # OHLCV
    open: float
    high: float
    low: float
    close: float
    volume: int
    tradedValue: Optional[float] = None  # INR — not OI
    oi: Optional[int] = None  # F&O only

    # State
    state: CandleState = CandleState.CLOSED
    isComplete: bool = True

    # Provenance
    source: DataSource = DataSource.UNKNOWN
    sourceInterval: Optional[str] = None  # interval used as source (for derived)
    normalizationVersion: str = "2.0.0"

    # Quality
    quality: DataQuality = DataQuality.UNKNOWN

    @model_validator(mode="after")
    def validate_ohlc_invariants(self) -> "CandleV2":
        """Enforce OHLC integrity constraints."""
        if self.high < max(self.open, self.close):
            raise ValueError(
                f"CandleV2 invariant: high ({self.high}) < max(open={self.open}, close={self.close})"
            )
        if self.low > min(self.open, self.close):
            raise ValueError(
                f"CandleV2 invariant: low ({self.low}) > min(open={self.open}, close={self.close})"
            )
        if self.volume < 0:
            raise ValueError(f"CandleV2 invariant: volume ({self.volume}) < 0")
        if any(p <= 0 for p in (self.open, self.high, self.low, self.close)):
            raise ValueError("CandleV2 invariant: all prices must be > 0")
        return self


# ---------------------------------------------------------------------------
# OptionContractV2
# ---------------------------------------------------------------------------


class OptionContractV2(BaseModel):
    """Single CE/PE contract row within an option chain snapshot.

    SEMANTIC INTEGRITY:
    - oi = open interest in contracts (from NSE openInterest field)
    - oiChange = change in OI (from changeinOpenInterest)
    - volume = traded quantity (from totalTradedVolume)
    - tradedValue = INR traded value (NOT OI)
    - iv may be None — zero IV is never a substitute for missing IV
    """
    token: str
    tradingSymbol: str
    instrumentId: str
    underlying: str
    expiry: str              # ISO-8601 date
    strike: float
    optionType: Literal["CE", "PE"]

    ltp: Optional[float] = None
    bid: Optional[float] = None
    ask: Optional[float] = None

    # SEMANTIC: OI = open interest, volume = quantity traded
    oi: Optional[int] = Field(None, description="Open interest (contracts).")
    oiChange: Optional[int] = Field(None, description="Change in OI.")
    volume: Optional[int] = Field(None, description="Traded quantity.")
    tradedValue: Optional[float] = Field(None, description="Traded value INR. NOT OI.")

    # Greeks — null means unavailable, not zero
    iv: Optional[float] = Field(None, description="Implied volatility %. None if unavailable.")
    delta: Optional[float] = None
    gamma: Optional[float] = None
    theta: Optional[float] = None
    vega: Optional[float] = None
    rho: Optional[float] = None

    # IV quality flag
    ivQuality: Optional[str] = None  # VALID, STALE, SPIKE, MISSING

    fetchedAt: str = Field(default_factory=lambda: _utc_now_iso())


# ---------------------------------------------------------------------------
# OptionChainSnapshotV2
# ---------------------------------------------------------------------------


class OptionChainRowV2(BaseModel):
    """One strike row: may have CE, PE, or both."""
    strike: float
    ce: Optional[OptionContractV2] = None
    pe: Optional[OptionContractV2] = None


class OptionChainCompletenessV2(BaseModel):
    """Completeness assessment of an option chain snapshot."""
    expectedStrikes: int = 0
    actualStrikes: int = 0
    missingCe: int = 0
    missingPe: int = 0
    duplicateStrikes: int = 0
    invalidStrikes: int = 0
    completenessPercent: float = 0.0
    isComplete: bool = False
    quality: DataQuality = DataQuality.UNKNOWN


class OptionChainAnalyticsV2(BaseModel):
    """Computed analytics with explicit source tags."""
    pcrOi: Optional[float] = None
    pcrOiTag: MetricTag = MetricTag.DERIVED
    pcrVolume: Optional[float] = None
    pcrVolumeTag: MetricTag = MetricTag.DERIVED
    maxCeOiStrike: Optional[float] = None
    maxPeOiStrike: Optional[float] = None
    totalCeOi: int = 0
    totalPeOi: int = 0
    totalCeOiChange: int = 0
    totalPeOiChange: int = 0
    atmIv: Optional[float] = None
    atmIvTag: MetricTag = MetricTag.DERIVED
    maxPain: Optional[float] = None
    maxPainTag: MetricTag = MetricTag.DERIVED


class OptionChainSnapshotV2(BaseModel):
    """Full option chain snapshot with complete provenance."""
    # Identity
    underlying: str
    underlyingInstrumentId: str
    exchange: str = "NSE"

    # Spot price — must correspond to snapshot time
    spot: Optional[float] = Field(
        None,
        description="Underlying spot price at snapshot time."
    )
    spotAgeMs: Optional[int] = Field(
        None,
        description="Age of the spot price at snapshot time (ms). If > threshold: CHAIN_QUALITY=DEGRADED."
    )

    # Expiry
    expiry: str            # ISO-8601 selected expiry
    expiries: list[str]    # All available expiries

    # Data
    rows: list[OptionChainRowV2] = []

    # Quality
    completeness: OptionChainCompletenessV2 = Field(
        default_factory=OptionChainCompletenessV2
    )
    analytics: OptionChainAnalyticsV2 = Field(
        default_factory=OptionChainAnalyticsV2
    )
    quality: DataQuality = DataQuality.UNKNOWN

    # Provenance
    provenance: DataProvenance = Field(default_factory=DataProvenance)
    fromCache: bool = False
    snapshotAgeMs: Optional[int] = None

    # Backward compat
    provider: Literal["scrapling"] = "scrapling"
    fetchedAt: str = Field(default_factory=lambda: _utc_now_iso())


# ---------------------------------------------------------------------------
# InstrumentV2
# ---------------------------------------------------------------------------


class InstrumentV2(BaseModel):
    """Full instrument definition with point-in-time validity.

    Tracks activeFrom/activeTo for historical backtest accuracy.
    """
    instrumentId: str  # Canonical internal ID
    token: str         # Exchange/broker token
    tradingSymbol: Annotated[str, Field(max_length=50)]
    displaySymbol: str = ""
    name: Annotated[str, Field(max_length=100)]

    exchange: str      # NSE, BSE, NFO, BFO, MCX
    segment: str       # EQ, FO, CD, COMM
    series: str = ""   # EQ, BE, etc.
    instrumentType: str  # EQ, FUT, CE, PE, ETF, IDX

    # Derivative fields
    underlying: Optional[str] = None
    expiry: str = ""
    strike: float = 0.0
    optionType: str = ""
    lotSize: int = 1
    tickSize: float = 0.05
    contractMultiplier: float = 1.0

    # Identifiers
    isin: Optional[str] = None
    scripCode: Optional[str] = None  # BSE scrip code
    brokerToken: Optional[str] = None  # Broker-specific numeric token

    # Point-in-time validity
    activeFrom: Optional[str] = None  # ISO date
    activeTo: Optional[str] = None    # ISO date (None = currently active)

    # Metadata
    fetchedAt: str = Field(default_factory=lambda: _utc_now_iso())
    sourceVersion: str = "unknown"


# ---------------------------------------------------------------------------
# ProviderHealthV2
# ---------------------------------------------------------------------------


class ProviderHealthV2(BaseModel):
    """Health assessment for a single data provider.

    A provider can be UP but DATA_DEGRADED if it returns stale/partial data.
    """
    provider: str
    status: str = "UNKNOWN"  # UP, DOWN, DEGRADED, UNKNOWN

    # Reliability metrics
    availability: float = 0.0       # 0.0-1.0
    freshness: FreshnessClass = FreshnessClass.UNKNOWN
    latencyP50Ms: Optional[int] = None
    latencyP99Ms: Optional[int] = None
    errorRate: float = 0.0           # 0.0-1.0
    successRate: float = 0.0         # 0.0-1.0

    # Content quality
    completeness: float = 0.0        # 0.0-1.0 fields populated
    semanticIntegrity: bool = True   # no known field mapping errors
    lastSuccessAt: Optional[str] = None
    lastFailureAt: Optional[str] = None
    lastFailureReason: Optional[str] = None

    # Circuit breaker state
    circuitState: str = "CLOSED"  # CLOSED, OPEN, HALF_OPEN

    checkedAt: str = Field(default_factory=_utc_now_iso)


# ---------------------------------------------------------------------------
# DataGapEvent
# ---------------------------------------------------------------------------


class DataGapEvent(BaseModel):
    """Detected gap in a continuous data stream."""
    gapId: str = Field(default_factory=lambda: str(uuid.uuid4()))
    instrumentId: str
    streamType: str  # TICK, CANDLE_1M, OPTION_CHAIN, etc.
    gapStartMs: int
    gapEndMs: int
    gapDurationMs: int
    expectedCount: int
    actualCount: int
    severity: str = "WARN"  # INFO, WARN, CRITICAL
    detectedAt: str = Field(default_factory=_utc_now_iso)


# ---------------------------------------------------------------------------
# DataIncident
# ---------------------------------------------------------------------------


class DataIncident(BaseModel):
    """Record of a data quality incident affecting signals or trades."""
    incidentId: str = Field(default_factory=lambda: str(uuid.uuid4()))
    detectedAt: str = Field(default_factory=_utc_now_iso)
    resolvedAt: Optional[str] = None
    component: str
    instrumentId: Optional[str] = None
    severity: str = "WARN"  # INFO, WARN, CRITICAL
    rootCause: Optional[str] = None
    durationMs: Optional[int] = None
    affectedSignals: list[str] = []
    affectedTrades: list[str] = []
    recovery: Optional[str] = None


# ---------------------------------------------------------------------------
# StrategyDataRequirements
# ---------------------------------------------------------------------------


class StrategyDataRequirements(BaseModel):
    """Data requirements declaration for a trading strategy.

    A strategy is blocked if required data is unavailable or below threshold.
    """
    strategyId: str
    strategyName: str
    requiredDataTypes: list[str]  # PRICE, VOLUME, OI, OPTION_CHAIN, CANDLE, etc.
    minConfidenceScore: int = 60  # 0-100
    maxQuoteAgeMs: int = 10_000   # 10 seconds default
    maxOptionChainAgeMs: int = 60_000
    requiresConfirmedCandle: bool = False
    requiresOI: bool = False
    requiresOptionChain: bool = False
    requiresGreeks: bool = False


# ---------------------------------------------------------------------------
# DataParityContract
# ---------------------------------------------------------------------------


class DataParityContract(BaseModel):
    """Asserts that live, paper, replay and backtest use the same data path."""
    contractVersion: str = "2.0.0"
    liveDataPath: str = "data-service/v2"
    paperDataPath: str = "data-service/v2"
    replayDataPath: str = "data-service/v2/replay"
    backtestDataPath: str = "data-service/v2/backtest"
    parityVerified: bool = False
    lastVerifiedAt: Optional[str] = None


# ---------------------------------------------------------------------------
# End of canonical V2 schemas
# ---------------------------------------------------------------------------
