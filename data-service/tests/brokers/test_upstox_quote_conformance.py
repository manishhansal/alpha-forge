"""
Upstox quote parser conformance tests (data-service).

Uses the REAL /v2/market-quote/quotes response shape (verified live) to guard:
  - provider is "upstox" (the MDQuote provider Literal was widened from
    "scrapling"-only, which previously made every Upstox quote fail validation),
  - changePct is COMPUTED from net_change / ohlc.close (Upstox does NOT return
    net_change_percentage),
  - total_buy_quantity / total_sell_quantity map to totalBuyQty / totalSellQty
    (Upstox uses *_quantity, not *_qty),
  - oi/prevClose/circuit fields map correctly.
"""

from __future__ import annotations

import httpx
import pytest

from src.brokers import upstox_client
from src.core import provider_http


# Real /v2/market-quote/quotes item shape (from the live API).
_REAL_ITEM = {
    "ohlc": {"open": 1304.1, "high": 1306.8, "low": 1298.2, "close": 1309.5},
    "depth": {"buy": [], "sell": []},
    "timestamp": "2026-09-08T10:18:48.85+05:30",
    "instrument_token": "NSE_EQ|INE002A01018",
    "symbol": "NA",
    "last_price": 1300.3,
    "volume": 12345,
    "average_price": 1301.36,
    "oi": 0,
    "net_change": -9.2,
    "total_buy_quantity": 50000,
    "total_sell_quantity": 45000,
    "lower_circuit_limit": 1178.55,
    "upper_circuit_limit": 1440.45,
    "last_trade_time": "2026-09-08T10:18:46+05:30",
}


def _install_mock(payload: dict) -> None:
    def handler(_req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"status": "success", "data": payload})

    transport = httpx.MockTransport(handler)
    provider_http._clients[upstox_client._UPSTOX_BASE] = httpx.AsyncClient(
        base_url=upstox_client._UPSTOX_BASE, transport=transport
    )


@pytest.fixture(autouse=True)
async def _cfg(monkeypatch):
    monkeypatch.setenv("UPSTOX_ANALYTICS_TOKEN", "test-token")
    yield
    await provider_http.close_all_clients()


async def test_quote_provider_is_upstox_and_fields_map_correctly():
    _install_mock({"NSE_EQ:RELIANCE": _REAL_ITEM})
    quotes = await upstox_client.get_quotes(["RELIANCE"], exchange="NSE")
    assert "RELIANCE" in quotes, "quote should parse (provider Literal must allow 'upstox')"
    q = quotes["RELIANCE"]
    assert q.provider == "upstox"
    assert q.ltp == 1300.3
    assert q.change == -9.2
    # changePct computed from net_change / ohlc.close: -9.2 / 1309.5 * 100
    assert q.changePct is not None
    assert abs(q.changePct - (-9.2 / 1309.5 * 100)) < 1e-6
    assert q.prevClose == 1309.5
    assert q.totalBuyQty == 50000
    assert q.totalSellQty == 45000
    assert q.oi == 0
    assert q.upperCircuit == 1440.45


async def test_quote_without_net_change_has_null_changePct():
    item = dict(_REAL_ITEM)
    item.pop("net_change")
    _install_mock({"NSE_EQ:RELIANCE": item})
    quotes = await upstox_client.get_quotes(["RELIANCE"], exchange="NSE")
    q = quotes["RELIANCE"]
    assert q.change is None
    assert q.changePct is None
