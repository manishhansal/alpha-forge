"""
Point-in-Time Data Contract for AlphaForge ML Service.

Core principle
--------------
For every ML observation at prediction_time T, the system must prove:

    available_time <= prediction_time

where:
    event_time     = when the market event occurred (exchange time, UTC)
    available_time = when AlphaForge could use this datum (after publication)
    ingestion_time = when the ml-service recorded it (audit trail)

The distinction between event_time and available_time is critical.

Example:
    NSE daily close at 15:30 IST is the event_time.
    The Bhavcopy is published ~16:00 IST — that is the available_time.
    A model prediction at 15:45 IST must NOT use this data because
    available_time (16:00) > prediction_time (15:45).

Timezone semantics
------------------
- ALL timestamps in this module are UTC-aware datetimes.
- NEVER use naive datetimes (datetime without tzinfo).
- Use IST only for human-readable display and NSE session interpretation.
- India Standard Time = Asia/Kolkata = UTC+5:30 (no DST).

NSE session boundaries (UTC):
    Pre-open start:   03:30 UTC  = 09:00 IST
    Session open:     03:45 UTC  = 09:15 IST
    Session close:    10:00 UTC  = 15:30 IST

Data availability delays (typical):
    OHLCV Bhavcopy:   +30 min after close  → available ~10:30 UTC
    OI / Option chain: +30 min after close  → available ~10:30 UTC
    Market breadth:    +90 min after close  → available ~11:30 UTC
    Delivery %:        T+1 morning          → available next day ~04:00 UTC
"""

from __future__ import annotations

import hashlib
import uuid
from dataclasses import dataclass, field
from datetime import date, datetime, timezone, timedelta
from enum import Enum
from typing import Optional
from zoneinfo import ZoneInfo

import structlog

logger = structlog.get_logger(__name__)

# ── Timezone constants ─────────────────────────────────────────────────────────

IST = ZoneInfo("Asia/Kolkata")
UTC = timezone.utc

# NSE session boundaries expressed in UTC
_NSE_OPEN_UTC_H = 3      # 03:45 UTC = 09:15 IST
_NSE_OPEN_UTC_M = 45
_NSE_CLOSE_UTC_H = 10    # 10:00 UTC = 15:30 IST
_NSE_CLOSE_UTC_M = 0

# Typical data availability delays after NSE close (seconds)
AVAILABILITY_DELAY_OHLCV_S:         int = 30 * 60   # 30 min
AVAILABILITY_DELAY_OPTIONS_S:        int = 30 * 60   # 30 min
AVAILABILITY_DELAY_MARKET_BREADTH_S: int = 90 * 60   # 90 min
AVAILABILITY_DELAY_DELIVERY_PCT_S:   int = 18 * 3600 # T+1 morning (~18h after close)


# ── DataAvailabilityStatus ─────────────────────────────────────────────────────

class DataAvailabilityStatus(str, Enum):
    """Status of a datum's availability at a given prediction time."""
    AVAILABLE     = "AVAILABLE"       # available_time <= prediction_time ✅
    NOT_YET       = "NOT_YET"         # available_time > prediction_time ❌
    DATA_UNAVAIL  = "DATA_UNAVAILABLE" # no availability record exists
    UNKNOWN       = "UNKNOWN"         # cannot determine without a record


# ── PointInTimeRecord ──────────────────────────────────────────────────────────

