"""
tests/providers/test_v8_foundation.py — Data Foundation V8 unit tests.

Tests for:
  - 3m rejection at all Python layer boundaries
  - Provider capability registry correctness
  - Provenance record construction
  - CanonicalCandle validation rules
  - Reconciliation engine logic
  - Quality scoring engine
  - Universe snapshot building
  - Acquisition planner

No network calls. No DB writes. Pure unit tests.
"""

import hashlib
import math
from datetime import date, datetime, timezone
from typing import Optional

import pytest

# ---------------------------------------------------------------------------
# Imports under test
# ---------------------------------------------------------------------------

from src.providers.common.registry import (
    SUPPORTED_TIMEFRAMES,
    ProviderCapability,
    DatasetType,
    InstrumentClass,
    ReliabilityClass,
    capabilities_for,
    providers_for_dataset,
    max_range_days,
    requests_per_second,
    is_authenticated_provider,
)
from src.providers.common.normalizer import (
    CanonicalCandle,
    validate_batch,
    validate_interval,
    BARS_PER_SESSION,
)
from src.providers.common.provenance import (
    build_provenance,
    build_raw_record,
    compute_response_hash,
    credential_identity_hash,
    DataProvenanceRecord,
    SOURCE_TYPE_BROKER_AUTHENTICATED,
    SOURCE_TYPE_OPEN_SOURCE_NSE_DERIVED,
    SOURCE_TYPE_YAHOO_FALLBACK,
    TRUST_VERIFIED_SINGLE_SOURCE,
    TRUST_UNVERIFIED,
    current_dataset_version,
)
from src.providers.common.reconciliation import (
    reconcile_candle_pair,
    reconcile_batch,
    ReconciliationTolerances,
    RECON_MATCHED,
    RECON_WITHIN_TOLERANCE,
    RECON_MINOR_DISCREPANCY,
    RECON_MAJOR_DISCREPANCY,
    RECON_SOURCE_ONLY,
)
from src.providers.common.quality import (
    compute_quality_score,
    QualityInput,
    STATUS_VERIFIED_RECONCILED,
    STATUS_VERIFIED_SINGLE_SOURCE,
    STATUS_DEGRADED,
    STATUS_UNVERIFIED,
    STATUS_INVALID,
)
from src.providers.common.acquisition_planner import (
    plan_acquisition,
    AcquisitionPlan,
)
from src.providers.common.universe import (
    FnoUniverseEntry,
    build_universe_snapshot,
    compute_universe_checksum,
    LIFECYCLE_ACTIVE,
    LIFECYCLE_ADDED,
    LIFECYCLE_REMOVED,
)


# ===========================================================================
# 1. 3m Rejection — permanent removal
# ===========================================================================

class Test3mRejection:
    """V8: 3m must be rejected at every Python layer boundary."""

    def test_supported_timeframes_excludes_3m(self):
        assert "3m" not in SUPPORTED_TIMEFRAMES, (
            "3m must not be in SUPPORTED_TIMEFRAMES — permanently removed in V8"
        )
        assert "1m" in SUPPORTED_TIMEFRAMES
        assert "5m" in SUPPORTED_TIMEFRAMES
        assert len(SUPPORTED_TIMEFRAMES) == 9

    def test_validate_interval_rejects_3m(self):
        with pytest.raises(ValueError, match="3m.*removed"):
            validate_interval("3m")

    def test_validate_interval_accepts_supported(self):
        for tf in ["1m", "5m", "10m", "15m", "30m", "1h", "1d", "1w", "1M"]:
            validate_interval(tf)  # should not raise

    def test_registry_has_no_3m_capability(self):
        for provider in ["angel_one", "upstox", "jugaad", "openchart", "yahoo"]:
            caps = capabilities_for(provider, timeframe="3m")
            # ProviderCapability.__post_init__ would have raised on creation
            # but we can also verify via query
            assert len(caps) == 0, (
                f"Provider '{provider}' must not have any 3m capability (V8 removal)"
            )

    def test_registry_capability_raises_on_3m_creation(self):
        with pytest.raises(ValueError, match="3m"):
            ProviderCapability(
                provider="test", dataset=DatasetType.INTRADAY_OHLCV,
                instrumentClass=InstrumentClass.EQUITY, timeframe="3m",
                historical=True, realtime=True, authenticated=False,
                requiresCredentials=False, maximumRangeDays=14, requestsPerSecond=1.0,
            )

    def test_providers_for_dataset_raises_on_3m(self):
        with pytest.raises(ValueError, match="3m.*removed"):
            providers_for_dataset(DatasetType.INTRADAY_OHLCV, timeframe="3m")

    def test_acquisition_planner_blocks_3m(self):
        plan = plan_acquisition(
            provider="upstox",
            instrument_id="RELIANCE",
            exchange="NSE",
            interval_str="3m",
            from_date=date(2026, 1, 1),
            to_date=date(2026, 1, 31),
        )
        assert not plan.feasible
        assert "3m" in plan.blocked_reason
        assert plan.chunks == []

    def test_build_provenance_raises_on_3m(self):
        with pytest.raises(ValueError, match="3m.*not supported"):
            build_provenance(
                provider="upstox",
                instrument_id="RELIANCE",
                exchange="NSE",
                interval_str="3m",
                session_date="2026-09-12",
                row_count=10,
            )

    def test_bars_per_session_excludes_3m(self):
        assert "3m" not in BARS_PER_SESSION


