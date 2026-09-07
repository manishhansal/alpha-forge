"""
Phase 3Q — Data-reliability monitoring metrics (spec §25).

Plain, honest counters/gauges over the four monitored surfaces: provider, data,
market, and pipeline. Nothing here fabricates a healthy status — every metric is
an accumulation of observed facts. This is ADDITIVE and independent of the
existing model-monitoring in `src.monitoring`.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any


# Canonical metric names grouped by surface (spec §25). Kept as constants so
# emitters and dashboards agree on spelling.
PROVIDER_METRICS = (
    "provider.request.count", "provider.latency.ms", "provider.error.count",
    "provider.timeout.count", "provider.rate_limited.count",
    "provider.fallback.count", "provider.conflict.count",
)
DATA_METRICS = (
    "data.stale.count", "data.missing_bar.count", "data.duplicate.count",
    "data.invalid.count", "data.completeness.ratio",
    "data.timestamp_violation.count", "data.ohlc_violation.count",
)
MARKET_METRICS = (
    "market.session.state", "market.latest_bar_age.seconds",
    "market.expected_bars", "market.received_bars",
)
PIPELINE_METRICS = (
    "pipeline.feature_unavailable.count", "pipeline.signal_suppressed.count",
    "pipeline.model_reject.count", "pipeline.dq_reject.count",
)

ALL_METRICS = PROVIDER_METRICS + DATA_METRICS + MARKET_METRICS + PIPELINE_METRICS


@dataclass
class MetricRegistry:
    """
    Thread-unsafe (single-writer per instance) metric accumulator (spec §25).
    Counters accumulate; gauges/observations keep the last value + a small
    history. Never invents values — an unseen metric reads as 0 / None.
    """
    _counters: dict[str, float] = field(default_factory=lambda: defaultdict(float))
    _gauges:   dict[str, float] = field(default_factory=dict)
    _labeled:  dict[str, dict[str, float]] = field(
        default_factory=lambda: defaultdict(lambda: defaultdict(float)))

    def incr(self, name: str, amount: float = 1.0, *, label: str | None = None) -> None:
        if label is None:
            self._counters[name] += amount
        else:
            self._labeled[name][label] += amount

    def observe(self, name: str, value: float) -> None:
        """Record a gauge / latest observation (e.g. latency, bar age)."""
        self._gauges[name] = value

    def counter(self, name: str, *, label: str | None = None) -> float:
        if label is None:
            return self._counters.get(name, 0.0)
        return self._labeled.get(name, {}).get(label, 0.0)

    def gauge(self, name: str) -> float | None:
        return self._gauges.get(name)

    def snapshot(self) -> dict[str, Any]:
        """A point-in-time, JSON-serialisable view of all metrics (no secrets)."""
        return {
            "counters": dict(self._counters),
            "gauges":   dict(self._gauges),
            "labeled":  {k: dict(v) for k, v in self._labeled.items()},
        }
