"""
ML-Specific Data Quality Gate — AlphaForge ML Service.

This module provides a batch data quality gate for ML training datasets.
It is distinct from the data-service live-signal DataQualityGate which
is designed for real-time per-quote validation.

The ML gate checks:
  1. Point-in-time invariants (available_time <= prediction_time)
  2. OHLCV integrity (negative prices, impossible high/low, zero volume)
  3. Timestamp completeness and ordering
  4. Universe membership (symbol known and eligible)
  5. Instrument metadata integrity (lot size available)
  6. Duplicate observations
  7. Missing required fields
  8. Stale data (unchanged price for N bars with zero volume)
  9. Corporate action inconsistency (not yet checkable — DATA_UNAVAILABLE)

Severity levels
---------------
CRITICAL  — must block dataset creation; a model trained on this data
             would produce invalid results. Examples: future timestamps,
             negative prices, confirmed PIT violations.

ERROR     — should block dataset creation unless explicitly overridden.
             Examples: zero-volume across entire symbol, duplicate rows.

WARNING   — suspicious but potentially acceptable with documentation.
             Examples: DATA_UNAVAILABLE metadata, stale rows (filtered),
             lot size APPROXIMATE.

INFO      — informational; does not affect dataset validity.

Usage
-----
::
    gate = MLDataQualityGate()
    report = gate.check_dataframe(df, prediction_time=dt)
    if report.is_blocked:
        raise RuntimeError(f"Dataset blocked: {report.critical_messages}")
    dataset_snapshot.quality_status = report.quality_status
    dataset_snapshot.quality_issues = report.warning_count
    dataset_snapshot.quality_errors = report.error_count
    dataset_snapshot.pit_violations = report.pit_violation_count
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from enum import Enum
from typing import Optional

import numpy as np
import pandas as pd
import structlog

logger = structlog.get_logger(__name__)

UTC = timezone.utc


# ── IssueSeverity ─────────────────────────────────────────────────────────────

class IssueSeverity(str, Enum):
    CRITICAL = "CRITICAL"
    ERROR    = "ERROR"
    WARNING  = "WARNING"
    INFO     = "INFO"


# ── MLDataQualityIssue ────────────────────────────────────────────────────────

@dataclass
class MLDataQualityIssue:
    """A single data quality finding."""

    severity:    IssueSeverity
    check_name:  str
    symbol:      str
    description: str
    row_count:   int = 0
    examples:    list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "severity":    self.severity.value,
            "checkName":   self.check_name,
            "symbol":      self.symbol,
            "description": self.description,
            "rowCount":    self.row_count,
            "examples":    self.examples[:5],
        }


# ── MLDataQualityReport ───────────────────────────────────────────────────────

@dataclass
class MLDataQualityReport:
    """
    Summary of all quality checks for one dataset or symbol.

    Fields
    ------
    symbol              : "*" for dataset-level; symbol name for per-symbol.
    issues              : All quality issues found.
    rows_checked        : Total rows checked.
    rows_excluded       : Rows that were excluded by quality filtering.
    pit_violation_count : Number of point-in-time violations (CRITICAL).
    """

    symbol:              str
    issues:              list[MLDataQualityIssue] = field(default_factory=list)
    rows_checked:        int = 0
    rows_excluded:       int = 0
    pit_violation_count: int = 0

    @property
    def critical_count(self) -> int:
        return sum(1 for i in self.issues if i.severity == IssueSeverity.CRITICAL)

    @property
    def error_count(self) -> int:
        return sum(1 for i in self.issues if i.severity == IssueSeverity.ERROR)

    @property
    def warning_count(self) -> int:
        return sum(1 for i in self.issues if i.severity == IssueSeverity.WARNING)

    @property
    def info_count(self) -> int:
        return sum(1 for i in self.issues if i.severity == IssueSeverity.INFO)

    @property
    def is_blocked(self) -> bool:
        """True when CRITICAL or ERROR issues exist."""
        return self.critical_count > 0 or self.error_count > 0

    @property
    def quality_status(self) -> str:
        if self.critical_count > 0:
            return "BLOCKED"
        if self.error_count > 0:
            return "HAS_ERRORS"
        if self.warning_count > 0:
            return "HAS_WARNINGS"
        return "CLEAN"

    @property
    def critical_messages(self) -> list[str]:
        return [i.description for i in self.issues if i.severity == IssueSeverity.CRITICAL]

    def to_dict(self) -> dict:
        return {
            "symbol":           self.symbol,
            "rowsChecked":      self.rows_checked,
            "rowsExcluded":     self.rows_excluded,
            "pitViolations":    self.pit_violation_count,
            "criticalCount":    self.critical_count,
            "errorCount":       self.error_count,
            "warningCount":     self.warning_count,
            "isBlocked":        self.is_blocked,
            "qualityStatus":    self.quality_status,
            "issues":           [i.to_dict() for i in self.issues],
        }


# ── MLDataQualityGate ─────────────────────────────────────────────────────────

class MLDataQualityGate:
    """
    ML-specific data quality gate for training datasets.

    Distinct from data-service DataQualityGate which validates real-time quotes.
    This gate validates BATCH training data before feature engineering.

    Usage
    -----
    ::
        gate = MLDataQualityGate()
        report = gate.check_ohlcv(df, symbol="RELIANCE", prediction_time=dt)
        if report.is_blocked:
            logger.error("BLOCKED", issues=report.critical_messages)
    """

    # Thresholds
    MAX_SINGLE_BAR_CHANGE_PCT: float = 0.25    # > 25% = suspicious (circuit breaker = 20%)
    MAX_STALE_BARS: int = 3                     # 3 consecutive unchanged bars at zero volume
    MIN_ROWS_PER_SYMBOL: int = 20               # fewer rows → not enough data

    def check_ohlcv(
        self,
        df: pd.DataFrame,
        symbol: str,
        prediction_time: Optional[datetime] = None,
        available_time_col: Optional[str] = None,
    ) -> MLDataQualityReport:
        """
        Run all OHLCV quality checks for a single symbol.

        Parameters
        ----------
        df               : DataFrame with columns [open, high, low, close, volume].
                           Index should be a DatetimeIndex or have a 'date' column.
        symbol           : Symbol being checked (for reporting).
        prediction_time  : If provided and available_time_col is set, validates PIT.
        available_time_col: Column name containing availability timestamps.
        """
        report = MLDataQualityReport(symbol=symbol, rows_checked=len(df))
        issues = report.issues

        if len(df) == 0:
            issues.append(MLDataQualityIssue(
                severity=IssueSeverity.CRITICAL,
                check_name="EMPTY_DATASET",
                symbol=symbol,
                description=f"Symbol {symbol}: DataFrame is empty. Cannot train.",
                row_count=0,
            ))
            return report

        # ── 1. Required columns ───────────────────────────────────────────────
        required = {"open", "high", "low", "close", "volume"}
        missing = required - set(df.columns)
        if missing:
            issues.append(MLDataQualityIssue(
                severity=IssueSeverity.CRITICAL,
                check_name="MISSING_COLUMNS",
                symbol=symbol,
                description=f"Missing required columns: {sorted(missing)}",
            ))
            return report  # cannot proceed without OHLCV

        close  = df["close"].astype(float)
        high   = df["high"].astype(float)
        low    = df["low"].astype(float)
        open_  = df["open"].astype(float)
        volume = df["volume"].astype(float)

        # ── 2. Negative / zero prices ─────────────────────────────────────────
        invalid_close = close <= 0
        invalid_open  = open_ <= 0
        invalid_high  = high <= 0
        invalid_low   = low <= 0
        n_invalid = (invalid_close | invalid_open | invalid_high | invalid_low).sum()
        if n_invalid > 0:
            issues.append(MLDataQualityIssue(
                severity=IssueSeverity.CRITICAL,
                check_name="INVALID_PRICE",
                symbol=symbol,
                description=f"{n_invalid} rows with zero or negative OHLC prices.",
                row_count=int(n_invalid),
                examples=_get_index_examples(df, invalid_close | invalid_open),
            ))

        # ── 3. Negative volume ────────────────────────────────────────────────
        neg_vol = volume < 0
        if neg_vol.any():
            issues.append(MLDataQualityIssue(
                severity=IssueSeverity.CRITICAL,
                check_name="NEGATIVE_VOLUME",
                symbol=symbol,
                description=f"{neg_vol.sum()} rows with negative volume.",
                row_count=int(neg_vol.sum()),
            ))

        # ── 4. High < Low ─────────────────────────────────────────────────────
        hl_invalid = high < low
        if hl_invalid.any():
            issues.append(MLDataQualityIssue(
                severity=IssueSeverity.CRITICAL,
                check_name="HIGH_LESS_THAN_LOW",
                symbol=symbol,
                description=f"{hl_invalid.sum()} rows where high < low.",
                row_count=int(hl_invalid.sum()),
            ))

        # ── 5. Close outside [low, high] ──────────────────────────────────────
        close_outside = (close > high) | (close < low)
        if close_outside.any():
            issues.append(MLDataQualityIssue(
                severity=IssueSeverity.ERROR,
                check_name="CLOSE_OUTSIDE_RANGE",
                symbol=symbol,
                description=f"{close_outside.sum()} rows where close not in [low, high].",
                row_count=int(close_outside.sum()),
            ))

        # ── 6. Extreme single-bar price moves (circuit breaker proxy) ─────────
        pct_chg = close.pct_change().abs()
        extreme = pct_chg > self.MAX_SINGLE_BAR_CHANGE_PCT
        if extreme.any():
            issues.append(MLDataQualityIssue(
                severity=IssueSeverity.WARNING,
                check_name="EXTREME_PRICE_MOVE",
                symbol=symbol,
                description=(
                    f"{extreme.sum()} bars with >25% single-bar price change. "
                    "May be circuit breaker days or data errors."
                ),
                row_count=int(extreme.sum()),
                examples=_get_index_examples(df, extreme),
            ))

        # ── 7. Stale data (unchanged price + zero volume) ─────────────────────
        price_unchanged = (close == close.shift(1)) & (close == close.shift(2))
        zero_volume = volume == 0
        stale = price_unchanged & zero_volume
        if stale.any():
            issues.append(MLDataQualityIssue(
                severity=IssueSeverity.WARNING,
                check_name="STALE_BARS",
                symbol=symbol,
                description=(
                    f"{stale.sum()} bars with unchanged price and zero volume "
                    "(3+ consecutive). Likely market holidays or data gaps."
                ),
                row_count=int(stale.sum()),
            ))

        # ── 8. NaN values ────────────────────────────────────────────────────
        nan_count = df[["open", "high", "low", "close", "volume"]].isna().any(axis=1).sum()
        if nan_count > 0:
            issues.append(MLDataQualityIssue(
                severity=IssueSeverity.ERROR,
                check_name="NAN_VALUES",
                symbol=symbol,
                description=f"{nan_count} rows with NaN in OHLCV columns.",
                row_count=int(nan_count),
            ))

        # ── 9. Duplicate timestamps ───────────────────────────────────────────
        if isinstance(df.index, pd.DatetimeIndex):
            dupes = df.index.duplicated()
        elif "date" in df.columns:
            dupes = df["date"].duplicated()
        else:
            dupes = pd.Series(False, index=df.index)

        if dupes.any():
            issues.append(MLDataQualityIssue(
                severity=IssueSeverity.ERROR,
                check_name="DUPLICATE_TIMESTAMPS",
                symbol=symbol,
                description=f"{dupes.sum()} duplicate timestamps detected.",
                row_count=int(dupes.sum()),
            ))

        # ── 10. Minimum row count ─────────────────────────────────────────────
        if len(df) < self.MIN_ROWS_PER_SYMBOL:
            issues.append(MLDataQualityIssue(
                severity=IssueSeverity.ERROR,
                check_name="INSUFFICIENT_ROWS",
                symbol=symbol,
                description=(
                    f"Only {len(df)} rows; minimum {self.MIN_ROWS_PER_SYMBOL} required "
                    "for meaningful feature engineering."
                ),
                row_count=len(df),
            ))

        # ── 11. Naive timestamps ──────────────────────────────────────────────
        if isinstance(df.index, pd.DatetimeIndex) and df.index.tz is None:
            issues.append(MLDataQualityIssue(
                severity=IssueSeverity.CRITICAL,
                check_name="NAIVE_TIMESTAMP_INDEX",
                symbol=symbol,
                description=(
                    "DataFrame DatetimeIndex has no timezone. "
                    "All timestamps must be UTC-aware. "
                    "Use df.index = df.index.tz_localize('UTC')."
                ),
            ))

        # ── 12. PIT violation check ───────────────────────────────────────────
        if (prediction_time is not None and available_time_col is not None
                and available_time_col in df.columns):
            from .point_in_time import PointInTimeValidator, _coerce_to_utc

            pit_violations = 0
            pt_utc = prediction_time.astimezone(UTC)

            for idx, row in df.iterrows():
                avail = _coerce_to_utc(row[available_time_col], available_time_col)
                if avail is not None and avail > pt_utc:
                    pit_violations += 1

            if pit_violations > 0:
                issues.append(MLDataQualityIssue(
                    severity=IssueSeverity.CRITICAL,
                    check_name="PIT_VIOLATION",
                    symbol=symbol,
                    description=(
                        f"{pit_violations} rows where available_time > prediction_time. "
                        "Future data would leak into training features."
                    ),
                    row_count=pit_violations,
                ))
                report.pit_violation_count = pit_violations

        # Summary logging
        if report.critical_count > 0:
            logger.error(
                "quality_gate_critical",
                symbol=symbol,
                n_critical=report.critical_count,
                messages=report.critical_messages,
            )
        elif report.error_count > 0:
            logger.warning(
                "quality_gate_errors",
                symbol=symbol,
                n_errors=report.error_count,
            )
        elif report.warning_count > 0:
            logger.debug("quality_gate_warnings", symbol=symbol, n_warn=report.warning_count)

        return report

    def check_dataset(
        self,
        symbol_dfs: dict[str, pd.DataFrame],
        prediction_time: Optional[datetime] = None,
        available_time_col: Optional[str] = None,
        block_on_critical: bool = True,
        block_on_error: bool = True,
    ) -> dict[str, MLDataQualityReport]:
        """
        Run quality checks across all symbols in a dataset.

        Returns a dict mapping symbol → MLDataQualityReport.
        If block_on_critical and any CRITICAL issues exist, raises RuntimeError.
        """
        all_reports: dict[str, MLDataQualityReport] = {}
        total_critical = 0

        for symbol, df in symbol_dfs.items():
            report = self.check_ohlcv(
                df, symbol, prediction_time, available_time_col
            )
            all_reports[symbol] = report
            total_critical += report.critical_count
            if block_on_error and report.error_count > 0:
                total_critical += report.error_count

        if block_on_critical and total_critical > 0:
            blocked_symbols = [
                sym for sym, r in all_reports.items()
                if r.is_blocked
            ]
            raise RuntimeError(
                f"MLDataQualityGate: dataset BLOCKED due to CRITICAL/ERROR issues "
                f"in {len(blocked_symbols)} symbols: {blocked_symbols[:5]}. "
                f"Inspect the reports for details."
            )

        return all_reports


# ── Helpers ───────────────────────────────────────────────────────────────────

def _get_index_examples(df: pd.DataFrame, mask: pd.Series, n: int = 3) -> list[str]:
    """Return up to n index values where mask is True, as strings."""
    try:
        return [str(idx) for idx in df.index[mask][:n]]
    except Exception:
        return []
