"""
Phase 3N — Data-quality + point-in-time validation layer (spec §11–§17, §23).

This module ORCHESTRATES the existing PIT/quality infrastructure — it does not
duplicate it:

  * `execution.market_calendar.NSECalendar` — trading-day / session / expiry.
  * `data.point_in_time.PointInTimeValidator` — the no-lookahead invariant
    (available_time ≤ prediction_time). Reused, not reimplemented.
  * `data.historical_universe`, `data.fno_eligibility`, `data.instrument_master`,
    `data.corporate_actions` — PIT eligibility / metadata stores.

It adds the Phase 3N validation surface those stores did not cover:
  §11 market-calendar session classification,
  §12 instrument/timeframe-aware freshness (FRESH/AGING/STALE/UNAVAILABLE),
  §13 OHLCV quality (NaN/Inf/zero/neg/dup/out-of-order/future-ts + OHLC invariants),
  §14 F&O metadata (no current-into-historical substitution),
  §15 option-chain validity (CE/PE/strike/expiry/OI/IV),
  §16 corporate-action non-corruption,
  §17 historical-universe eligibility (reject future membership),
  §23 a no-lookahead asserter over an arbitrary set of timestamped inputs.

Every check FAILS CLOSED: a missing/invalid/future input produces an explicit
issue, never a fabricated value. Determinism: pure stdlib + numpy. Import-clean.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field, asdict
from datetime import date, datetime, timedelta, timezone
from enum import Enum
from typing import Optional

UTC = timezone.utc


def _now() -> datetime:
    return datetime.now(UTC)


# ══════════════════════════════════════════════════════════════════════════════
# Result vocabulary
# ══════════════════════════════════════════════════════════════════════════════

class QualitySeverity(str, Enum):
    OK       = "OK"
    WARNING  = "WARNING"
    CRITICAL = "CRITICAL"


@dataclass
class QualityIssue:
    """One data-quality / PIT finding. CRITICAL issues block usage (fail-closed)."""
    code:      str
    severity:  str
    detail:    str
    instrument: str = ""
    field:     str = ""

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class QualityReport:
    """Aggregated result of a data-quality assessment."""
    subject:   str                     # what was checked (instrument / session / ...)
    issues:    list[QualityIssue] = field(default_factory=list)
    checked_at: str = ""

    def __post_init__(self):
        if not self.checked_at:
            self.checked_at = _now().isoformat()

    def add(self, code: str, severity: QualitySeverity, detail: str,
            instrument: str = "", field_name: str = "") -> None:
        self.issues.append(QualityIssue(code=code, severity=severity.value,
                                        detail=detail, instrument=instrument, field=field_name))

    @property
    def critical(self) -> list[QualityIssue]:
        return [i for i in self.issues if i.severity == QualitySeverity.CRITICAL.value]

    @property
    def ok(self) -> bool:
        """Usable iff there are no CRITICAL issues (WARNING is allowed)."""
        return len(self.critical) == 0

    def to_dict(self) -> dict:
        return {"subject": self.subject, "ok": self.ok,
                "n_issues": len(self.issues), "n_critical": len(self.critical),
                "issues": [i.to_dict() for i in self.issues], "checked_at": self.checked_at}


# ══════════════════════════════════════════════════════════════════════════════
# §11 Market-calendar session classification (reuses NSECalendar)
# ══════════════════════════════════════════════════════════════════════════════

class SessionType(str, Enum):
    PRE_OPEN    = "PRE_OPEN"        # 09:00–09:15 IST
    REGULAR     = "REGULAR"         # 09:15–15:30 IST
    POST_MARKET = "POST_MARKET"     # after 15:30 IST on a trading day
    CLOSED      = "CLOSED"          # before pre-open on a trading day
    WEEKEND     = "WEEKEND"
    HOLIDAY     = "HOLIDAY"
    UNKNOWN     = "UNKNOWN"         # calendar has no evidence for this year


# IST session bounds (mirror NSECalendar)
_IST = timezone(timedelta(hours=5, minutes=30))
_PRE_OPEN_START = (9, 0)
_REGULAR_START  = (9, 15)
_REGULAR_END    = (15, 30)


@dataclass
class SessionClassification:
    session:    str            # SessionType
    is_trading_day: bool
    is_expiry:  bool
    calendar_status: str       # OK / DATA_APPROXIMATE / INSUFFICIENT_EVIDENCE
    detail:     str = ""

    def to_dict(self) -> dict:
        return asdict(self)


def classify_session(dt: datetime, calendar=None) -> SessionClassification:
    """
    Classify an IST/UTC-aware timestamp into an NSE session (spec §11). Reuses
    `NSECalendar` for holiday/trading-day evidence; returns UNKNOWN calendar
    status for years the built-in calendar does not cover (fail-closed, never
    assumes a weekday is a trading day).
    """
    from src.execution.market_calendar import DEFAULT_CALENDAR, CalendarDataStatus
    cal = calendar or DEFAULT_CALENDAR

    if dt.tzinfo is None:
        return SessionClassification(SessionType.UNKNOWN.value, False, False,
                                     "INSUFFICIENT_EVIDENCE", "naive timestamp")
    ist = dt.astimezone(_IST)
    d = ist.date()

    is_trading, cal_status = cal.is_trading_day(d)
    is_expiry = _is_expiry_day(d, cal)

    if cal_status == CalendarDataStatus.INSUFFICIENT_EVIDENCE:
        return SessionClassification(SessionType.UNKNOWN.value, False, is_expiry,
                                     cal_status, f"year {d.year} not covered by calendar")
    if cal.is_weekend(d):
        return SessionClassification(SessionType.WEEKEND.value, False, is_expiry, cal_status)
    if cal.is_holiday(d):
        return SessionClassification(SessionType.HOLIDAY.value, False, is_expiry, cal_status)

    # trading day — classify intraday session
    t = (ist.hour, ist.minute)
    if t < _PRE_OPEN_START:
        sess = SessionType.CLOSED
    elif t < _REGULAR_START:
        sess = SessionType.PRE_OPEN
    elif t < _REGULAR_END:
        sess = SessionType.REGULAR
    else:
        sess = SessionType.POST_MARKET
    return SessionClassification(sess.value, True, is_expiry, cal_status)


def _is_expiry_day(d: date, cal) -> bool:
    """True if d is the NSE monthly expiry (last-Thursday, holiday-adjusted)."""
    try:
        monthly = cal.monthly_expiry(d.year, d.month)
        return d == monthly
    except Exception:
        return False


def assert_no_regular_session_on_holiday(dt: datetime, calendar=None) -> QualityReport:
    """
    §11: the system must not generate a REGULAR-session decision on a holiday /
    weekend. Returns a report with a CRITICAL issue if it would.
    """
    rep = QualityReport(subject=f"session:{dt.isoformat()}")
    sc = classify_session(dt, calendar)
    if sc.session in (SessionType.HOLIDAY.value, SessionType.WEEKEND.value):
        rep.add("REGULAR_SESSION_ON_NON_TRADING_DAY", QualitySeverity.CRITICAL,
                f"timestamp falls on {sc.session}; no regular-session decision allowed")
    elif sc.session == SessionType.UNKNOWN.value:
        rep.add("CALENDAR_INSUFFICIENT_EVIDENCE", QualitySeverity.CRITICAL,
                sc.detail or "calendar cannot confirm trading day")
    return rep


# ══════════════════════════════════════════════════════════════════════════════
# §12 Freshness (instrument/timeframe aware)
# ══════════════════════════════════════════════════════════════════════════════

class Freshness(str, Enum):
    FRESH       = "FRESH"
    AGING       = "AGING"
    STALE       = "STALE"
    UNAVAILABLE = "UNAVAILABLE"


@dataclass(frozen=True)
class FreshnessPolicy:
    """
    Config-driven, timeframe-aware freshness thresholds (spec §12) — no single
    global threshold. Ages are in seconds. Defaults are conservative multiples of
    the bar interval.
    """
    version: str = "3n-freshness-policy-v1"
    # per-timeframe (fresh_max, aging_max) in seconds; beyond aging_max => STALE
    thresholds: dict = field(default_factory=lambda: {
        "1m":  (120, 300),
        "5m":  (600, 1800),
        "15m": (1800, 5400),
        "30m": (3600, 10800),
        "1h":  (7200, 21600),
        "1d":  (129600, 345600),   # fresh <1.5d, aging <4d (weekend-tolerant)
    })
    default: tuple = (3600, 21600)

    def classify(self, timeframe: str, age_seconds: Optional[float]) -> Freshness:
        if age_seconds is None:
            return Freshness.UNAVAILABLE
        if age_seconds < 0:
            # future-dated data is not "fresh" — it is a PIT violation, treat as
            # unavailable for freshness purposes (the OHLCV/PIT checks flag it).
            return Freshness.UNAVAILABLE
        fresh_max, aging_max = self.thresholds.get(timeframe, self.default)
        if age_seconds <= fresh_max:
            return Freshness.FRESH
        if age_seconds <= aging_max:
            return Freshness.AGING
        return Freshness.STALE


def classify_freshness(timeframe: str, market_timestamp: Optional[datetime],
                       now: Optional[datetime] = None,
                       policy: Optional[FreshnessPolicy] = None) -> tuple[Freshness, Optional[float]]:
    """Return (Freshness, age_seconds) for a market timestamp at `now`."""
    pol = policy or FreshnessPolicy()
    if market_timestamp is None:
        return Freshness.UNAVAILABLE, None
    ref = now or _now()
    age = (ref - market_timestamp).total_seconds()
    return pol.classify(timeframe, age), age


# ══════════════════════════════════════════════════════════════════════════════
# §13 OHLCV quality
# ══════════════════════════════════════════════════════════════════════════════

def validate_ohlcv_bars(bars: list[dict], instrument: str = "",
                        now: Optional[datetime] = None) -> QualityReport:
    """
    Validate a chronological list of OHLCV bar dicts (spec §13). Each bar:
    {timestamp (epoch s or datetime), open, high, low, close, volume, [oi]}.

    Detects (as CRITICAL unless noted): NaN/Inf, zero/negative price, negative
    volume, OHLC invariant breaks (high < max(o,c) or low > min(o,c)),
    out-of-order timestamps, duplicate timestamps, future timestamps.
    """
    rep = QualityReport(subject=f"ohlcv:{instrument}")
    ref = now or _now()
    ref_epoch = ref.timestamp()

    prev_ts = None
    seen_ts: set = set()

    for i, bar in enumerate(bars):
        ts = bar.get("timestamp")
        ts_epoch = _to_epoch(ts)

        # timestamp checks
        if ts_epoch is None:
            rep.add("MISSING_TIMESTAMP", QualitySeverity.CRITICAL,
                    f"bar {i} has no usable timestamp", instrument, "timestamp")
        else:
            if ts_epoch > ref_epoch:
                rep.add("FUTURE_TIMESTAMP", QualitySeverity.CRITICAL,
                        f"bar {i} timestamp is in the future ({ts_epoch} > {ref_epoch:.0f})",
                        instrument, "timestamp")
            if prev_ts is not None and ts_epoch < prev_ts:
                rep.add("OUT_OF_ORDER", QualitySeverity.CRITICAL,
                        f"bar {i} timestamp {ts_epoch} < previous {prev_ts}", instrument, "timestamp")
            if ts_epoch in seen_ts:
                rep.add("DUPLICATE_BAR", QualitySeverity.CRITICAL,
                        f"bar {i} duplicate timestamp {ts_epoch}", instrument, "timestamp")
            seen_ts.add(ts_epoch)
            prev_ts = ts_epoch

        # price / volume checks
        o, h, l, c = bar.get("open"), bar.get("high"), bar.get("low"), bar.get("close")
        v = bar.get("volume")
        for name, val in (("open", o), ("high", h), ("low", l), ("close", c)):
            if val is None:
                rep.add("MISSING_PRICE", QualitySeverity.CRITICAL,
                        f"bar {i} missing {name}", instrument, name)
                continue
            if _bad_float(val):
                rep.add("NAN_OR_INF_PRICE", QualitySeverity.CRITICAL,
                        f"bar {i} {name}={val} is NaN/Inf", instrument, name)
            elif val <= 0:
                rep.add("NON_POSITIVE_PRICE", QualitySeverity.CRITICAL,
                        f"bar {i} {name}={val} <= 0", instrument, name)
        if v is not None:
            if _bad_float(v):
                rep.add("NAN_OR_INF_VOLUME", QualitySeverity.CRITICAL,
                        f"bar {i} volume={v} NaN/Inf", instrument, "volume")
            elif v < 0:
                rep.add("NEGATIVE_VOLUME", QualitySeverity.CRITICAL,
                        f"bar {i} volume={v} < 0", instrument, "volume")

        # OHLC invariants (only when all four are valid finite positives)
        if all(x is not None and not _bad_float(x) and x > 0 for x in (o, h, l, c)):
            if h < max(o, c):
                rep.add("OHLC_HIGH_INVARIANT", QualitySeverity.CRITICAL,
                        f"bar {i} high {h} < max(open,close) {max(o,c)}", instrument, "high")
            if l > min(o, c):
                rep.add("OHLC_LOW_INVARIANT", QualitySeverity.CRITICAL,
                        f"bar {i} low {l} > min(open,close) {min(o,c)}", instrument, "low")
            if h < l:
                rep.add("OHLC_HIGH_LOW", QualitySeverity.CRITICAL,
                        f"bar {i} high {h} < low {l}", instrument, "high")

        # OI (optional) — negative OI is invalid
        oi = bar.get("oi", bar.get("open_interest"))
        if oi is not None:
            if _bad_float(oi):
                rep.add("NAN_OR_INF_OI", QualitySeverity.CRITICAL, f"bar {i} oi NaN/Inf", instrument, "oi")
            elif oi < 0:
                rep.add("NEGATIVE_OI", QualitySeverity.CRITICAL, f"bar {i} oi={oi} < 0", instrument, "oi")

    return rep


def _bad_float(x) -> bool:
    try:
        f = float(x)
    except (TypeError, ValueError):
        return True
    return math.isnan(f) or math.isinf(f)


def _to_epoch(ts) -> Optional[float]:
    if ts is None:
        return None
    if isinstance(ts, (int, float)):
        return None if _bad_float(ts) else float(ts)
    if isinstance(ts, datetime):
        return ts.timestamp()
    try:
        return datetime.fromisoformat(str(ts)).timestamp()
    except ValueError:
        return None


def _to_date(value) -> Optional[date]:
    """Coerce a date / datetime / ISO string to a date; None if not parseable."""
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        return None


# ══════════════════════════════════════════════════════════════════════════════
# §14 F&O metadata — no current-into-historical substitution
# ══════════════════════════════════════════════════════════════════════════════

def validate_fno_metadata(contract: dict, as_of: date,
                          instrument_store=None) -> QualityReport:
    """
    Validate an F&O contract's metadata is PIT-correct as of `as_of` (spec §14).
    A contract carries: symbol, underlying, expiry (date/iso), strike, option_type,
    lot_size, instrument_token, trading_status.

    Fails CLOSED when historical lot size cannot be confirmed (never substitutes
    today's lot size into a historical observation).
    """
    rep = QualityReport(subject=f"fno:{contract.get('symbol','?')}")
    sym = contract.get("symbol", "")

    # expiry must not be before as_of (an expired contract is not tradable)
    exp = contract.get("expiry")
    exp_date = _to_date(exp)
    if exp_date is None:
        rep.add("FNO_MISSING_EXPIRY", QualitySeverity.CRITICAL, "no usable expiry", sym, "expiry")
    elif exp_date < as_of:
        rep.add("FNO_EXPIRED_CONTRACT", QualitySeverity.CRITICAL,
                f"expiry {exp_date} < as_of {as_of}", sym, "expiry")

    # option_type must be CE/PE/None(future)
    ot = contract.get("option_type")
    if ot not in (None, "", "CE", "PE"):
        rep.add("FNO_BAD_OPTION_TYPE", QualitySeverity.CRITICAL, f"option_type={ot}", sym, "option_type")

    # strike must be positive for options
    if ot in ("CE", "PE"):
        strike = contract.get("strike")
        if strike is None or _bad_float(strike) or float(strike) <= 0:
            rep.add("FNO_BAD_STRIKE", QualitySeverity.CRITICAL, f"strike={strike}", sym, "strike")

    # lot size — MUST be the historical PIT lot size, not today's
    lot = contract.get("lot_size")
    if instrument_store is not None:
        try:
            hist = instrument_store.get_lot_size(sym, as_of)  # expected (value, status)
            value, status = hist if isinstance(hist, tuple) else (hist, "OK")
            if status == "DATA_UNAVAILABLE" or value is None:
                rep.add("FNO_LOT_SIZE_UNAVAILABLE", QualitySeverity.CRITICAL,
                        f"historical lot size unavailable for {sym} @ {as_of} (do NOT substitute current)",
                        sym, "lot_size")
            elif lot is not None and value is not None and int(lot) != int(value):
                rep.add("FNO_LOT_SIZE_MISMATCH", QualitySeverity.CRITICAL,
                        f"provided lot {lot} != historical lot {value} @ {as_of}", sym, "lot_size")
            elif status == "APPROXIMATE":
                rep.add("FNO_LOT_SIZE_APPROXIMATE", QualitySeverity.WARNING,
                        f"historical lot size approximate for {sym} @ {as_of}", sym, "lot_size")
        except Exception as exc:
            rep.add("FNO_LOT_SIZE_UNAVAILABLE", QualitySeverity.CRITICAL,
                    f"lot-size lookup failed: {exc}", sym, "lot_size")
    elif lot is None:
        rep.add("FNO_LOT_SIZE_UNAVAILABLE", QualitySeverity.CRITICAL,
                "no lot size and no historical store to confirm it", sym, "lot_size")

    return rep


# ══════════════════════════════════════════════════════════════════════════════
# §15 Option-chain validity
# ══════════════════════════════════════════════════════════════════════════════

def validate_option_chain(rows: list[dict], expiry: Optional[date] = None,
                          as_of: Optional[date] = None) -> QualityReport:
    """
    Validate an option-chain snapshot (spec §15). Each row: {strike, option_type
    (CE/PE), ltp, volume, oi, oi_change, iv, expiry}. Detects duplicate strikes,
    invalid expiry, negative OI/volume, invalid IV. Downstream derivatives must
    not be computed from an INVALID chain (caller checks .ok).
    """
    rep = QualityReport(subject="option_chain")
    seen: set = set()
    for i, row in enumerate(rows):
        strike = row.get("strike")
        ot = row.get("option_type")
        if ot not in ("CE", "PE"):
            rep.add("OC_BAD_OPTION_TYPE", QualitySeverity.CRITICAL, f"row {i} option_type={ot}", field_name="option_type")
        if strike is None or _bad_float(strike) or float(strike) <= 0:
            rep.add("OC_BAD_STRIKE", QualitySeverity.CRITICAL, f"row {i} strike={strike}", field_name="strike")
        else:
            key = (float(strike), ot)
            if key in seen:
                rep.add("OC_DUPLICATE_STRIKE", QualitySeverity.CRITICAL, f"row {i} duplicate {key}", field_name="strike")
            seen.add(key)

        row_exp = _to_date(row.get("expiry"))
        if expiry is not None and row_exp is not None and row_exp != expiry:
            rep.add("OC_EXPIRY_MISMATCH", QualitySeverity.CRITICAL,
                    f"row {i} expiry {row_exp} != chain expiry {expiry}", field_name="expiry")
        if as_of is not None and row_exp is not None and row_exp < as_of:
            rep.add("OC_INVALID_EXPIRY", QualitySeverity.CRITICAL,
                    f"row {i} expiry {row_exp} before as_of {as_of}", field_name="expiry")

        for fld in ("oi", "volume"):
            val = row.get(fld)
            if val is not None and (_bad_float(val) or float(val) < 0):
                rep.add(f"OC_NEGATIVE_{fld.upper()}", QualitySeverity.CRITICAL, f"row {i} {fld}={val}", field_name=fld)

        iv = row.get("iv")
        if iv is not None:
            if _bad_float(iv) or float(iv) < 0 or float(iv) > 5.0:  # 500% IV cap
                rep.add("OC_INVALID_IV", QualitySeverity.CRITICAL, f"row {i} iv={iv}", field_name="iv")
    return rep


# ══════════════════════════════════════════════════════════════════════════════
# §16 Corporate-action non-corruption
# ══════════════════════════════════════════════════════════════════════════════

def validate_corporate_action_pit(ca_record, as_of: datetime) -> QualityReport:
    """
    §16: a corporate action may only influence history if it was KNOWN/effective
    as of the query time. Reuses `data.corporate_actions.CorporateActionRecord`
    (`.was_known_at` / `.was_available_at`). A future CA leaking into historical
    features is a CRITICAL PIT violation.
    """
    rep = QualityReport(subject="corporate_action")
    try:
        known = ca_record.was_known_at(as_of)
    except Exception as exc:
        rep.add("CA_LOOKUP_FAILED", QualitySeverity.CRITICAL, f"was_known_at failed: {exc}")
        return rep
    if not known:
        rep.add("CA_FUTURE_LEAK", QualitySeverity.CRITICAL,
                f"corporate action not known as of {as_of.isoformat()} — must not adjust history")
    return rep


# ══════════════════════════════════════════════════════════════════════════════
# §17 Historical-universe eligibility (reject future membership)
# ══════════════════════════════════════════════════════════════════════════════

def validate_universe_membership(membership) -> QualityReport:
    """
    §17: only instruments actually eligible at the observation date may be in the
    universe. Reuses `data.historical_universe.UniverseMembership`. A member whose
    eligibility is not TRUE (or is DATA_UNAVAILABLE) must not be treated as
    tradable — reject rather than assume.
    """
    rep = QualityReport(subject=f"universe:{getattr(membership,'symbol','?')}")
    if getattr(membership, "is_safe_to_use", False):
        return rep
    if getattr(membership, "needs_warning", False):
        rep.add("UNIVERSE_ELIGIBILITY_UNKNOWN", QualitySeverity.CRITICAL,
                "eligibility dimension is DATA_UNAVAILABLE — cannot confirm PIT membership",
                instrument=getattr(membership, "symbol", ""))
    else:
        rep.add("UNIVERSE_NOT_ELIGIBLE", QualitySeverity.CRITICAL,
                "instrument not eligible at observation date",
                instrument=getattr(membership, "symbol", ""))
    return rep


def reject_future_universe_membership(symbol: str, observation_date: date,
                                      fo_entry_date: Optional[date]) -> QualityReport:
    """
    Explicit adversarial guard (spec §17, §56): if an instrument's F&O entry date
    is AFTER the observation date, its membership at observation time is future
    information and must be rejected.
    """
    rep = QualityReport(subject=f"universe-future:{symbol}")
    if fo_entry_date is not None and fo_entry_date > observation_date:
        rep.add("FUTURE_UNIVERSE_MEMBERSHIP", QualitySeverity.CRITICAL,
                f"{symbol} entered F&O on {fo_entry_date} > observation {observation_date}",
                instrument=symbol)
    return rep


# ══════════════════════════════════════════════════════════════════════════════
# §23 No-lookahead asserter (reuses PointInTimeValidator)
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class TimestampedInput:
    """One decision input with the time its information became available."""
    name:            str            # price / volume / oi / iv / regime / model / ...
    available_time:  datetime       # UTC-aware
    instrument:      str = ""


def assert_no_lookahead(inputs: list[TimestampedInput], decision_time: datetime,
                        tolerance_seconds: float = 0.0) -> QualityReport:
    """
    §23: prove every input satisfies information_timestamp ≤ decision_time. Any
    input whose availability is after the decision time is a CRITICAL leak. Reuses
    the existing `PointInTimeValidator` semantics for consistency.
    """
    rep = QualityReport(subject=f"no-lookahead:{decision_time.isoformat()}")
    if decision_time.tzinfo is None:
        rep.add("NAIVE_DECISION_TIME", QualitySeverity.CRITICAL, "decision_time not tz-aware")
        return rep
    dt = decision_time.astimezone(UTC)
    for inp in inputs:
        at = inp.available_time
        if at is None:
            rep.add("MISSING_AVAILABILITY", QualitySeverity.CRITICAL,
                    f"input {inp.name} has no availability time", inp.instrument, inp.name)
            continue
        if at.tzinfo is None:
            rep.add("NAIVE_INPUT_TIME", QualitySeverity.CRITICAL,
                    f"input {inp.name} availability not tz-aware", inp.instrument, inp.name)
            continue
        if at.astimezone(UTC) > dt + timedelta(seconds=tolerance_seconds):
            leak = (at.astimezone(UTC) - dt).total_seconds()
            rep.add("LOOKAHEAD_LEAK", QualitySeverity.CRITICAL,
                    f"input {inp.name} available_time > decision_time (leak={leak:.1f}s)",
                    inp.instrument, inp.name)
    return rep
