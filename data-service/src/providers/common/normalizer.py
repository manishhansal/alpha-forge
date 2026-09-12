"""
providers/common/normalizer.py — Data Foundation V8 §14/§15/§17.

Canonical OHLCV normalization types and utilities.

Every provider adapter normalizes its raw response into CanonicalCandle
before any persistence or downstream use. Derived timeframes (e.g. 1m→5m
aggregation) carry sourceTimeframe + derived=True so the signal engine
and ML service can distinguish broker-native from derived data.

ABSOLUTE RULES:
  - Never convert null OI/IV/bid/ask to zero.
  - Never interpolate missing OHLCV.
  - Never silently accept stale or unauthenticated data.
  - Mark volume=0 with volumeUnavailable=True when source didn't supply it.
  - 3m is permanently out of scope — reject at normalization entry.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional


# Supported canonical timeframes. 3m deliberately absent (V8 removal).
SUPPORTED_TIMEFRAMES: frozenset[str] = frozenset({
    "1m", "5m", "10m", "15m", "30m", "1h", "1d", "1w", "1M"
})

# Intraday timeframes (have bars per session).
INTRADAY_TIMEFRAMES: frozenset[str] = frozenset({
    "1m", "5m", "10m", "15m", "30m", "1h"
})

# Historical-only timeframes (not built by live candle builder).
HISTORICAL_ONLY_TIMEFRAMES: frozenset[str] = frozenset({"1w", "1M"})

# NSE intraday bars per full session (09:15–15:30 = 375 min). 3m absent.
BARS_PER_SESSION: dict[str, int] = {
    "1m":  375,
    "5m":  75,
    "10m": 38,   # ceil(375/10)
    "15m": 25,
    "30m": 13,   # ceil(375/30)
    "1h":  7,    # ceil(375/60)
    "1d":  1,
}

# Interval seconds map. 3m absent.
INTERVAL_SECONDS: dict[str, int] = {
    "1m":  60,
    "5m":  300,
    "10m": 600,
    "15m": 900,
    "30m": 1800,
    "1h":  3600,
    "1d":  86400,
    "1w":  604800,
    "1M":  2592000,
}


def validate_interval(interval_str: str) -> None:
    """Raise ValueError if interval_str is not in the canonical supported set."""
    if interval_str == "3m":
        raise ValueError(
            "Interval '3m' was permanently removed from AlphaForge (V8 refactor/signals). "
            "No candle data is acquired, persisted, or served for 3m. "
            "Supported intervals: 1m 5m 10m 15m 30m 1h 1d 1w 1M"
        )
    if interval_str not in SUPPORTED_TIMEFRAMES:
        raise ValueError(
            f"Unsupported interval '{interval_str}'. "
            f"Supported: {sorted(SUPPORTED_TIMEFRAMES)}"
        )


@dataclass
class CanonicalCandle:
    """
    Single canonical OHLCV candle produced by any provider adapter.

    All timestamps are UTC epoch seconds (candle open time, NOT close).
    Prices are in INR (rupees), never paisa.
    Volume is the actual traded volume; 0 with volumeUnavailable=True
    means the source did NOT supply a volume (never a genuine zero-volume bar).
    """
    # Core identification
    instrumentId:    str
    exchange:        str
    intervalStr:     str
    sessionDate:     str             # IST YYYY-MM-DD
    provider:        str

    # Candle open time (UTC epoch seconds)
    time:            int

    # OHLCV (never null — if source doesn't supply, do not create the candle)
    open:            float
    high:            float
    low:             float
    close:           float
    volume:          float           = 0.0
    volumeUnavailable: bool          = False  # True = source didn't supply volume

    # Open interest (derivatives only — null for equity)
    oi:              Optional[float] = None
    oiChange:        Optional[float] = None  # delta vs previous session close

    # Options-specific (null = unavailable, not zero)
    iv:              Optional[float] = None
    bid:             Optional[float] = None
    ask:             Optional[float] = None

    # Derivatives identification
    expiry:          Optional[str]   = None  # ISO-8601 YYYY-MM-DD
    strike:          Optional[float] = None
    optionType:      Optional[str]   = None  # "CE" | "PE"

    # Provenance
    sourceTimestamp: Optional[str]   = None  # provider-declared UTC ISO-8601
    datasetVersion:  Optional[str]   = None

    # Derivation metadata (for aggregated candles)
    derived:         bool            = False
    sourceTimeframe: Optional[str]   = None   # e.g. "1m" if derived from 1m
    aggregationVersion: Optional[str] = None

    def validate(self) -> list[str]:
        """
        Return a list of validation failures (empty = valid).
        Does NOT raise — caller decides what to do with failures.
        """
        errors: list[str] = []

        # Interval check
        if self.intervalStr == "3m":
            errors.append("interval_3m_not_supported: 3m was removed in V8")
        elif self.intervalStr not in SUPPORTED_TIMEFRAMES:
            errors.append(f"unsupported_interval: {self.intervalStr!r}")

        # OHLC invariants
        if self.open <= 0:
            errors.append(f"open_not_positive: {self.open}")
        if self.high <= 0:
            errors.append(f"high_not_positive: {self.high}")
        if self.low <= 0:
            errors.append(f"low_not_positive: {self.low}")
        if self.close <= 0:
            errors.append(f"close_not_positive: {self.close}")
        if self.high < self.open or self.high < self.close:
            errors.append(
                f"high_lt_ohlc: high={self.high} open={self.open} close={self.close}"
            )
        if self.low > self.open or self.low > self.close:
            errors.append(
                f"low_gt_ohlc: low={self.low} open={self.open} close={self.close}"
            )
        if self.high < self.low:
            errors.append(f"high_lt_low: high={self.high} low={self.low}")

        # Volume
        if not self.volumeUnavailable and self.volume < 0:
            errors.append(f"negative_volume: {self.volume}")

        # OI (never null→0)
        if self.oi is not None and self.oi < 0:
            errors.append(f"negative_oi: {self.oi}")

        # IV (if present, should be positive and reasonable)
        if self.iv is not None and self.iv < 0:
            errors.append(f"negative_iv: {self.iv}")

        # Timestamp sanity
        if self.time <= 0:
            errors.append(f"invalid_timestamp: {self.time}")

        # Future candle detection (> 5 minutes in the future is suspicious)
        import time as _time
        now_sec = int(_time.time())
        if self.time > now_sec + 300:
            errors.append(f"future_candle: time={self.time} now={now_sec}")

        # Options field consistency
        if self.optionType is not None and self.optionType not in ("CE", "PE"):
            errors.append(f"invalid_option_type: {self.optionType!r}")

        # Derived field consistency
        if self.derived and self.sourceTimeframe is None:
            errors.append("derived_candle_missing_sourceTimeframe")

        return errors

    @property
    def is_valid(self) -> bool:
        return len(self.validate()) == 0


def validate_batch(
    candles: list[CanonicalCandle],
) -> tuple[list[CanonicalCandle], list[dict]]:
    """
    Validate a batch of candles.

    Returns
    -------
    valid : list[CanonicalCandle]
        Candles that passed all validation rules.
    dropped : list[dict]
        Records for each dropped candle (time, errors) for audit.
    """
    valid: list[CanonicalCandle] = []
    dropped: list[dict] = []
    for c in candles:
        errors = c.validate()
        if errors:
            dropped.append({"time": c.time, "instrumentId": c.instrumentId, "errors": errors})
        else:
            valid.append(c)
    return valid, dropped
