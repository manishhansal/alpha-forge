"""
Data Freshness Engine — Phase 6.

Classifies the freshness of market data observations.
Thresholds are instrument-specific, data-type-specific, and session-aware.

Usage:
    from src.engines.freshness_engine import freshness_engine
    cls = freshness_engine.classify_quote(age_ms, symbol="NIFTY", in_session=True)
"""

from __future__ import annotations

from src.core.schemas_v2 import FreshnessClass
from src.engines.timestamp_engine import ts_engine


# ---------------------------------------------------------------------------
# Freshness thresholds (milliseconds)
# ---------------------------------------------------------------------------
# These are tiered by instrument type and session phase.
# During regular session thresholds are tighter; pre/post market looser.

# Quote freshness thresholds by tier (ms)
_QUOTE_THRESHOLDS: dict[str, dict[str, int]] = {
    "INDEX": {
        "FRESH": 10_000,    # < 10s
        "AGING": 30_000,    # 10–30s
        "STALE": 60_000,    # 30–60s
        "EXPIRED": 300_000, # > 5m
    },
    "FNO_LIQUID": {
        "FRESH": 10_000,
        "AGING": 30_000,
        "STALE": 60_000,
        "EXPIRED": 300_000,
    },
    "FNO_NORMAL": {
        "FRESH": 15_000,
        "AGING": 60_000,
        "STALE": 120_000,
        "EXPIRED": 600_000,
    },
    "EQUITY": {
        "FRESH": 30_000,
        "AGING": 120_000,
        "STALE": 300_000,
        "EXPIRED": 1_800_000,
    },
    "OFFMARKET": {   # Pre-open, post-market
        "FRESH": 300_000,
        "AGING": 1_800_000,
        "STALE": 7_200_000,
        "EXPIRED": 86_400_000,
    },
}

# Option chain snapshot thresholds (ms)
_OPTION_CHAIN_THRESHOLDS: dict[str, int] = {
    "FRESH": 30_000,     # < 30s
    "AGING": 120_000,    # 30s–2m
    "STALE": 300_000,    # 2–5m
    "EXPIRED": 900_000,  # > 15m
}

# Candle freshness: how stale can the last closed candle be (ms)
_CANDLE_THRESHOLDS: dict[str, dict[str, int]] = {
    "1m":  {"FRESH": 90_000,  "AGING": 180_000,  "STALE": 300_000,  "EXPIRED": 600_000},
    "3m":  {"FRESH": 210_000, "AGING": 360_000,  "STALE": 600_000,  "EXPIRED": 900_000},
    "5m":  {"FRESH": 360_000, "AGING": 600_000,  "STALE": 900_000,  "EXPIRED": 1_800_000},
    "15m": {"FRESH": 960_000, "AGING": 1_800_000, "STALE": 3_600_000, "EXPIRED": 7_200_000},
    "30m": {"FRESH": 1_860_000, "AGING": 3_600_000, "STALE": 7_200_000, "EXPIRED": 14_400_000},
    "1h":  {"FRESH": 3_660_000, "AGING": 7_200_000, "STALE": 14_400_000, "EXPIRED": 28_800_000},
    "1d":  {"FRESH": 86_400_000, "AGING": 172_800_000, "STALE": 604_800_000, "EXPIRED": 2_592_000_000},
}

# Instrument master freshness (24h is fine)
_INSTRUMENT_MASTER_MAX_AGE_MS: int = 24 * 3600 * 1000

# Index symbols — highest priority
_INDEX_SYMBOLS: frozenset[str] = frozenset({
    "NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY",
    "NIFTY50", "NIFTYBANK", "SENSEX", "BANKEX", "NIFTNXT50",
})

# Liquid F&O stocks — tier 2
_LIQUID_FNO: frozenset[str] = frozenset({
    "RELIANCE", "HDFCBANK", "ICICIBANK", "TCS", "INFY",
    "AXISBANK", "SBIN", "WIPRO", "BAJFINANCE", "LT",
    "KOTAKBANK", "HCLTECH", "MARUTI", "ASIANPAINT", "TITAN",
})


