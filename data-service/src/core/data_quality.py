"""
Data Quality Engine — Phases 52-55.

Computes DataConfidenceScore (0-100) and DataQualityGate for signal safety.

The signal engine MUST obtain a DataQualityGate before generating any signal.
DataConfidence=100 is only achievable with fresh, complete, validated, reconciled
data — never just because HTTP returned 200.

Phase 53: DataQualityGate — signal engine safety contract.
Phase 52: DataConfidenceScore.
Phase 54: Fail-closed rule.
Phase 55: Strategy-specific data requirements.
"""

from __future__ import annotations

from typing import Optional

import structlog

from src.core.schemas_v2 import (
    DataQuality,
    DataQualityGate,
    FreshnessClass,
    StrategyDataRequirements,
)
from src.engines.freshness_engine import freshness_engine

logger = structlog.get_logger(__name__)


# ---------------------------------------------------------------------------
# Confidence score components (weights sum to 100)
# ---------------------------------------------------------------------------

_WEIGHTS = {
    "freshness": 35,
    "completeness": 25,
    "provider_health": 20,
    "timestamp_validity": 10,
    "cross_source_agreement": 10,
}


def compute_confidence_score(
    freshness_class: FreshnessClass,
    completeness_pct: float,      # 0.0-1.0
    provider_healthy: bool,
    timestamp_valid: bool,
    cross_source_agreement: float = 1.0,  # 0.0-1.0
    sequence_integrity: bool = True,
) -> int:
    """Compute a data confidence score from 0 to 100.

    Never returns 100 just because HTTP returned 200.
    The maximum is capped at 95 to reflect inherent uncertainty.

    Args:
        freshness_class: Freshness classification of the data
        completeness_pct: Fraction of expected fields populated (0.0-1.0)
        provider_healthy: Whether the provider circuit breaker is CLOSED
        timestamp_valid: Whether timestamps pass validation
        cross_source_agreement: Agreement between sources (1.0 = full agreement)
        sequence_integrity: Whether sequence numbers show no gaps
    """
    score = 0

    # Freshness component (0-35)
    freshness_score = {
        FreshnessClass.FRESH: 35,
        FreshnessClass.AGING: 25,
        FreshnessClass.STALE: 10,
        FreshnessClass.EXPIRED: 0,
        FreshnessClass.UNKNOWN: 5,
    }.get(freshness_class, 0)
    score += freshness_score

    # Completeness component (0-25)
    score += int(_WEIGHTS["completeness"] * min(1.0, max(0.0, completeness_pct)))

    # Provider health component (0-20)
    score += _WEIGHTS["provider_health"] if provider_healthy else 0

    # Timestamp validity component (0-10)
    score += _WEIGHTS["timestamp_validity"] if timestamp_valid else 0

    # Cross-source agreement component (0-10)
    score += int(_WEIGHTS["cross_source_agreement"] * min(1.0, max(0.0, cross_source_agreement)))

    # Sequence integrity penalty
    if not sequence_integrity:
        score = int(score * 0.8)

    # Cap at 95 — never 100 (inherent uncertainty in market data)
    return min(95, max(0, score))


