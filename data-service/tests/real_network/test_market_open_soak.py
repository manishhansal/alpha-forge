"""
Market-open soak test and Time-To-First-Valid-Data (TTFD) measurement.

Evidence level: LIVE_SESSION_TESTED (requires NSE market hours + www.nseindia.com)

Run at 09:00–10:00 IST:
    pytest tests/real_network/test_market_open_soak.py -v -s

Skip conditions (both must pass or test is skipped — NOT a pass):
    1. Current IST time is between 09:00 and 15:35
    2. www.nseindia.com NextApi is reachable

What this measures:
    - TTFD: wall-clock from script start to first valid index / equity / signal
    - Session stability at 09:15 (no false ban, no session failure)
    - Quote stale rate at open
    - Rate-limit safety under rapid requests

Output:
    JSON at data-service/reports/MARKET_OPEN_SOAK_{date}.json
"""

from __future__ import annotations

import asyncio
import json
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import httpx
import pytest


# ---------------------------------------------------------------------------
# Skip helpers
# ---------------------------------------------------------------------------

def _ist_hmm() -> tuple[int, int]:
    utc = datetime.now(timezone.utc)
    ist_min = (utc.hour * 60 + utc.minute + 330) % (24 * 60)
    return ist_min // 60, ist_min % 60


def _in_market_window() -> bool:
    h, m = _ist_hmm()
    total = h * 60 + m
    return 9 * 60 <= total <= 15 * 60 + 35


async def _nse_reachable() -> bool:
    try:
        async with httpx.AsyncClient(timeout=5.0) as c:
            r = await c.get(
                "https://www.nseindia.com/api/NextApi/apiClient"
                "?functionName=getIndexData&&type=All",
                headers={"Referer": "https://www.nseindia.com/",
                         "Accept": "application/json", "User-Agent": "Mozilla/5.0"},
            )
        return r.status_code == 200
    except Exception:
        return False


@pytest.fixture(autouse=True, scope="module")
async def require_live_session():
    h, m = _ist_hmm()
    if not _in_market_window():
        pytest.skip(
            f"Market-open soak requires IST 09:00–15:35. "
            f"Current IST: {h:02d}:{m:02d}. Evidence: NOT_TESTED"
        )
    if not await _nse_reachable():
        pytest.skip(
            "www.nseindia.com unreachable. Evidence: NOT_TESTED"
        )


# ---------------------------------------------------------------------------
# TTFD tracker
# ---------------------------------------------------------------------------

_ttfd_start_ms = int(time.time() * 1000)
_ttfd: dict[str, int] = {}


def _mark_ttfd(key: str) -> None:
    if key not in _ttfd:
        _ttfd[key] = int(time.time() * 1000) - _ttfd_start_ms


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestMarketOpenTTFD:

    @pytest.mark.asyncio
    async def test_ttfd_nifty(self):
        """Time to first valid NIFTY live quote."""
        from src.scrapers.live_quotes import _fetch_index_quotes
        for attempt in range(10):
            quotes = await _fetch_index_quotes(["NIFTY"])
            q = quotes.get("NIFTY")
            if q and q.ltp and q.ltp > 0:
                _mark_ttfd("nifty_quote")
                print(f"\n[LIVE_SESSION] NIFTY TTFD={_ttfd['nifty_quote']}ms, "
                      f"ltp={q.ltp} (attempt {attempt+1})")
                return
            await asyncio.sleep(1.0)
        pytest.fail("NIFTY quote unavailable after 10s — possible session failure")

    @pytest.mark.asyncio
    async def test_ttfd_equity(self):
        """Time to first valid RELIANCE quote."""
        from src.scrapers.live_quotes import _fetch_batch_quotes
        for attempt in range(10):
            quotes = await _fetch_batch_quotes(None, ["RELIANCE"])
            q = quotes.get("RELIANCE")
            if q and q.ltp:
                _mark_ttfd("reliance_quote")
                print(f"\n[LIVE_SESSION] RELIANCE TTFD={_ttfd['reliance_quote']}ms")
                return
            await asyncio.sleep(1.0)
        pytest.fail("RELIANCE quote unavailable after 10s")

    @pytest.mark.asyncio
    async def test_ttfd_signal_gate_open(self):
        """Time to first signalEngineAllowed=True for NIFTY."""
        from src.scrapers.live_quotes import _fetch_index_quotes
        from src.core.data_quality import build_quality_gate

        for attempt in range(20):
            t0 = time.time()
            quotes = await _fetch_index_quotes(["NIFTY"])
            fetch_ms = int((time.time() - t0) * 1000)
            q = quotes.get("NIFTY")
            if q and q.ltp:
                gate = build_quality_gate(
                    quote_age_ms=fetch_ms, symbol="NIFTY",
                    completeness_pct=1.0, provider_healthy=True, timestamp_valid=True,
                )
                if gate.signalEngineAllowed:
                    _mark_ttfd("signal_eligible")
                    print(
                        f"\n[LIVE_SESSION] Signal-eligible TTFD={_ttfd['signal_eligible']}ms "
                        f"confidence={gate.confidenceScore}"
                    )
                    return
            await asyncio.sleep(1.0)
        pytest.fail("Signal gate never opened in 20 attempts")