# ===========================================================================
# 2. Provider Capability Registry
# ===========================================================================

class TestProviderRegistry:
    """Registry must reflect real, verified provider capabilities."""

    def test_angel_one_is_authenticated(self):
        assert is_authenticated_provider("angel_one")

    def test_upstox_is_authenticated(self):
        assert is_authenticated_provider("upstox")

    def test_jugaad_is_not_authenticated(self):
        assert not is_authenticated_provider("jugaad")

    def test_openchart_is_not_authenticated(self):
        assert not is_authenticated_provider("openchart")

    def test_yahoo_is_not_authenticated(self):
        assert not is_authenticated_provider("yahoo")

    def test_jugaad_supports_eod_only(self):
        caps = capabilities_for("jugaad")
        for cap in caps:
            assert cap.timeframe == "1d", (
                f"Jugaad should only have 1d capability, got {cap.timeframe}"
            )

    def test_jugaad_supports_oi_for_fno(self):
        fno_caps = capabilities_for(
            "jugaad", dataset=DatasetType.FNO_EOD, timeframe="1d"
        )
        assert len(fno_caps) > 0
        assert any(c.supportsOI for c in fno_caps)

    def test_openchart_supports_full_range_no_live(self):
        for tf in ["1m", "5m", "10m", "15m", "30m", "1h", "1d", "1w", "1M"]:
            caps = capabilities_for("openchart", timeframe=tf)
            assert len(caps) > 0, f"openchart must support {tf}"
            for cap in caps:
                assert cap.realtime is False, (
                    f"openchart must not claim realtime for {tf}"
                )
                assert not cap.supportsOI, (
                    f"openchart must not claim OI support for {tf}"
                )
                assert not cap.supportsIV, (
                    f"openchart must not claim IV support for {tf}"
                )

    def test_angel_one_no_index_history(self):
        """Angel returns 0 for index tokens — not registered as index history source."""
        # Angel caps are for EQUITY only
        index_caps = capabilities_for(
            "angel_one",
            instrument_class=InstrumentClass.INDEX,
        )
        # Angel should have no INDEX-specific capabilities (only EQUITY)
        for cap in index_caps:
            assert cap.instrumentClass == InstrumentClass.EQUITY or \
                   cap.instrumentClass == InstrumentClass.ALL

    def test_max_range_days_angel_1m(self):
        days = max_range_days("angel_one", "1m")
        assert days is not None
        assert days <= 30  # conservative per matrix

    def test_max_range_days_upstox_1m(self):
        days = max_range_days("upstox", "1m")
        assert days is not None
        assert days <= 7  # Upstox 1m capped to avoid HTTP 400

    def test_openchart_rps_is_conservative(self):
        rps = requests_per_second("openchart")
        assert rps <= 1.5  # never more than 1.5 req/s for NSE charting platform

    def test_provider_source_types_in_provenance(self):
        prov = build_provenance("angel_one", "RELIANCE", "NSE", "1d", "2026-09-12", 10)
        assert prov.sourceType == SOURCE_TYPE_BROKER_AUTHENTICATED
        assert prov.authenticated is True

        prov2 = build_provenance("jugaad", "RELIANCE", "NSE", "1d", "2026-09-12", 10)
        assert prov2.sourceType == SOURCE_TYPE_OPEN_SOURCE_NSE_DERIVED
        assert prov2.authenticated is False

        prov3 = build_provenance("yahoo", "RELIANCE", "NSE", "1d", "2026-09-12", 10)
        assert prov3.sourceType == SOURCE_TYPE_YAHOO_FALLBACK
        assert prov3.authenticated is False


