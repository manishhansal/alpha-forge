"""
Phase 3Q — Typed provider-failure taxonomy (spec §3).

The existing `paper.providers.SourceStatus` already distinguishes OK / DEGRADED /
TIMEOUT / ERROR / UNCONFIGURED / UNAVAILABLE. Phase 3Q ADDS the finer operational
failure taxonomy the spec requires and maps it deterministically onto those
existing statuses so the fallback chain keeps working unchanged. A provider
failure is NEVER silently swallowed: it always resolves to one explicit member.

Key distinction the spec demands (§3):
  NO_DATA           — a *meaningful* empty result (market genuinely had no data)
  PROVIDER_FAILURE  — the provider itself failed to answer
are DIFFERENT and must not be conflated (NO_DATA must not trigger blind fallback).
"""

from __future__ import annotations

from enum import Enum


class ProviderFailure(str, Enum):
    """Explicit, exhaustive provider outcome taxonomy (spec §3)."""
    OK                    = "OK"                     # usable data returned
    NO_DATA               = "NO_DATA"                # meaningful empty (not a failure)
    PROVIDER_FAILURE      = "PROVIDER_FAILURE"       # generic upstream failure
    DATA_INVALID          = "DATA_INVALID"           # malformed / failed validation
    DATA_STALE            = "DATA_STALE"             # older than freshness policy
    MARKET_CLOSED         = "MARKET_CLOSED"          # no data because market shut
    SYMBOL_NOT_SUPPORTED  = "SYMBOL_NOT_SUPPORTED"   # provider does not cover symbol
    AUTH_FAILURE          = "AUTH_FAILURE"           # credential/token rejected
    RATE_LIMITED          = "RATE_LIMITED"           # throttled by provider
    NETWORK_FAILURE       = "NETWORK_FAILURE"        # timeout / connection error
    UNKNOWN_PROVIDER_ERROR = "UNKNOWN_PROVIDER_ERROR"


# Outcomes on which the chain SHOULD fall through to the next provider (§3).
# NO_DATA / MARKET_CLOSED / SYMBOL_NOT_SUPPORTED are meaningful answers — falling
# back on them would be wrong (there is nothing a lower tier can add).
_FALLBACK_ELIGIBLE: frozenset[ProviderFailure] = frozenset({
    ProviderFailure.PROVIDER_FAILURE,
    ProviderFailure.DATA_INVALID,
    ProviderFailure.DATA_STALE,
    ProviderFailure.AUTH_FAILURE,
    ProviderFailure.RATE_LIMITED,
    ProviderFailure.NETWORK_FAILURE,
    ProviderFailure.UNKNOWN_PROVIDER_ERROR,
})

# Outcomes that must NOT be retried against the same provider (§18).
_NON_RETRYABLE: frozenset[ProviderFailure] = frozenset({
    ProviderFailure.OK,
    ProviderFailure.NO_DATA,
    ProviderFailure.MARKET_CLOSED,
    ProviderFailure.SYMBOL_NOT_SUPPORTED,
    ProviderFailure.AUTH_FAILURE,       # never retry a bad credential (§18)
    ProviderFailure.DATA_INVALID,       # a malformed payload will stay malformed (§18)
})


def is_fallback_eligible(failure: ProviderFailure | str) -> bool:
    """A provider outcome that justifies falling through to the next tier (§3)."""
    try:
        return ProviderFailure(failure) in _FALLBACK_ELIGIBLE
    except ValueError:
        # unknown value → fail closed (treat as a failure that permits fallback)
        return True


def is_retryable(failure: ProviderFailure | str) -> bool:
    """Whether the SAME provider may be retried for this outcome (§18)."""
    try:
        return ProviderFailure(failure) not in _NON_RETRYABLE
    except ValueError:
        return False


# ── Mapping onto the existing paper.providers vocabulary (no duplication) ──────

def to_source_status(failure: ProviderFailure | str) -> str:
    """
    Map the Phase 3Q failure taxonomy onto the existing
    `paper.providers.SourceStatus` string values so the existing ProviderChain
    consumes it unchanged.
    """
    f = ProviderFailure(failure)
    mapping = {
        ProviderFailure.OK:                    "OK",
        ProviderFailure.NO_DATA:               "OK",          # source healthy, empty answer
        ProviderFailure.MARKET_CLOSED:         "OK",
        ProviderFailure.SYMBOL_NOT_SUPPORTED:  "UNCONFIGURED",
        ProviderFailure.DATA_STALE:            "DEGRADED",
        ProviderFailure.RATE_LIMITED:          "DEGRADED",
        ProviderFailure.NETWORK_FAILURE:       "TIMEOUT",
        ProviderFailure.AUTH_FAILURE:          "ERROR",
        ProviderFailure.DATA_INVALID:          "ERROR",
        ProviderFailure.PROVIDER_FAILURE:      "ERROR",
        ProviderFailure.UNKNOWN_PROVIDER_ERROR: "ERROR",
    }
    return mapping[f]


def to_response_status(failure: ProviderFailure | str) -> str:
    """Map onto `paper.providers.ResponseStatus` string values."""
    f = ProviderFailure(failure)
    if f == ProviderFailure.OK:
        return "PRIMARY"
    if f == ProviderFailure.DATA_STALE:
        return "STALE"
    if f == ProviderFailure.DATA_INVALID:
        return "INVALID"
    # NO_DATA / MARKET_CLOSED / SYMBOL_NOT_SUPPORTED / failures → UNAVAILABLE
    return "UNAVAILABLE"