def _classify_by_thresholds(age_ms: int, thresholds: dict[str, int]) -> FreshnessClass:
    """Classify an age against a threshold dict with FRESH/AGING/STALE/EXPIRED keys."""
    if age_ms < 0:
        return FreshnessClass.UNKNOWN
    if age_ms <= thresholds["FRESH"]:
        return FreshnessClass.FRESH
    if age_ms <= thresholds["AGING"]:
        return FreshnessClass.AGING
    if age_ms <= thresholds["STALE"]:
        return FreshnessClass.STALE
    return FreshnessClass.EXPIRED


def _instrument_tier(symbol: str) -> str:
    """Return the instrument tier for freshness classification."""
    sym = symbol.upper()
    if sym in _INDEX_SYMBOLS:
        return "INDEX"
    if sym in _LIQUID_FNO:
        return "FNO_LIQUID"
    return "FNO_NORMAL"


class DataFreshnessEngine:
    """Classifies data freshness for quotes, ticks, candles, and option chains."""

    def classify_quote(
        self,
        age_ms: int,
        symbol: str = "",
        in_session: bool = True,
    ) -> FreshnessClass:
        """Classify the freshness of a live quote.

        Args:
            age_ms: Age of the quote in milliseconds.
            symbol: Instrument symbol (used for tier selection).
            in_session: Whether we are within NSE regular session.
        """
        if not in_session:
            tier = "OFFMARKET"
        else:
            tier = _instrument_tier(symbol)
        return _classify_by_thresholds(age_ms, _QUOTE_THRESHOLDS[tier])

    def classify_tick(self, age_ms: int, symbol: str = "") -> FreshnessClass:
        """Classify the freshness of a tick."""
        # Ticks use same logic as quotes
        return self.classify_quote(age_ms, symbol, in_session=True)

    def classify_candle(self, age_ms: int, interval: str = "1m") -> FreshnessClass:
        """Classify the freshness of a candle."""
        thresholds = _CANDLE_THRESHOLDS.get(interval, _CANDLE_THRESHOLDS["1m"])
        return _classify_by_thresholds(age_ms, thresholds)

    def classify_option_chain(self, age_ms: int) -> FreshnessClass:
        """Classify the freshness of an option chain snapshot."""
        return _classify_by_thresholds(age_ms, _OPTION_CHAIN_THRESHOLDS)

    def classify_instrument_master(self, age_ms: int) -> FreshnessClass:
        """Classify the freshness of the instrument master."""
        if age_ms < _INSTRUMENT_MASTER_MAX_AGE_MS:
            return FreshnessClass.FRESH
        if age_ms < _INSTRUMENT_MASTER_MAX_AGE_MS * 2:
            return FreshnessClass.AGING
        if age_ms < _INSTRUMENT_MASTER_MAX_AGE_MS * 7:
            return FreshnessClass.STALE
        return FreshnessClass.EXPIRED

    def quote_age_ms(self, fetched_at_ms: int) -> int:
        """Compute quote age in milliseconds from a fetched_at timestamp."""
        return ts_engine.age_ms(fetched_at_ms)

    def is_stale_for_signal(
        self,
        age_ms: int,
        symbol: str = "",
        strategy_max_age_ms: int = 10_000,
    ) -> bool:
        """Return True when data is too stale for safe signal generation."""
        return age_ms > strategy_max_age_ms

    def freshness_summary(
        self,
        quote_age_ms: int,
        option_chain_age_ms: int,
        candle_age_ms: int,
        symbol: str = "",
    ) -> dict:
        """Return a summary dict of freshness classifications."""
        return {
            "quote": self.classify_quote(quote_age_ms, symbol).value,
            "optionChain": self.classify_option_chain(option_chain_age_ms).value,
            "candle": self.classify_candle(candle_age_ms).value,
            "quoteAgeMs": quote_age_ms,
            "optionChainAgeMs": option_chain_age_ms,
            "candleAgeMs": candle_age_ms,
        }


# ---------------------------------------------------------------------------
# Module-level singleton
# ---------------------------------------------------------------------------

freshness_engine = DataFreshnessEngine()