@dataclass
class PointInTimeRecord:
    """
    A single ML-ready observation with full point-in-time metadata.

    Every row in a training dataset should be representable as a
    PointInTimeRecord so that:
      1. The PIT invariant can be verified.
      2. The observation can be traced back to its source.
      3. Data revisions can be managed deterministically.

    Fields
    ------
    observation_id  : Unique ID for this datum; use for lineage queries.
    symbol          : Trading symbol (NSE convention, uppercase).
    exchange        : Exchange identifier ("NSE", "NFO", "BSE").
    event_time      : When the market event occurred (UTC, timezone-aware).
    available_time  : When this datum became available for use (UTC, tz-aware).
    ingestion_time  : When ml-service recorded/fetched this datum (UTC, tz-aware).
    prediction_time : The timestamp for which a model prediction is being made
                      (UTC, tz-aware).  Must be >= available_time.
    provider        : Source identifier (mirrors data-service DataSource enum values).
    revision_id     : Monotonically increasing revision number.  0 = original.
                      Higher = more recent correction.  Selection policy:
                      use the latest revision whose available_time <= prediction_time.
    source_revision : Provider-side revision tag (e.g. "NSE_BHAVCOPY_20241115_v2").
    """

    observation_id:   str
    symbol:           str
    exchange:         str
    event_time:       datetime           # UTC, tz-aware
    available_time:   datetime           # UTC, tz-aware
    ingestion_time:   datetime           # UTC, tz-aware
    prediction_time:  Optional[datetime] # UTC, tz-aware; set at query time
    provider:         str
    revision_id:      int   = 0
    source_revision:  str   = ""
    is_fallback:      bool  = False
    fallback_reason:  Optional[str] = None

    @classmethod
    def create(
        cls,
        symbol: str,
        exchange: str,
        event_time: datetime,
        available_time: datetime,
        provider: str,
        ingestion_time: Optional[datetime] = None,
        prediction_time: Optional[datetime] = None,
        revision_id: int = 0,
        source_revision: str = "",
        is_fallback: bool = False,
        fallback_reason: Optional[str] = None,
    ) -> "PointInTimeRecord":
        """
        Factory that validates timezone-awareness and relative ordering.

        Raises
        ------
        ValueError
            If any timestamp is naive (missing tzinfo).
        ValueError
            If available_time < event_time (availability cannot precede the event).
        """
        _require_tz_aware(event_time, "event_time")
        _require_tz_aware(available_time, "available_time")
        if ingestion_time is not None:
            _require_tz_aware(ingestion_time, "ingestion_time")
        if prediction_time is not None:
            _require_tz_aware(prediction_time, "prediction_time")

        if available_time < event_time:
            raise ValueError(
                f"available_time ({available_time.isoformat()}) cannot be earlier "
                f"than event_time ({event_time.isoformat()}) for {symbol}. "
                "Data cannot be available before the market event occurs."
            )

        now_utc = datetime.now(UTC)
        return cls(
            observation_id=str(uuid.uuid4()),
            symbol=symbol.upper(),
            exchange=exchange.upper(),
            event_time=event_time.astimezone(UTC),
            available_time=available_time.astimezone(UTC),
            ingestion_time=(ingestion_time or now_utc).astimezone(UTC),
            prediction_time=prediction_time.astimezone(UTC) if prediction_time else None,
            provider=provider,
            revision_id=revision_id,
            source_revision=source_revision,
            is_fallback=is_fallback,
            fallback_reason=fallback_reason,
        )

    def is_available_at(self, query_time: datetime) -> DataAvailabilityStatus:
        """
        Check whether this observation was available at query_time.

        Returns DataAvailabilityStatus.AVAILABLE when:
            self.available_time <= query_time

        Returns DataAvailabilityStatus.NOT_YET when:
            self.available_time > query_time

        This is the core PIT invariant check.
        """
        _require_tz_aware(query_time, "query_time")
        q = query_time.astimezone(UTC)
        if self.available_time <= q:
            return DataAvailabilityStatus.AVAILABLE
        return DataAvailabilityStatus.NOT_YET

    def to_dict(self) -> dict:
        return {
            "observationId":   self.observation_id,
            "symbol":          self.symbol,
            "exchange":        self.exchange,
            "eventTime":       self.event_time.isoformat(),
            "availableTime":   self.available_time.isoformat(),
            "ingestionTime":   self.ingestion_time.isoformat(),
            "predictionTime":  self.prediction_time.isoformat() if self.prediction_time else None,
            "provider":        self.provider,
            "revisionId":      self.revision_id,
            "sourceRevision":  self.source_revision,
            "isFallback":      self.is_fallback,
            "fallbackReason":  self.fallback_reason,
        }


# ── PointInTimeValidator ───────────────────────────────────────────────────────

@dataclass
class PITViolation:
    """A single point-in-time constraint violation."""
    symbol:          str
    feature:         str
    prediction_time: datetime
    available_time:  datetime
    severity:        str        # "CRITICAL" | "WARNING"
    reason:          str

    def to_dict(self) -> dict:
        return {
            "status":          "FAIL" if self.severity == "CRITICAL" else "WARNING",
            "reason":          self.reason,
            "symbol":          self.symbol,
            "feature":         self.feature,
            "predictionTime":  self.prediction_time.isoformat(),
            "availableTime":   self.available_time.isoformat(),
            "leakSeconds":     (self.available_time - self.prediction_time).total_seconds(),
        }


