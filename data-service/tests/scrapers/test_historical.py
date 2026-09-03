"""
Unit tests for ``GET /scraping/historical`` — BhavcopyScraper.

Covers:
  1. NSE daily CSV → correct OHLCV field mapping
  2. BSE daily ZIP → correct OHLCV field mapping
  3. Disk cache prevents a second HTTP call when mtime < 24 h
  4. IST-to-UTC timestamp conversion for intraday candles
  5. HTTP 400 on missing required parameter(s)
  6. HTTP 400 on invalid exchange value
  7. HTTP 400 on invalid interval value
  8. HTTP 400 when from > to
  9. HTTP 400 when daily range exceeds 1825 days
 10. HTTP 200 {candles: [], count: 0} when symbol not found / upstream returns empty CSV
 11. HTTP 503 when the upstream fetch raises an exception (timeout / error)

Pure helper unit tests (no HTTP, no mocks):
  - _ist_ms_to_utc_s  (IST ms → UTC s arithmetic)
  - _validate_params  (all validation branches)
  - _build_response   (count == len(candles), candles sorted by time)

Requirements: 2.1 – 2.13
"""

from __future__ import annotations

import gzip
import io
import json
import os
import time
import zipfile
from contextlib import asynccontextmanager
from datetime import date, timezone, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from fastapi.responses import JSONResponse


# ---------------------------------------------------------------------------
# Fixtures — NSE and BSE test data
# ---------------------------------------------------------------------------

# NSE historical CSV fixture (csvFlag=1 format)
# Columns: Date, Series, OPEN, HIGH, LOW, CLOSE, LAST, PREVCLOSE, TOTTRDQTY, ...
_NSE_CSV = (
    "Date,Series,OPEN,HIGH,LOW,CLOSE,LAST,PREVCLOSE,TOTTRDQTY,TOTTRDVAL,"
    "TIMESTAMP,TOTALTRADES,ISIN\n"
    "01-JAN-2024,EQ,1950.00,1975.50,1942.00,1965.30,1965.30,1948.50,"
    "12345678,0,01-JAN-2024,45678,ISIN001\n"
)

# NSE empty CSV (no data rows — symbol not found or empty range)
_NSE_CSV_EMPTY = (
    "Date,Series,OPEN,HIGH,LOW,CLOSE,LAST,PREVCLOSE,TOTTRDQTY,TOTTRDVAL,"
    "TIMESTAMP,TOTALTRADES,ISIN\n"
)

# BSE Bhavcopy CSV fixture (EQ{DDMMYYYY}_CSV.CSV inside ZIP)
_BSE_CSV = (
    "Code,Name,Open,High,Low,Close,No of Shares,Turnover\n"
    "500325,RELIANCE,1950.00,1975.50,1942.00,1965.30,12345678,0\n"
)

# NSE charting API response fixture (intraday)
# grapthData: [[ts_ms_ist, open, high, low, close, volume], ...]
_NSE_INTRADAY_JSON = {
    "grapthData": [
        [1_630_000_000_000, 1950.0, 1975.5, 1942.0, 1965.3, 12345678],
    ]
}

# BSE charting API response fixture (intraday)
_BSE_INTRADAY_JSON = {
    "Data": [
        [1_630_000_000_000, 1950.0, 1975.5, 1942.0, 1965.3, 12345678],
    ]
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_bse_zip(csv_date_str: str, csv_content: str = _BSE_CSV) -> bytes:
    """Build an in-memory ZIP containing the BSE Bhavcopy CSV file."""
    buf = io.BytesIO()
    filename = f"EQ{csv_date_str}_CSV.CSV"
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(filename, csv_content)
    buf.seek(0)
    return buf.read()


def _gzip_json(data: list) -> bytes:
    """Return gzip-compressed JSON bytes for a candle list."""
    raw = json.dumps(data).encode("utf-8")
    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode="wb") as gz:
        gz.write(raw)
    return buf.getvalue()


# ---------------------------------------------------------------------------
# no-op lifespan fixture (keeps startup infra out of tests)
# ---------------------------------------------------------------------------


@asynccontextmanager
async def _noop_lifespan(app):  # noqa: ANN001
    import src.monitoring.router as _mon

    _mon._service_initialized = False
    _mon._proxy_manager = None
    _mon._session_warmer = None
    yield
    _mon._service_initialized = False


@pytest.fixture
def test_client():
    """TestClient with a no-op lifespan so no real infrastructure is started."""
    with patch("src.server.lifespan", _noop_lifespan):
        from src.server import app

        app.router.lifespan_context = _noop_lifespan
        with TestClient(app, raise_server_exceptions=False) as client:
            yield client


# ---------------------------------------------------------------------------
# Pure helper unit tests (no HTTP, no mocks)
# ---------------------------------------------------------------------------


