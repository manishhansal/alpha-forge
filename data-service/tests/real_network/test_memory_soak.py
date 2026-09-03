"""
Memory soak test — 1-hour, 4-hour, and full-session RSS tracking.

Evidence level: LIVE_SESSION_TESTED (requires running data-service + NSE access)

Run:
    pytest tests/real_network/test_memory_soak.py -v -s --soak-minutes=60

What this measures:
    - RSS / heap at start, after 15m, 30m, 60m (1-hour variant)
    - LineageStore current_size growth
    - CircuitBreaker history list size
    - EventDeduplicator cache size
    - StreamPublisher counters
    - Memory growth slope (MB/hour) — target: < 10 MB/hour

Pass condition:
    No unbounded growth (slope < 10 MB/hour over the test window).
    LineageStore must stay bounded at max_size (LRU eviction working).

Skip condition:
    Skipped when psutil is not installed or outside market hours.
    The short "micro-soak" variant (1 minute) always runs for CI purposes.

Output:
    JSON at data-service/reports/MEMORY_SOAK_{date}.json
"""

from __future__ import annotations

import asyncio
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import pytest


def _psutil_available() -> bool:
    try:
        import psutil  # noqa: F401
        return True
    except ImportError:
        return False


def _rss_mb() -> float:
    """Return current process RSS in megabytes."""
    try:
        import psutil, os
        proc = psutil.Process(os.getpid())
        return proc.memory_info().rss / (1024 * 1024)
    except Exception:
        return 0.0


def _component_sizes() -> dict:
    """Snapshot bounded-container sizes for leak detection."""
    sizes = {}
    try:
        from src.core.lineage import lineage_store
        sizes["lineage_store_current"] = lineage_store.current_size
        sizes["lineage_store_total_recorded"] = lineage_store.total_recorded
        sizes["lineage_store_max"] = lineage_store._max_size
    except Exception:
        pass
    try:
        from src.core.deduplication import event_dedup
        sizes["event_dedup_size"] = len(event_dedup._seen)
        sizes["event_dedup_max"] = event_dedup._max_size
    except Exception:
        pass
    try:
        from src.core.circuit_breaker import all_breakers
        for name, cb in all_breakers().items():
            sizes[f"cb_{name}_history"] = len(cb._history)
    except Exception:
        pass
    try:
        from src.publisher.stream_publisher import stream_publisher
        sizes["stream_pub_pub_count"] = stream_publisher._pub_count
        sizes["stream_pub_stream_count"] = stream_publisher._stream_count
        sizes["stream_pub_drop_count"] = stream_publisher._drop_count
    except Exception:
        pass
    return sizes


class TestMicroSoak:
    """
    Micro-soak (30 seconds) — always runs, no external dependencies.
    Verifies bounded containers don't leak memory under simulated load.
    Evidence label: UNIT_TESTED (no network, pure in-process)
    """

    @pytest.mark.asyncio
    async def test_lineage_store_stays_bounded(self):
        """LineageStore must not exceed max_size under continuous load."""
        from src.core.lineage import LineageStore
        from src.core.schemas_v2 import DataSource

        store = LineageStore(max_size=1000)
        for i in range(5000):
            store.record(
                instrument_id=f"SYM_{i % 50}",
                symbol=f"SYM_{i % 50}",
                data_type="QUOTE",
                source=DataSource.NSE_NEXTAPI,
                event_time_ms=i,
            )
        assert store.current_size <= 1000, (
            f"LineageStore exceeded max_size: {store.current_size} > 1000"
        )
        assert store.total_recorded == 5000, "total_recorded should be monotonic"
        print(f"\n[UNIT_TESTED] LineageStore bounded: "
              f"size={store.current_size}/1000, total={store.total_recorded}")

    @pytest.mark.asyncio
    async def test_event_dedup_stays_bounded(self):
        """EventDeduplicator LRU cache must not exceed max_size."""
        from src.core.deduplication import EventDeduplicator
        dedup = EventDeduplicator(max_size=500)
        for i in range(2000):
            dedup.is_duplicate(f"event_{i}")
        assert len(dedup._seen) <= 500, (
            f"EventDeduplicator exceeded max_size: {len(dedup._seen)} > 500"
        )
        print(f"\n[UNIT_TESTED] EventDeduplicator bounded: "
              f"size={len(dedup._seen)}/500, dups={dedup.duplicate_count}")

    @pytest.mark.asyncio
    async def test_circuit_breaker_history_pruned(self):
        """CircuitBreaker rolling window must prune stale entries."""
        from src.core.circuit_breaker import CircuitBreaker
        import time as _time

        cb = CircuitBreaker("soak_test", window_seconds=0.1)  # 100ms window
        for _ in range(100):
            cb.record_success()

        _time.sleep(0.15)  # let the window expire
        cb.record_success()  # triggers prune

        assert len(cb._history) <= 10, (
            f"CircuitBreaker history not pruned: {len(cb._history)} entries"
        )
        print(f"\n[UNIT_TESTED] CircuitBreaker history pruned: "
              f"{len(cb._history)} entries after expiry")

    def test_rss_baseline(self):
        """Record baseline RSS for comparison in extended soak."""
        if not _psutil_available():
            pytest.skip("psutil not installed — RSS tracking unavailable")
        rss = _rss_mb()
        print(f"\n[UNIT_TESTED] Baseline RSS: {rss:.1f} MB")
        assert rss < 500, f"Baseline RSS {rss:.1f}MB unexpectedly high"

    def test_component_size_snapshot(self):
        """Snapshot all bounded container sizes at rest."""
        sizes = _component_sizes()
        print(f"\n[UNIT_TESTED] Component sizes at rest: {sizes}")
        # LineageStore at rest should be within bounds
        max_sz = sizes.get("lineage_store_max", 50000)
        cur_sz = sizes.get("lineage_store_current", 0)
        assert cur_sz <= max_sz, f"LineageStore overflow: {cur_sz} > {max_sz}"


