"""
Deduplication and sequence integrity — Phases 19-21.

Provides:
- Deterministic event ID computation
- Duplicate detection with a bounded LRU-style cache
- Sequence gap detection
- Out-of-order event detection

Usage:
    from src.core.deduplication import event_dedup, SequenceTracker
    is_dup = event_dedup.is_duplicate(tick_id)
    gap = seq_tracker.check(instrument_id, sequence_num)
"""

from __future__ import annotations

import hashlib
import threading
import time
from collections import OrderedDict
from typing import Optional

import structlog

from src.core.schemas_v2 import DataGapEvent

logger = structlog.get_logger(__name__)


# ---------------------------------------------------------------------------
# Deterministic event ID
# ---------------------------------------------------------------------------


def compute_event_id(
    instrument_id: str,
    event_time_ms: int,
    source: str,
    ltp: float,
    volume: Optional[int] = None,
    sequence: Optional[int] = None,
) -> str:
    """Compute a deterministic deduplication ID from key event fields.

    Returns the first 32 hex chars of SHA-256.
    """
    parts = [instrument_id, str(event_time_ms), source, f"{ltp:.4f}"]
    if volume is not None:
        parts.append(str(volume))
    if sequence is not None:
        parts.append(str(sequence))
    key = ":".join(parts)
    return hashlib.sha256(key.encode()).hexdigest()[:32]


# ---------------------------------------------------------------------------
# Bounded deduplication cache
# ---------------------------------------------------------------------------


class EventDeduplicator:
    """LRU-bounded cache for event deduplication.

    Keeps the most recent N event IDs in memory.
    Thread-safe via a lock.
    """

    def __init__(self, max_size: int = 10_000) -> None:
        self._max_size = max_size
        self._seen: OrderedDict[str, float] = OrderedDict()  # id → timestamp
        self._lock = threading.Lock()
        self._duplicate_count = 0
        self._total_count = 0

    def is_duplicate(self, event_id: str) -> bool:
        """Return True when this event_id was already seen.

        Automatically registers the ID if new.
        """
        with self._lock:
            self._total_count += 1
            if event_id in self._seen:
                self._duplicate_count += 1
                logger.debug("duplicate_event_detected", event_id=event_id)
                return True
            # Register new event
            self._seen[event_id] = time.monotonic()
            self._seen.move_to_end(event_id)
            # Evict oldest if over capacity
            while len(self._seen) > self._max_size:
                self._seen.popitem(last=False)
            return False

    @property
    def duplicate_count(self) -> int:
        with self._lock:
            return self._duplicate_count

    @property
    def total_count(self) -> int:
        with self._lock:
            return self._total_count

    @property
    def duplicate_rate(self) -> float:
        with self._lock:
            if self._total_count == 0:
                return 0.0
            return self._duplicate_count / self._total_count

    def reset(self) -> None:
        with self._lock:
            self._seen.clear()
            self._duplicate_count = 0
            self._total_count = 0


# ---------------------------------------------------------------------------
# Sequence tracker — detects gaps, out-of-order, rewinding
# ---------------------------------------------------------------------------