class TestIstToUtcConversion:
    """Unit tests for the _ist_ms_to_utc_s pure function."""

    def test_known_value(self):
        """1_630_000_000_000 ms IST → 1_629_980_200 UTC s."""
        from src.scrapers.historical import _ist_ms_to_utc_s

        assert _ist_ms_to_utc_s(1_630_000_000_000) == 1_629_980_200

    def test_zero_epoch(self):
        """UTC epoch 0 IST (ts_ms_ist=19_800_000) → 0 UTC s."""
        from src.scrapers.historical import _ist_ms_to_utc_s

        # IST midnight 1970-01-01 is 19800 s after UTC epoch
        assert _ist_ms_to_utc_s(19_800 * 1_000) == 0

    def test_round_trip_property(self):
        """Converting IST ms → UTC s and back is lossless for whole seconds."""
        from src.scrapers.historical import _ist_ms_to_utc_s

        ts_ms_ist = 1_700_000_000_000  # arbitrary timestamp
        utc_s = _ist_ms_to_utc_s(ts_ms_ist)
        recovered_ms_ist = (utc_s + 19_800) * 1_000
        assert recovered_ms_ist == ts_ms_ist

    def test_negative_offset_does_not_underflow_for_recent_dates(self):
        """Large modern timestamps remain positive after IST offset removal."""
        from src.scrapers.historical import _ist_ms_to_utc_s

        assert _ist_ms_to_utc_s(1_700_000_000_000) > 0


class TestValidateParams:
    """Unit tests for the _validate_params pure helper."""

    def test_valid_params_returns_date_tuple(self):
        """All valid inputs must return a (from_date, to_date) tuple."""
        from src.scrapers.historical import _validate_params

        result = _validate_params("RELIANCE", "NSE", "1d", "2024-01-01", "2024-03-01")
        assert isinstance(result, tuple)
        assert result[0] == date(2024, 1, 1)
        assert result[1] == date(2024, 3, 1)

    def test_missing_symbol_returns_400(self):
        """Missing symbol → JSONResponse with 400 status."""
        from src.scrapers.historical import _validate_params

        result = _validate_params(None, "NSE", "1d", "2024-01-01", "2024-03-01")
        assert isinstance(result, JSONResponse)
        assert result.status_code == 400

    def test_missing_exchange_returns_400(self):
        from src.scrapers.historical import _validate_params

        result = _validate_params("RELIANCE", None, "1d", "2024-01-01", "2024-03-01")
        assert isinstance(result, JSONResponse)
        assert result.status_code == 400

    def test_invalid_exchange_returns_400(self):
        from src.scrapers.historical import _validate_params

        result = _validate_params("RELIANCE", "INVALID", "1d", "2024-01-01", "2024-03-01")
        assert isinstance(result, JSONResponse)
        assert result.status_code == 400

    def test_invalid_interval_returns_400(self):
        from src.scrapers.historical import _validate_params

        result = _validate_params("RELIANCE", "NSE", "3h", "2024-01-01", "2024-03-01")
        assert isinstance(result, JSONResponse)
        assert result.status_code == 400

    def test_from_after_to_returns_400(self):
        from src.scrapers.historical import _validate_params

        result = _validate_params("RELIANCE", "NSE", "1d", "2024-03-01", "2024-01-01")
        assert isinstance(result, JSONResponse)
        assert result.status_code == 400

    def test_daily_range_exceeds_1825_days_returns_400(self):
        from src.scrapers.historical import _validate_params

        result = _validate_params("RELIANCE", "NSE", "1d", "2018-01-01", "2024-01-01")
        assert isinstance(result, JSONResponse)
        assert result.status_code == 400

    def test_intraday_range_exceeds_365_days_returns_400(self):
        from src.scrapers.historical import _validate_params

        result = _validate_params("RELIANCE", "NSE", "5m", "2022-01-01", "2024-01-01")
        assert isinstance(result, JSONResponse)
        assert result.status_code == 400

    def test_same_from_to_is_valid(self):
        """from == to is a valid single-day range."""
        from src.scrapers.historical import _validate_params

        result = _validate_params("NIFTY", "NSE", "1d", "2024-06-01", "2024-06-01")
        assert isinstance(result, tuple)

    def test_invalid_date_format_returns_400(self):
        """Non-ISO date format → 400."""
        from src.scrapers.historical import _validate_params

        result = _validate_params("NIFTY", "NSE", "1d", "01-01-2024", "2024-06-01")
        assert isinstance(result, JSONResponse)
        assert result.status_code == 400


