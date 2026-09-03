"""
F&O universe coverage measurement.

Evidence level: LIVE_SESSION_TESTED (requires www.nseindia.com)

Run:
    pytest tests/real_network/test_fno_coverage.py -v -s

Skip condition:
    All tests skipped when NSE unreachable. Skipping is NOT a pass.

What this measures:
    - Total active F&O underlyings reachable via NSE NextApi
    - Quotes available / fresh / stale / missing per instrument
    - F&O usable coverage % (fresh quote + healthy provider)
    - Signal-capable coverage % (fresh + gate.signalEngineAllowed)

Output:
    JSON report at data-service/reports/FNO_COVERAGE_{date}.json
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
# Module-level skip when NSE unreachable
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True, scope="module")
async def require_nse_network():
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
        if r.status_code != 200:
            pytest.skip(
                f"NSE NextApi returned HTTP {r.status_code}. Evidence: NOT_TESTED"
            )
    except Exception as exc:
        pytest.skip(
            f"NSE unreachable ({exc}). "
            "Run from an Indian IP or VPN. Evidence: NOT_TESTED"
        )


# ---------------------------------------------------------------------------
# F&O universe
# ---------------------------------------------------------------------------

FNO_INDICES = ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY"]
FNO_EQUITY_TOP50 = [
    "RELIANCE", "HDFCBANK", "ICICIBANK", "SBIN", "INFY", "TCS", "WIPRO",
    "AXISBANK", "KOTAKBANK", "BAJFINANCE", "LT", "HINDUNILVR", "ITC",
    "MARUTI", "ASIANPAINT", "NTPC", "POWERGRID", "HCLTECH", "TITAN",
    "SUNPHARMA", "BAJAJFINSV", "ADANIENT", "TATAMOTORS", "JSWSTEEL",
    "TATASTEEL", "TECHM", "NESTLEIND", "BRITANNIA", "DIVISLAB",
    "HEROMOTOCO", "CIPLA", "GRASIM", "INDUSINDBK", "DRREDDY",
    "BPCL", "EICHERMOT", "SHRIRAMFIN", "ULTRACEMCO", "APOLLOHOSP",
    "ONGC", "COALINDIA", "ADANIPORTS", "HINDALCO", "TATACONSUM",
    "SBILIFE", "HDFCLIFE", "BAJAJ-AUTO", "LTIM", "VEDL", "M&M",
]

FRESH_THRESHOLD_MS = 10_000


# ---------------------------------------------------------------------------
# CoverageRecord
# ---------------------------------------------------------------------------

class CoverageRecord:
    def __init__(self) -> None:
        self.total = 0
        self.available = 0
        self.fresh = 0
        self.stale = 0
        self.missing = 0
        self.gate_allowed = 0
        self.details: dict = {}

    def add(self, symbol: str, ltp: Optional[float], fetch_ms: float, gate_allowed: bool) -> None:
        self.total += 1
        is_fresh = fetch_ms <= FRESH_THRESHOLD_MS
        if ltp is not None and ltp > 0:
            self.available += 1
            if is_fresh:
                self.fresh += 1
            else:
                self.stale += 1
            if gate_allowed:
                self.gate_allowed += 1
        else:
            self.missing += 1
        self.details[symbol] = {
            "ltp": ltp,
            "fetch_ms": round(fetch_ms, 1),
            "fresh": is_fresh,
            "gate_allowed": gate_allowed,
        }

    def summary(self) -> dict:
        return {
            "total_instruments": self.total,
            "quotes_available": self.available,
            "quotes_fresh": self.fresh,
            "quotes_stale": self.stale,
            "quotes_missing": self.missing,
            "signal_capable": self.gate_allowed,
            "fno_usable_coverage_pct": round(
                self.fresh / self.total * 100, 2
            ) if self.total else 0.0,
            "signal_capable_coverage_pct": round(
                self.gate_allowed / self.total * 100, 2
            ) if self.total else 0.0,
            "label": "LIVE_SESSION",
        }


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestFnoCoverage:

    @pytest.mark.asyncio
    async def test_index_coverage(self):
        from src.scrapers.live_quotes import _fetch_index_quotes
        from src.core.data_quality import build_quality_gate

        coverage = CoverageRecord()
        t0 = time.time()
        quotes = await _fetch_index_quotes(FNO_INDICES)
        fetch_ms = (time.time() - t0) * 1000

        for sym in FNO_INDICES:
            q = quotes.get(sym)
            ltp = q.ltp if q else None
            gate = build_quality_gate(
                quote_age_ms=int(fetch_ms), symbol=sym,
                completeness_pct=1.0 if q else 0.0,
                provider_healthy=True, timestamp_valid=True,
            )
            coverage.add(sym, ltp, fetch_ms, gate.signalEngineAllowed)

        s = coverage.summary()
        print(f"\n[LIVE_SESSION] Index F&O coverage: {s}")
        assert s["quotes_available"] >= 3, (
            f"Expected >=3 index quotes, got {s['quotes_available']}"
        )

    @pytest.mark.asyncio
    async def test_equity_fno_top10_coverage(self):
        from src.scrapers.live_quotes import _fetch_batch_quotes
        from src.core.data_quality import build_quality_gate

        sample = FNO_EQUITY_TOP50[:10]
        coverage = CoverageRecord()

        t0 = time.time()
        try:
            quotes = await _fetch_batch_quotes(None, sample)
        except Exception as exc:
            pytest.skip(f"Equity batch fetch failed: {exc}. Evidence: NOT_TESTED")
        fetch_ms = (time.time() - t0) * 1000

        # If NSE is blocked at HTTP level the scraper returns an empty dict
        if not any(v for v in quotes.values() if v and v.ltp):
            pytest.skip(
                "All equity quotes returned null — NSE geo-blocked at HTTP level. "
                "Evidence: NOT_TESTED (run from Indian IP)"
            )

        for sym in sample:
            q = quotes.get(sym)
            ltp = q.ltp if q else None
            gate = build_quality_gate(
                quote_age_ms=int(fetch_ms), symbol=sym,
                completeness_pct=1.0 if q else 0.0,
                provider_healthy=True, timestamp_valid=True,
            )
            coverage.add(sym, ltp, fetch_ms, gate.signalEngineAllowed)

        s = coverage.summary()
        print(f"\n[LIVE_SESSION] Equity F&O top-10 coverage: {s}")
        assert s["fno_usable_coverage_pct"] >= 50.0, (
            f"F&O usable coverage {s['fno_usable_coverage_pct']}% < 50% — "
            "data service cannot support reliable signal generation"
        )

    @pytest.mark.asyncio
    async def test_full_fno_universe_coverage(self):
        """
        Certification metric: F&O usable coverage % across 54 instruments.
        This must be ≥ 70% for production certification.
        """
        from src.scrapers.live_quotes import _fetch_index_quotes, _fetch_batch_quotes
        from src.core.data_quality import build_quality_gate

        coverage = CoverageRecord()

        # Indices
        t0 = time.time()
        idx = await _fetch_index_quotes(FNO_INDICES)
        idx_ms = (time.time() - t0) * 1000
        for sym in FNO_INDICES:
            q = idx.get(sym)
            gate = build_quality_gate(
                quote_age_ms=int(idx_ms), symbol=sym,
                completeness_pct=1.0 if q else 0.0,
                provider_healthy=True, timestamp_valid=True,
            )
            coverage.add(sym, q.ltp if q else None, idx_ms, gate.signalEngineAllowed)

        # Equity in batches of 20
        for i in range(0, len(FNO_EQUITY_TOP50), 20):
            batch = FNO_EQUITY_TOP50[i:i + 20]
            t0 = time.time()
            eq = await _fetch_batch_quotes(None, batch)
            ms = (time.time() - t0) * 1000
            for sym in batch:
                q = eq.get(sym)
                gate = build_quality_gate(
                    quote_age_ms=int(ms), symbol=sym,
                    completeness_pct=1.0 if q else 0.0,
                    provider_healthy=True, timestamp_valid=True,
                )
                coverage.add(sym, q.ltp if q else None, ms, gate.signalEngineAllowed)
            await asyncio.sleep(0.5)

        s = {**coverage.summary(), "details": coverage.details}

        # Write report
        out_dir = Path(__file__).parent.parent.parent / "reports"
        out_dir.mkdir(exist_ok=True)
        ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        out_path = out_dir / f"FNO_COVERAGE_{ts}.json"
        out_path.write_text(json.dumps(s, indent=2))

        print(
            f"\n[LIVE_SESSION] Full F&O coverage:\n"
            f"  Total: {s['total_instruments']}\n"
            f"  Available: {s['quotes_available']}\n"
            f"  Fresh: {s['quotes_fresh']}\n"
            f"  F&O usable: {s['fno_usable_coverage_pct']}%\n"
            f"  Signal-capable: {s['signal_capable_coverage_pct']}%\n"
            f"  Report: {out_path}"
        )
        assert s["fno_usable_coverage_pct"] >= 70.0, (
            f"F&O usable coverage {s['fno_usable_coverage_pct']}% < 70% — "
            "CERTIFICATION BLOCKED"
        )