class PointInTimeValidator:
    """
    Validates the PIT invariant: available_time <= prediction_time.

    This is the enforcement layer that prevents future information from
    entering a training dataset.  Every PIT violation must be surfaced as
    either a WARNING or a CRITICAL finding.

    Usage
    -----
    ::
        validator = PointInTimeValidator()
        violations = validator.validate_record(record, prediction_time)
        if any(v.severity == "CRITICAL" for v in violations):
            raise RuntimeError("PIT violation blocks training")
    """

    def validate_record(
        self,
        record: PointInTimeRecord,
        prediction_time: datetime,
        feature_name: str = "ohlcv",
        tolerance_seconds: float = 0.0,
    ) -> list[PITViolation]:
        """
        Validate that record.available_time <= prediction_time.

        Parameters
        ----------
        record           : The PIT record to check.
        prediction_time  : The model's prediction timestamp (UTC, tz-aware).
        feature_name     : Name of the feature being validated (for diagnostics).
        tolerance_seconds: Small positive value allowed for clock-skew margin.
                           Default 0 = strict enforcement.

        Returns
        -------
        List of PITViolation objects.  Empty list = no violations.
        """
        _require_tz_aware(prediction_time, "prediction_time")
        violations: list[PITViolation] = []

        # Check 1: future available_time
        effective_pt = prediction_time.astimezone(UTC)
        avail = record.available_time.astimezone(UTC)

        if avail > effective_pt + timedelta(seconds=tolerance_seconds):
            violations.append(PITViolation(
                symbol=record.symbol,
                feature=feature_name,
                prediction_time=effective_pt,
                available_time=avail,
                severity="CRITICAL",
                reason=(
                    f"FUTURE_DATA: available_time ({avail.isoformat()}) "
                    f"> prediction_time ({effective_pt.isoformat()}). "
                    f"Leak = {(avail - effective_pt).total_seconds():.1f}s. "
                    "This datum was not available when the prediction was made."
                ),
            ))

        # Check 2: naive timestamps (should never reach here if create() is used, but belt+braces)
        if record.event_time.tzinfo is None:
            violations.append(PITViolation(
                symbol=record.symbol,
                feature=feature_name,
                prediction_time=effective_pt,
                available_time=avail,
                severity="CRITICAL",
                reason="NAIVE_TIMESTAMP: event_time has no timezone info. All timestamps must be UTC-aware.",
            ))

        # Check 3: available before event (semantic impossibility)
        if record.available_time < record.event_time:
            violations.append(PITViolation(
                symbol=record.symbol,
                feature=feature_name,
                prediction_time=effective_pt,
                available_time=avail,
                severity="CRITICAL",
                reason=(
                    f"IMPOSSIBLE_ORDER: available_time ({record.available_time.isoformat()}) "
                    f"< event_time ({record.event_time.isoformat()}). "
                    "Data cannot be available before the market event."
                ),
            ))

        # Check 4: far-future ingestion time (likely a misconfigured timezone)
        now_utc = datetime.now(UTC)
        if record.ingestion_time > now_utc + timedelta(hours=1):
            violations.append(PITViolation(
                symbol=record.symbol,
                feature=feature_name,
                prediction_time=effective_pt,
                available_time=avail,
                severity="WARNING",
                reason=(
                    f"FUTURE_INGESTION: ingestion_time ({record.ingestion_time.isoformat()}) "
                    f"is more than 1h in the future. Possible timezone misconfiguration."
                ),
            ))

        if violations:
            logger.warning(
                "pit_violations_found",
                symbol=record.symbol,
                feature=feature_name,
                n_violations=len(violations),
                critical=sum(1 for v in violations if v.severity == "CRITICAL"),
            )

        return violations

    def validate_dataframe(
        self,
        df: "pd.DataFrame",
        available_time_col: str,
        prediction_time_col: str,
        symbol_col: str = "symbol",
        feature_name: str = "dataframe",
        tolerance_seconds: float = 0.0,
    ) -> list[PITViolation]:
        """
        Validate PIT invariant across a DataFrame.

        Expects the specified columns to contain UTC-aware datetimes (or ISO strings).
        Returns all violations found.  A CRITICAL violation in any row blocks training.
        """
        import pandas as pd

        violations: list[PITViolation] = []

        if available_time_col not in df.columns or prediction_time_col not in df.columns:
            violations.append(PITViolation(
                symbol="*",
                feature=feature_name,
                prediction_time=datetime.now(UTC),
                available_time=datetime.now(UTC),
                severity="CRITICAL",
                reason=f"Missing required columns: {available_time_col}, {prediction_time_col}",
            ))
            return violations

        for idx, row in df.iterrows():
            avail_raw = row[available_time_col]
            pred_raw  = row[prediction_time_col]
            sym       = row.get(symbol_col, str(idx))

            avail_dt = _coerce_to_utc(avail_raw, f"{available_time_col}[{idx}]")
            pred_dt  = _coerce_to_utc(pred_raw, f"{prediction_time_col}[{idx}]")

            if avail_dt is None or pred_dt is None:
                violations.append(PITViolation(
                    symbol=str(sym),
                    feature=feature_name,
                    prediction_time=datetime.now(UTC),
                    available_time=datetime.now(UTC),
                    severity="CRITICAL",
                    reason=f"Row {idx}: Cannot parse timestamps. All timestamps must be UTC-aware.",
                ))
                continue

            if avail_dt > pred_dt + timedelta(seconds=tolerance_seconds):
                violations.append(PITViolation(
                    symbol=str(sym),
                    feature=feature_name,
                    prediction_time=pred_dt,
                    available_time=avail_dt,
                    severity="CRITICAL",
                    reason=(
                        f"FUTURE_DATA at row {idx}: available={avail_dt.isoformat()}, "
                        f"prediction={pred_dt.isoformat()}, "
                        f"leak={( avail_dt - pred_dt).total_seconds():.1f}s"
                    ),
                ))

        return violations


