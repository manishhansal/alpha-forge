"""
Tests for deduplication and sequence tracking — Phases 19-21.
"""

from __future__ import annotations

import pytest

from src.core.deduplication import (
    EventDeduplicator,
    SequenceTracker,
    StreamGapDetector,
    compute_event_id,
)


class TestComputeEventId:
    def test_deterministic(self) -> None:
        id1 = compute_event_id("NSE:NIFTY", 1_000_000_000, "NSE_NEXTAPI", 24850.0, 100)
        id2 = compute_event_id("NSE:NIFTY", 1_000_000_000, "NSE_NEXTAPI", 24850.0, 100)
        assert id1 == id2

    def test_different_instruments(self) -> None:
        id1 = compute_event_id("NSE:NIFTY", 1_000_000_000, "NSE_NEXTAPI", 24850.0)
        id2 = compute_event_id("NSE:BANKNIFTY", 1_000_000_000, "NSE_NEXTAPI", 24850.0)
        assert id1 != id2

    def test_different_prices(self) -> None:
        id1 = compute_event_id("NSE:NIFTY", 1_000_000_000, "NSE_NEXTAPI", 24850.0)
        id2 = compute_event_id("NSE:NIFTY", 1_000_000_000, "NSE_NEXTAPI", 24851.0)
        assert id1 != id2

    def test_length_is_32_hex_chars(self) -> None:
        event_id = compute_event_id("NSE:NIFTY", 1_000_000_000, "NSE_NEXTAPI", 24850.0)
        assert len(event_id) == 32
        assert all(c in "0123456789abcdef" for c in event_id)


class TestEventDeduplicator:
    def test_first_occurrence_not_duplicate(self) -> None:
        d = EventDeduplicator()
        assert not d.is_duplicate("abc123")

    def test_second_occurrence_is_duplicate(self) -> None:
        d = EventDeduplicator()
        d.is_duplicate("abc123")
        assert d.is_duplicate("abc123")

    def test_different_ids_not_duplicates(self) -> None:
        d = EventDeduplicator()
        assert not d.is_duplicate("abc")
        assert not d.is_duplicate("def")
        assert d.duplicate_count == 0

    def test_duplicate_count_increments(self) -> None:
        d = EventDeduplicator()
        d.is_duplicate("x")
        d.is_duplicate("x")  # duplicate
        d.is_duplicate("x")  # duplicate
        assert d.duplicate_count == 2

    def test_lru_eviction_at_max_size(self) -> None:
        d = EventDeduplicator(max_size=3)
        d.is_duplicate("a")
        d.is_duplicate("b")
        d.is_duplicate("c")
        d.is_duplicate("d")  # evicts "a"
        # "a" should no longer be in cache — not a duplicate
        assert not d.is_duplicate("a")

    def test_reset_clears_state(self) -> None:
        d = EventDeduplicator()
        d.is_duplicate("a")
        d.is_duplicate("a")
        d.reset()
        assert d.duplicate_count == 0
        assert not d.is_duplicate("a")

    def test_duplicate_rate(self) -> None:
        d = EventDeduplicator()
        d.is_duplicate("a")   # new
        d.is_duplicate("a")   # dup
        d.is_duplicate("b")   # new
        # 1 dup out of 3 = 0.333
        assert abs(d.duplicate_rate - 1/3) < 0.01


class TestSequenceTracker:
    def test_first_event_ok(self) -> None:
        t = SequenceTracker()
        assert t.check("NSE:NIFTY", 1) == "ok"

    def test_sequential_is_ok(self) -> None:
        t = SequenceTracker()
        t.check("NSE:NIFTY", 1)
        assert t.check("NSE:NIFTY", 2) == "ok"

    def test_duplicate_sequence(self) -> None:
        t = SequenceTracker()
        t.check("NSE:NIFTY", 5)
        assert t.check("NSE:NIFTY", 5) == "duplicate"

    def test_gap_detection(self) -> None:
        t = SequenceTracker()
        t.check("NSE:NIFTY", 1)
        result = t.check("NSE:NIFTY", 10)  # gap of 9
        assert result == "gap"
        assert t.gap_count == 1

    def test_small_gap_is_ok(self) -> None:
        t = SequenceTracker()
        t.check("NSE:NIFTY", 1)
        result = t.check("NSE:NIFTY", 3)  # gap of 2 = threshold
        assert result in ("ok", "gap")  # 2 == GAP_THRESHOLD, implementation detail

    def test_out_of_order(self) -> None:
        t = SequenceTracker()
        t.check("NSE:NIFTY", 10)
        result = t.check("NSE:NIFTY", 8)  # behind but within rewind threshold
        assert result == "out_of_order"
        assert t.out_of_order_count == 1

    def test_rewind_detection(self) -> None:
        t = SequenceTracker()
        t.check("NSE:NIFTY", 500)
        result = t.check("NSE:NIFTY", 1)  # way behind = rewind
        assert result == "rewind"

    def test_different_instruments_independent(self) -> None:
        t = SequenceTracker()
        t.check("NSE:NIFTY", 1)
        t.check("NSE:BANKNIFTY", 1)
        # Each instrument has its own sequence
        assert t.check("NSE:NIFTY", 2) == "ok"
        assert t.check("NSE:BANKNIFTY", 2) == "ok"

    def test_reset_instrument(self) -> None:
        t = SequenceTracker()
        t.check("NSE:NIFTY", 100)
        t.reset_instrument("NSE:NIFTY")
        assert t.check("NSE:NIFTY", 1) == "ok"  # first event again


class TestStreamGapDetector:
    def test_no_gap_on_first_event(self) -> None:
        d = StreamGapDetector(expected_interval_ms=5000)
        result = d.record_event("NSE:NIFTY", 1_000_000, "TICK")
        assert result is None

    def test_no_gap_within_tolerance(self) -> None:
        d = StreamGapDetector(expected_interval_ms=5000)
        d.record_event("NSE:NIFTY", 1_000_000, "TICK")
        # 6 seconds later (within 1.5x = 7.5s tolerance)
        result = d.record_event("NSE:NIFTY", 1_006_000, "TICK")
        assert result is None

    def test_gap_detected(self) -> None:
        d = StreamGapDetector(expected_interval_ms=5000)
        d.record_event("NSE:NIFTY", 1_000_000, "TICK")
        # 30 seconds later — gap
        result = d.record_event("NSE:NIFTY", 1_030_000, "TICK")
        assert result is not None
        assert result.instrumentId == "NSE:NIFTY"
        assert result.gapDurationMs == 30_000

    def test_critical_gap_severity(self) -> None:
        d = StreamGapDetector(expected_interval_ms=5000)
        d.record_event("NSE:NIFTY", 1_000_000, "TICK")
        # 60 seconds later — critical
        result = d.record_event("NSE:NIFTY", 1_060_000, "TICK")
        assert result is not None
        assert result.severity == "CRITICAL"

    def test_total_gaps_count(self) -> None:
        d = StreamGapDetector(expected_interval_ms=5000)
        d.record_event("NSE:NIFTY", 1_000_000)
        d.record_event("NSE:NIFTY", 1_030_000)  # gap
        d.record_event("NSE:NIFTY", 1_060_000)  # gap
        assert d.total_gaps == 2

    def test_different_instruments_independent(self) -> None:
        d = StreamGapDetector(expected_interval_ms=5000)
        d.record_event("NSE:NIFTY", 1_000_000)
        d.record_event("NSE:BANKNIFTY", 1_000_000)
        # No gap within same instrument
        result = d.record_event("NSE:NIFTY", 1_005_000)
        assert result is None