# ===========================================================================
# 3. Canonical Candle Validation
# ===========================================================================

def _make_candle(**overrides) -> CanonicalCandle:
    defaults = dict(
        instrumentId="RELIANCE", exchange="NSE",
        intervalStr="5m", sessionDate="2026-09-12",
        provider="angel_one", time=1757727900,  # valid UTC epoch
        open=2900.0, high=2910.0, low=2895.0, close=2905.0,
        volume=10000.0,
    )
    defaults.update(overrides)
    return CanonicalCandle(**defaults)


class TestCandleValidation:
    def test_valid_candle_passes(self):
        c = _make_candle()
        assert c.is_valid
        assert c.validate() == []

    def test_3m_interval_rejected(self):
        c = _make_candle(intervalStr="3m")
        errors = c.validate()
        assert any("3m" in e for e in errors)

    def test_negative_open_rejected(self):
        c = _make_candle(open=-1.0)
        errors = c.validate()
        assert any("open" in e for e in errors)

    def test_high_lt_close_rejected(self):
        c = _make_candle(high=2800.0, close=2900.0)
        errors = c.validate()
        assert any("high" in e for e in errors)

    def test_low_gt_open_rejected(self):
        c = _make_candle(low=3000.0, open=2900.0)
        errors = c.validate()
        assert any("low" in e for e in errors)

    def test_negative_volume_rejected(self):
        c = _make_candle(volume=-100.0, volumeUnavailable=False)
        errors = c.validate()
        assert any("volume" in e for e in errors)

    def test_null_oi_stays_null_not_zero(self):
        """OI must stay None when source doesn't supply it — never converted to 0."""
        c = _make_candle(oi=None)
        assert c.oi is None
        assert c.is_valid

    def test_zero_oi_is_invalid_when_suspicious(self):
        """Negative OI must be caught."""
        c = _make_candle(oi=-500.0)
        errors = c.validate()
        assert any("oi" in e for e in errors)

    def test_invalid_option_type_caught(self):
        c = _make_candle(optionType="XX")
        errors = c.validate()
        assert any("option_type" in e for e in errors)

    def test_derived_without_source_timeframe_caught(self):
        c = _make_candle(derived=True, sourceTimeframe=None)
        errors = c.validate()
        assert any("sourceTimeframe" in e for e in errors)

    def test_validate_batch_separates_valid_invalid(self):
        good = _make_candle()
        bad = _make_candle(open=-1.0)
        valid, dropped = validate_batch([good, bad])
        assert len(valid) == 1
        assert len(dropped) == 1
        assert valid[0].open == 2900.0


# ===========================================================================
# 4. Provenance
# ===========================================================================

