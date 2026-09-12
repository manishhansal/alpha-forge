"""
providers/common/quality.py — Data Foundation V8 §14/§22/§38.

Deterministic data quality scoring engine.

Produces a [0–100] quality score and a qualityStatus classification from
nine measurable dimensions. The formula is documented and deterministic —
not a black-box number.

QUALITY STATUS:
  VERIFIED_RECONCILED    (A) — valid + complete + fresh + provenance + cross-source match
  VERIFIED_SINGLE_SOURCE (B) — valid + complete + strong provenance, single source
  DEGRADED               (C) — known gaps/discrepancies/minor issues
  UNVERIFIED             (D) — insufficient verification
  INVALID                (F) — invalid data

CRITICAL FAILURE RULE:
  A critical failure (e.g. negative OI, impossible OHLC) ALWAYS overrides
  the numeric score and sets status=INVALID regardless of other dimensions.
  A score of 99.9 with a critical failure is still INVALID.

SCORING FORMULA (documented):
  score = weighted sum of dimension scores, clamped to [0, 100]:

  dimension              weight  description
  ─────────────────────────────────────────
  completeness           25      actual_bars / expected_bars
  validity               20      valid_rows / total_rows
  freshness              15      based on age vs timeframe threshold
  provenance             15      BROKER_AUTH=1.0, NSE_DERIVED=0.9, YAHOO=0.6, UNKNOWN=0.3
  reconciliation         15      MATCHED=1.0, WITHIN_TOL=0.9, MINOR=0.5, MAJOR=0.0
  duplicate_rate         5       1 - duplicate_rows/total_rows
  gap_rate               5       1 - gap_count/expected_bars (approx)
  timestamp_integrity    0*      pass/fail (failure → INVALID override)
  provider_health        0*      pass/fail (failure → DEGRADED)

  * Zero weight but can trigger overrides.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

from src.providers.common.reconciliation import (
    RECON_MATCHED, RECON_WITHIN_TOLERANCE, RECON_MINOR_DISCREPANCY,
    RECON_MAJOR_DISCREPANCY, RECON_SOURCE_ONLY, RECON_UNAVAILABLE,
)

# ---------------------------------------------------------------------------
# Quality status constants
# ---------------------------------------------------------------------------

STATUS_VERIFIED_RECONCILED    = "VERIFIED_RECONCILED"
STATUS_VERIFIED_SINGLE_SOURCE = "VERIFIED_SINGLE_SOURCE"
STATUS_DEGRADED               = "DEGRADED"
STATUS_UNVERIFIED             = "UNVERIFIED"
STATUS_INVALID                = "INVALID"

# Reliability grades for scoring labels
GRADE_A = "A"  # VERIFIED_RECONCILED
GRADE_B = "B"  # VERIFIED_SINGLE_SOURCE
GRADE_C = "C"  # DEGRADED
GRADE_D = "D"  # UNVERIFIED
GRADE_F = "F"  # INVALID

# Provenance strength to score mapping
_PROVENANCE_SCORES = {
    "BROKER_AUTHENTICATED":    1.0,
    "NSE_EXCHANGE_DERIVED":    0.9,
    "NSE_CHART_DERIVED":       0.85,
    "AGGREGATED_DELAYED":      0.6,
    "UNKNOWN":                 0.3,
}

# Reconciliation status to score mapping
_RECONCILIATION_SCORES = {
    RECON_MATCHED:            1.0,
    RECON_WITHIN_TOLERANCE:   0.9,
    RECON_MINOR_DISCREPANCY:  0.5,
    RECON_MAJOR_DISCREPANCY:  0.0,
    RECON_SOURCE_ONLY:        0.7,   # only one source, still usable
    RECON_UNAVAILABLE:        0.7,   # no comparison possible
}

# Freshness thresholds by timeframe (seconds) — not stale = 100%, stale = degraded
_FRESHNESS_THRESHOLDS_SECS: dict[str, dict[str, int]] = {
    "1m":  {"fresh": 90,        "stale": 300,       "expired": 600},
    "5m":  {"fresh": 360,       "stale": 900,       "expired": 1800},
    "10m": {"fresh": 660,       "stale": 1200,      "expired": 3600},
    "15m": {"fresh": 960,       "stale": 1800,      "expired": 7200},
    "30m": {"fresh": 1860,      "stale": 3600,      "expired": 14400},
    "1h":  {"fresh": 3660,      "stale": 14400,     "expired": 28800},
    "1d":  {"fresh": 86400,     "stale": 604800,    "expired": 2592000},
    "1w":  {"fresh": 604800,    "stale": 1209600,   "expired": 5184000},
    "1M":  {"fresh": 2592000,   "stale": 7776000,   "expired": 15552000},
}

# Score dimension weights
_WEIGHTS = {
    "completeness":    0.25,
    "validity":        0.20,
    "freshness":       0.15,
    "provenance":      0.15,
    "reconciliation":  0.15,
    "duplicate_rate":  0.05,
    "gap_rate":        0.05,
}


# ---------------------------------------------------------------------------
# Quality input/output types
# ---------------------------------------------------------------------------

@dataclass
class QualityInput:
    """
    All the evidence needed to compute a quality score.
    Callers supply what they have; missing fields degrade the score.
    """
    instrumentId:      str
    exchange:          str
    intervalStr:       str
    sessionDate:       str
    provider:          str

    # Completeness
    actual_bars:       int   = 0
    expected_bars:     int   = 0

    # Validity
    valid_rows:        int   = 0
    total_rows:        int   = 0
    invalid_rows:      int   = 0
    duplicate_rows:    int   = 0

    # Freshness (age of the data in seconds at evaluation time)
    age_seconds:       Optional[float] = None

    # Provenance
    provenance_strength: str = "UNKNOWN"   # from ReliabilityClass
    authenticated:       bool = False

    # Reconciliation (from reconciliation engine)
    reconciliation_status: str = RECON_UNAVAILABLE

    # Gap detection
    gap_count:         int  = 0

    # Critical failures (any → override to INVALID)
    has_negative_oi:     bool = False
    has_impossible_ohlc: bool = False
    has_future_candle:   bool = False
    has_duplicate_key:   bool = False

    # Provider health flags
    provider_had_errors: bool = False

    # Dataset version (for audit)
    dataset_version:   Optional[str] = None


@dataclass
class QualityResult:
    """
    Deterministic quality scoring result.
    """
    instrumentId:     str
    exchange:         str
    intervalStr:      str
    sessionDate:      str
    provider:         str

    # Numeric score [0–100]; None if computation blocked by critical failure
    qualityScore:     Optional[float]
    qualityStatus:    str
    grade:            str

    # Per-dimension scores [0–1]
    completenessScore:   Optional[float] = None
    validityScore:       Optional[float] = None
    freshnessScore:      Optional[float] = None
    provenanceScore:     Optional[float] = None
    reconciliationScore: Optional[float] = None
    duplicateRate:       Optional[float] = None
    gapRate:             Optional[float] = None
    timestampIntegrity:  Optional[float] = None
    providerHealth:      Optional[float] = None

    # Audit
    reasons:          list[str] = field(default_factory=list)
    criticalFailure:  bool      = False
    criticalReason:   Optional[str] = None
    datasetVersion:   Optional[str] = None

    def to_db_dict(self) -> dict:
        from dataclasses import asdict
        return asdict(self)


# ---------------------------------------------------------------------------
# Scoring engine
# ---------------------------------------------------------------------------

def compute_quality_score(inp: QualityInput) -> QualityResult:
    """
    Compute a deterministic quality score for a dataset.

    See module docstring for the full scoring formula.
    """
    result = QualityResult(
        instrumentId=inp.instrumentId,
        exchange=inp.exchange,
        intervalStr=inp.intervalStr,
        sessionDate=inp.sessionDate,
        provider=inp.provider,
        qualityScore=None,
        qualityStatus=STATUS_UNVERIFIED,
        grade=GRADE_D,
        datasetVersion=inp.dataset_version,
    )

    reasons: list[str] = []

    # ------------------------------------------------------------------
    # 1. Critical failure check — overrides everything
    # ------------------------------------------------------------------
    critical_failures: list[str] = []
    if inp.has_negative_oi:
        critical_failures.append("negative_oi_detected")
    if inp.has_impossible_ohlc:
        critical_failures.append("impossible_ohlc_detected")
    if inp.has_future_candle:
        critical_failures.append("future_candle_detected")
    if inp.has_duplicate_key:
        critical_failures.append("duplicate_primary_key_detected")

    if critical_failures:
        result.criticalFailure = True
        result.criticalReason = "; ".join(critical_failures)
        result.qualityScore = None
        result.qualityStatus = STATUS_INVALID
        result.grade = GRADE_F
        result.reasons = critical_failures
        return result

    # ------------------------------------------------------------------
    # 2. Per-dimension scores
    # ------------------------------------------------------------------

    # Completeness: actual / expected, clamped to [0, 1]
    completeness = 0.0
    if inp.expected_bars > 0:
        completeness = min(1.0, inp.actual_bars / inp.expected_bars)
    elif inp.actual_bars > 0:
        completeness = 1.0  # expected unknown but we have data
    result.completenessScore = completeness
    if completeness < 0.9:
        reasons.append(f"completeness_{completeness:.0%}:expected={inp.expected_bars}"
                       f"_actual={inp.actual_bars}")

    # Validity: valid / total
    validity = 1.0
    if inp.total_rows > 0:
        validity = min(1.0, inp.valid_rows / inp.total_rows)
    result.validityScore = validity
    if validity < 1.0:
        reasons.append(f"invalid_rows_{inp.invalid_rows}_of_{inp.total_rows}")

    # Freshness
    freshness = _compute_freshness_score(inp.intervalStr, inp.age_seconds)
    result.freshnessScore = freshness
    if freshness < 0.7:
        reasons.append(f"stale_data:age_secs={inp.age_seconds}")

    # Provenance
    provenance = _PROVENANCE_SCORES.get(inp.provenance_strength, 0.3)
    result.provenanceScore = provenance
    if provenance < 0.7:
        reasons.append(f"weak_provenance:{inp.provenance_strength}")

    # Reconciliation
    recon = _RECONCILIATION_SCORES.get(inp.reconciliation_status, 0.7)
    result.reconciliationScore = recon
    if inp.reconciliation_status == RECON_MAJOR_DISCREPANCY:
        reasons.append(f"major_reconciliation_discrepancy")

    # Duplicate rate
    dup_rate = 0.0
    if inp.total_rows > 0:
        dup_rate = inp.duplicate_rows / inp.total_rows
    result.duplicateRate = dup_rate
    if dup_rate > 0.01:
        reasons.append(f"duplicate_rate_{dup_rate:.2%}")

    # Gap rate
    gap_score = 1.0
    if inp.expected_bars > 0 and inp.gap_count > 0:
        gap_score = max(0.0, 1.0 - (inp.gap_count / inp.expected_bars))
    result.gapRate = 1.0 - gap_score
    if inp.gap_count > 0:
        reasons.append(f"gaps_detected:{inp.gap_count}")

    # Timestamp integrity (pass/fail — failures already caught above)
    result.timestampIntegrity = 1.0

    # Provider health
    provider_health = 0.0 if inp.provider_had_errors else 1.0
    result.providerHealth = provider_health
    if inp.provider_had_errors:
        reasons.append("provider_had_errors")

    # ------------------------------------------------------------------
    # 3. Weighted composite score
    # ------------------------------------------------------------------
    score = (
        completeness     * _WEIGHTS["completeness"]    +
        validity         * _WEIGHTS["validity"]        +
        freshness        * _WEIGHTS["freshness"]       +
        provenance       * _WEIGHTS["provenance"]      +
        recon            * _WEIGHTS["reconciliation"]  +
        (1.0 - dup_rate) * _WEIGHTS["duplicate_rate"] +
        gap_score        * _WEIGHTS["gap_rate"]
    )
    result.qualityScore = round(score * 100, 2)

    # ------------------------------------------------------------------
    # 4. Status classification
    # ------------------------------------------------------------------
    if inp.reconciliation_status in (RECON_MATCHED, RECON_WITHIN_TOLERANCE):
        recon_verified = True
    else:
        recon_verified = False

    high_provenance = provenance >= 0.85

    if (result.qualityScore >= 95 and completeness >= 0.98 and validity >= 0.99
            and recon_verified and high_provenance):
        result.qualityStatus = STATUS_VERIFIED_RECONCILED
        result.grade = GRADE_A
    elif (result.qualityScore >= 90 and completeness >= 0.95 and validity >= 0.98
            and high_provenance):
        result.qualityStatus = STATUS_VERIFIED_SINGLE_SOURCE
        result.grade = GRADE_B
    elif result.qualityScore >= 70:
        result.qualityStatus = STATUS_DEGRADED
        result.grade = GRADE_C
    elif result.qualityScore >= 50:
        result.qualityStatus = STATUS_UNVERIFIED
        result.grade = GRADE_D
    else:
        result.qualityStatus = STATUS_INVALID
        result.grade = GRADE_F

    # Stale or degraded provider health → downgrade to DEGRADED at most
    if inp.provider_had_errors and result.qualityStatus in (
        STATUS_VERIFIED_RECONCILED, STATUS_VERIFIED_SINGLE_SOURCE
    ):
        result.qualityStatus = STATUS_DEGRADED
        result.grade = GRADE_C
        reasons.append("downgraded_due_to_provider_errors")

    result.reasons = reasons
    return result


def _compute_freshness_score(interval_str: str, age_seconds: Optional[float]) -> float:
    """
    Compute a [0–1] freshness score based on data age vs timeframe thresholds.
    Returns 1.0 if age is unknown (can't penalize what we can't measure).
    """
    if age_seconds is None:
        return 1.0
    thresholds = _FRESHNESS_THRESHOLDS_SECS.get(interval_str, _FRESHNESS_THRESHOLDS_SECS["1d"])

    if age_seconds <= thresholds["fresh"]:
        return 1.0
    elif age_seconds <= thresholds["stale"]:
        # Linear interpolation from 1.0 → 0.7
        t = (age_seconds - thresholds["fresh"]) / (thresholds["stale"] - thresholds["fresh"])
        return 1.0 - (t * 0.3)
    elif age_seconds <= thresholds["expired"]:
        # Linear interpolation from 0.7 → 0.3
        t = (age_seconds - thresholds["stale"]) / (thresholds["expired"] - thresholds["stale"])
        return 0.7 - (t * 0.4)
    else:
        return 0.1  # expired but still has some value