class TestMarketOpenStability:

    @pytest.mark.asyncio
    async def test_no_empty_batch_at_open(self):
        from src.scrapers.live_quotes import _fetch_batch_quotes
        sample = ["RELIANCE", "HDFCBANK", "TCS"]
        quotes = await _fetch_batch_quotes(None, sample)
        non_null = [k for k, v in quotes.items() if v and v.ltp]
        assert len(non_null) >= 1, (
            f"Zero quotes at market open for {sample} — "
            "possible session failure or shadow ban"
        )
        print(f"\n[LIVE_SESSION] Batch at open: {len(non_null)}/{len(sample)} non-null")

    @pytest.mark.asyncio
    async def test_circuit_breaker_closed(self):
        from src.core.circuit_breaker import get_breaker, CircuitState
        cb = get_breaker("nse_nextapi")
        assert cb.state == CircuitState.CLOSED, (
            f"Circuit breaker not CLOSED at market open: {cb.state} — "
            f"failures={cb._total_failures}"
        )

    @pytest.mark.asyncio
    async def test_rate_limit_not_tripped(self):
        from src.scrapers.live_quotes import _fetch_index_quotes
        from src.anti_ban.ban_detector import ban_detector
        bans_before = ban_detector.ban_count
        for _ in range(5):
            await _fetch_index_quotes(["NIFTY"])
            await asyncio.sleep(0.4)  # 2.5 req/s — within 3 req/s NSE limit
        bans_after = ban_detector.ban_count
        assert bans_after == bans_before, (
            f"Ban detected during rate-limit test: {bans_before} → {bans_after}"
        )

    @pytest.mark.asyncio
    async def test_quote_age_distribution(self):
        """Sample 10 consecutive fetches; record quote age P50/P95."""
        from src.scrapers.live_quotes import _fetch_index_quotes
        ages = []
        for _ in range(10):
            t0 = time.time()
            await _fetch_index_quotes(["NIFTY"])
            ages.append(int((time.time() - t0) * 1000))
            await asyncio.sleep(0.5)
        ages.sort()
        n = len(ages)
        p50, p95 = ages[n // 2], ages[min(int(0.95 * n), n - 1)]
        print(f"\n[LIVE_SESSION] Quote age P50={p50}ms P95={p95}ms max={ages[-1]}ms")
        _ttfd["quote_age_p50_ms"] = p50
        _ttfd["quote_age_p95_ms"] = p95


@pytest.fixture(scope="module", autouse=True)
def write_ttfd_report():
    yield
    report = {
        "startMs": _ttfd_start_ms,
        "ttfd": _ttfd,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "label": "LIVE_SESSION",
    }
    out_dir = Path(__file__).parent.parent.parent / "reports"
    out_dir.mkdir(exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    out_path = out_dir / f"MARKET_OPEN_SOAK_{ts}.json"
    out_path.write_text(json.dumps(report, indent=2))
    print(f"\n[LIVE_SESSION] TTFD report: {out_path}")
    print(json.dumps(report, indent=2))