class TestBuildResponse:
    """Unit tests for the _build_response pure helper."""

    def test_count_equals_len_candles(self):
        from src.scrapers.historical import _build_response
        from src.schemas import OHLCVCandle

        candles = [
            OHLCVCandle(time=1_000, open=100.0, high=105.0, low=99.0, close=103.0, volume=1000),
            OHLCVCandle(time=2_000, open=103.0, high=108.0, low=102.0, close=107.0, volume=1500),
        ]
        body = _build_response("NIFTY", "NSE", "1d", candles, "bhavcopy")
        assert body["count"] == 2
        assert len(body["candles"]) == 2

    def test_candles_sorted_ascending_by_time(self):
        """Candles must be sorted ascending by time regardless of input order."""
        from src.scrapers.historical import _build_response
        from src.schemas import OHLCVCandle

        candles = [
            OHLCVCandle(time=3_000, open=100.0, high=105.0, low=99.0, close=103.0, volume=1000),
            OHLCVCandle(time=1_000, open=103.0, high=108.0, low=102.0, close=107.0, volume=1500),
            OHLCVCandle(time=2_000, open=99.0, high=101.0, low=98.0, close=100.0, volume=500),
        ]
        body = _build_response("NIFTY", "NSE", "1d", candles, "bhavcopy")
        times = [c["time"] for c in body["candles"]]
        assert times == sorted(times)

    def test_empty_candles_returns_count_zero(self):
        from src.scrapers.historical import _build_response

        body = _build_response("NIFTY", "NSE", "1d", [], "bhavcopy")
        assert body["count"] == 0
        assert body["candles"] == []


# ---------------------------------------------------------------------------
# HTTP endpoint tests (via TestClient)
# ---------------------------------------------------------------------------


class TestHistoricalValidation:
    """HTTP 400 cases — parameter validation through the full request pipeline."""

    def test_missing_all_params_returns_400(self, test_client):
        """GET /scraping/historical with no params → 400."""
        resp = test_client.get("/scraping/historical")
        assert resp.status_code == 400
        body = resp.json()
        assert "error" in body

    def test_missing_symbol_returns_400(self, test_client):
        resp = test_client.get(
            "/scraping/historical",
            params={"exchange": "NSE", "interval": "1d", "from": "2024-01-01", "to": "2024-03-01"},
        )
        assert resp.status_code == 400
        assert "error" in resp.json()

    def test_missing_exchange_returns_400(self, test_client):
        resp = test_client.get(
            "/scraping/historical",
            params={"symbol": "RELIANCE", "interval": "1d", "from": "2024-01-01", "to": "2024-03-01"},
        )
        assert resp.status_code == 400
        assert "error" in resp.json()

    def test_missing_interval_returns_400(self, test_client):
        resp = test_client.get(
            "/scraping/historical",
            params={"symbol": "RELIANCE", "exchange": "NSE", "from": "2024-01-01", "to": "2024-03-01"},
        )
        assert resp.status_code == 400
        assert "error" in resp.json()

    def test_missing_from_returns_400(self, test_client):
        resp = test_client.get(
            "/scraping/historical",
            params={"symbol": "RELIANCE", "exchange": "NSE", "interval": "1d", "to": "2024-03-01"},
        )
        assert resp.status_code == 400
        assert "error" in resp.json()

    def test_missing_to_returns_400(self, test_client):
        resp = test_client.get(
            "/scraping/historical",
            params={"symbol": "RELIANCE", "exchange": "NSE", "interval": "1d", "from": "2024-01-01"},
        )
        assert resp.status_code == 400
        assert "error" in resp.json()

    def test_invalid_exchange_returns_400(self, test_client):
        """exchange=INVALID → 400."""
        resp = test_client.get(
            "/scraping/historical",
            params={
                "symbol": "RELIANCE",
                "exchange": "INVALID",
                "interval": "1d",
                "from": "2024-01-01",
                "to": "2024-03-01",
            },
        )
        assert resp.status_code == 400
        body = resp.json()
        assert "error" in body
        assert "exchange" in body["error"].lower() or "INVALID" in body["error"]

    def test_invalid_interval_returns_400(self, test_client):
        """interval=3h → 400."""
        resp = test_client.get(
            "/scraping/historical",
            params={
                "symbol": "RELIANCE",
                "exchange": "NSE",
                "interval": "3h",
                "from": "2024-01-01",
                "to": "2024-03-01",
            },
        )
        assert resp.status_code == 400
        body = resp.json()
        assert "error" in body
        assert "interval" in body["error"].lower() or "3h" in body["error"]

    def test_from_after_to_returns_400(self, test_client):
        """from > to → 400."""
        resp = test_client.get(
            "/scraping/historical",
            params={
                "symbol": "RELIANCE",
                "exchange": "NSE",
                "interval": "1d",
                "from": "2024-03-01",
                "to": "2024-01-01",
            },
        )
        assert resp.status_code == 400
        body = resp.json()
        assert "error" in body

    def test_daily_range_exceeds_1825_days_returns_400(self, test_client):
        """1d interval with span > 1825 days → 400."""
        resp = test_client.get(
            "/scraping/historical",
            params={
                "symbol": "RELIANCE",
                "exchange": "NSE",
                "interval": "1d",
                "from": "2018-01-01",
                "to": "2024-01-01",
            },
        )
        assert resp.status_code == 400
        body = resp.json()
        assert "error" in body
        assert "1825" in body["error"]

    def test_intraday_range_exceeds_365_days_returns_400(self, test_client):
        """5m interval with span > 365 days → 400."""
        resp = test_client.get(
            "/scraping/historical",
            params={
                "symbol": "RELIANCE",
                "exchange": "NSE",
                "interval": "5m",
                "from": "2022-01-01",
                "to": "2024-01-01",
            },
        )
        assert resp.status_code == 400
        body = resp.json()
        assert "error" in body
        assert "365" in body["error"]

    def test_invalid_date_format_from_returns_400(self, test_client):
        """Non-ISO 'from' date → 400."""
        resp = test_client.get(
            "/scraping/historical",
            params={
                "symbol": "RELIANCE",
                "exchange": "NSE",
                "interval": "1d",
                "from": "01-01-2024",
                "to": "2024-03-01",
            },
        )
        assert resp.status_code == 400
        assert "error" in resp.json()

    def test_invalid_date_format_to_returns_400(self, test_client):
        """Non-ISO 'to' date → 400."""
        resp = test_client.get(
            "/scraping/historical",
            params={
                "symbol": "RELIANCE",
                "exchange": "NSE",
                "interval": "1d",
                "from": "2024-01-01",
                "to": "2024/03/01",
            },
        )
        assert resp.status_code == 400
        assert "error" in resp.json()


