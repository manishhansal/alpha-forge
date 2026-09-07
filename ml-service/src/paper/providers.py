"""
Phase 3N — Canonical provider-response contract + fallback semantics (spec §6–§9).

This module does NOT acquire data. It defines:

  1. The canonical provider hierarchy (Tier 0→3): DataService → Angel One →
     Upstox → Yahoo. There is NO 'nse' provider here — direct NSE acquisition
     belongs only to the data-service tier (spec §2). No new scraper is created.

  2. A single canonical `ProviderResponse` contract carrying enough metadata to
     identify provider / version / timestamps / instrument / exchange / asset
     type / timeframe / data window / source+response status / raw+normalized
     snapshot ids / schema version (spec §6). This normalizes onto the concepts
     already defined in `data-service/src/core/schemas_v2.py` (DataProvenance,
     DataSource, ProviderHealthV2) without duplicating acquisition.

  3. Explicit fallback semantics (spec §7): PRIMARY / FALLBACK / PARTIAL / STALE
     / INVALID / UNAVAILABLE. Every fallback event is recorded. Providers are
     NEVER silently merged (spec §6): the chain returns the FIRST usable
     response and records why each earlier provider was skipped.

  4. Config-driven cross-provider consistency validation (spec §8, §9): exact
     fields (timestamp, instrument identity) vs tolerant numeric fields (OHLC,
     volume, OI) vs provider-specific fields. All mismatches are classified;
     tolerances live in `ConsistencyPolicy`, never hard-coded at call sites.

Determinism: pure stdlib. No np.random.*. Import-clean.
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from enum import Enum
from typing import Callable, Optional

UTC = timezone.utc


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


# ══════════════════════════════════════════════════════════════════════════════
# Canonical provider hierarchy (spec §2) — matches src/lib/market-data (TS)
# ══════════════════════════════════════════════════════════════════════════════

class ProviderId(str, Enum):
    """
    Canonical data providers, in acquisition priority order. There is deliberately
    NO ``nse`` provider: direct NSE acquisition is prohibited outside the
    data-service tier (which the ``data_service`` provider fronts).
    """
    DATA_SERVICE = "data_service"   # Tier 0 — Scrapling / exchange-official Bhavcopy
    ANGEL_ONE    = "angel_one"      # Tier 1 — Angel One SmartAPI (via Next.js /api/in)
    UPSTOX       = "upstox"         # Tier 2 — Upstox API
    YAHOO        = "yahoo"          # Tier 3 — Yahoo Finance last-resort fallback


# Fixed priority order (Tier 0 → Tier 3).
PROVIDER_HIERARCHY: tuple[ProviderId, ...] = (
    ProviderId.DATA_SERVICE,
    ProviderId.ANGEL_ONE,
    ProviderId.UPSTOX,
    ProviderId.YAHOO,
)


class AssetType(str, Enum):
    EQUITY  = "EQUITY"
    INDEX   = "INDEX"
    FUTURE  = "FUTURE"
    OPTION  = "OPTION"
    UNKNOWN = "UNKNOWN"


class DataTag(str, Enum):
    """Provenance of the underlying bytes — official evidence separation (spec §57)."""
    REAL_MARKET_DATA = "REAL_MARKET_DATA"
    REPLAY_DATA      = "REPLAY_DATA"
    SYNTHETIC_DATA   = "SYNTHETIC_DATA"
    MOCK_DATA        = "MOCK_DATA"


# ══════════════════════════════════════════════════════════════════════════════
# Status / fallback vocabulary (spec §7)
# ══════════════════════════════════════════════════════════════════════════════

class SourceStatus(str, Enum):
    """Health of the upstream source that produced (or failed to produce) a response."""
    OK          = "OK"
    DEGRADED    = "DEGRADED"     # up but stale/partial
    TIMEOUT     = "TIMEOUT"
    ERROR       = "ERROR"        # malformed / HTTP error
    UNCONFIGURED = "UNCONFIGURED"  # provider not configured (not a failure)
    UNAVAILABLE = "UNAVAILABLE"


class ResponseStatus(str, Enum):
    """
    Classification of a single provider's response payload (spec §7). This is the
    per-provider verdict; `FallbackRole` records how it was used in the chain.
    """
    PRIMARY     = "PRIMARY"      # complete, fresh, from the highest-priority provider
    FALLBACK    = "FALLBACK"     # complete, used because a higher provider failed
    PARTIAL     = "PARTIAL"      # some required fields present, some missing
    STALE       = "STALE"        # data older than the freshness policy allows
    INVALID     = "INVALID"      # failed quality/schema validation
    UNAVAILABLE = "UNAVAILABLE"  # no data produced


class FallbackRole(str, Enum):
    """The role a provider played in the resolved chain."""
    USED        = "USED"         # this provider's response was selected
    SKIPPED     = "SKIPPED"      # not attempted (a higher provider already succeeded)
    FAILED_OVER = "FAILED_OVER"  # attempted, failed → fell through to the next


# Responses that are NOT usable as the chain's answer (fail-closed).
_UNUSABLE_RESPONSE_STATES: frozenset[ResponseStatus] = frozenset({
    ResponseStatus.INVALID,
    ResponseStatus.UNAVAILABLE,
})


# ══════════════════════════════════════════════════════════════════════════════
# Canonical provider response contract (spec §6)
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class ProviderResponse:
    """
    Canonical, provider-agnostic response envelope (spec §6). Normalizes onto the
    `data-service/src/core/schemas_v2.py` concepts (DataProvenance / DataSource /
    ProviderHealthV2) so provenance is uniform across the ml-service.

    A response carries enough metadata to fully identify what was fetched, from
    where, when, and whether it is trustworthy. Missing values are ``None`` —
    never a substituted default (spec §41).
    """
    # identity
    provider:            str                     # ProviderId value
    provider_version:    str = ""
    # timing
    request_timestamp:   str = ""                # when we asked
    market_timestamp:    Optional[str] = None    # last market event time in the payload
    # instrument identity
    instrument:          str = ""                # canonical instrument id
    symbol:              str = ""
    exchange:            str = ""                # NSE / NFO / BSE / ...
    asset_type:          str = AssetType.UNKNOWN.value
    timeframe:           str = ""                # 1d / 5m / ...
    # data window
    data_start:          Optional[str] = None
    data_end:            Optional[str] = None
    bar_count:           int = 0
    # status
    source_status:       str = SourceStatus.UNAVAILABLE.value
    response_status:     str = ResponseStatus.UNAVAILABLE.value
    # snapshot identity / lineage
    raw_snapshot_id:     Optional[str] = None
    normalized_snapshot_id: Optional[str] = None
    schema_version:      str = "3n-provider-contract-v1"
    # data provenance tag (real vs synthetic vs replay) — official-evidence gate
    data_tag:            str = DataTag.SYNTHETIC_DATA.value
    # freshness / diagnostics
    data_age_seconds:    Optional[float] = None
    is_fallback:         bool = False
    notes:               str = ""
    created_at:          str = ""

    def __post_init__(self):
        if not self.created_at:
            self.created_at = _now_iso()
        if not self.request_timestamp:
            self.request_timestamp = self.created_at

    @property
    def usable(self) -> bool:
        """A response is usable as a chain answer unless INVALID/UNAVAILABLE."""
        try:
            rs = ResponseStatus(self.response_status)
        except ValueError:
            return False
        return rs not in _UNUSABLE_RESPONSE_STATES

    @property
    def is_real_market_data(self) -> bool:
        return self.data_tag == DataTag.REAL_MARKET_DATA.value

    def to_dict(self) -> dict:
        d = asdict(self)
        d["usable"] = self.usable
        return d

    @classmethod
    def from_dict(cls, d: dict) -> "ProviderResponse":
        known = {f for f in cls.__dataclass_fields__}  # type: ignore[attr-defined]
        return cls(**{k: v for k, v in d.items() if k in known})

    @classmethod
    def unavailable(cls, provider: str, reason: str,
                    source_status: str = SourceStatus.UNAVAILABLE.value) -> "ProviderResponse":
        """Fail-closed factory for a provider that produced nothing."""
        return cls(provider=provider, source_status=source_status,
                   response_status=ResponseStatus.UNAVAILABLE.value, notes=reason)


# ══════════════════════════════════════════════════════════════════════════════
# Fallback events + chain result (spec §7)
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class FallbackEvent:
    """Records exactly what happened for one provider during chain resolution."""
    provider:        str
    role:            str            # FallbackRole value
    source_status:   str
    response_status: str
    reason:          str = ""
    timestamp:       str = ""

    def __post_init__(self):
        if not self.timestamp:
            self.timestamp = _now_iso()

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class ProviderChainResult:
    """
    The resolved result of walking the provider hierarchy for one request.

    `selected` is the response that was used (or None if the whole chain failed
    closed). `events` records every provider's role — this is the auditable
    fallback trail. Providers are NEVER merged: exactly one response is selected.
    """
    request_key:  str
    selected:     Optional[ProviderResponse]
    events:       list[FallbackEvent] = field(default_factory=list)
    resolved_at:  str = ""

    def __post_init__(self):
        if not self.resolved_at:
            self.resolved_at = _now_iso()

    @property
    def ok(self) -> bool:
        return self.selected is not None and self.selected.usable

    @property
    def provider_used(self) -> Optional[str]:
        return self.selected.provider if self.selected else None

    @property
    def failed_over(self) -> bool:
        return any(e.role == FallbackRole.FAILED_OVER.value for e in self.events)

    def to_dict(self) -> dict:
        return {
            "request_key": self.request_key,
            "ok": self.ok,
            "provider_used": self.provider_used,
            "failed_over": self.failed_over,
            "selected": self.selected.to_dict() if self.selected else None,
            "events": [e.to_dict() for e in self.events],
            "resolved_at": self.resolved_at,
        }


class ProviderChain:
    """
    Resolves a request against the canonical provider hierarchy with explicit,
    recorded fallback semantics (spec §7). It NEVER merges providers and NEVER
    fabricates data — if every provider is unusable it returns a fail-closed
    result with a full event trail.

    The chain is acquisition-agnostic: the caller supplies a `fetch` callable
    `fetch(provider_id) -> ProviderResponse`. This keeps the module import-clean
    (no network dependency) and lets tests inject deterministic providers.
    """

    def __init__(self, hierarchy: tuple[ProviderId, ...] = PROVIDER_HIERARCHY,
                 enabled: Optional[dict[ProviderId, bool]] = None):
        self.hierarchy = hierarchy
        self.enabled = enabled or {}

    def resolve(self, request_key: str,
                fetch: Callable[[ProviderId], ProviderResponse]) -> ProviderChainResult:
        """
        Walk the hierarchy. Return the first USABLE response, promoting a
        higher-tier success to PRIMARY and a lower-tier success to FALLBACK.
        Records a FallbackEvent for every provider considered.
        """
        events: list[FallbackEvent] = []
        selected: Optional[ProviderResponse] = None
        higher_failed = False

        for pid in self.hierarchy:
            if not self.enabled.get(pid, True):
                events.append(FallbackEvent(
                    provider=pid.value, role=FallbackRole.SKIPPED.value,
                    source_status=SourceStatus.UNCONFIGURED.value,
                    response_status=ResponseStatus.UNAVAILABLE.value,
                    reason="provider disabled/unconfigured"))
                continue

            if selected is not None:
                # A higher-priority provider already answered — do NOT fetch more
                # (no silent merge). Record the remaining providers as SKIPPED.
                events.append(FallbackEvent(
                    provider=pid.value, role=FallbackRole.SKIPPED.value,
                    source_status=SourceStatus.OK.value,
                    response_status=ResponseStatus.UNAVAILABLE.value,
                    reason="higher-priority provider already selected"))
                continue

            try:
                resp = fetch(pid)
            except Exception as exc:  # a provider raising is a failover, not a crash
                events.append(FallbackEvent(
                    provider=pid.value, role=FallbackRole.FAILED_OVER.value,
                    source_status=SourceStatus.ERROR.value,
                    response_status=ResponseStatus.UNAVAILABLE.value,
                    reason=f"fetch raised: {exc}"))
                higher_failed = True
                continue

            if resp is None or not resp.usable:
                events.append(FallbackEvent(
                    provider=pid.value, role=FallbackRole.FAILED_OVER.value,
                    source_status=(resp.source_status if resp else SourceStatus.UNAVAILABLE.value),
                    response_status=(resp.response_status if resp else ResponseStatus.UNAVAILABLE.value),
                    reason=(resp.notes if resp else "no response")))
                higher_failed = True
                continue

            # usable — select it. Mark PRIMARY only if no higher provider failed.
            resp.is_fallback = higher_failed
            if higher_failed and resp.response_status == ResponseStatus.PRIMARY.value:
                resp.response_status = ResponseStatus.FALLBACK.value
            selected = resp
            events.append(FallbackEvent(
                provider=pid.value, role=FallbackRole.USED.value,
                source_status=resp.source_status,
                response_status=resp.response_status,
                reason="selected"))

        return ProviderChainResult(request_key=request_key, selected=selected, events=events)


# ══════════════════════════════════════════════════════════════════════════════
# Cross-provider consistency validation (spec §8, §9)
# ══════════════════════════════════════════════════════════════════════════════

class FieldClass(str, Enum):
    STRICT           = "STRICT"            # must match exactly (timestamp, identity)
    TOLERANT_NUMERIC = "TOLERANT_NUMERIC"  # numeric within relative/absolute tolerance
    PROVIDER_SPECIFIC = "PROVIDER_SPECIFIC" # not compared across providers


@dataclass(frozen=True)
class FieldTolerance:
    """Tolerance for one tolerant-numeric field. Config-driven, not hard-coded."""
    rel_tol: float = 0.001   # 0.1% relative
    abs_tol: float = 0.0


@dataclass(frozen=True)
class ConsistencyPolicy:
    """
    Config-driven cross-provider consistency thresholds (spec §9). Field classes
    and tolerances live here, never scattered as literals through call sites.
    """
    version: str = "3n-consistency-policy-v1"
    strict_fields: tuple[str, ...] = ("timestamp", "instrument", "exchange")
    tolerant_fields: tuple[str, ...] = ("open", "high", "low", "close", "volume", "oi")
    provider_specific_fields: tuple[str, ...] = ("source", "raw_snapshot_id")
    tolerances: dict[str, FieldTolerance] = field(default_factory=lambda: {
        "open":   FieldTolerance(rel_tol=0.002),
        "high":   FieldTolerance(rel_tol=0.002),
        "low":    FieldTolerance(rel_tol=0.002),
        "close":  FieldTolerance(rel_tol=0.002),
        "volume": FieldTolerance(rel_tol=0.05),   # volume differs more across venues
        "oi":     FieldTolerance(rel_tol=0.05),
    })

    def field_class(self, name: str) -> FieldClass:
        if name in self.strict_fields:
            return FieldClass.STRICT
        if name in self.tolerant_fields:
            return FieldClass.TOLERANT_NUMERIC
        return FieldClass.PROVIDER_SPECIFIC


@dataclass
class FieldMismatch:
    """A single classified cross-provider field disagreement."""
    field:           str
    field_class:     str
    provider_a:      str
    provider_b:      str
    value_a:         object
    value_b:         object
    abs_diff:        Optional[float] = None
    rel_diff:        Optional[float] = None
    within_tolerance: bool = False

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class CrossProviderComparison:
    """Result of comparing two providers' payloads for one instrument (spec §8)."""
    provider_a:      str
    provider_b:      str
    instrument:      str
    n_fields:        int = 0
    mismatches:      list[FieldMismatch] = field(default_factory=list)
    missingness_a:   list[str] = field(default_factory=list)
    missingness_b:   list[str] = field(default_factory=list)
    timestamp_offset_seconds: Optional[float] = None
    bar_count_diff:  Optional[int] = None
    duplicate_bars_a: int = 0
    duplicate_bars_b: int = 0

    @property
    def strict_mismatch(self) -> bool:
        return any(m.field_class == FieldClass.STRICT.value and not m.within_tolerance
                   for m in self.mismatches)

    @property
    def tolerant_breaches(self) -> list[FieldMismatch]:
        return [m for m in self.mismatches
                if m.field_class == FieldClass.TOLERANT_NUMERIC.value and not m.within_tolerance]

    @property
    def consistent(self) -> bool:
        """Consistent iff no strict mismatch and no tolerant field out of tolerance."""
        return not self.strict_mismatch and not self.tolerant_breaches

    def to_dict(self) -> dict:
        return {
            "provider_a": self.provider_a,
            "provider_b": self.provider_b,
            "instrument": self.instrument,
            "n_fields": self.n_fields,
            "consistent": self.consistent,
            "strict_mismatch": self.strict_mismatch,
            "timestamp_offset_seconds": self.timestamp_offset_seconds,
            "bar_count_diff": self.bar_count_diff,
            "duplicate_bars_a": self.duplicate_bars_a,
            "duplicate_bars_b": self.duplicate_bars_b,
            "missingness_a": self.missingness_a,
            "missingness_b": self.missingness_b,
            "mismatches": [m.to_dict() for m in self.mismatches],
        }