class TestProvenance:
    def test_credential_is_never_stored(self):
        """Credential must be hashed — raw value never in the record."""
        raw_cred = "secret-api-key-12345"
        prov = build_provenance(
            "angel_one", "RELIANCE", "NSE", "1d", "2026-09-12", 5,
            credential=raw_cred,
        )
        d = prov.to_db_dict()
        assert raw_cred not in str(d), "Raw credential must NOT appear in provenance dict"
        assert prov.credentialIdentityHash is not None
        assert prov.credentialIdentityHash == hashlib.sha256(
            raw_cred.encode()
        ).hexdigest()

    def test_response_hash_is_deterministic(self):
        data = [{"time": 1, "open": 100}]
        h1 = compute_response_hash(data)
        h2 = compute_response_hash(data)
        assert h1 == h2
        assert len(h1) == 64  # SHA-256 hex

    def test_dataset_version_format(self):
        v = current_dataset_version()
        # Should be YYYY-MM-DD-v1
        assert len(v) >= 12
        assert "-v" in v

    def test_raw_record_endpoint_no_tokens(self):
        """Endpoint string must not contain auth tokens."""
        record = build_raw_record(
            provider="angel_one",
            endpoint="https://apiconnect.angelbroking.com/rest/secure/angelbroking/historical/v1/getCandleData",
            instrument_id="RELIANCE",
            exchange="NSE",
            interval_str="1d",
            request_params={"symbol": "RELIANCE", "interval": "1d"},
            raw_response=[{"time": 1, "close": 2900}],
        )
        # Endpoint does not contain obvious auth tokens
        assert "Bearer" not in record.endpoint
        assert "secret" not in record.endpoint.lower()

    def test_raw_record_large_response_truncated(self):
        """Response > 50KB must be truncated in the raw record."""
        big_response = [{"time": i, "data": "x" * 500} for i in range(200)]
        record = build_raw_record(
            provider="openchart",
            endpoint="openchart.NSEData.historical",
            instrument_id="RELIANCE",
            exchange="NSE",
            interval_str="1d",
            request_params={},
            raw_response=big_response,
        )
        # Large response should be truncated
        if record.rawResponseJson is not None:
            import json
            size = len(json.dumps(record.rawResponseJson).encode())
            assert size <= 55 * 1024, f"Raw response too large: {size} bytes"


# ===========================================================================
# 5. Reconciliation Engine
# ===========================================================================

class TestReconciliation:
    def _pair(self, provA, provB, closeA=2905.0, closeB=2905.0, oiA=None, oiB=None):
        ca = _make_candle(provider=provA, close=closeA, oi=oiA)
        cb = _make_candle(provider=provB, close=closeB, oi=oiB)
        return ca, cb

    def test_identical_candles_matched(self):
        ca, cb = self._pair("angel_one", "upstox")
        r = reconcile_candle_pair(ca, cb)
        assert r.reconciliationStatus == RECON_MATCHED

    def test_tiny_diff_within_tolerance(self):
        ca, cb = self._pair("angel_one", "openchart", closeA=2905.00, closeB=2905.03)
        r = reconcile_candle_pair(ca, cb)
        assert r.reconciliationStatus == RECON_WITHIN_TOLERANCE

    def test_small_diff_minor_discrepancy(self):
        ca, cb = self._pair("angel_one", "openchart", closeA=2905.0, closeB=2906.0)
        tol = ReconciliationTolerances(price_within_tolerance=0.05, price_minor_threshold=2.0)
        r = reconcile_candle_pair(ca, cb, tolerances=tol)
        assert r.reconciliationStatus == RECON_MINOR_DISCREPANCY

    def test_large_diff_major_discrepancy(self):
        ca, cb = self._pair("angel_one", "openchart", closeA=2905.0, closeB=2920.0)
        r = reconcile_candle_pair(ca, cb)
        assert r.reconciliationStatus == RECON_MAJOR_DISCREPANCY

    def test_oi_never_null_to_zero(self):
        """OI that is None in one provider must NOT be treated as 0 for comparison."""
        ca, cb = self._pair("angel_one", "jugaad", oiA=100000.0, oiB=None)
        r = reconcile_candle_pair(ca, cb)
        # oiB is None — no OI comparison performed, no fabricated 0
        assert r.oiB is None

    def test_batch_reconciliation_source_only(self):
        ca = _make_candle(time=1000, provider="angel_one")
        cb = _make_candle(time=2000, provider="upstox")
        # Different timestamps → no overlap
        results, matched, source_only = reconcile_batch([ca], [cb])
        assert matched == 0
        assert source_only == 2
        assert all(r.reconciliationStatus == RECON_SOURCE_ONLY for r in results)


# ===========================================================================
# 6. Quality Scoring
# ===========================================================================