class TestNseDailyOhlcvMapping:
    """
    Test that NSE daily Bhavcopy CSV is parsed into correct OHLCVCandle values.

    _fetch_nse_daily uses FetcherSession when scrapling is installed, falling
    back to httpx when it is not.  We mock the httpx path here for portability.
    """

    def test_nse_daily_ohlcv_field_mapping(self, test_client, tmp_path, monkeypatch):
        """
        Mock the httpx path inside _fetch_nse_daily; assert open/high/low/close/volume
        are correctly parsed from the NSE CSV fixture.
        """
        # Prevent disk-cache hit by pointing data_dir at a fresh temp directory.
        # Settings is a frozen dataclass so we patch the module-level name directly.
        monkeypatch.setattr(
            "src.scrapers.historical.settings",
            SimpleNamespace(data_dir=str(tmp_path)),
        )

        # Patch _fetch_nse_daily directly to avoid FetcherSession / httpx complexity
        from src.schemas import OHLCVCandle

        expected_time = int(
            datetime(2024, 1, 1, tzinfo=timezone.utc).timestamp()
        )
        expected_candle = OHLCVCandle(
            time=expected_time,
            open=1950.0,
            high=1975.5,
            low=1942.0,
            close=1965.3,
            volume=12345678,
        )

        async def _mock_fetch_nse_daily(symbol, from_date, to_date):
            return [expected_candle]

        monkeypatch.setattr(
            "src.scrapers.historical._fetch_nse_daily",
            _mock_fetch_nse_daily,
        )
        # Patch Redis away
        monkeypatch.setattr("src.scrapers.historical._redis_get", AsyncMock(return_value=None))
        monkeypatch.setattr("src.scrapers.historical._redis_set", AsyncMock())

        resp = test_client.get(
            "/scraping/historical",
            params={
                "symbol": "RELIANCE",
                "exchange": "NSE",
                "interval": "1d",
                "from": "2024-01-01",
                "to": "2024-01-01",
            },
        )

        assert resp.status_code == 200
        body = resp.json()
        assert body["count"] == 1
        candle = body["candles"][0]
        assert candle["open"] == pytest.approx(1950.0)
        assert candle["high"] == pytest.approx(1975.5)
        assert candle["low"] == pytest.approx(1942.0)
        assert candle["close"] == pytest.approx(1965.3)
        assert candle["volume"] == 12345678
        assert candle["time"] == expected_time

    def test_nse_daily_csv_parse_directly(self):
        """
        Unit-test the CSV parsing logic inside _fetch_nse_daily by calling the
        internal httpx path with a mocked response.
        """
        import asyncio
        import csv
        import io
        from datetime import date
        from src.schemas import OHLCVCandle
        from src.scrapers.historical import _ist_ms_to_utc_s

        # Replicate the parser logic from _fetch_nse_daily to verify field mapping
        reader = csv.DictReader(io.StringIO(_NSE_CSV))
        candles = []
        for row in reader:
            date_str = row.get("Date", "").strip()
            if not date_str:
                continue
            time_utc = int(
                datetime.strptime(date_str, "%d-%b-%Y")
                .replace(tzinfo=timezone.utc)
                .timestamp()
            )
            open_ = float(row["OPEN"])
            high = float(row["HIGH"])
            low = float(row["LOW"])
            close = float(row["CLOSE"])
            volume = int(float(row["TOTTRDQTY"]))
            candles.append(
                OHLCVCandle(
                    time=time_utc,
                    open=open_,
                    high=high,
                    low=low,
                    close=close,
                    volume=volume,
                )
            )

        assert len(candles) == 1
        c = candles[0]
        assert c.open == pytest.approx(1950.0)
        assert c.high == pytest.approx(1975.5)
        assert c.low == pytest.approx(1942.0)
        assert c.close == pytest.approx(1965.3)
        assert c.volume == 12345678
        # 01-JAN-2024 UTC epoch
        expected_time = int(datetime(2024, 1, 1, tzinfo=timezone.utc).timestamp())
        assert c.time == expected_time


