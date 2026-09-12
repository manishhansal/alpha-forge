"""
providers/common/registry.py — Data Foundation V8 §7.

ONE authoritative provider capability registry for the Python data-service.
Mirrors the TypeScript provider-capability-matrix.ts but is the Python-layer
source of truth for dataset-specific routing in the acquisition pipeline.

Key design decisions
--------------------
- Capabilities are EXPLICITLY declared per (provider, dataset, instrumentType,
  timeframe). No guessing, no silent defaults.
- "authenticated" means broker-API credentials are required AND presented.
  Open-source NSE-derived data (jugaad, openchart) is NEVER marked authenticated
  even though it can be highly trustworthy.
- dataTrustStatus and authenticationStatus are DISTINCT fields.
- NEVER use a linear fallback chain for everything. Use dataset-specific routing.
- 3m is deliberately absent from all capability declarations (V8 removal).

Supported timeframes: 1m 5m 10m 15m 30m 1h 1d 1w 1M
3m: NOT SUPPORTED — permanently removed from AlphaForge scope.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Optional


# ---------------------------------------------------------------------------
# Enumerations
# ---------------------------------------------------------------------------

class ProviderRole(str, Enum):
    """High-level role classification of a market data provider."""
    LIVE_BROKER          = "LIVE_BROKER"           # authenticated, live + historical
    HISTORICAL_OSS       = "HISTORICAL_OSS"        # open-source, historical only
    FALLBACK             = "FALLBACK"              # last-resort, restricted use


class DatasetType(str, Enum):
    """The type of dataset a capability entry covers."""
    LIVE_QUOTE           = "LIVE_QUOTE"
    LIVE_TICK            = "LIVE_TICK"
    INTRADAY_OHLCV       = "INTRADAY_OHLCV"
    EOD_OHLCV            = "EOD_OHLCV"
    FNO_EOD              = "FNO_EOD"               # F&O derivatives EOD bhavcopy
    OPTION_CHAIN         = "OPTION_CHAIN"
    INSTRUMENT_MASTER    = "INSTRUMENT_MASTER"


class InstrumentClass(str, Enum):
    """Instrument classification."""
    EQUITY   = "EQUITY"
    INDEX    = "INDEX"
    FUTURES  = "FUTURES"
    OPTIONS  = "OPTIONS"
    ALL      = "ALL"


class ReliabilityClass(str, Enum):
    """Provider reliability classification."""
    BROKER_AUTHENTICATED    = "BROKER_AUTHENTICATED"
    NSE_EXCHANGE_DERIVED    = "NSE_EXCHANGE_DERIVED"
    NSE_CHART_DERIVED       = "NSE_CHART_DERIVED"
    AGGREGATED_DELAYED      = "AGGREGATED_DELAYED"
    UNKNOWN                 = "UNKNOWN"


# ---------------------------------------------------------------------------
# Capability record
# ---------------------------------------------------------------------------

# Supported canonical timeframes (3m deliberately absent — V8 removal).
SUPPORTED_TIMEFRAMES: frozenset[str] = frozenset({
    "1m", "5m", "10m", "15m", "30m", "1h", "1d", "1w", "1M"
})


@dataclass(frozen=True)
class ProviderCapability:
    """
    One capability entry for a (provider, dataset, instrumentClass, timeframe).
    Every field is explicit — None means the field does not apply, NOT unknown.
    """
    provider:              str
    dataset:               DatasetType
    instrumentClass:       InstrumentClass
    timeframe:             Optional[str]        # None for non-candle datasets
    historical:            bool
    realtime:              bool
    authenticated:         bool
    requiresCredentials:   bool
    maximumRangeDays:      Optional[int]        # max historical window per request
    requestsPerSecond:     float
    supportsOI:            bool = False
    supportsIV:            bool = False
    supportsBidAsk:        bool = False
    supportsWebsocket:     bool = False
    provenanceStrength:    ReliabilityClass = ReliabilityClass.UNKNOWN
    notes:                 str = ""

    def __post_init__(self) -> None:
        if self.timeframe is not None and self.timeframe not in SUPPORTED_TIMEFRAMES:
            raise ValueError(
                f"Unsupported timeframe '{self.timeframe}' in capability for provider "
                f"'{self.provider}'. Supported: {sorted(SUPPORTED_TIMEFRAMES)}. "
                f"Note: '3m' was permanently removed (V8)."
            )


# ---------------------------------------------------------------------------
# The canonical registry
# ---------------------------------------------------------------------------

_REGISTRY: list[ProviderCapability] = [

    # ── ANGEL ONE (SmartAPI) ────────────────────────────────────────────────
    # Verified live 2026-09-12: no 3m, no index history, ~3 req/s.
    ProviderCapability(
        provider="angel_one", dataset=DatasetType.INTRADAY_OHLCV,
        instrumentClass=InstrumentClass.EQUITY, timeframe="1m",
        historical=True, realtime=True, authenticated=True,
        requiresCredentials=True, maximumRangeDays=30, requestsPerSecond=3.0,
        provenanceStrength=ReliabilityClass.BROKER_AUTHENTICATED,
        notes="Angel SmartAPI: 1m equities, max 30d per request.",
    ),
    ProviderCapability(
        provider="angel_one", dataset=DatasetType.INTRADAY_OHLCV,
        instrumentClass=InstrumentClass.EQUITY, timeframe="5m",
        historical=True, realtime=True, authenticated=True,
        requiresCredentials=True, maximumRangeDays=90, requestsPerSecond=3.0,
        provenanceStrength=ReliabilityClass.BROKER_AUTHENTICATED,
    ),
    ProviderCapability(
        provider="angel_one", dataset=DatasetType.INTRADAY_OHLCV,
        instrumentClass=InstrumentClass.EQUITY, timeframe="15m",
        historical=True, realtime=True, authenticated=True,
        requiresCredentials=True, maximumRangeDays=180, requestsPerSecond=3.0,
        provenanceStrength=ReliabilityClass.BROKER_AUTHENTICATED,
    ),
    ProviderCapability(
        provider="angel_one", dataset=DatasetType.INTRADAY_OHLCV,
        instrumentClass=InstrumentClass.EQUITY, timeframe="30m",
        historical=True, realtime=True, authenticated=True,
        requiresCredentials=True, maximumRangeDays=180, requestsPerSecond=3.0,
        provenanceStrength=ReliabilityClass.BROKER_AUTHENTICATED,
    ),
    ProviderCapability(
        provider="angel_one", dataset=DatasetType.INTRADAY_OHLCV,
        instrumentClass=InstrumentClass.EQUITY, timeframe="1h",
        historical=True, realtime=True, authenticated=True,
        requiresCredentials=True, maximumRangeDays=365, requestsPerSecond=3.0,
        provenanceStrength=ReliabilityClass.BROKER_AUTHENTICATED,
    ),
    ProviderCapability(
        provider="angel_one", dataset=DatasetType.EOD_OHLCV,
        instrumentClass=InstrumentClass.EQUITY, timeframe="1d",
        historical=True, realtime=True, authenticated=True,
        requiresCredentials=True, maximumRangeDays=2000, requestsPerSecond=3.0,
        provenanceStrength=ReliabilityClass.BROKER_AUTHENTICATED,
    ),
    ProviderCapability(
        provider="angel_one", dataset=DatasetType.OPTION_CHAIN,
        instrumentClass=InstrumentClass.OPTIONS, timeframe=None,
        historical=False, realtime=True, authenticated=True,
        requiresCredentials=True, maximumRangeDays=None, requestsPerSecond=2.0,
        supportsOI=True, supportsIV=True, supportsBidAsk=True,
        provenanceStrength=ReliabilityClass.BROKER_AUTHENTICATED,
        notes="optionGreek endpoint. IV/bid/ask NULL off market hours.",
    ),
    ProviderCapability(
        provider="angel_one", dataset=DatasetType.INSTRUMENT_MASTER,
        instrumentClass=InstrumentClass.ALL, timeframe=None,
        historical=False, realtime=True, authenticated=True,
        requiresCredentials=True, maximumRangeDays=None, requestsPerSecond=1.0,
        provenanceStrength=ReliabilityClass.BROKER_AUTHENTICATED,
    ),

    # ── UPSTOX V3 ──────────────────────────────────────────────────────────
    # Serves both equities and indices. 1m capped to ~7d per request.
    ProviderCapability(
        provider="upstox", dataset=DatasetType.INTRADAY_OHLCV,
        instrumentClass=InstrumentClass.ALL, timeframe="1m",
        historical=True, realtime=True, authenticated=True,
        requiresCredentials=True, maximumRangeDays=7, requestsPerSecond=5.0,
        provenanceStrength=ReliabilityClass.BROKER_AUTHENTICATED,
        notes="Upstox V3: 1m capped to 7d window to avoid HTTP 400.",
    ),
    ProviderCapability(
        provider="upstox", dataset=DatasetType.INTRADAY_OHLCV,
        instrumentClass=InstrumentClass.ALL, timeframe="5m",
        historical=True, realtime=True, authenticated=True,
        requiresCredentials=True, maximumRangeDays=30, requestsPerSecond=5.0,
        provenanceStrength=ReliabilityClass.BROKER_AUTHENTICATED,
    ),
    ProviderCapability(
        provider="upstox", dataset=DatasetType.INTRADAY_OHLCV,
        instrumentClass=InstrumentClass.ALL, timeframe="15m",
        historical=True, realtime=True, authenticated=True,
        requiresCredentials=True, maximumRangeDays=90, requestsPerSecond=5.0,
        provenanceStrength=ReliabilityClass.BROKER_AUTHENTICATED,
    ),
    ProviderCapability(
        provider="upstox", dataset=DatasetType.INTRADAY_OHLCV,
        instrumentClass=InstrumentClass.ALL, timeframe="30m",
        historical=True, realtime=True, authenticated=True,
        requiresCredentials=True, maximumRangeDays=90, requestsPerSecond=5.0,
        provenanceStrength=ReliabilityClass.BROKER_AUTHENTICATED,
    ),
    ProviderCapability(
        provider="upstox", dataset=DatasetType.INTRADAY_OHLCV,
        instrumentClass=InstrumentClass.ALL, timeframe="1h",
        historical=True, realtime=True, authenticated=True,
        requiresCredentials=True, maximumRangeDays=180, requestsPerSecond=5.0,
        provenanceStrength=ReliabilityClass.BROKER_AUTHENTICATED,
    ),
    ProviderCapability(
        provider="upstox", dataset=DatasetType.EOD_OHLCV,
        instrumentClass=InstrumentClass.ALL, timeframe="1d",
        historical=True, realtime=True, authenticated=True,
        requiresCredentials=True, maximumRangeDays=2000, requestsPerSecond=5.0,
        provenanceStrength=ReliabilityClass.BROKER_AUTHENTICATED,
    ),

    # ── JUGAAD-DATA (NSE bhavcopy) ──────────────────────────────────────────
    # Open-source. Historical EOD only. F&O bhavcopy includes OI and derivatives.
    # No intraday. No live. No credentials required.
    # Handles both UDiff (≥ 2024-07-08) and legacy BHAVDATA-FULL formats.
    ProviderCapability(
        provider="jugaad", dataset=DatasetType.EOD_OHLCV,
        instrumentClass=InstrumentClass.EQUITY, timeframe="1d",
        historical=True, realtime=False, authenticated=False,
        requiresCredentials=False, maximumRangeDays=365, requestsPerSecond=1.0,
        provenanceStrength=ReliabilityClass.NSE_EXCHANGE_DERIVED,
        notes="jugaad-data: equity bhavcopy (BHAVDATA-FULL / UDiff). "
              "All NSE-listed equities per session date.",
    ),
    ProviderCapability(
        provider="jugaad", dataset=DatasetType.FNO_EOD,
        instrumentClass=InstrumentClass.FUTURES, timeframe="1d",
        historical=True, realtime=False, authenticated=False,
        requiresCredentials=False, maximumRangeDays=365, requestsPerSecond=1.0,
        supportsOI=True,
        provenanceStrength=ReliabilityClass.NSE_EXCHANGE_DERIVED,
        notes="jugaad-data: F&O bhavcopy. Includes FUTSTK/FUTIDX with OI.",
    ),
    ProviderCapability(
        provider="jugaad", dataset=DatasetType.FNO_EOD,
        instrumentClass=InstrumentClass.OPTIONS, timeframe="1d",
        historical=True, realtime=False, authenticated=False,
        requiresCredentials=False, maximumRangeDays=365, requestsPerSecond=1.0,
        supportsOI=True,
        provenanceStrength=ReliabilityClass.NSE_EXCHANGE_DERIVED,
        notes="jugaad-data: F&O bhavcopy. OPTSTK/OPTIDX with OI.",
    ),

    # ── OPENCHART 0.2.0 ────────────────────────────────────────────────────
    # Open-source, NSE charting platform. Historical OHLCV 1m–1M.
    # No OI, no IV, no bid/ask, no live data. No credentials.
    # Very conservative rate: NSE charting platform — 1 req/s max.
    ProviderCapability(
        provider="openchart", dataset=DatasetType.INTRADAY_OHLCV,
        instrumentClass=InstrumentClass.ALL, timeframe="1m",
        historical=True, realtime=False, authenticated=False,
        requiresCredentials=False, maximumRangeDays=7, requestsPerSecond=1.0,
        provenanceStrength=ReliabilityClass.NSE_CHART_DERIVED,
        notes="openchart 0.2.0: 1m intraday. Window limited by NSE charting platform.",
    ),
    ProviderCapability(
        provider="openchart", dataset=DatasetType.INTRADAY_OHLCV,
        instrumentClass=InstrumentClass.ALL, timeframe="5m",
        historical=True, realtime=False, authenticated=False,
        requiresCredentials=False, maximumRangeDays=30, requestsPerSecond=1.0,
        provenanceStrength=ReliabilityClass.NSE_CHART_DERIVED,
    ),
    ProviderCapability(
        provider="openchart", dataset=DatasetType.INTRADAY_OHLCV,
        instrumentClass=InstrumentClass.ALL, timeframe="10m",
        historical=True, realtime=False, authenticated=False,
        requiresCredentials=False, maximumRangeDays=60, requestsPerSecond=1.0,
        provenanceStrength=ReliabilityClass.NSE_CHART_DERIVED,
    ),
    ProviderCapability(
        provider="openchart", dataset=DatasetType.INTRADAY_OHLCV,
        instrumentClass=InstrumentClass.ALL, timeframe="15m",
        historical=True, realtime=False, authenticated=False,
        requiresCredentials=False, maximumRangeDays=90, requestsPerSecond=1.0,
        provenanceStrength=ReliabilityClass.NSE_CHART_DERIVED,
    ),
    ProviderCapability(
        provider="openchart", dataset=DatasetType.INTRADAY_OHLCV,
        instrumentClass=InstrumentClass.ALL, timeframe="30m",
        historical=True, realtime=False, authenticated=False,
        requiresCredentials=False, maximumRangeDays=90, requestsPerSecond=1.0,
        provenanceStrength=ReliabilityClass.NSE_CHART_DERIVED,
    ),
    ProviderCapability(
        provider="openchart", dataset=DatasetType.INTRADAY_OHLCV,
        instrumentClass=InstrumentClass.ALL, timeframe="1h",
        historical=True, realtime=False, authenticated=False,
        requiresCredentials=False, maximumRangeDays=180, requestsPerSecond=1.0,
        provenanceStrength=ReliabilityClass.NSE_CHART_DERIVED,
    ),
    ProviderCapability(
        provider="openchart", dataset=DatasetType.EOD_OHLCV,
        instrumentClass=InstrumentClass.ALL, timeframe="1d",
        historical=True, realtime=False, authenticated=False,
        requiresCredentials=False, maximumRangeDays=2000, requestsPerSecond=1.0,
        provenanceStrength=ReliabilityClass.NSE_CHART_DERIVED,
        notes="openchart 0.2.0: daily OHLCV for equity/index/F&O.",
    ),
    ProviderCapability(
        provider="openchart", dataset=DatasetType.EOD_OHLCV,
        instrumentClass=InstrumentClass.ALL, timeframe="1w",
        historical=True, realtime=False, authenticated=False,
        requiresCredentials=False, maximumRangeDays=2000, requestsPerSecond=1.0,
        provenanceStrength=ReliabilityClass.NSE_CHART_DERIVED,
    ),
    ProviderCapability(
        provider="openchart", dataset=DatasetType.EOD_OHLCV,
        instrumentClass=InstrumentClass.ALL, timeframe="1M",
        historical=True, realtime=False, authenticated=False,
        requiresCredentials=False, maximumRangeDays=2000, requestsPerSecond=1.0,
        provenanceStrength=ReliabilityClass.NSE_CHART_DERIVED,
    ),

    # ── YAHOO FINANCE (last-resort fallback) ────────────────────────────────
    # Restricted: NEVER for options/OI/IV. Delayed. Equity only.
    ProviderCapability(
        provider="yahoo", dataset=DatasetType.INTRADAY_OHLCV,
        instrumentClass=InstrumentClass.EQUITY, timeframe="5m",
        historical=True, realtime=True, authenticated=False,
        requiresCredentials=False, maximumRangeDays=60, requestsPerSecond=2.0,
        provenanceStrength=ReliabilityClass.AGGREGATED_DELAYED,
        notes="Yahoo Finance fallback. Coarse, delayed. NEVER for F&O/OI/IV.",
    ),
    ProviderCapability(
        provider="yahoo", dataset=DatasetType.EOD_OHLCV,
        instrumentClass=InstrumentClass.EQUITY, timeframe="1d",
        historical=True, realtime=True, authenticated=False,
        requiresCredentials=False, maximumRangeDays=2000, requestsPerSecond=2.0,
        provenanceStrength=ReliabilityClass.AGGREGATED_DELAYED,
    ),
]


# ---------------------------------------------------------------------------
# Registry query helpers
# ---------------------------------------------------------------------------

def capabilities_for(
    provider: str,
    dataset: Optional[DatasetType] = None,
    timeframe: Optional[str] = None,
    instrument_class: Optional[InstrumentClass] = None,
) -> list[ProviderCapability]:
    """Return all matching capability entries."""
    result = [c for c in _REGISTRY if c.provider == provider]
    if dataset is not None:
        result = [c for c in result if c.dataset == dataset]
    if timeframe is not None:
        result = [c for c in result if c.timeframe == timeframe]
    if instrument_class is not None:
        result = [
            c for c in result
            if c.instrumentClass in (instrument_class, InstrumentClass.ALL)
        ]
    return result


def providers_for_dataset(
    dataset: DatasetType,
    timeframe: Optional[str] = None,
    instrument_class: Optional[InstrumentClass] = None,
    historical_only: bool = False,
    realtime_only: bool = False,
) -> list[str]:
    """
    Return provider names that can serve a dataset, in registry order.
    Raises ValueError if a 3m timeframe is requested.
    """
    if timeframe == "3m":
        raise ValueError(
            "Timeframe '3m' was permanently removed from AlphaForge (V8). "
            "No provider serves 3m data. Supported: 1m 5m 10m 15m 30m 1h 1d 1w 1M."
        )
    if timeframe is not None and timeframe not in SUPPORTED_TIMEFRAMES:
        raise ValueError(
            f"Unsupported timeframe '{timeframe}'. "
            f"Supported: {sorted(SUPPORTED_TIMEFRAMES)}"
        )

    result = []
    seen: set[str] = set()
    for cap in _REGISTRY:
        if cap.provider in seen:
            continue
        if cap.dataset != dataset:
            continue
        if timeframe is not None and cap.timeframe != timeframe:
            continue
        if instrument_class is not None and cap.instrumentClass not in (
            instrument_class, InstrumentClass.ALL
        ):
            continue
        if historical_only and not cap.historical:
            continue
        if realtime_only and not cap.realtime:
            continue
        result.append(cap.provider)
        seen.add(cap.provider)
    return result


def max_range_days(provider: str, timeframe: str) -> Optional[int]:
    """Return the maximum historical request window for a provider+timeframe."""
    caps = [
        c for c in _REGISTRY
        if c.provider == provider and c.timeframe == timeframe and c.historical
    ]
    if not caps:
        return None
    return min(c.maximumRangeDays for c in caps if c.maximumRangeDays is not None)


def requests_per_second(provider: str) -> float:
    """Return the conservative sustained request budget for a provider."""
    caps = [c for c in _REGISTRY if c.provider == provider]
    if not caps:
        return 1.0
    return min(c.requestsPerSecond for c in caps)


def is_authenticated_provider(provider: str) -> bool:
    """True when ANY capability for this provider requires credentials."""
    return any(c.requiresCredentials for c in _REGISTRY if c.provider == provider)
