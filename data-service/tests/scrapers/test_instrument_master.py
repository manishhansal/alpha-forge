"""
Unit tests for InstrumentMaster — task 7.1.

Covers:
- Disk cache freshness / staleness
- type=FO filtering
- exchange filtering (NSE / BSE)
- Single-instrument lookup by tradingSymbol
- POST /refresh bypasses cache
- HTTP 400 on invalid exchange param
- HTTP 503 when fetch fails and no cache exists
- HTTP 404 for unknown symbol
- Stale cache fallback when upstream fetch errors
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

# ---------------------------------------------------------------------------
# Patch heavy lifespan dependencies before importing the app so the
# TestClient doesn't try to spin up Chromium or connect to Redis.
# We patch at the server module level to avoid importing aioredis directly
# (aioredis 2.0.1 uses distutils which was removed in Python 3.12).
# ---------------------------------------------------------------------------
with patch("src.server.lifespan"):
    from src.server import app

from src.schemas import Instrument
from src.scrapers.instrument_master import (
    NSE_LOT_SIZES,
    _apply_exchange_filter,
    _apply_type_filter,
    _cache_path,
    _invalidate_cache,
    _is_cache_fresh,
    _load_instruments,
    _read_cache,
    _write_cache,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_instrument(**overrides: Any) -> Instrument:
    defaults: dict[str, Any] = {
        "token": "1234",
        "tradingSymbol": "RELIANCE",
        "name": "Reliance Industries",
        "exchange": "NSE",
        "lotSize": 250,
        "instrumentType": "EQ",
        "expiry": "",
        "strike": 0.0,
        "optionType": "",
        "isin": "INE002A01018",
    }
    defaults.update(overrides)
    return Instrument(**defaults)


_NSE_EQ = _make_instrument(symbol="RELIANCE_NSE_EQ", tradingSymbol="RELIANCE", exchange="NSE", instrumentType="EQ")
_NFO_FUT = _make_instrument(token="5678", tradingSymbol="NIFTY25JULFUT", exchange="NFO", instrumentType="FUT", expiry="2025-07-31", name="Nifty Future")
_NFO_CE = _make_instrument(token="9999", tradingSymbol="NIFTY25JUL24000CE", exchange="NFO", instrumentType="CE", expiry="2025-07-31", strike=24000.0, optionType="CE", name="Nifty CE")
_BSE_EQ = _make_instrument(token="500325", tradingSymbol="RELIANCE", exchange="BSE", instrumentType="EQ", name="Reliance BSE")
_BFO_PE = _make_instrument(token="900001", tradingSymbol="SENSEX25JULPE", exchange="BFO", instrumentType="PE", expiry="2025-07-31", strike=80000.0, optionType="PE", name="Sensex PE")

_SAMPLE_NSE = [_NSE_EQ, _NFO_FUT, _NFO_CE]
_SAMPLE_BSE = [_BSE_EQ, _BFO_PE]


# ---------------------------------------------------------------------------
# Pure helper unit tests (no HTTP)
# ---------------------------------------------------------------------------


class TestApplyTypeFilter:
    def test_no_filter_returns_all(self) -> None:
        assert _apply_type_filter(_SAMPLE_NSE, None) == _SAMPLE_NSE

    def test_fo_filter_excludes_eq(self) -> None:
        result = _apply_type_filter(_SAMPLE_NSE, "FO")
        assert all(i.instrumentType in {"FUT", "CE", "PE"} for i in result)
        assert _NSE_EQ not in result

    def test_fo_filter_case_insensitive(self) -> None:
        lower = _apply_type_filter(_SAMPLE_NSE, "fo")
        upper = _apply_type_filter(_SAMPLE_NSE, "FO")
        assert lower == upper

    def test_unknown_filter_returns_all(self) -> None:
        assert _apply_type_filter(_SAMPLE_NSE, "UNKNOWN") == _SAMPLE_NSE


class TestApplyExchangeFilter:
    def test_no_filter_returns_all(self) -> None:
        combined = _SAMPLE_NSE + _SAMPLE_BSE
        assert _apply_exchange_filter(combined, None) == combined

    def test_nse_filter_keeps_nse_and_nfo(self) -> None:
        combined = _SAMPLE_NSE + _SAMPLE_BSE
        result = _apply_exchange_filter(combined, "NSE")
        assert all(i.exchange in {"NSE", "NFO"} for i in result)
        assert _BSE_EQ not in result

    def test_bse_filter_keeps_bse_and_bfo(self) -> None:
        combined = _SAMPLE_NSE + _SAMPLE_BSE
        result = _apply_exchange_filter(combined, "BSE")
        assert all(i.exchange in {"BSE", "BFO"} for i in result)
        assert _NSE_EQ not in result


class TestDiskCacheHelpers:
    def test_cache_path_returns_json_file(self, tmp_path: Path) -> None:
        with patch("src.scrapers.instrument_master.settings") as mock_settings:
            mock_settings.data_dir = str(tmp_path)
            path = _cache_path("NSE")
        assert path.suffix == ".json"
        assert "NSE" in path.name

    def test_is_cache_fresh_missing_file(self, tmp_path: Path) -> None:
        with patch("src.scrapers.instrument_master.settings") as mock_settings:
            mock_settings.data_dir = str(tmp_path)
            assert not _is_cache_fresh(_cache_path("NSE"))

    def test_is_cache_fresh_recent_file(self, tmp_path: Path) -> None:
        p = tmp_path / "NSE.json"
        p.write_text("[]")
        # mtime just set — must be fresh.
        assert _is_cache_fresh(p)

    def test_is_cache_stale_old_file(self, tmp_path: Path) -> None:
        p = tmp_path / "NSE.json"
        p.write_text("[]")
        # Set mtime to 25 hours ago.
        old_mtime = time.time() - (25 * 3600)
        os.utime(p, (old_mtime, old_mtime))
        assert not _is_cache_fresh(p)

    def test_write_and_read_cache_roundtrip(self, tmp_path: Path) -> None:
        instruments = [_NSE_EQ, _NFO_FUT]
        with patch("src.scrapers.instrument_master.settings") as mock_settings:
            mock_settings.data_dir = str(tmp_path)
            path = _cache_path("NSE")
        _write_cache(path, instruments)
        recovered = _read_cache(path)
        assert recovered is not None
        assert len(recovered) == 2
        assert recovered[0]["tradingSymbol"] == "RELIANCE"

    def test_read_cache_returns_none_on_missing_file(self, tmp_path: Path) -> None:
        assert _read_cache(tmp_path / "nonexistent.json") is None

    def test_invalidate_removes_file(self, tmp_path: Path) -> None:
        p = tmp_path / "NSE.json"
        p.write_text("[]")
        assert p.exists()
        _invalidate_cache(p)
        assert not p.exists()

    def test_invalidate_is_noop_when_missing(self, tmp_path: Path) -> None:
        # Should not raise.
        _invalidate_cache(tmp_path / "ghost.json")


import os  # noqa: E402  (placed here to keep grouping clear)


# ---------------------------------------------------------------------------
# _load_instruments unit tests
# ---------------------------------------------------------------------------


class TestLoadInstruments:
    @pytest.mark.asyncio
    async def test_returns_cached_data_when_fresh(self, tmp_path: Path) -> None:
        """When a fresh cache file exists, fetch stubs must NOT be called."""
        with patch("src.scrapers.instrument_master.settings") as mock_settings:
            mock_settings.data_dir = str(tmp_path)
            path = _cache_path("NSE")
        _write_cache(path, _SAMPLE_NSE)

        with (
            patch("src.scrapers.instrument_master._fetch_nse_instruments") as mock_fetch,
            patch("src.scrapers.instrument_master.settings") as mock_settings,
        ):
            mock_settings.data_dir = str(tmp_path)
            instruments, from_cache = await _load_instruments("NSE")

        mock_fetch.assert_not_called()
        assert from_cache is True
        assert len(instruments) == len(_SAMPLE_NSE)

    @pytest.mark.asyncio
    async def test_fetches_when_cache_is_stale(self, tmp_path: Path) -> None:
        with patch("src.scrapers.instrument_master.settings") as mock_settings:
            mock_settings.data_dir = str(tmp_path)
            path = _cache_path("NSE")

        # Write a stale cache file.
        _write_cache(path, [_NSE_EQ])
        old_mtime = time.time() - (25 * 3600)
        os.utime(path, (old_mtime, old_mtime))

        new_data = [_NFO_FUT, _NFO_CE]
        with (
            patch("src.scrapers.instrument_master._fetch_nse_instruments", new_callable=AsyncMock) as mock_fetch,
            patch("src.scrapers.instrument_master.settings") as mock_settings,
        ):
            mock_settings.data_dir = str(tmp_path)
            mock_fetch.return_value = new_data
            instruments, from_cache = await _load_instruments("NSE")

        mock_fetch.assert_called_once()
        assert from_cache is False
        assert instruments == new_data

    @pytest.mark.asyncio
    async def test_force_refresh_ignores_fresh_cache(self, tmp_path: Path) -> None:
        with patch("src.scrapers.instrument_master.settings") as mock_settings:
            mock_settings.data_dir = str(tmp_path)
            path = _cache_path("NSE")
        _write_cache(path, _SAMPLE_NSE)

        fresh_data = [_NFO_CE]
        with (
            patch("src.scrapers.instrument_master._fetch_nse_instruments", new_callable=AsyncMock) as mock_fetch,
            patch("src.scrapers.instrument_master.settings") as mock_settings,
        ):
            mock_settings.data_dir = str(tmp_path)
            mock_fetch.return_value = fresh_data
            instruments, from_cache = await _load_instruments("NSE", force_refresh=True)

        mock_fetch.assert_called_once()
        assert from_cache is False
        assert instruments == fresh_data

    @pytest.mark.asyncio
    async def test_raises_when_fetch_fails_and_no_cache(self, tmp_path: Path) -> None:
        with (
            patch("src.scrapers.instrument_master._fetch_nse_instruments", new_callable=AsyncMock) as mock_fetch,
            patch("src.scrapers.instrument_master.settings") as mock_settings,
        ):
            mock_settings.data_dir = str(tmp_path)
            mock_fetch.side_effect = RuntimeError("upstream unavailable")
            with pytest.raises(RuntimeError, match="upstream unavailable"):
                await _load_instruments("NSE")

    @pytest.mark.asyncio
    async def test_serves_stale_cache_when_fetch_fails(self, tmp_path: Path) -> None:
        """When fetch fails but a stale cache file exists, serve the stale data."""
        with patch("src.scrapers.instrument_master.settings") as mock_settings:
            mock_settings.data_dir = str(tmp_path)
            path = _cache_path("NSE")

        # Write stale cache.
        _write_cache(path, _SAMPLE_NSE)
        old_mtime = time.time() - (25 * 3600)
        os.utime(path, (old_mtime, old_mtime))

        with (
            patch("src.scrapers.instrument_master._fetch_nse_instruments", new_callable=AsyncMock) as mock_fetch,
            patch("src.scrapers.instrument_master.settings") as mock_settings,
        ):
            mock_settings.data_dir = str(tmp_path)
            mock_fetch.side_effect = RuntimeError("network error")
            instruments, from_cache = await _load_instruments("NSE")

        assert from_cache is True
        assert len(instruments) == len(_SAMPLE_NSE)


# ---------------------------------------------------------------------------
# HTTP endpoint tests via TestClient
# ---------------------------------------------------------------------------


@pytest.fixture()
def client(tmp_path: Path):
    """FastAPI TestClient with both fetch stubs mocked and settings patched to tmp_path."""
    with (
        patch("src.scrapers.instrument_master._fetch_nse_instruments", new_callable=AsyncMock) as mock_nse,
        patch("src.scrapers.instrument_master._fetch_bse_instruments", new_callable=AsyncMock) as mock_bse,
        patch("src.scrapers.instrument_master.settings") as mock_settings,
    ):
        mock_settings.data_dir = str(tmp_path)
        mock_nse.return_value = _SAMPLE_NSE
        mock_bse.return_value = _SAMPLE_BSE
        with TestClient(app, raise_server_exceptions=False) as c:
            c._nse_mock = mock_nse
            c._bse_mock = mock_bse
            yield c


class TestGetInstrumentsEndpoint:
    def test_returns_all_instruments_no_filter(self, client: TestClient) -> None:
        resp = client.get("/scraping/instruments")
        assert resp.status_code == 200
        data = resp.json()
        assert "instruments" in data
        assert "count" in data
        assert data["count"] == len(data["instruments"])
        assert data["exchange"] == "ALL"

    def test_type_fo_excludes_eq(self, client: TestClient) -> None:
        resp = client.get("/scraping/instruments?type=FO")
        assert resp.status_code == 200
        data = resp.json()
        for inst in data["instruments"]:
            assert inst["instrumentType"] in {"FUT", "CE", "PE"}

    def test_exchange_nse_filters_correctly(self, client: TestClient) -> None:
        resp = client.get("/scraping/instruments?exchange=NSE")
        assert resp.status_code == 200
        data = resp.json()
        for inst in data["instruments"]:
            assert inst["exchange"] in {"NSE", "NFO"}
        assert data["exchange"] == "NSE"

    def test_exchange_bse_filters_correctly(self, client: TestClient) -> None:
        resp = client.get("/scraping/instruments?exchange=BSE")
        assert resp.status_code == 200
        data = resp.json()
        for inst in data["instruments"]:
            assert inst["exchange"] in {"BSE", "BFO"}
        assert data["exchange"] == "BSE"

    def test_invalid_exchange_returns_400(self, client: TestClient) -> None:
        resp = client.get("/scraping/instruments?exchange=INVALID")
        assert resp.status_code == 400
        assert "error" in resp.json()

    def test_count_equals_instruments_length(self, client: TestClient) -> None:
        resp = client.get("/scraping/instruments")
        data = resp.json()
        assert data["count"] == len(data["instruments"])

    def test_cache_false_on_first_fetch(self, client: TestClient, tmp_path: Path) -> None:
        resp = client.get("/scraping/instruments")
        assert resp.status_code == 200
        # First request must go through fetch (stubs return new data → cached=False)
        # because tmp_path has no pre-existing cache.
        data = resp.json()
        assert data["cached"] is False


class TestGetInstrumentBySymbolEndpoint:
    def test_found_returns_instrument(self, client: TestClient) -> None:
        resp = client.get("/scraping/instruments/RELIANCE")
        assert resp.status_code == 200
        data = resp.json()
        assert "instrument" in data
        assert data["instrument"]["tradingSymbol"].upper() == "RELIANCE"

    def test_lookup_case_insensitive(self, client: TestClient) -> None:
        resp = client.get("/scraping/instruments/reliance")
        assert resp.status_code == 200

    def test_unknown_symbol_returns_404(self, client: TestClient) -> None:
        resp = client.get("/scraping/instruments/UNKNOWN_XXXXXX")
        assert resp.status_code == 404
        assert "error" in resp.json()


class TestRefreshEndpoint:
    def test_refresh_returns_instruments_and_refreshed_flag(self, client: TestClient) -> None:
        resp = client.post("/scraping/instruments/refresh")
        assert resp.status_code == 200
        data = resp.json()
        assert data["refreshed"] is True
        assert data["cached"] is False
        assert "instruments" in data
        assert "count" in data

    def test_refresh_with_exchange_param(self, client: TestClient) -> None:
        resp = client.post("/scraping/instruments/refresh?exchange=NSE")
        assert resp.status_code == 200
        data = resp.json()
        assert data["exchange"] == "NSE"
        assert data["refreshed"] is True

    def test_refresh_invalid_exchange_returns_400(self, client: TestClient) -> None:
        resp = client.post("/scraping/instruments/refresh?exchange=XYZ")
        assert resp.status_code == 400


class TestHTTP503OnUpstreamFailure:
    def test_get_instruments_503_when_fetch_fails_and_no_cache(self, tmp_path: Path) -> None:
        with (
            patch("src.scrapers.instrument_master._fetch_nse_instruments", new_callable=AsyncMock) as mock_nse,
            patch("src.scrapers.instrument_master._fetch_bse_instruments", new_callable=AsyncMock) as mock_bse,
            patch("src.scrapers.instrument_master.settings") as mock_settings,
        ):
            mock_settings.data_dir = str(tmp_path)
            mock_nse.side_effect = RuntimeError("NSE down")
            mock_bse.side_effect = RuntimeError("BSE down")
            with TestClient(app, raise_server_exceptions=False) as c:
                resp = c.get("/scraping/instruments")
        assert resp.status_code == 503
        data = resp.json()
        assert data["available"] is False
        assert "reason" in data

    def test_get_instrument_by_symbol_503_when_fetch_fails(self, tmp_path: Path) -> None:
        with (
            patch("src.scrapers.instrument_master._fetch_nse_instruments", new_callable=AsyncMock) as mock_nse,
            patch("src.scrapers.instrument_master._fetch_bse_instruments", new_callable=AsyncMock) as mock_bse,
            patch("src.scrapers.instrument_master.settings") as mock_settings,
        ):
            mock_settings.data_dir = str(tmp_path)
            mock_nse.side_effect = RuntimeError("NSE down")
            mock_bse.side_effect = RuntimeError("BSE down")
            with TestClient(app, raise_server_exceptions=False) as c:
                resp = c.get("/scraping/instruments/NIFTY")
        assert resp.status_code == 503


class TestDiskCachePreventsFetch:
    def test_second_request_served_from_cache(self, tmp_path: Path) -> None:
        """After the first fetch writes the cache, the second request must not call fetch."""
        with (
            patch("src.scrapers.instrument_master._fetch_nse_instruments", new_callable=AsyncMock) as mock_nse,
            patch("src.scrapers.instrument_master._fetch_bse_instruments", new_callable=AsyncMock) as mock_bse,
            patch("src.scrapers.instrument_master.settings") as mock_settings,
        ):
            mock_settings.data_dir = str(tmp_path)
            mock_nse.return_value = _SAMPLE_NSE
            mock_bse.return_value = _SAMPLE_BSE
            with TestClient(app, raise_server_exceptions=False) as c:
                # First request — fetches and writes cache.
                r1 = c.get("/scraping/instruments?exchange=NSE")
                assert r1.status_code == 200

                # Reset call count.
                mock_nse.reset_mock()

                # Second request — should hit cache.
                r2 = c.get("/scraping/instruments?exchange=NSE")
                assert r2.status_code == 200
                mock_nse.assert_not_called()
                assert r2.json()["cached"] is True


class TestHardcodedLotSizes:
    def test_nse_lot_sizes_has_expected_entries(self) -> None:
        assert NSE_LOT_SIZES["NIFTY"] == 50
        assert NSE_LOT_SIZES["BANKNIFTY"] == 15
        assert NSE_LOT_SIZES["FINNIFTY"] == 40
        assert NSE_LOT_SIZES["MIDCPNIFTY"] == 75
        assert NSE_LOT_SIZES["SENSEX"] == 10
        assert NSE_LOT_SIZES["BANKEX"] == 15



# ---------------------------------------------------------------------------
# Task 7.2 — fetch implementation tests
# Uses unittest.mock to patch httpx.AsyncClient — no extra dependencies needed.
# ---------------------------------------------------------------------------

import io
import zipfile
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from src.scrapers.instrument_master import (
    NSE_LOT_SIZES,
    _BSE_EQUITY_ZIP_URL,
    _NSE_LOT_CSV_URL,
    _fetch_bse_instruments,
    _fetch_nse_instruments,
    _make_nse_fallback_instruments,
)


# ── Helpers ──────────────────────────────────────────────────────────────────


def _mock_nse_response(content: bytes, status_code: int = 200) -> MagicMock:
    """Return an AsyncMock that simulates httpx.AsyncClient.get() for NSE CSV."""
    mock_response = MagicMock(spec=httpx.Response)
    mock_response.status_code = status_code
    mock_response.content = content
    if status_code >= 400:
        mock_response.raise_for_status.side_effect = httpx.HTTPStatusError(
            f"HTTP {status_code}", request=MagicMock(), response=mock_response
        )
    else:
        mock_response.raise_for_status.return_value = None
    return mock_response


def _mock_bse_response(content: bytes, status_code: int = 200) -> MagicMock:
    """Return an AsyncMock that simulates httpx.AsyncClient.get() for BSE ZIP."""
    mock_response = MagicMock(spec=httpx.Response)
    mock_response.status_code = status_code
    mock_response.content = content
    return mock_response


def _make_async_client_cm(response: MagicMock | Exception) -> MagicMock:
    """Build a mock for ``httpx.AsyncClient`` used as an async context manager."""
    mock_client = AsyncMock()
    if isinstance(response, Exception):
        mock_client.get = AsyncMock(side_effect=response)
    else:
        mock_client.get = AsyncMock(return_value=response)
    mock_cm = MagicMock()
    mock_cm.__aenter__ = AsyncMock(return_value=mock_client)
    mock_cm.__aexit__ = AsyncMock(return_value=False)
    return mock_cm


def _make_bse_zip(csv_content: str, filename: str = "EQUITY_01012025.CSV") -> bytes:
    """Build an in-memory ZIP containing *csv_content* under *filename*."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(filename, csv_content)
    return buf.getvalue()