class TestQualityScoring:
    def _inp(self, **overrides) -> QualityInput:
        defaults = dict(
            instrumentId="RELIANCE", exchange="NSE",
            intervalStr="5m", sessionDate="2026-09-12",
            provider="angel_one",
            actual_bars=75, expected_bars=75,
            valid_rows=75, total_rows=75,
            provenance_strength="BROKER_AUTHENTICATED",
            authenticated=True,
            reconciliation_status=RECON_MATCHED,
        )
        defaults.update(overrides)
        return QualityInput(**defaults)

    def test_perfect_data_verified_reconciled(self):
        r = compute_quality_score(self._inp())
        assert r.qualityScore is not None
        assert r.qualityScore >= 95
        assert r.qualityStatus == STATUS_VERIFIED_RECONCILED
        assert r.grade == "A"
        assert not r.criticalFailure

    def test_negative_oi_forces_invalid(self):
        r = compute_quality_score(self._inp(has_negative_oi=True))
        assert r.qualityStatus == STATUS_INVALID
        assert r.grade == "F"
        assert r.criticalFailure
        assert r.qualityScore is None

    def test_impossible_ohlc_forces_invalid(self):
        r = compute_quality_score(self._inp(has_impossible_ohlc=True))
        assert r.qualityStatus == STATUS_INVALID
        assert r.criticalFailure

    def test_missing_bars_degrades_score(self):
        # 50% completeness
        r = compute_quality_score(self._inp(actual_bars=37, expected_bars=75))
        assert r.qualityScore is not None
        assert r.qualityScore < 95
        assert r.qualityStatus in (STATUS_DEGRADED, STATUS_UNVERIFIED, STATUS_VERIFIED_SINGLE_SOURCE)
        assert r.completenessScore is not None
        assert r.completenessScore < 0.6

    def test_yahoo_provenance_lowers_score(self):
        r_broker = compute_quality_score(self._inp(
            provenance_strength="BROKER_AUTHENTICATED", reconciliation_status=RECON_MATCHED
        ))
        r_yahoo = compute_quality_score(self._inp(
            provenance_strength="AGGREGATED_DELAYED", reconciliation_status=RECON_MATCHED
        ))
        assert r_yahoo.qualityScore < r_broker.qualityScore

    def test_unreconciled_cannot_be_verified_reconciled(self):
        r = compute_quality_score(self._inp(reconciliation_status=RECON_SOURCE_ONLY))
        # VERIFIED_RECONCILED requires actual reconciliation match
        assert r.qualityStatus != STATUS_VERIFIED_RECONCILED

    def test_formula_is_deterministic(self):
        inp = self._inp()
        r1 = compute_quality_score(inp)
        r2 = compute_quality_score(inp)
        assert r1.qualityScore == r2.qualityScore
        assert r1.qualityStatus == r2.qualityStatus


# ===========================================================================
# 7. Acquisition Planner
# ===========================================================================

class TestAcquisitionPlanner:
    def test_3m_always_blocked(self):
        for provider in ["angel_one", "upstox", "jugaad", "openchart"]:
            plan = plan_acquisition(
                provider=provider, instrument_id="RELIANCE", exchange="NSE",
                interval_str="3m",
                from_date=date(2026, 1, 1), to_date=date(2026, 1, 31),
            )
            assert not plan.feasible
            assert "3m" in plan.blocked_reason

    def test_angel_1m_chunks_respect_30d_limit(self):
        plan = plan_acquisition(
            "angel_one", "RELIANCE", "NSE", "1m",
            date(2026, 1, 1), date(2026, 6, 30),
        )
        assert plan.feasible
        for chunk in plan.chunks:
            days = (chunk.to_date - chunk.from_date).days + 1
            assert days <= 30, f"Chunk {chunk.chunk_idx} exceeds 30 days"

    def test_upstox_1m_chunks_respect_7d_limit(self):
        plan = plan_acquisition(
            "upstox", "RELIANCE", "NSE", "1m",
            date(2026, 1, 1), date(2026, 3, 31),
        )
        assert plan.feasible
        for chunk in plan.chunks:
            days = (chunk.to_date - chunk.from_date).days + 1
            assert days <= 7, f"Chunk {chunk.chunk_idx} exceeds 7 days"

    def test_jugaad_only_1d_feasible(self):
        plan_1d = plan_acquisition(
            "jugaad", "RELIANCE", "NSE", "1d",
            date(2026, 1, 1), date(2026, 3, 31),
        )
        assert plan_1d.feasible

        plan_5m = plan_acquisition(
            "jugaad", "RELIANCE", "NSE", "5m",
            date(2026, 1, 1), date(2026, 1, 31),
        )
        assert not plan_5m.feasible

    def test_openchart_supports_1w_1M(self):
        for tf in ("1w", "1M"):
            plan = plan_acquisition(
                "openchart", "RELIANCE", "NSE", tf,
                date(2024, 1, 1), date(2026, 9, 12),
            )
            assert plan.feasible, f"openchart must support {tf}"

    def test_invalid_date_range_blocked(self):
        plan = plan_acquisition(
            "angel_one", "RELIANCE", "NSE", "1d",
            date(2026, 3, 31), date(2026, 1, 1),  # to_date < from_date
        )
        assert not plan.feasible

    def test_expected_candles_reasonable(self):
        # 1 year of 5m data ≈ 252 * 75 = 18,900 bars
        plan = plan_acquisition(
            "angel_one", "RELIANCE", "NSE", "5m",
            date(2025, 9, 12), date(2026, 9, 12),
        )
        assert plan.feasible
        assert plan.expected_candles > 15_000  # at least 15k bars in a year