def _rel_diff(a: float, b: float) -> float:
    denom = max(abs(a), abs(b))
    return 0.0 if denom == 0 else abs(a - b) / denom


def cross_provider_compare(
    provider_a: str, provider_b: str, instrument: str,
    bar_a: dict, bar_b: dict,
    policy: Optional[ConsistencyPolicy] = None,
) -> CrossProviderComparison:
    """
    Compare two providers' bar dicts for one instrument (spec §8, §9). Fields are
    classified STRICT / TOLERANT_NUMERIC / PROVIDER_SPECIFIC by the policy; every
    disagreement is recorded and classified. Providers are NOT assumed equivalent.

    `bar_a` / `bar_b` are plain dicts (e.g. {timestamp, open, high, low, close,
    volume, oi, instrument, exchange, ...}). Missing keys are recorded as
    missingness, never treated as zero.
    """
    pol = policy or ConsistencyPolicy()
    cmp = CrossProviderComparison(provider_a=provider_a, provider_b=provider_b,
                                  instrument=instrument)

    all_fields = set(bar_a) | set(bar_b)
    comparable = [f for f in all_fields
                  if pol.field_class(f) != FieldClass.PROVIDER_SPECIFIC]
    cmp.n_fields = len(comparable)

    for f in sorted(comparable):
        in_a, in_b = f in bar_a, f in bar_b
        if not in_a:
            cmp.missingness_a.append(f)
        if not in_b:
            cmp.missingness_b.append(f)
        if not (in_a and in_b):
            continue

        va, vb = bar_a[f], bar_b[f]
        fclass = pol.field_class(f)

        if fclass == FieldClass.STRICT:
            within = (va == vb)
            cmp.mismatches.append(FieldMismatch(
                field=f, field_class=fclass.value,
                provider_a=provider_a, provider_b=provider_b,
                value_a=va, value_b=vb, within_tolerance=within)) if not within else None
        else:  # TOLERANT_NUMERIC
            try:
                fa, fb = float(va), float(vb)
            except (TypeError, ValueError):
                cmp.mismatches.append(FieldMismatch(
                    field=f, field_class=fclass.value,
                    provider_a=provider_a, provider_b=provider_b,
                    value_a=va, value_b=vb, within_tolerance=False))
                continue
            tol = pol.tolerances.get(f, FieldTolerance())
            adiff = abs(fa - fb)
            rdiff = _rel_diff(fa, fb)
            within = (adiff <= tol.abs_tol) or (rdiff <= tol.rel_tol)
            if not within:
                cmp.mismatches.append(FieldMismatch(
                    field=f, field_class=fclass.value,
                    provider_a=provider_a, provider_b=provider_b,
                    value_a=fa, value_b=fb, abs_diff=adiff, rel_diff=rdiff,
                    within_tolerance=False))

    # timestamp offset (informational) if both carry a timestamp
    ta, tb = bar_a.get("timestamp"), bar_b.get("timestamp")
    if isinstance(ta, (int, float)) and isinstance(tb, (int, float)):
        cmp.timestamp_offset_seconds = float(abs(ta - tb))

    return cmp