# ── NSE CSV test fixtures ────────────────────────────────────────────────────

_SAMPLE_NSE_LOT_CSV = (
    "SYMBOL,LOT SIZE\n"
    "NIFTY,75\n"
    "BANKNIFTY,30\n"
    "FINNIFTY,40\n"
    "MIDCPNIFTY,75\n"
    "GOLDPETAL,250\n"
)

_SAMPLE_NSE_LOT_CSV_ALT_COLS = (
    "SYMBOL NAME,SERIES,LOT SIZE\n"
    "NIFTY,EQ,75\n"
    "BANKNIFTY,EQ,30\n"
)

_SAMPLE_NSE_LOT_CSV_WITH_SECTION_HEADER = (
    "NSE F&O LOT SIZES\n"
    "SYMBOL,LOT SIZE\n"
    "NIFTY,75\n"
    "BANKNIFTY,30\n"
)

# ── BSE CSV fixture ──────────────────────────────────────────────────────────

_SAMPLE_BSE_CSV = (
    "Security Code,Security Name,Series,ISIN No.,Status\n"
    "500325,Reliance Industries Limited,EQ,INE002A01018,Active\n"
    "532540,Infosys Limited,EQ,INE009A01021,Active\n"
    "500010,HDFC Bank Limited,EQ,INE040A01034,Active\n"
)