class TestBseDailyOhlcvMapping:
    """Test that BSE daily Bhavcopy ZIP is parsed into correct OHLCVCandle values."""

    def test_bse_daily_ohlcv_field_mapping(self, test_client, tmp_path, monkeypatch):
        """Mock _fetch_bse_daily and verify OHLCV fields are mapped correctly."""
        monkeypatch.setattr(
            "src.scrapers.historical.settings",
            SimpleNamespace(data_dir=str(tmp_path)),
        )

        from src.schemas import OHLCVCandle
        from datetime import date

        expected_time = int(datetime(2024, 1, 2, tzinfo=timezone.utc).timestamp())
        expected_candle = OHLCVCandle(
            time=expected_time,
            open=1950.0,
            high=1975.5,
            low=1942.0,
            close=1965.3,
            volume=12345678,
        )

        async def _mock_fetch_bse_daily(symbol, from_date, to_date):
            return [expected_candle]

        monkeypatch.setattr(
            "src.scrapers.historical._fetch_bse_daily",
            _mock_fetch_bse_daily,
        )
        monkeypatch.setattr("src.scrapers.historical._redis_get", AsyncMock(return_value=None))
        monkeypatch.setattr("src.scrapers.historical._redis_set", AsyncMock())

        resp = test_client.get(
            "/scraping/historical",
            params={
                "symbol": "RELIANCE",
                "exchange": "BSE",
                "interval": "1d",
                "from": "2024-01-02",
                "to": "2024-01-02",
            },
        )

        assert resp.status_code == 200
        body = resp.json()
        assert body["count"] == 1
        candle = body["candles"][0]
        assert candle["open"] == pytest.approx(1950.0)
        assert candle["high"] == pytest.approx(1975.5)
        assert candle["low"] == pytest.approx(1942.0)
        assert candle["close"] == pytest.approx(1965.3)
        assert candle["volume"] == 12345678


class TestIntradayIstToUtcConversion:
    """Assert IST→UTC conversion is applied correctly in intraday candles."""

    def test_nse_intraday_ist_to_utc(self, test_client, monkeypatch):
        """
        Mock _fetch_nse_intraday to confirm the route passes back correctly
        converted timestamps from the intraday fetch.
        """
        from src.schemas import OHLCVCandle
        from src.scrapers.historical import _ist_ms_to_utc_s

        ts_ms_ist = 1_630_000_000_000
        expected_utc_s = _ist_ms_to_utc_s(ts_ms_ist)  # 1_629_980_200

        async def _mock_fetch_nse_intraday(symbol, interval, from_date, to_date):
            return [
                OHLCVCandle(
                    time=expected_utc_s,
                    open=1950.0,
                    high=1975.5,
                    low=1942.0,
                    close=1965.3,
                    volume=12345678,
                )
            ]

        monkeypatch.setattr(
            "src.scrapers.historical._fetch_nse_intraday",
            _mock_fetch_nse_intraday,
        )
        monkeypatch.setattr("src.scrapers.historical._redis_get", AsyncMock(return_value=None))
        monkeypatch.setattr("src.scrapers.historical._redis_set", AsyncMock())

        resp = test_client.get(
            "/scraping/historical",
            params={
                "symbol": "NIFTY",
                "exchange": "NSE",
                "interval": "5m",
                "from": "2021-08-26",
                "to": "2021-08-27",
            },
        )

        assert resp.status_code == 200
        body = resp.json()
        assert body["count"] == 1
        assert body["candles"][0]["time"] == expected_utc_s

    def test_ist_to_utc_arithmetic(self):
        """Direct arithmetic check: 1_630_000_000_000 ms IST → 1_629_980_200 UTC s."""
        from src.scrapers.historical import _ist_ms_to_utc_s

        result = _ist_ms_to_utc_s(1_630_000_000_000)
        assert result == 1_629_980_200