class SequenceTracker:
    """Per-instrument sequence number tracker.

    Detects:
    - gap: sequence jumped forward unexpectedly
    - out_of_order: sequence is less than expected (but not a rewind)
    - rewind: sequence reset to near-zero from a high value (e.g. reconnect)
    - duplicate: sequence == last seen
    """

    # Minimum gap to consider a sequence a "gap" vs normal out-of-order
    GAP_THRESHOLD = 2

    # If new seq < last_seq - REWIND_THRESHOLD it's a rewind, not out-of-order
    REWIND_THRESHOLD = 100

    def __init__(self) -> None:
        self._sequences: dict[str, int] = {}
        self._lock = threading.Lock()
        self._gap_count = 0
        self._out_of_order_count = 0
        self._rewind_count = 0

    def check(
        self,
        instrument_id: str,
        sequence: int,
        event_time_ms: Optional[int] = None,
    ) -> str:
        """Check a sequence number for the given instrument.

        Returns one of: "ok", "gap", "out_of_order", "rewind", "duplicate".
        Updating internal state only when "ok" or "gap".
        """
        with self._lock:
            last_seq = self._sequences.get(instrument_id)

            if last_seq is None:
                # First event for this instrument
                self._sequences[instrument_id] = sequence
                return "ok"

            if sequence == last_seq:
                return "duplicate"

            if sequence > last_seq:
                if sequence - last_seq > self.GAP_THRESHOLD:
                    self._gap_count += 1
                    logger.warning(
                        "sequence_gap_detected",
                        instrument_id=instrument_id,
                        last_seq=last_seq,
                        current_seq=sequence,
                        gap_size=sequence - last_seq,
                    )
                    self._sequences[instrument_id] = sequence
                    return "gap"
                self._sequences[instrument_id] = sequence
                return "ok"

            # sequence < last_seq
            if last_seq - sequence > self.REWIND_THRESHOLD:
                self._rewind_count += 1
                logger.warning(
                    "sequence_rewind_detected",
                    instrument_id=instrument_id,
                    last_seq=last_seq,
                    current_seq=sequence,
                )
                self._sequences[instrument_id] = sequence
                return "rewind"

            self._out_of_order_count += 1
            logger.debug(
                "sequence_out_of_order",
                instrument_id=instrument_id,
                last_seq=last_seq,
                current_seq=sequence,
            )
            return "out_of_order"

    @property
    def gap_count(self) -> int:
        with self._lock:
            return self._gap_count

    @property
    def out_of_order_count(self) -> int:
        with self._lock:
            return self._out_of_order_count

    def reset_instrument(self, instrument_id: str) -> None:
        """Reset tracking for a specific instrument (e.g. on reconnect)."""
        with self._lock:
            self._sequences.pop(instrument_id, None)


# ---------------------------------------------------------------------------
# Gap detector for time-based streams
# ---------------------------------------------------------------------------


class StreamGapDetector:
    """Detects gaps in time-based data streams (ticks, candles, option chains)."""

    def __init__(self, expected_interval_ms: int) -> None:
        """
        Args:
            expected_interval_ms: Expected interval between events in ms.
                For a 5s tick stream, this is 5000.
        """
        self._interval_ms = expected_interval_ms
        self._last_event_ms: dict[str, int] = {}
        self._lock = threading.Lock()
        self._gap_events: list[DataGapEvent] = []

    def record_event(
        self,
        instrument_id: str,
        event_time_ms: int,
        stream_type: str = "TICK",
    ) -> Optional[DataGapEvent]:
        """Record an event and detect if there was a gap before it.

        Returns a DataGapEvent if a gap was detected, else None.
        """
        with self._lock:
            last_ms = self._last_event_ms.get(instrument_id)
            self._last_event_ms[instrument_id] = event_time_ms

            if last_ms is None:
                return None

            actual_gap_ms = event_time_ms - last_ms
            # Allow 50% tolerance over expected interval
            if actual_gap_ms > self._interval_ms * 1.5:
                gap_event = DataGapEvent(
                    instrumentId=instrument_id,
                    streamType=stream_type,
                    gapStartMs=last_ms,
                    gapEndMs=event_time_ms,
                    gapDurationMs=actual_gap_ms,
                    expectedCount=max(1, int(actual_gap_ms / self._interval_ms)),
                    actualCount=1,
                    severity="CRITICAL" if actual_gap_ms > self._interval_ms * 10 else "WARN",
                )
                self._gap_events.append(gap_event)
                logger.warning(
                    "stream_gap_detected",
                    instrument_id=instrument_id,
                    gap_ms=actual_gap_ms,
                    expected_ms=self._interval_ms,
                )
                return gap_event
        return None

    @property
    def gap_events(self) -> list[DataGapEvent]:
        with self._lock:
            return list(self._gap_events)

    @property
    def total_gaps(self) -> int:
        with self._lock:
            return len(self._gap_events)


# ---------------------------------------------------------------------------
# Module-level singletons
# ---------------------------------------------------------------------------

event_dedup = EventDeduplicator(max_size=50_000)
sequence_tracker = SequenceTracker()
tick_gap_detector = StreamGapDetector(expected_interval_ms=5_000)   # 5s tick stream
candle_gap_detector = StreamGapDetector(expected_interval_ms=60_000) # 1m candles