def build_quality_gate(
    quote_age_ms: int,
    symbol: str = "",
    completeness_pct: float = 1.0,
    provider_healthy: bool = True,
    timestamp_valid: bool = True,
    cross_source_agreement: float = 1.0,
    sequence_integrity: bool = True,
    strategy_requirements: Optional[StrategyDataRequirements] = None,
) -> DataQualityGate:
    """Build a DataQualityGate for use by the signal engine.

    Phase 53: The signal engine MUST check signalEngineAllowed before proceeding.
    Phase 54: If critical data is unavailable, return gate with signalEngineAllowed=False.

    Args:
        quote_age_ms: Age of the most recent quote in milliseconds
        symbol: Instrument symbol
        completeness_pct: Fraction of expected data fields present
        provider_healthy: Whether the upstream provider is healthy
        timestamp_valid: Whether timestamps pass validation
        cross_source_agreement: Agreement between data sources (0.0-1.0)
        sequence_integrity: Whether sequence numbers are intact
        strategy_requirements: Optional strategy-specific thresholds
    """
    in_session = True  # Assume session for conservative defaults
    freshness = freshness_engine.classify_quote(quote_age_ms, symbol, in_session)

    # Determine individual gate conditions
    is_fresh = freshness in (FreshnessClass.FRESH, FreshnessClass.AGING)
    is_complete = completeness_pct >= 0.8  # 80% threshold
    ts_valid = timestamp_valid
    provider_ok = provider_healthy
    semantically_valid = True  # Set False when known semantic errors detected

    # Apply strategy-specific thresholds
    max_age_ms = 10_000  # default 10s
    if strategy_requirements:
        max_age_ms = strategy_requirements.maxQuoteAgeMs
        if strategy_requirements.minConfidenceScore > 70:
            is_fresh = freshness == FreshnessClass.FRESH

    is_fresh = is_fresh and (quote_age_ms <= max_age_ms)

    confidence = compute_confidence_score(
        freshness_class=freshness,
        completeness_pct=completeness_pct,
        provider_healthy=provider_healthy,
        timestamp_valid=timestamp_valid,
        cross_source_agreement=cross_source_agreement,
        sequence_integrity=sequence_integrity,
    )

    # Classify overall quality
    if confidence >= 80 and is_fresh and is_complete:
        quality = DataQuality.VALID
    elif confidence >= 50:
        quality = DataQuality.DEGRADED
    else:
        quality = DataQuality.INVALID

    # Block reason
    block_reasons = []
    if not is_fresh:
        block_reasons.append(f"data_stale ({quote_age_ms}ms, freshness={freshness.value})")
    if not is_complete:
        block_reasons.append(f"data_incomplete ({completeness_pct:.0%})")
    if not ts_valid:
        block_reasons.append("timestamp_invalid")
    if not provider_ok:
        block_reasons.append("provider_unhealthy")

    gate = DataQualityGate(
        dataFresh=is_fresh,
        dataComplete=is_complete,
        dataTimestampValid=ts_valid,
        dataProviderHealthy=provider_ok,
        dataSemanticallyValid=semantically_valid,
        quoteAgeMs=quote_age_ms,
        confidenceScore=confidence,
        quality=quality,
        blockReason="; ".join(block_reasons) if block_reasons else None,
    )

    if block_reasons:
        logger.debug(
            "data_quality_gate_blocked",
            symbol=symbol,
            confidence=confidence,
            reasons=block_reasons,
        )

    return gate


def check_strategy_data_requirements(
    requirements: StrategyDataRequirements,
    quote_age_ms: int,
    option_chain_available: bool = True,
    oi_available: bool = True,
    candle_confirmed: bool = True,
    confidence_score: int = 0,
) -> tuple[bool, list[str]]:
    """Check if strategy data requirements are satisfied.

    Phase 55: Different strategies need different data.
    Returns (allowed, list_of_blocking_reasons).
    """
    reasons = []

    if confidence_score < requirements.minConfidenceScore:
        reasons.append(
            f"confidence_too_low: {confidence_score} < {requirements.minConfidenceScore}"
        )

    if quote_age_ms > requirements.maxQuoteAgeMs:
        reasons.append(
            f"quote_too_stale: {quote_age_ms}ms > {requirements.maxQuoteAgeMs}ms"
        )

    if requirements.requiresOptionChain and not option_chain_available:
        reasons.append("option_chain_required_but_unavailable")

    if requirements.requiresOI and not oi_available:
        reasons.append("oi_required_but_unavailable")

    if requirements.requiresConfirmedCandle and not candle_confirmed:
        reasons.append("confirmed_candle_required_but_candle_is_partial")

    return len(reasons) == 0, reasons