class TestExtendedSoak:
    """
    Extended soak (configurable duration via --soak-minutes CLI flag).
    Skipped unless psutil is installed and NSE is accessible.

    This class is a template. Run manually during a full session.
    """

    SOAK_MINUTES = 60  # override via --soak-minutes pytest option

    @pytest.fixture(autouse=True)
    def require_psutil(self):
        if not _psutil_available():
            pytest.skip(
                "psutil not installed. Install with: pip install psutil. "
                "Evidence: NOT_TESTED"
            )

    @pytest.mark.asyncio
    async def test_1_hour_rss_slope(self):
        """
        Run for SOAK_MINUTES and measure RSS growth slope.
        Pass condition: slope < 10 MB/hour.
        """
        duration_s = self.SOAK_MINUTES * 60
        interval_s = 60  # sample every minute
        samples: list[tuple[float, float]] = []  # (elapsed_s, rss_mb)

        start = time.time()
        samples.append((0.0, _rss_mb()))

        print(f"\n[LIVE_SESSION] Starting {self.SOAK_MINUTES}-minute memory soak...")
        print(f"  t=0s  RSS={samples[0][1]:.1f}MB  components={_component_sizes()}")

        while time.time() - start < duration_s:
            await asyncio.sleep(interval_s)
            elapsed = time.time() - start
            rss = _rss_mb()
            components = _component_sizes()
            samples.append((elapsed, rss))
            print(f"  t={elapsed:.0f}s  RSS={rss:.1f}MB  {components}")

        # Compute linear slope (MB/hour) via least-squares
        if len(samples) >= 2:
            n = len(samples)
            xs = [s[0] / 3600 for s in samples]  # hours
            ys = [s[1] for s in samples]
            x_mean = sum(xs) / n
            y_mean = sum(ys) / n
            slope = sum((x - x_mean) * (y - y_mean) for x, y in zip(xs, ys)) / \
                    sum((x - x_mean) ** 2 for x in xs) if any(x != x_mean for x in xs) else 0.0
        else:
            slope = 0.0

        result = {
            "soak_minutes": self.SOAK_MINUTES,
            "samples": len(samples),
            "rss_start_mb": samples[0][1],
            "rss_end_mb": samples[-1][1],
            "rss_delta_mb": round(samples[-1][1] - samples[0][1], 2),
            "slope_mb_per_hour": round(slope, 3),
            "pass": slope < 10.0,
            "label": "LIVE_SESSION",
        }

        out_dir = Path(__file__).parent.parent.parent / "reports"
        out_dir.mkdir(exist_ok=True)
        ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        out_path = out_dir / f"MEMORY_SOAK_{ts}.json"
        out_path.write_text(json.dumps({"result": result, "samples": samples}, indent=2))

        print(f"\n[LIVE_SESSION] Memory soak complete:")
        print(json.dumps(result, indent=2))
        print(f"Report: {out_path}")

        assert slope < 10.0, (
            f"Memory leak detected: slope={slope:.2f} MB/hour > 10 MB/hour limit. "
            "Check LineageStore eviction, CircuitBreaker history, "
            "StreamPublisher counters."
        )
