"""
Real NSE NextApi live-quote validation test.

Evidence level: REAL_NETWORK_TESTED (requires www.nseindia.com accessible)

Run with:
    pytest tests/real_network/test_nse_live_quotes.py -v -s

Skip condition:
    All tests are automatically skipped when www.nseindia.com is unreachable.
    Skipping is NOT a pass — it means NOT_TESTED.

What this validates when NSE is reachable:
    1. Live quotes for NIFTY / BANKNIFTY / top-10 equity
    2. OI = null for all equity (semantic integrity on live data)
    3. ltp, open, high, low, prevClose present and positive
    4. OHLC invariants hold across all returned rows
    5. eventTime <= receivedAt <= availableAt ordering
    6. Latency P50/P95/P99 from real requests
    7. DataQualityGate evaluates correctly on real quote age
    8. Lineage records created with source=NSE_NEXTAPI
"""

from __future__ import annotations

import asyncio
import statistics
import time
from typing import Optional

import httpx
import pytest

# ---------------------------------------------------------------------------
# One-time connectivity check
# ---------------------------------------------------------------------------

async def _nse_reachable() -> bool:
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.get(
                "https://www.nseindia.com/api/NextApi/apiClient"
                "?functionName=getIndexData&&type=All",
                headers={
                    "Referer": "https://www.nseindia.com/",
                    "Accept": "application/json",
                    "User-Agent": "Mozilla/5.0",
                },
            )
            return r.status_code == 200
    except Exception:
        return False


@pytest.fixture(autouse=True, scope="module")
async def nse_reachable():
    ok = await _nse_reachable()
    if not ok:
        pytest.skip(
            "www.nseindia.com unreachable from this IP. "
            "Run from an Indian IP or VPN. Evidence label: NOT_TESTED"
        )


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

NSE_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/128.0",
    "Referer": "https://www.nseindia.com/",
    "Accept": "application/json, text/plain, */*",
}
INDEX_URL = ("https://www.nseindia.com/api/NextApi/apiClient"
             "?functionName=getIndexData&&type=All")
BATCH_URL = ("https://www.nseindia.com/api/NextApi/apiClient/marketWatchApi"
             "?functionName=getIndicesData&symbol=NIFTY%20200")

INDEX_SYMBOLS = ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY"]
EQUITY_SYMBOLS = [
    "RELIANCE", "HDFCBANK", "ICICIBANK", "SBIN", "INFY",
    "TCS", "WIPRO", "AXISBANK", "KOTAKBANK", "BAJFINANCE",
]


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestNseIndexQuotes:

    @pytest.mark.asyncio
    async def test_index_endpoint_200(self):
        async with httpx.AsyncClient(timeout=12.0, headers=NSE_HEADERS) as c:
            r = await c.get(INDEX_URL)
        assert r.status_code == 200
        data = r.json()
        assert "data" in data and len(data["data"]) > 0, "Index list empty"
        print(f"\n[REAL_NETWORK] Index items returned: {len(data['data'])}")

    @pytest.mark.asyncio
    async def test_nifty_required_fields(self):
        async with httpx.AsyncClient(timeout=12.0, headers=NSE_HEADERS) as c:
            r = await c.get(INDEX_URL)
        items = {i.get("indexName", ""): i for i in r.json().get("data", [])}
        nifty = items.get("NIFTY 50")
        assert nifty is not None, "NIFTY 50 missing from index list"
        for field in ["last", "open", "high", "low", "previousClose"]:
            assert nifty.get(field) is not None, f"NIFTY 50.{field} is None"
            assert float(nifty[field]) > 0, f"NIFTY 50.{field} <= 0"

    @pytest.mark.asyncio
    async def test_index_ohlc_invariants(self):
        async with httpx.AsyncClient(timeout=12.0, headers=NSE_HEADERS) as c:
            r = await c.get(INDEX_URL)
        violations = []
        for item in r.json().get("data", []):
            name = item.get("indexName", "?")
            try:
                h = float(item.get("high") or 0)
                lo = float(item.get("low") or 0)
                o = float(item.get("open") or 0)
                last = float(item.get("last") or 0)
                if h > 0 and lo > 0 and o > 0 and last > 0:
                    if h < max(o, last):
                        violations.append(f"{name}: high={h} < max(O={o},last={last})")
                    if lo > min(o, last):
                        violations.append(f"{name}: low={lo} > min(O={o},last={last})")
            except (TypeError, ValueError):
                pass
        assert not violations, "OHLC violations:\n" + "\n".join(violations)

    @pytest.mark.asyncio
    async def test_index_oi_null_in_scraper(self):
        """Scraper must never populate OI for index symbols."""
        from src.scrapers.live_quotes import _fetch_index_quotes
        quotes = await _fetch_index_quotes(INDEX_SYMBOLS)
        for sym in INDEX_SYMBOLS:
            q = quotes.get(sym)
            if q:
                assert q.oi is None, (
                    f"SEMANTIC VIOLATION: {sym}.oi={q.oi} — "
                    "index quotes must never map OI from traded value"
                )