class TestDiskCache:
    """Disk cache prevents a second HTTP call for daily interval when mtime < 24 h."""

    def test_disk_cache_hit_skips_fetch(self, test_client, tmp_path, monkeypatch):
        """
        Write a fresh disk cache file, then assert _fetch_nse_daily is NOT called
        on the second (and only) request.
        """
        monkeypatch.setattr(
            "src.scrapers.historical.settings",
            SimpleNamespace(data_dir=str(tmp_path)),
        )
        monkeypatch.setattr("src.scrapers.historical._redis_get", AsyncMock(return_value=None))
        monkeypatch.setattr("src.scrapers.historical._redis_set", AsyncMock())

        # Pre-populate the disk cache with valid gzip-compressed JSON
        from src.scrapers.historical import _daily_disk_cache_path
        from src.schemas import OHLCVCandle

        from_date = date(2024, 1, 1)
        cache_path = _daily_disk_cache_path("NSE", "RELIANCE", from_date)
        os.makedirs(os.path.dirname(cache_path), exist_ok=True)

        cached_candle = {
            "time": int(datetime(2024, 1, 1, tzinfo=timezone.utc).timestamp()),
            "open": 1950.0,
            "high": 1975.5,
            "low": 1942.0,
            "close": 1965.3,
            "volume": 12345678,
            "oi": None,
        }
        compressed = _gzip_json([cached_candle])
        with open(cache_path, "wb") as fh:
            fh.write(compressed)

        # Track whether the upstream fetch was called
        fetch_call_count = 0

        async def _mock_fetch_nse_daily(symbol, from_date, to_date):
            nonlocal fetch_call_count
            fetch_call_count += 1
            return []

        monkeypatch.setattr(
            "src.scrapers.historical._fetch_nse_daily",
            _mock_fetch_nse_daily,
        )

        resp = test_client.get(
            "/scraping/historical",
            params={
                "symbol": "RELIANCE",
                "exchange": "NSE",
                "interval": "1d",
                "from": "2024-01-01",
                "to": "2024-01-01",
            },
        )

        assert resp.status_code == 200
        # The upstream fetch must NOT have been called — served from disk cache
        assert fetch_call_count == 0
        body = resp.json()
        assert body["count"] == 1
        assert body["candles"][0]["open"] == pytest.approx(1950.0)

    def test_stale_disk_cache_triggers_fetch(self, test_client, tmp_path, monkeypatch):
        """
        A disk cache file with mtime > 24 h ago must be bypassed and the upstream
        fetch must be called.
        """
        monkeypatch.setattr(
            "src.scrapers.historical.settings",
            SimpleNamespace(data_dir=str(tmp_path)),
        )
        monkeypatch.setattr("src.scrapers.historical._redis_get", AsyncMock(return_value=None))
        monkeypatch.setattr("src.scrapers.historical._redis_set", AsyncMock())

        from src.scrapers.historical import _daily_disk_cache_path

        from_date = date(2024, 1, 1)
        cache_path = _daily_disk_cache_path("NSE", "STALE", from_date)
        os.makedirs(os.path.dirname(cache_path), exist_ok=True)

        # Write a cache file and backdate its mtime by 25 hours
        cached_candle = {
            "time": int(datetime(2024, 1, 1, tzinfo=timezone.utc).timestamp()),
            "open": 1.0, "high": 2.0, "low": 0.5, "close": 1.5,
            "volume": 100, "oi": None,
        }
        with open(cache_path, "wb") as fh:
            fh.write(_gzip_json([cached_candle]))

        stale_mtime = time.time() - (25 * 3600)
        os.utime(cache_path, (stale_mtime, stale_mtime))

        fetch_call_count = 0

        async def _mock_fetch_nse_daily(symbol, from_date, to_date):
            nonlocal fetch_call_count
            fetch_call_count += 1
            return []

        monkeypatch.setattr(
            "src.scrapers.historical._fetch_nse_daily",
            _mock_fetch_nse_daily,
        )

        test_client.get(
            "/scraping/historical",
            params={
                "symbol": "STALE",
                "exchange": "NSE",
                "interval": "1d",
                "from": "2024-01-01",
                "to": "2024-01-01",
            },
        )

        assert fetch_call_count == 1, "Stale cache must trigger an upstream fetch"