# ===========================================================================
# 8. Universe Snapshot
# ===========================================================================

class TestUniverseSnapshot:
    def _entries(self, symbols) -> list[FnoUniverseEntry]:
        return [
            FnoUniverseEntry(
                symbol=sym, exchange="NSE", instrumentType="EQ",
                angelToken=f"tok_{sym}", fnoEligible=True,
            )
            for sym in symbols
        ]

    def test_checksum_is_deterministic(self):
        entries = self._entries(["RELIANCE", "TCS", "HDFCBANK"])
        c1 = compute_universe_checksum(entries)
        c2 = compute_universe_checksum(entries)
        assert c1 == c2
        assert len(c1) == 64  # SHA-256 hex

    def test_checksum_changes_on_different_universe(self):
        e1 = self._entries(["RELIANCE", "TCS"])
        e2 = self._entries(["RELIANCE", "TCS", "INFY"])
        assert compute_universe_checksum(e1) != compute_universe_checksum(e2)

    def test_snapshot_never_deletes_previous(self):
        """Universe builds are append-only — old snapshots are never overwritten."""
        prev = self._entries(["RELIANCE", "TCS"])
        curr = self._entries(["RELIANCE", "TCS", "INFY"])
        snap = build_universe_snapshot("angel_one", curr, previous_entries=prev)
        # New symbol marked as ADDED
        added = [e for e in snap.constituents if e.symbol == "INFY"]
        assert len(added) == 1
        assert added[0].lifecycleStatus == LIFECYCLE_ADDED
        # Old symbols still active
        active = [e for e in snap.constituents if e.symbol in ("RELIANCE", "TCS")]
        assert all(e.lifecycleStatus == LIFECYCLE_ACTIVE for e in active)

    def test_removed_symbols_tracked(self):
        prev = self._entries(["RELIANCE", "TCS", "SUNPHARMA"])
        curr = self._entries(["RELIANCE", "TCS"])  # SUNPHARMA removed
        snap = build_universe_snapshot("angel_one", curr, previous_entries=prev)
        removed = [e for e in snap.constituents if e.lifecycleStatus == LIFECYCLE_REMOVED]
        assert any(e.symbol == "SUNPHARMA" for e in removed)
        assert snap.removedCount == 1

    def test_snapshot_has_correct_counts(self):
        entries = self._entries(["RELIANCE", "TCS", "HDFCBANK", "INFY", "SBIN"])
        snap = build_universe_snapshot("angel_one", entries)
        assert snap.constituentCount == 5
        assert snap.fnoEquityCount == 5
        assert snap.fnoIndexCount == 0
        assert snap.checksum is not None
        assert snap.universeVersion.endswith("#angel_one")

    def test_snapshot_version_includes_provider(self):
        entries = self._entries(["RELIANCE"])
        snap = build_universe_snapshot("upstox", entries)
        assert "upstox" in snap.universeVersion