# ── NSE fetch tests ──────────────────────────────────────────────────────────


class TestFetchNseInstruments:
    """Tests for _fetch_nse_instruments — NSE CloudFront CDN CSV path."""

    @pytest.mark.asyncio
    async def test_parses_standard_csv_format(self) -> None:
        resp = _mock_nse_response(_SAMPLE_NSE_LOT_CSV.encode())
        with patch("httpx.AsyncClient", return_value=_make_async_client_cm(resp)):
            instruments = await _fetch_nse_instruments()
        symbols = {i.tradingSymbol for i in instruments}
        assert "NIFTY" in symbols
        assert "BANKNIFTY" in symbols
        nifty = next(i for i in instruments if i.tradingSymbol == "NIFTY")
        assert nifty.lotSize == 75
        assert nifty.exchange == "NFO"
        assert nifty.instrumentType == "FUT"
        assert nifty.expiry == ""
        assert nifty.strike == 0.0
        assert nifty.optionType == ""

    @pytest.mark.asyncio
    async def test_parses_alt_column_format(self) -> None:
        """Lot size in column 2 when column 1 is a non-numeric series."""
        resp = _mock_nse_response(_SAMPLE_NSE_LOT_CSV_ALT_COLS.encode())
        with patch("httpx.AsyncClient", return_value=_make_async_client_cm(resp)):
            instruments = await _fetch_nse_instruments()
        symbols = {i.tradingSymbol for i in instruments}
        assert "NIFTY" in symbols
        nifty = next(i for i in instruments if i.tradingSymbol == "NIFTY")
        assert nifty.lotSize == 75

    @pytest.mark.asyncio
    async def test_skips_header_rows(self) -> None:
        """Rows where first column is 'SYMBOL' or a section title must be skipped."""
        resp = _mock_nse_response(_SAMPLE_NSE_LOT_CSV_WITH_SECTION_HEADER.encode())
        with patch("httpx.AsyncClient", return_value=_make_async_client_cm(resp)):
            instruments = await _fetch_nse_instruments()
        trading_symbols = {i.tradingSymbol for i in instruments}
        assert "SYMBOL" not in trading_symbols
        assert "NIFTY" in trading_symbols

    @pytest.mark.asyncio
    async def test_falls_back_to_hardcoded_on_http_error(self) -> None:
        resp = _mock_nse_response(b"", status_code=503)
        with patch("httpx.AsyncClient", return_value=_make_async_client_cm(resp)):
            instruments = await _fetch_nse_instruments()
        symbols = {i.tradingSymbol for i in instruments}
        for sym in NSE_LOT_SIZES:
            assert sym in symbols

    @pytest.mark.asyncio
    async def test_falls_back_to_hardcoded_on_connection_error(self) -> None:
        err = httpx.ConnectError("connection refused")
        with patch("httpx.AsyncClient", return_value=_make_async_client_cm(err)):
            instruments = await _fetch_nse_instruments()
        symbols = {i.tradingSymbol for i in instruments}
        for sym in NSE_LOT_SIZES:
            assert sym in symbols

    @pytest.mark.asyncio
    async def test_falls_back_on_empty_parse_result(self) -> None:
        """Header-only CSV (no data rows) triggers fallback to hardcoded."""
        empty_csv = "SYMBOL,LOT SIZE\n"
        resp = _mock_nse_response(empty_csv.encode())
        with patch("httpx.AsyncClient", return_value=_make_async_client_cm(resp)):
            instruments = await _fetch_nse_instruments()
        symbols = {i.tradingSymbol for i in instruments}
        for sym in NSE_LOT_SIZES:
            assert sym in symbols

    def test_make_nse_fallback_instruments_matches_lot_sizes(self) -> None:
        fallback = _make_nse_fallback_instruments()
        assert len(fallback) == len(NSE_LOT_SIZES)
        lot_map = {i.tradingSymbol: i.lotSize for i in fallback}
        for sym, lot in NSE_LOT_SIZES.items():
            assert lot_map[sym] == lot