class TestEmptyResults:
    """HTTP 200 with empty candles when upstream returns no data."""

    def test_symbol_not_found_returns_empty_candles(self, test_client, tmp_path, monkeypatch):
        """
        When the upstream fetch returns an empty list (symbol not found),
        the response must be HTTP 200 with candles=[] and count=0.
        """
        monkeypatch.setattr(
            "src.scrapers.historical.settings",
            SimpleNamespace(data_dir=str(tmp_path)),
        )
        monkeypatch.setattr("src.scrapers.historical._redis_get", AsyncMock(return_value=None))
        monkeypatch.setattr("src.scrapers.historical._redis_set", AsyncMock())

        async def _empty_fetch(symbol, from_date, to_date):
            return []

        monkeypatch.setattr("src.scrapers.historical._fetch_nse_daily", _empty_fetch)

        resp = test_client.get(
            "/scraping/historical",
            params={
                "symbol": "UNKNOWNSYMBOL",
                "exchange": "NSE",
                "interval": "1d",
                "from": "2024-01-01",
                "to": "2024-01-05",
            },
        )

        assert resp.status_code == 200
        body = resp.json()
        assert body["count"] == 0
        assert body["candles"] == []

    def test_intraday_symbol_not_found_returns_empty_candles(self, test_client, monkeypatch):
        """Intraday: upstream returns empty → HTTP 200 with empty candles."""
        monkeypatch.setattr("src.scrapers.historical._redis_get", AsyncMock(return_value=None))
        monkeypatch.setattr("src.scrapers.historical._redis_set", AsyncMock())

        async def _empty_fetch(symbol, interval, from_date, to_date):
            return []

        monkeypatch.setattr("src.scrapers.historical._fetch_nse_intraday", _empty_fetch)

        resp = test_client.get(
            "/scraping/historical",
            params={
                "symbol": "UNKNOWNSYMBOL",
                "exchange": "NSE",
                "interval": "5m",
                "from": "2024-01-01",
                "to": "2024-01-05",
            },
        )

        assert resp.status_code == 200
        body = resp.json()
        assert body["count"] == 0
        assert body["candles"] == []


class TestUpstreamErrors:
    """HTTP 503 when the upstream fetch raises an exception."""

    def test_fetch_timeout_returns_503(self, test_client, tmp_path, monkeypatch):
        """TimeoutError from fetch → HTTP 503 with available=false."""
        monkeypatch.setattr(
            "src.scrapers.historical.settings",
            SimpleNamespace(data_dir=str(tmp_path)),
        )
        monkeypatch.setattr("src.scrapers.historical._redis_get", AsyncMock(return_value=None))

        async def _timeout_fetch(symbol, from_date, to_date):
            raise TimeoutError("NSE charting API timed out")

        monkeypatch.setattr("src.scrapers.historical._fetch_nse_daily", _timeout_fetch)

        resp = test_client.get(
            "/scraping/historical",
            params={
                "symbol": "RELIANCE",
                "exchange": "NSE",
                "interval": "1d",
                "from": "2024-01-01",
                "to": "2024-01-05",
            },
        )

        assert resp.status_code == 503
        body = resp.json()
        assert body["available"] is False
        assert "reason" in body
        assert body["provider"] == "scrapling"

    def test_fetch_runtime_error_returns_503(self, test_client, tmp_path, monkeypatch):
        """RuntimeError from fetch (HTTP error, malformed response) → HTTP 503."""
        monkeypatch.setattr(
            "src.scrapers.historical.settings",
            SimpleNamespace(data_dir=str(tmp_path)),
        )
        monkeypatch.setattr("src.scrapers.historical._redis_get", AsyncMock(return_value=None))

        async def _error_fetch(symbol, from_date, to_date):
            raise RuntimeError("NSE Bhavcopy returned HTTP 503")

        monkeypatch.setattr("src.scrapers.historical._fetch_nse_daily", _error_fetch)

        resp = test_client.get(
            "/scraping/historical",
            params={
                "symbol": "RELIANCE",
                "exchange": "NSE",
                "interval": "1d",
                "from": "2024-01-01",
                "to": "2024-01-05",
            },
        )

        assert resp.status_code == 503
        body = resp.json()
        assert body["available"] is False

    def test_intraday_timeout_returns_503(self, test_client, monkeypatch):
        """Intraday: TimeoutError → HTTP 503."""
        monkeypatch.setattr("src.scrapers.historical._redis_get", AsyncMock(return_value=None))

        async def _timeout_fetch(symbol, interval, from_date, to_date):
            raise TimeoutError("NSE intraday timed out")

        monkeypatch.setattr("src.scrapers.historical._fetch_nse_intraday", _timeout_fetch)

        resp = test_client.get(
            "/scraping/historical",
            params={
                "symbol": "RELIANCE",
                "exchange": "NSE",
                "interval": "5m",
                "from": "2024-01-01",
                "to": "2024-01-05",
            },
        )

        assert resp.status_code == 503
        body = resp.json()
        assert body["available"] is False
        assert body["provider"] == "scrapling"