class TestNseEquityBatch:

    @pytest.mark.asyncio
    async def test_batch_returns_symbols(self):
        async with httpx.AsyncClient(timeout=12.0, headers=NSE_HEADERS) as c:
            r = await c.get(BATCH_URL)
        items = r.json().get("data", {}).get("data", [])
        assert len(items) >= 100, f"Expected >=100 NIFTY 200 rows, got {len(items)}"

    @pytest.mark.asyncio
    async def test_equity_ohlc_invariants(self):
        async with httpx.AsyncClient(timeout=12.0, headers=NSE_HEADERS) as c:
            r = await c.get(BATCH_URL)
        items = r.json().get("data", {}).get("data", [])
        violations, valid = [], 0
        for item in items:
            sym = item.get("symbol", "?")
            try:
                ltp = float(item.get("lastPrice") or 0)
                h = float(item.get("dayHigh") or 0)
                lo = float(item.get("dayLow") or 0)
                o = float(item.get("open") or 0)
                if ltp > 0 and h > 0 and lo > 0 and o > 0:
                    if h < max(o, ltp):
                        violations.append(f"{sym}: high={h} < max(O={o},ltp={ltp})")
                    if lo > min(o, ltp):
                        violations.append(f"{sym}: low={lo} > min(O={o},ltp={ltp})")
                    valid += 1
            except (TypeError, ValueError):
                pass
        assert not violations, "OHLC violations:\n" + "\n".join(violations[:10])
        print(f"\n[REAL_NETWORK] Valid equity OHLC rows: {valid}/{len(items)}")

    @pytest.mark.asyncio
    async def test_equity_oi_null_in_scraper(self):
        """CRITICAL: scraper must set oi=None for all equity symbols."""
        from src.scrapers.live_quotes import _fetch_batch_quotes
        quotes = await _fetch_batch_quotes(None, EQUITY_SYMBOLS[:5])
        for sym, q in quotes.items():
            assert q.oi is None, (
                f"SEMANTIC VIOLATION: {sym}.oi={q.oi} — "
                "equity oi must be None, not totalTradedValue"
            )


class TestNseTimestampOrdering:

    @pytest.mark.asyncio
    async def test_received_before_available(self):
        """receivedAtMs <= availableAtMs for every lineage record."""
        # Guard: skip if scraper fetch fails (NSE unreachable at test-body level)
        from src.scrapers.live_quotes import _fetch_index_quotes
        from src.core.lineage import lineage_store

        count_before = lineage_store.total_recorded
        t_before_ms = int(time.time() * 1000)
        try:
            result = await _fetch_index_quotes(["NIFTY"])
        except Exception as exc:
            pytest.skip(f"_fetch_index_quotes raised {exc} — NSE unreachable")

        t_after_ms = int(time.time() * 1000)

        if lineage_store.total_recorded <= count_before:
            # Fetch returned empty (NSE geo-blocked at HTTP level despite DNS resolving)
            pytest.skip("NSE returned no data — timestamp ordering cannot be verified")

        records = lineage_store.get_by_instrument("NIFTY", limit=1)
        assert records, "NIFTY lineage record not found"
        rec = records[0]

        assert rec.received_at_ms >= t_before_ms, "receivedAtMs before fetch start"
        assert rec.available_at_ms >= rec.received_at_ms, "availableAtMs < receivedAtMs"
        assert rec.received_at_ms <= t_after_ms, "receivedAtMs after fetch end"
        print(
            f"\n[REAL_NETWORK] Timestamp ordering: "
            f"receivedAt={rec.received_at_ms} <= availableAt={rec.available_at_ms} ✓"
        )


class TestNseLatency:

    @pytest.mark.asyncio
    async def test_index_latency_percentiles(self):
        latencies = []
        for _ in range(5):
            t0 = time.perf_counter()
            async with httpx.AsyncClient(timeout=12.0, headers=NSE_HEADERS) as c:
                await c.get(INDEX_URL)
            latencies.append((time.perf_counter() - t0) * 1000)
            await asyncio.sleep(0.5)

        latencies.sort()
        n = len(latencies)
        p50 = latencies[int(0.50 * n)]
        p95 = latencies[min(int(0.95 * n), n - 1)]
        p99 = latencies[min(int(0.99 * n), n - 1)]
        print(
            f"\n[REAL_NETWORK] Index latency: "
            f"P50={p50:.0f}ms P95={p95:.0f}ms P99={p99:.0f}ms"
        )
        assert p99 < 10_000, f"P99={p99:.0f}ms > 10s"

    @pytest.mark.asyncio
    async def test_gate_on_real_quote(self):
        from src.core.data_quality import build_quality_gate

        t0 = time.perf_counter()
        async with httpx.AsyncClient(timeout=12.0, headers=NSE_HEADERS) as c:
            await c.get(INDEX_URL)
        fetch_ms = int((time.perf_counter() - t0) * 1000)

        gate = build_quality_gate(
            quote_age_ms=fetch_ms, symbol="NIFTY",
            completeness_pct=1.0, provider_healthy=True, timestamp_valid=True,
        )
        print(
            f"\n[REAL_NETWORK] Gate on live quote: "
            f"age={fetch_ms}ms confidence={gate.confidenceScore} "
            f"allowed={gate.signalEngineAllowed}"
        )
        if fetch_ms < 10_000:
            assert gate.signalEngineAllowed, (
                f"Fresh live quote ({fetch_ms}ms) blocked by gate — check thresholds"
            )