# ── BSE fetch tests ──────────────────────────────────────────────────────────


class TestFetchBseInstruments:
    """Tests for _fetch_bse_instruments — BSE equity scrip master ZIP path."""

    @pytest.mark.asyncio
    async def test_parses_standard_bse_csv(self) -> None:
        zip_bytes = _make_bse_zip(_SAMPLE_BSE_CSV)
        resp = _mock_bse_response(zip_bytes)
        with patch("httpx.AsyncClient", return_value=_make_async_client_cm(resp)):
            instruments = await _fetch_bse_instruments()
        assert len(instruments) == 3
        tokens = {i.token for i in instruments}
        assert "500325" in tokens
        assert "532540" in tokens

    @pytest.mark.asyncio
    async def test_field_mapping_is_correct(self) -> None:
        zip_bytes = _make_bse_zip(_SAMPLE_BSE_CSV)
        resp = _mock_bse_response(zip_bytes)
        with patch("httpx.AsyncClient", return_value=_make_async_client_cm(resp)):
            instruments = await _fetch_bse_instruments()
        rel = next(i for i in instruments if i.token == "500325")
        assert "Reliance Industries" in rel.name
        assert rel.exchange == "BSE"
        assert rel.instrumentType == "EQ"
        assert rel.lotSize == 1
        assert rel.expiry == ""
        assert rel.strike == 0.0
        assert rel.optionType == ""
        assert rel.isin == "INE002A01018"

    @pytest.mark.asyncio
    async def test_trading_symbol_truncated_to_50_chars(self) -> None:
        long_name = "A" * 80
        csv_content = (
            "Security Code,Security Name,Series,ISIN No.,Status\n"
            f"999999,{long_name},EQ,INE000X00000,Active\n"
        )
        zip_bytes = _make_bse_zip(csv_content)
        resp = _mock_bse_response(zip_bytes)
        with patch("httpx.AsyncClient", return_value=_make_async_client_cm(resp)):
            instruments = await _fetch_bse_instruments()
        assert len(instruments) == 1
        assert len(instruments[0].tradingSymbol) == 50
        assert len(instruments[0].name) == 80  # 80 < 100 so not truncated

    @pytest.mark.asyncio
    async def test_raises_on_non_200_response(self) -> None:
        resp = _mock_bse_response(b"", status_code=404)
        with patch("httpx.AsyncClient", return_value=_make_async_client_cm(resp)):
            with pytest.raises(RuntimeError, match="HTTP 404"):
                await _fetch_bse_instruments()

    @pytest.mark.asyncio
    async def test_raises_on_corrupt_zip(self) -> None:
        resp = _mock_bse_response(b"not a zip file")
        with patch("httpx.AsyncClient", return_value=_make_async_client_cm(resp)):
            with pytest.raises(RuntimeError, match="corrupt"):
                await _fetch_bse_instruments()

    @pytest.mark.asyncio
    async def test_raises_on_connection_error(self) -> None:
        err = httpx.ConnectError("no route to host")
        with patch("httpx.AsyncClient", return_value=_make_async_client_cm(err)):
            with pytest.raises(RuntimeError, match="download failed"):
                await _fetch_bse_instruments()

    @pytest.mark.asyncio
    async def test_raises_on_zip_with_no_csv(self) -> None:
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr("README.txt", "no csv here")
        resp = _mock_bse_response(buf.getvalue())
        with patch("httpx.AsyncClient", return_value=_make_async_client_cm(resp)):
            with pytest.raises(RuntimeError, match="no CSV file"):
                await _fetch_bse_instruments()

    @pytest.mark.asyncio
    async def test_skips_rows_with_empty_code_or_name(self) -> None:
        csv_content = (
            "Security Code,Security Name,Series\n"
            "500325,Reliance Industries Limited,EQ\n"
            ",Empty Code,EQ\n"       # missing code → skip
            "500001,,EQ\n"           # missing name → skip
        )
        zip_bytes = _make_bse_zip(csv_content)
        resp = _mock_bse_response(zip_bytes)
        with patch("httpx.AsyncClient", return_value=_make_async_client_cm(resp)):
            instruments = await _fetch_bse_instruments()
        assert len(instruments) == 1
        assert instruments[0].token == "500325"