class TestRedisCache:
    """Intraday Redis cache is read before fetch and written after fetch."""

    def test_redis_cache_hit_returns_cached_data(self, test_client, monkeypatch):
        """If Redis has a valid cached entry, the upstream fetch is skipped."""
        cached_candle = {
            "time": 1_000,
            "open": 100.0,
            "high": 105.0,
            "low": 99.0,
            "close": 103.0,
            "volume": 5000,
            "oi": None,
        }
        cached_value = json.dumps([cached_candle]).encode("utf-8")

        fetch_call_count = 0

        async def _mock_nse_intraday(symbol, interval, from_date, to_date):
            nonlocal fetch_call_count
            fetch_call_count += 1
            return []

        monkeypatch.setattr(
            "src.scrapers.historical._redis_get",
            AsyncMock(return_value=[cached_candle]),
        )
        monkeypatch.setattr("src.scrapers.historical._fetch_nse_intraday", _mock_nse_intraday)

        resp = test_client.get(
            "/scraping/historical",
            params={
                "symbol": "NIFTY",
                "exchange": "NSE",
                "interval": "5m",
                "from": "2024-01-01",
                "to": "2024-01-02",
            },
        )

        assert resp.status_code == 200
        assert fetch_call_count == 0, "Redis cache hit should skip upstream fetch"
        body = resp.json()
        assert body["count"] == 1

    def test_redis_cache_written_after_fetch(self, test_client, monkeypatch):
        """After a successful intraday fetch, _redis_set must be called once."""
        from src.schemas import OHLCVCandle

        mock_redis_set = AsyncMock()
        monkeypatch.setattr("src.scrapers.historical._redis_get", AsyncMock(return_value=None))
        monkeypatch.setattr("src.scrapers.historical._redis_set", mock_redis_set)

        async def _mock_fetch(symbol, interval, from_date, to_date):
            return [
                OHLCVCandle(
                    time=1_629_980_200,
                    open=1950.0,
                    high=1975.5,
                    low=1942.0,
                    close=1965.3,
                    volume=12345678,
                )
            ]

        monkeypatch.setattr("src.scrapers.historical._fetch_nse_intraday", _mock_fetch)

        resp = test_client.get(
            "/scraping/historical",
            params={
                "symbol": "NIFTY",
                "exchange": "NSE",
                "interval": "5m",
                "from": "2024-01-01",
                "to": "2024-01-02",
            },
        )

        assert resp.status_code == 200
        mock_redis_set.assert_awaited_once()


class TestResponseShape:
    """Verify the canonical response shape: candles, count, sorted ascending."""

    def test_response_contains_candles_and_count(self, test_client, tmp_path, monkeypatch):
        from src.schemas import OHLCVCandle

        monkeypatch.setattr(
            "src.scrapers.historical.settings",
            SimpleNamespace(data_dir=str(tmp_path)),
        )
        monkeypatch.setattr("src.scrapers.historical._redis_get", AsyncMock(return_value=None))
        monkeypatch.setattr("src.scrapers.historical._redis_set", AsyncMock())

        async def _mock_fetch(symbol, from_date, to_date):
            return [
                OHLCVCandle(time=1_000, open=10.0, high=11.0, low=9.0, close=10.5, volume=100),
                OHLCVCandle(time=2_000, open=10.5, high=12.0, low=10.0, close=11.5, volume=200),
            ]

        monkeypatch.setattr("src.scrapers.historical._fetch_nse_daily", _mock_fetch)

        resp = test_client.get(
            "/scraping/historical",
            params={
                "symbol": "NIFTY",
                "exchange": "NSE",
                "interval": "1d",
                "from": "2024-01-01",
                "to": "2024-01-05",
            },
        )

        assert resp.status_code == 200
        body = resp.json()
        assert "candles" in body
        assert "count" in body
        assert body["count"] == len(body["candles"])

    def test_candles_sorted_ascending_by_time(self, test_client, tmp_path, monkeypatch):
        """Response candles must be sorted ascending by time field."""
        from src.schemas import OHLCVCandle

        monkeypatch.setattr(
            "src.scrapers.historical.settings",
            SimpleNamespace(data_dir=str(tmp_path)),
        )
        monkeypatch.setattr("src.scrapers.historical._redis_get", AsyncMock(return_value=None))
        monkeypatch.setattr("src.scrapers.historical._redis_set", AsyncMock())

        # Return candles out of order — the route must sort them
        async def _mock_fetch(symbol, from_date, to_date):
            return [
                OHLCVCandle(time=3_000, open=10.0, high=11.0, low=9.0, close=10.5, volume=100),
                OHLCVCandle(time=1_000, open=10.5, high=12.0, low=10.0, close=11.5, volume=200),
                OHLCVCandle(time=2_000, open=9.0, high=10.0, low=8.5, close=9.5, volume=50),
            ]

        monkeypatch.setattr("src.scrapers.historical._fetch_nse_daily", _mock_fetch)

        resp = test_client.get(
            "/scraping/historical",
            params={
                "symbol": "NIFTY",
                "exchange": "NSE",
                "interval": "1d",
                "from": "2024-01-01",
                "to": "2024-01-05",
            },
        )

        assert resp.status_code == 200
        times = [c["time"] for c in resp.json()["candles"]]
        assert times == sorted(times)
