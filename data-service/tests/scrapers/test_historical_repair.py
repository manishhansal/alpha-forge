"""
Tests for the cache-key / fingerprint / gap-repair helpers (spec §15-17).

Deterministic and network-free: repair fetchers are simple async fakes.
"""

from __future__ import annotations

import pytest

from src.schemas import OHLCVCandle
from src.scrapers.historical_repair import (
    canonical_cache_key,
    data_fingerprint,
    detect_gaps,
    is_valid_candle,
    repair_gaps,
)


def _c(t: int, close: float = 100.0) -> OHLCVCandle:
    return OHLCVCandle(time=t, open=100, high=101, low=99, close=close, volume=10)


def test_canonical_cache_key_is_provider_independent_and_normalized():
    k1 = canonical_cache_key("NSE", "RELIANCE", "5m", "2026-01-01", "2026-01-02")
    k2 = canonical_cache_key("nse", "reliance", "5m", "2026-01-01", "2026-01-02")
    assert k1 == k2
    # Different range → different key.
    k3 = canonical_cache_key("NSE", "RELIANCE", "5m", "2026-01-01", "2026-01-03")
    assert k1 != k3


def test_data_fingerprint_is_stable_and_content_sensitive():
    a = [_c(0), _c(300), _c(600)]
    b = [_c(0), _c(300), _c(600)]
    assert data_fingerprint(a) == data_fingerprint(b)
    c = [_c(0), _c(300), _c(600, close=101)]
    assert data_fingerprint(a) != data_fingerprint(c)


def test_is_valid_candle_rejects_impossible_ohlc():
    assert is_valid_candle(_c(0)) is True
    assert is_valid_candle(OHLCVCandle(time=0, open=100, high=99, low=99, close=100, volume=1)) is False
    assert is_valid_candle(OHLCVCandle(time=0, open=-1, high=1, low=1, close=1, volume=1)) is False


def test_detect_gaps_flags_missing_interval():
    series = [_c(0), _c(600)]  # missing the 300 candle for a 5m stream
    gaps = detect_gaps(series, "5m")
    assert len(gaps) == 1
    assert gaps[0].missing_count == 1
    # A contiguous series has no gaps.
    assert detect_gaps([_c(0), _c(300), _c(600)], "5m") == []


async def test_repair_gaps_fills_and_validates():
    series = [_c(0), _c(600)]

    async def good(a: int, b: int):
        return [_c(300)]

    out = await repair_gaps(series, "5m", [("upstox", good)])
    assert out.repaired_count == 1
    assert [x.time for x in out.candles] == [0, 300, 600]
    assert any(r.result == "repaired" and r.provider == "upstox" for r in out.attempts)


async def test_repair_rejects_invalid_and_falls_over():
    series = [_c(0), _c(600)]

    async def bad(a: int, b: int):
        # invalid candle (high < low) must be rejected before persistence
        return [OHLCVCandle(time=300, open=100, high=1, low=99, close=100, volume=1)]

    async def good(a: int, b: int):
        return [_c(300)]

    out = await repair_gaps(series, "5m", [("upstox", bad), ("yahoo", good)])
    assert out.repaired_count == 1
    # The invalid provider result was rejected…
    assert any(r.result == "invalid" for r in out.attempts)
    # …and the fallback provider repaired the gap.
    assert any(r.result == "repaired" and r.provider == "yahoo" for r in out.attempts)


async def test_repair_records_error_when_fetcher_raises():
    series = [_c(0), _c(600)]

    async def boom(a: int, b: int):
        raise RuntimeError("provider 503")

    async def good(a: int, b: int):
        return [_c(300)]

    out = await repair_gaps(series, "5m", [("angel_one", boom), ("upstox", good)])
    assert out.repaired_count == 1
    assert any(r.result == "error" and r.provider == "angel_one" for r in out.attempts)


async def test_no_gaps_means_no_provider_calls():
    series = [_c(0), _c(300), _c(600)]
    called = {"n": 0}

    async def fetch(a: int, b: int):
        called["n"] += 1
        return []

    out = await repair_gaps(series, "5m", [("upstox", fetch)])
    assert out.repaired_count == 0
    assert called["n"] == 0  # spec §16: never call a provider when data is complete