# ── Timestamp helpers ──────────────────────────────────────────────────────────

def require_utc_aware(dt: datetime, field_name: str = "timestamp") -> datetime:
    """Ensure dt is UTC-aware; raise ValueError if naive."""
    _require_tz_aware(dt, field_name)
    return dt.astimezone(UTC)


def nse_close_utc(trading_date: date) -> datetime:
    """Return the NSE session close time for trading_date in UTC."""
    return datetime(
        trading_date.year, trading_date.month, trading_date.day,
        _NSE_CLOSE_UTC_H, _NSE_CLOSE_UTC_M, 0, tzinfo=UTC
    )


def nse_close_ist(trading_date: date) -> datetime:
    """Return the NSE session close time for trading_date in IST."""
    return datetime(
        trading_date.year, trading_date.month, trading_date.day,
        15, 30, 0, tzinfo=IST
    )


def bhavcopy_available_utc(trading_date: date) -> datetime:
    """
    Estimated Bhavcopy availability time for trading_date.

    NSE publishes the Bhavcopy approximately 30 minutes after market close.
    This returns 10:30 UTC = 16:00 IST as the conservative estimate.
    """
    close = nse_close_utc(trading_date)
    return close + timedelta(seconds=AVAILABILITY_DELAY_OHLCV_S)


def ist_to_utc(dt: datetime) -> datetime:
    """Convert an IST datetime to UTC."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=IST)
    return dt.astimezone(UTC)


def utc_to_ist(dt: datetime) -> datetime:
    """Convert a UTC datetime to IST for display."""
    _require_tz_aware(dt, "dt")
    return dt.astimezone(IST)


def select_best_revision(
    revisions: list[PointInTimeRecord],
    query_time: datetime,
) -> Optional[PointInTimeRecord]:
    """
    Given multiple revisions of the same observation, select the correct
    one for a model prediction at query_time.

    Policy: return the revision with the highest revision_id whose
            available_time <= query_time.

    This ensures:
    - Future corrections do NOT alter what was available at query_time.
    - The most recent available revision IS used (e.g. same-day corrections).

    Returns None when no revision was available at query_time.
    """
    _require_tz_aware(query_time, "query_time")
    q = query_time.astimezone(UTC)

    eligible = [
        r for r in revisions
        if r.available_time.astimezone(UTC) <= q
    ]
    if not eligible:
        return None
    # Among eligible, pick the highest revision_id (most recent correction)
    return max(eligible, key=lambda r: r.revision_id)


# ── Internal helpers ───────────────────────────────────────────────────────────

def _require_tz_aware(dt: datetime, name: str) -> None:
    if dt.tzinfo is None or dt.tzinfo.utcoffset(dt) is None:
        raise ValueError(
            f"Timestamp '{name}' is naive (no timezone). "
            "All ML pipeline timestamps must be UTC-aware. "
            "Use datetime(..., tzinfo=timezone.utc) or datetime.now(timezone.utc)."
        )


def _coerce_to_utc(value: object, name: str) -> Optional[datetime]:
    """Try to convert value to a UTC-aware datetime. Return None on failure."""
    import pandas as pd

    if isinstance(value, datetime):
        if value.tzinfo is None:
            return None  # naive — reject
        return value.astimezone(UTC)

    if isinstance(value, pd.Timestamp):
        if value.tzinfo is None:
            return None
        return value.to_pydatetime().astimezone(UTC)

    if isinstance(value, str):
        try:
            dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if dt.tzinfo is None:
                return None
            return dt.astimezone(UTC)
        except ValueError:
            return None

    return None
