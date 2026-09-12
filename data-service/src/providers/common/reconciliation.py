"""
providers/common/reconciliation.py — Data Foundation V8 §13/§21.

Multi-source OHLCV reconciliation engine.

When overlapping data is available from multiple providers (Angel, Upstox,
Jugaad, OpenChart), this engine compares them candle by candle and produces
a deterministic reconciliation status.

RECONCILIATION STATUSES:
  MATCHED              — values identical (or within floating-point epsilon)
  WITHIN_TOLERANCE     — values differ by ≤ configured tolerance
  MINOR_DISCREPANCY    — values differ > tolerance, < major threshold
  MAJOR_DISCREPANCY    — values differ significantly; record for ops review
  SOURCE_ONLY          — candle exists in only one source
  UNAVAILABLE          — comparison not possible (no second source)

ABSOLUTE RULES:
  - Never silently choose a provider when MAJOR_DISCREPANCY is detected.
  - Tolerances are CONFIGURABLE and DOCUMENTED — not hardcoded magic.
  - Floating-point equality is NEVER required.
  - A discrepancy record is always written — never silently dropped.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

from src.providers.common.normalizer import CanonicalCandle


# ---------------------------------------------------------------------------
# Tolerance configuration
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class ReconciliationTolerances:
    """
    Configurable tolerances for OHLCV comparison.
    Absolute differences (INR for prices, % for volume/OI).

    Defaults are conservative but not zero — floating-point rounding across
    providers is expected. All thresholds must be positive.
    """
    # OHLC price absolute difference (INR)
    price_within_tolerance: float = 0.05    # 5 paisa
    price_minor_threshold:  float = 1.0     # 1 rupee
    # Volume relative difference (0–1, e.g. 0.05 = 5%)
    volume_relative_tolerance: float = 0.05
    # OI absolute difference (contracts)
    oi_within_tolerance: float = 100.0
    oi_minor_threshold:  float = 1000.0

    def __post_init__(self) -> None:
        for attr in ("price_within_tolerance", "price_minor_threshold",
                     "volume_relative_tolerance", "oi_within_tolerance",
                     "oi_minor_threshold"):
            v = getattr(self, attr)
            if not isinstance(v, (int, float)) or v < 0:
                raise ValueError(f"Tolerance '{attr}' must be a non-negative number, got {v!r}")


DEFAULT_TOLERANCES = ReconciliationTolerances()


# ---------------------------------------------------------------------------
# Reconciliation status
# ---------------------------------------------------------------------------

RECON_MATCHED            = "MATCHED"
RECON_WITHIN_TOLERANCE   = "WITHIN_TOLERANCE"
RECON_MINOR_DISCREPANCY  = "MINOR_DISCREPANCY"
RECON_MAJOR_DISCREPANCY  = "MAJOR_DISCREPANCY"
RECON_SOURCE_ONLY        = "SOURCE_ONLY"
RECON_UNAVAILABLE        = "UNAVAILABLE"


@dataclass
class CandleReconciliationResult:
    """
    Result of comparing two candles from different providers for the same
    (instrumentId, exchange, intervalStr, time).
    """
    instrumentId:          str
    exchange:              str
    intervalStr:           str
    time:                  int          # UTC epoch seconds
    sessionDate:           str
    providerA:             str
    providerB:             str

    # Observed values (None = provider did not supply)
    openA:   Optional[float] = None
    openB:   Optional[float] = None
    highA:   Optional[float] = None
    highB:   Optional[float] = None
    lowA:    Optional[float] = None
    lowB:    Optional[float] = None
    closeA:  Optional[float] = None
    closeB:  Optional[float] = None
    volumeA: Optional[float] = None
    volumeB: Optional[float] = None
    oiA:     Optional[float] = None
    oiB:     Optional[float] = None

    # Computed differences
    maxOhlcDiff: Optional[float]   = None
    reconciliationStatus: str      = RECON_UNAVAILABLE
    toleranceConfig: Optional[dict] = None

    # Discrepancy details for ops review
    discrepancyFields: list[str]   = field(default_factory=list)

    def to_db_dict(self) -> dict:
        from dataclasses import asdict
        d = asdict(self)
        return d


def reconcile_candle_pair(
    candle_a: CanonicalCandle,
    candle_b: CanonicalCandle,
    tolerances: ReconciliationTolerances = DEFAULT_TOLERANCES,
) -> CandleReconciliationResult:
    """
    Compare two candles from different providers.

    Parameters
    ----------
    candle_a : CanonicalCandle
        Candle from the primary/higher-trust provider.
    candle_b : CanonicalCandle
        Candle from the secondary provider.
    tolerances : ReconciliationTolerances
        Tolerance thresholds.

    Returns
    -------
    CandleReconciliationResult
        Reconciliation result with deterministic status.
    """
    assert candle_a.instrumentId == candle_b.instrumentId
    assert candle_a.exchange == candle_b.exchange
    assert candle_a.intervalStr == candle_b.intervalStr
    assert candle_a.time == candle_b.time

    result = CandleReconciliationResult(
        instrumentId=candle_a.instrumentId,
        exchange=candle_a.exchange,
        intervalStr=candle_a.intervalStr,
        time=candle_a.time,
        sessionDate=candle_a.sessionDate,
        providerA=candle_a.provider,
        providerB=candle_b.provider,
        openA=candle_a.open,   openB=candle_b.open,
        highA=candle_a.high,   highB=candle_b.high,
        lowA=candle_a.low,     lowB=candle_b.low,
        closeA=candle_a.close, closeB=candle_b.close,
        volumeA=candle_a.volume if not candle_a.volumeUnavailable else None,
        volumeB=candle_b.volume if not candle_b.volumeUnavailable else None,
        oiA=candle_a.oi,       oiB=candle_b.oi,
        toleranceConfig={
            "price_within_tolerance":    tolerances.price_within_tolerance,
            "price_minor_threshold":     tolerances.price_minor_threshold,
            "volume_relative_tolerance": tolerances.volume_relative_tolerance,
            "oi_within_tolerance":       tolerances.oi_within_tolerance,
            "oi_minor_threshold":        tolerances.oi_minor_threshold,
        },
    )

    # Compare OHLC fields
    discrepancy_fields: list[str] = []
    max_diff = 0.0
    worst_status = RECON_MATCHED

    def _compare_price(field_name: str, val_a: float, val_b: float) -> str:
        diff = abs(val_a - val_b)
        if diff > max(result.maxOhlcDiff or 0, diff):
            result.maxOhlcDiff = diff
        if diff == 0.0:
            return RECON_MATCHED
        elif diff <= tolerances.price_within_tolerance:
            return RECON_WITHIN_TOLERANCE
        elif diff <= tolerances.price_minor_threshold:
            discrepancy_fields.append(f"{field_name}:diff={diff:.4f}")
            return RECON_MINOR_DISCREPANCY
        else:
            discrepancy_fields.append(f"{field_name}:diff={diff:.4f}:MAJOR")
            return RECON_MAJOR_DISCREPANCY

    _status_order = [
        RECON_MATCHED, RECON_WITHIN_TOLERANCE,
        RECON_MINOR_DISCREPANCY, RECON_MAJOR_DISCREPANCY
    ]

    def _upgrade(current: str, candidate: str) -> str:
        try:
            return candidate if _status_order.index(candidate) > _status_order.index(current) else current
        except ValueError:
            return candidate

    for fname, va, vb in [
        ("open", candle_a.open, candle_b.open),
        ("high", candle_a.high, candle_b.high),
        ("low",  candle_a.low,  candle_b.low),
        ("close",candle_a.close,candle_b.close),
    ]:
        diff = abs(va - vb)
        max_diff = max(max_diff, diff)
        s = _compare_price(fname, va, vb)
        worst_status = _upgrade(worst_status, s)

    # Volume comparison (relative, only when both available)
    if result.volumeA is not None and result.volumeB is not None:
        avg_vol = (result.volumeA + result.volumeB) / 2
        if avg_vol > 0:
            rel_diff = abs(result.volumeA - result.volumeB) / avg_vol
            if rel_diff > tolerances.volume_relative_tolerance * 5:
                discrepancy_fields.append(f"volume:rel_diff={rel_diff:.4f}:MAJOR")
                worst_status = _upgrade(worst_status, RECON_MAJOR_DISCREPANCY)
            elif rel_diff > tolerances.volume_relative_tolerance:
                discrepancy_fields.append(f"volume:rel_diff={rel_diff:.4f}")
                worst_status = _upgrade(worst_status, RECON_MINOR_DISCREPANCY)

    # OI comparison (only when both available)
    if result.oiA is not None and result.oiB is not None:
        oi_diff = abs(result.oiA - result.oiB)
        if oi_diff > tolerances.oi_minor_threshold:
            discrepancy_fields.append(f"oi:diff={oi_diff:.0f}:MAJOR")
            worst_status = _upgrade(worst_status, RECON_MAJOR_DISCREPANCY)
        elif oi_diff > tolerances.oi_within_tolerance:
            discrepancy_fields.append(f"oi:diff={oi_diff:.0f}")
            worst_status = _upgrade(worst_status, RECON_MINOR_DISCREPANCY)

    result.maxOhlcDiff = max_diff
    result.reconciliationStatus = worst_status
    result.discrepancyFields = discrepancy_fields

    return result


def reconcile_batch(
    candles_a: list[CanonicalCandle],
    candles_b: list[CanonicalCandle],
    tolerances: ReconciliationTolerances = DEFAULT_TOLERANCES,
) -> tuple[list[CandleReconciliationResult], int, int]:
    """
    Reconcile two lists of candles by matching on (instrumentId, time).

    Returns
    -------
    results : list[CandleReconciliationResult]
        All reconciliation records.
    matched_count : int
        Number of candles successfully compared.
    source_only_count : int
        Number of candles that existed in only one source.
    """
    map_a = {c.time: c for c in candles_a}
    map_b = {c.time: c for c in candles_b}

    results: list[CandleReconciliationResult] = []
    matched_count = 0
    source_only_count = 0

    all_times = set(map_a.keys()) | set(map_b.keys())
    for t in sorted(all_times):
        ca = map_a.get(t)
        cb = map_b.get(t)

        if ca is not None and cb is not None:
            r = reconcile_candle_pair(ca, cb, tolerances)
            results.append(r)
            matched_count += 1
        elif ca is not None:
            results.append(CandleReconciliationResult(
                instrumentId=ca.instrumentId, exchange=ca.exchange,
                intervalStr=ca.intervalStr, time=t, sessionDate=ca.sessionDate,
                providerA=ca.provider, providerB="",
                openA=ca.open, highA=ca.high, lowA=ca.low, closeA=ca.close,
                reconciliationStatus=RECON_SOURCE_ONLY,
            ))
            source_only_count += 1
        else:
            assert cb is not None
            results.append(CandleReconciliationResult(
                instrumentId=cb.instrumentId, exchange=cb.exchange,
                intervalStr=cb.intervalStr, time=t, sessionDate=cb.sessionDate,
                providerA="", providerB=cb.provider,
                openB=cb.open, highB=cb.high, lowB=cb.low, closeB=cb.close,
                reconciliationStatus=RECON_SOURCE_ONLY,
            ))
            source_only_count += 1

    return results, matched_count, source_only_count
