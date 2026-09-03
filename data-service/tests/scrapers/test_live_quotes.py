"""
Unit tests for LiveQuoteScraper — task 15.3.

Covers:
- MDQuote field mapping for NIFTY 200 batch XHR path
- ltp: null when NSE returns null lastPrice (no error)
- Redis cache write with TTL 5s (_cache_set)
- Cached value returned on second call within TTL (_cache_get)
- HTTP 400 for missing / empty / >200 symbols
- HTTP 503 on DynamicSession timeout (10s); existing cache NOT overwritten
- Merged results in original input order for mixed batch

Requirements: 3.1–3.10
"""

from __future__ import annotations

import asyncio
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

# ---------------------------------------------------------------------------
# Patch the heavy lifespan before importing the app so TestClient never
# attempts to start Chromium, Redis, or the AntibanLayer.
# ---------------------------------------------------------------------------
with patch("src.server.lifespan"):
    from src.server import app

from src.schemas import MDQuote
from src.scrapers.live_quotes import (
    NIFTY_200_SYMBOLS,
    _QUOTE_CACHE_TTL,
    _SESSION_TIMEOUT,
    _cache_get,
    _cache_set,
    _fetch_batch_quotes,
    _fetch_single_quote,
    _utc_now_iso,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_mock_xhr(url_fragment: str, payload: dict) -> MagicMock:
    """Return a mock XHR object whose .url contains *url_fragment* and .json() returns *payload*."""
    xhr = MagicMock()
    xhr.url = f"https://www.nseindia.com/api/{url_fragment}"
    xhr.json = MagicMock(return_value=payload)
    return xhr


def _make_mock_page(xhrs: list[MagicMock]) -> MagicMock:
    """Return a mock page whose .captured_xhr is *xhrs*."""
    page = MagicMock()
    page.captured_xhr = xhrs
    return page


def _make_batch_payload(items: list[dict]) -> dict:
    return {"data": items}


def _batch_item(
    symbol: str,
    last_price: Any = 100.0,
    change: float = 1.0,
    p_change: float = 1.0,
    open_: float = 99.0,
    day_high: float = 101.0,
    day_low: float = 98.0,
    prev_close: float = 99.0,
    volume: int = 1_000_000,
) -> dict:
    return {
        "symbol": symbol,
        "lastPrice": last_price,
        "change": change,
        "pChange": p_change,
        "open": open_,
        "dayHigh": day_high,
        "dayLow": day_low,
        "previousClose": prev_close,
        "totalTradedVolume": volume,
    }


def _single_item(
    symbol: str,
    last_price: Any = 200.0,
    change: float = 2.0,
    p_change: float = 1.0,
) -> dict:
    return {
        "info": {"symbol": symbol},
        "priceInfo": {
            "lastPrice": last_price,
            "change": change,
            "pChange": p_change,
            "open": 198.0,
            "previousClose": 198.0,
            "intraDayHighLow": {"max": 205.0, "min": 196.0},
        },
        "securityWiseDP": {"quantityTraded": 500_000, "totalBuyQuantity": 12_000},
    }


def _make_mdquote(symbol: str = "RELIANCE", ltp: float | None = 100.0) -> MDQuote:
    return MDQuote(
        symbol=symbol,
        exchange="NSE",
        ltp=ltp,
        provider="scrapling",
        fetchedAt=_utc_now_iso(),
    )


# ---------------------------------------------------------------------------
# TestCacheHelpers — unit tests for _cache_get / _cache_set (no HTTP)
# ---------------------------------------------------------------------------


class TestCacheHelpers:
    """Tests for the _cache_get and _cache_set helper functions."""

    @pytest.mark.asyncio
    async def test_cache_set_calls_redis_with_ttl_5(self) -> None:
        """_cache_set must call redis.set with ex=5 (QUOTE_CACHE_TTL)."""
        redis = AsyncMock()
        redis.set = AsyncMock(return_value=True)

        quote = _make_mdquote("RELIANCE", 2850.0)
        key = "scraping:quote:NSE:RELIANCE"

        await _cache_set(redis, key, quote)

        redis.set.assert_awaited_once()
        call_args = redis.set.call_args
        # Positional: (key, json_str); keyword: ex=<TTL>
        assert call_args.args[0] == key
        assert call_args.kwargs.get("ex") == _QUOTE_CACHE_TTL
        # Value must be valid JSON that round-trips to an MDQuote
        stored_json = call_args.args[1]
        recovered = MDQuote.model_validate_json(stored_json)
        assert recovered.symbol == "RELIANCE"
        assert recovered.ltp == 2850.0

    @pytest.mark.asyncio
    async def test_cache_set_is_noop_when_redis_is_none(self) -> None:
        """_cache_set must not raise when redis is None."""
        await _cache_set(None, "some:key", _make_mdquote())  # should not raise

    @pytest.mark.asyncio
    async def test_cache_get_returns_none_on_miss(self) -> None:
        redis = AsyncMock()
        redis.get = AsyncMock(return_value=None)
        result = await _cache_get(redis, "scraping:quote:NSE:MISSING")
        assert result is None

    @pytest.mark.asyncio
    async def test_cache_get_returns_mdquote_on_hit(self) -> None:
        """_cache_get must deserialise a cached MDQuote from Redis."""
        quote = _make_mdquote("HDFCBANK", 1650.25)
        serialised = quote.model_dump_json()

        redis = AsyncMock()
        redis.get = AsyncMock(return_value=serialised.encode())

        result = await _cache_get(redis, "scraping:quote:NSE:HDFCBANK")
        assert result is not None
        assert result.symbol == "HDFCBANK"
        assert result.ltp == 1650.25
        assert result.provider == "scrapling"

    @pytest.mark.asyncio
    async def test_cache_get_returns_none_when_redis_is_none(self) -> None:
        result = await _cache_get(None, "any:key")
        assert result is None

    @pytest.mark.asyncio
    async def test_cache_get_returns_none_on_corrupt_json(self) -> None:
        redis = AsyncMock()
        redis.get = AsyncMock(return_value=b"not-valid-json{{{{")
        result = await _cache_get(redis, "scraping:quote:NSE:BAD")
        assert result is None  # error is swallowed, not raised


# ---------------------------------------------------------------------------
# TestFetchBatchQuotes — unit tests for _fetch_batch_quotes
# ---------------------------------------------------------------------------


class TestFetchBatchQuotes:
    """Tests for _fetch_batch_quotes — NIFTY 200 batch XHR path."""

    @pytest.mark.asyncio
    async def test_correct_mdquote_field_mapping(self) -> None:
        """All MDQuote fields must be mapped from the NSE equity-stockIndices payload."""
        payload = _make_batch_payload(
            [
                _batch_item(
                    "RELIANCE",
                    last_price=2850.60,
                    change=12.35,
                    p_change=0.44,
                    open_=2840.0,
                    day_high=2862.0,
                    day_low=2835.0,
                    prev_close=2838.25,
                    volume=3_456_789,
                )
            ]
        )
        xhr = _make_mock_xhr("equity-stockIndices?index=NIFTY%20200", payload)
        page = _make_mock_page([xhr])

        session = MagicMock()
        session.fetch = AsyncMock(return_value=page)

        results = await _fetch_batch_quotes(session, ["RELIANCE"])

        assert "RELIANCE" in results
        q = results["RELIANCE"]
        assert q.ltp == 2850.60
        assert q.change == 12.35
        assert q.changePct == 0.44
        assert q.open == 2840.0
        assert q.high == 2862.0
        assert q.low == 2835.0
        assert q.prevClose == 2838.25
        assert q.volume == 3_456_789
        assert q.provider == "scrapling"
        assert q.exchange == "NSE"
        assert q.fetchedAt  # non-empty UTC ISO string

    @pytest.mark.asyncio
    async def test_ltp_is_none_when_last_price_null(self) -> None:
        """Null lastPrice in XHR must map to ltp=None in MDQuote without error."""
        payload = _make_batch_payload([_batch_item("INFY", last_price=None)])
        xhr = _make_mock_xhr("equity-stockIndices?index=NIFTY%20200", payload)
        page = _make_mock_page([xhr])

        session = MagicMock()
        session.fetch = AsyncMock(return_value=page)

        results = await _fetch_batch_quotes(session, ["INFY"])

        assert "INFY" in results
        assert results["INFY"].ltp is None

    @pytest.mark.asyncio
    async def test_only_requested_symbols_included(self) -> None:
        """Symbols not in the requested list must be absent from the result dict."""
        payload = _make_batch_payload(
            [
                _batch_item("TCS"),
                _batch_item("WIPRO"),
                _batch_item("HDFCBANK"),
            ]
        )
        xhr = _make_mock_xhr("equity-stockIndices", payload)
        page = _make_mock_page([xhr])

        session = MagicMock()
        session.fetch = AsyncMock(return_value=page)

        results = await _fetch_batch_quotes(session, ["TCS", "HDFCBANK"])

        assert "TCS" in results
        assert "HDFCBANK" in results
        assert "WIPRO" not in results

    @pytest.mark.asyncio
    async def test_returns_empty_dict_when_xhr_not_captured(self) -> None:
        """If no XHR matches equity-stockIndices, return empty dict."""
        page = _make_mock_page([])  # no captured XHRs
        session = MagicMock()
        session.fetch = AsyncMock(return_value=page)

        results = await _fetch_batch_quotes(session, ["RELIANCE"])

        assert results == {}

    @pytest.mark.asyncio
    async def test_returns_empty_dict_on_fetch_exception(self) -> None:
        """Network error must be caught and an empty dict returned."""
        session = MagicMock()
        session.fetch = AsyncMock(side_effect=RuntimeError("network failure"))

        results = await _fetch_batch_quotes(session, ["TCS"])

        assert results == {}

    @pytest.mark.asyncio
    async def test_symbol_matching_is_case_insensitive(self) -> None:
        """Symbols in lower/mixed case from the caller still match uppercase in payload."""
        payload = _make_batch_payload([_batch_item("ICICIBANK", last_price=1100.0)])
        xhr = _make_mock_xhr("equity-stockIndices", payload)
        page = _make_mock_page([xhr])

        session = MagicMock()
        session.fetch = AsyncMock(return_value=page)

        # Pass lowercase symbol to the function
        results = await _fetch_batch_quotes(session, ["icicibank"])
        assert "ICICIBANK" in results


# ---------------------------------------------------------------------------
# TestFetchSingleQuote — unit tests for _fetch_single_quote
# ---------------------------------------------------------------------------


class TestFetchSingleQuote:
    """Tests for _fetch_single_quote — per-symbol XHR path."""

    @pytest.mark.asyncio
    async def test_correct_mdquote_field_mapping(self) -> None:
        """All MDQuote fields must be mapped correctly from the quote/equity XHR."""
        data = _single_item("ADANIPORTS", last_price=800.0, change=5.0, p_change=0.63)
        xhr = _make_mock_xhr("quote/equity?symbol=ADANIPORTS", data)
        page = _make_mock_page([xhr])

        session = MagicMock()
        session.fetch = AsyncMock(return_value=page)

        quote = await _fetch_single_quote(session, "ADANIPORTS")

        assert quote is not None
        assert quote.symbol == "ADANIPORTS"
        assert quote.ltp == 800.0
        assert quote.change == 5.0
        assert quote.changePct == 0.63
        assert quote.open == 198.0
        assert quote.high == 205.0
        assert quote.low == 196.0
        assert quote.prevClose == 198.0
        assert quote.volume == 500_000
        assert quote.oi == 12_000
        assert quote.provider == "scrapling"
        assert quote.exchange == "NSE"

    @pytest.mark.asyncio
    async def test_ltp_is_none_when_missing_from_price_info(self) -> None:
        """Absent lastPrice must map to ltp=None without raising."""
        data = {
            "info": {"symbol": "SBIN"},
            "priceInfo": {
                # lastPrice deliberately absent
                "change": 0.5,
                "pChange": 0.1,
                "open": 620.0,
                "previousClose": 619.5,
                "intraDayHighLow": {"max": 625.0, "min": 618.0},
            },
            "securityWiseDP": {},
        }
        xhr = _make_mock_xhr("quote/equity?symbol=SBIN", data)
        page = _make_mock_page([xhr])

        session = MagicMock()
        session.fetch = AsyncMock(return_value=page)

        quote = await _fetch_single_quote(session, "SBIN")
        assert quote is not None
        assert quote.ltp is None

    @pytest.mark.asyncio
    async def test_returns_none_when_xhr_not_captured(self) -> None:
        page = _make_mock_page([])
        session = MagicMock()
        session.fetch = AsyncMock(return_value=page)

        result = await _fetch_single_quote(session, "UNKNOWN")
        assert result is None

    @pytest.mark.asyncio
    async def test_returns_none_on_fetch_exception(self) -> None:
        session = MagicMock()
        session.fetch = AsyncMock(side_effect=RuntimeError("browser crash"))

        result = await _fetch_single_quote(session, "SOME_SYM")
        assert result is None


# ---------------------------------------------------------------------------
# TestGetQuotesEndpoint — HTTP-level tests via TestClient
# ---------------------------------------------------------------------------


@pytest.fixture()
def client():
    """FastAPI TestClient with lifespan no-op'd and Redis wired to None by default."""
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


class TestGetQuotesValidation:
    """HTTP 400 validation cases — no scraping is triggered."""

    def test_missing_symbols_param_returns_400(self, client: TestClient) -> None:
        resp = client.get("/scraping/quotes")
        assert resp.status_code == 400
        assert "error" in resp.json()

    def test_empty_symbols_returns_400(self, client: TestClient) -> None:
        resp = client.get("/scraping/quotes?symbols=")
        assert resp.status_code == 400
        assert "error" in resp.json()

    def test_whitespace_only_symbols_returns_400(self, client: TestClient) -> None:
        resp = client.get("/scraping/quotes?symbols=  ,  ,  ")
        assert resp.status_code == 400
        assert "error" in resp.json()

    def test_more_than_200_symbols_returns_400(self, client: TestClient) -> None:
        symbols = ",".join([f"SYM{i}" for i in range(201)])
        resp = client.get(f"/scraping/quotes?symbols={symbols}")
        assert resp.status_code == 400
        body = resp.json()
        assert "error" in body
        assert "200" in body["error"]

    def test_exactly_200_symbols_is_accepted(self, client: TestClient) -> None:
        """200 symbols must not return 400 — 200 is the inclusive upper bound."""
        symbols = ",".join([f"SYM{i}" for i in range(200)])
        # Patch away all side effects so the endpoint resolves quickly.
        with (
            patch("src.scrapers.live_quotes._get_redis", new_callable=AsyncMock, return_value=None),
            patch("src.scrapers.live_quotes.get_quote_session", new_callable=AsyncMock) as mock_sess,
            patch("src.scrapers.live_quotes._fetch_single_quote", new_callable=AsyncMock, return_value=None),
        ):
            mock_sess.return_value = MagicMock()
            resp = client.get(f"/scraping/quotes?symbols={symbols}")
        # Validation must pass; any scraping error is a 503, not 400.
        assert resp.status_code != 400

    def test_single_symbol_is_accepted(self, client: TestClient) -> None:
        """Minimum of 1 symbol must be valid."""
        with (
            patch("src.scrapers.live_quotes._get_redis", new_callable=AsyncMock, return_value=None),
            patch("src.scrapers.live_quotes.get_quote_session", new_callable=AsyncMock) as mock_sess,
            patch("src.scrapers.live_quotes._fetch_single_quote", new_callable=AsyncMock, return_value=None),
        ):
            mock_sess.return_value = MagicMock()
            resp = client.get("/scraping/quotes?symbols=RELIANCE")
        assert resp.status_code != 400

    def test_invalid_exchange_returns_400(self, client: TestClient) -> None:
        resp = client.get("/scraping/quotes?symbols=RELIANCE&exchange=XYZ")
        assert resp.status_code == 400
        assert "error" in resp.json()


class TestGetQuotesCacheHit:
    """The endpoint must return cached values without calling the session."""

    def test_cached_value_returned_without_scraping(self, client: TestClient) -> None:
        """When all requested symbols have fresh cache entries, no scraping call occurs."""
        cached_quote = _make_mdquote("RELIANCE", 2900.0)
        cached_json = cached_quote.model_dump_json().encode()

        redis_mock = AsyncMock()
        redis_mock.get = AsyncMock(return_value=cached_json)

        with (
            patch("src.scrapers.live_quotes._get_redis", new_callable=AsyncMock, return_value=redis_mock),
            patch("src.scrapers.live_quotes.get_quote_session") as mock_session_fn,
        ):
            resp = client.get("/scraping/quotes?symbols=RELIANCE")

        assert resp.status_code == 200
        body = resp.json()
        assert body["count"] == 1
        assert body["quotes"][0] is not None
        assert body["quotes"][0]["ltp"] == 2900.0
        assert body["quotes"][0]["symbol"] == "RELIANCE"
        # DynamicSession must not have been created/used
        mock_session_fn.assert_not_called()

    def test_cache_key_format_is_exchange_prefixed(self, client: TestClient) -> None:
        """Cache key must be scraping:quote:{exchange}:{symbol}."""
        cached_quote = _make_mdquote("TCS", 4200.0)
        cached_json = cached_quote.model_dump_json().encode()

        redis_mock = AsyncMock()
        redis_mock.get = AsyncMock(return_value=cached_json)

        with (
            patch("src.scrapers.live_quotes._get_redis", new_callable=AsyncMock, return_value=redis_mock),
            patch("src.scrapers.live_quotes.get_quote_session"),
        ):
            client.get("/scraping/quotes?symbols=TCS&exchange=NSE")

        # Assert that get was called with the correct key format
        redis_mock.get.assert_awaited()
        call_args_list = redis_mock.get.call_args_list
        keys_used = [str(call.args[0]) for call in call_args_list]
        assert "scraping:quote:NSE:TCS" in keys_used


class TestGetQuotesCacheWrite:
    """After a successful fetch, the result must be written to Redis with TTL 5s."""

    def test_cache_is_written_with_ttl_5_after_successful_fetch(self, client: TestClient) -> None:
        """After a live fetch, redis.set must be called with ex=5."""
        # PAYTM is NOT a NIFTY 200 constituent → uses single-quote path.
        fetched_quote = _make_mdquote("PAYTM", 620.0)
        redis_mock = AsyncMock()
        redis_mock.get = AsyncMock(return_value=None)  # cache miss
        redis_mock.set = AsyncMock(return_value=True)

        session_mock = AsyncMock()

        with (
            patch("src.scrapers.live_quotes._get_redis", new_callable=AsyncMock, return_value=redis_mock),
            patch("src.scrapers.live_quotes.get_quote_session", new_callable=AsyncMock, return_value=session_mock),
            patch("src.scrapers.live_quotes._fetch_single_quote", new_callable=AsyncMock, return_value=fetched_quote),
        ):
            resp = client.get("/scraping/quotes?symbols=PAYTM")

        assert resp.status_code == 200
        # redis.set must have been called with TTL 5
        redis_mock.set.assert_awaited()
        call_kwargs = redis_mock.set.call_args.kwargs
        assert call_kwargs.get("ex") == 5

    def test_cache_not_written_when_fetch_returns_none(self, client: TestClient) -> None:
        """When a symbol returns None (fetch failed), redis.set must not be called for it."""
        redis_mock = AsyncMock()
        redis_mock.get = AsyncMock(return_value=None)
        redis_mock.set = AsyncMock(return_value=True)

        session_mock = MagicMock()

        with (
            patch("src.scrapers.live_quotes._get_redis", new_callable=AsyncMock, return_value=redis_mock),
            patch("src.scrapers.live_quotes.get_quote_session", new_callable=AsyncMock, return_value=session_mock),
            patch("src.scrapers.live_quotes._fetch_single_quote", new_callable=AsyncMock, return_value=None),
        ):
            resp = client.get("/scraping/quotes?symbols=UNKNOWN_SYM")

        assert resp.status_code == 200
        redis_mock.set.assert_not_awaited()


class TestGetQuotesTimeout:
    """HTTP 503 on DynamicSession timeout; existing cache must not be overwritten."""

    def test_http_503_on_session_timeout(self, client: TestClient) -> None:
        """asyncio.TimeoutError in the fetch path must produce HTTP 503."""
        redis_mock = AsyncMock()
        redis_mock.get = AsyncMock(return_value=None)  # cache miss
        redis_mock.set = AsyncMock(return_value=True)

        async def _timeout(*args, **kwargs):
            raise asyncio.TimeoutError

        with (
            patch("src.scrapers.live_quotes._get_redis", new_callable=AsyncMock, return_value=redis_mock),
            patch("src.scrapers.live_quotes.get_quote_session", new_callable=AsyncMock, return_value=MagicMock()),
            patch("src.scrapers.live_quotes._fetch_single_quote", new=_timeout),
        ):
            # Patch asyncio.wait_for to raise TimeoutError directly
            with patch("asyncio.wait_for", side_effect=asyncio.TimeoutError):
                resp = client.get("/scraping/quotes?symbols=BAJFINANCE")

        assert resp.status_code == 503
        body = resp.json()
        assert body["available"] is False
        assert "reason" in body

    def test_cache_not_overwritten_on_timeout(self, client: TestClient) -> None:
        """On timeout, redis.set must not be called (cache must not be touched)."""
        existing_quote = _make_mdquote("BAJFINANCE", 7500.0)
        redis_mock = AsyncMock()
        # First call returns a stale entry (simulating a cache miss so we go to fetch)
        redis_mock.get = AsyncMock(return_value=None)
        redis_mock.set = AsyncMock(return_value=True)

        with (
            patch("src.scrapers.live_quotes._get_redis", new_callable=AsyncMock, return_value=redis_mock),
            patch("src.scrapers.live_quotes.get_quote_session", new_callable=AsyncMock, return_value=MagicMock()),
            patch("asyncio.wait_for", side_effect=asyncio.TimeoutError),
        ):
            resp = client.get("/scraping/quotes?symbols=BAJFINANCE")

        assert resp.status_code == 503
        redis_mock.set.assert_not_awaited()

    def test_http_503_when_scrapling_not_installed(self, client: TestClient) -> None:
        """RuntimeError('scrapling not available') must produce HTTP 503."""
        redis_mock = AsyncMock()
        redis_mock.get = AsyncMock(return_value=None)

        with (
            patch("src.scrapers.live_quotes._get_redis", new_callable=AsyncMock, return_value=redis_mock),
            patch(
                "src.scrapers.live_quotes.get_quote_session",
                new_callable=AsyncMock,
                side_effect=RuntimeError("scrapling not available"),
            ),
        ):
            resp = client.get("/scraping/quotes?symbols=RELIANCE")

        assert resp.status_code == 503
        body = resp.json()
        assert body["available"] is False


class TestGetQuotesMixedBatch:
    """Mixed batches: NIFTY 200 constituents + non-constituents → merged in input order."""

    def test_results_aligned_to_input_order(self, client: TestClient) -> None:
        """Results must be positionally aligned to the input symbols list."""
        # Use one known NIFTY 200 constituent and one non-constituent.
        constituent = next(iter(NIFTY_200_SYMBOLS))  # e.g. "RELIANCE"
        non_constituent = "PAYTM"  # not in the NIFTY_200_SYMBOLS set

        symbols_input = [constituent, non_constituent]

        batch_quote = _make_mdquote(constituent, 2850.0)
        single_quote = _make_mdquote(non_constituent, 3100.0)

        redis_mock = AsyncMock()
        redis_mock.get = AsyncMock(return_value=None)  # all cache misses
        redis_mock.set = AsyncMock(return_value=True)

        session_mock = MagicMock()

        with (
            patch("src.scrapers.live_quotes._get_redis", new_callable=AsyncMock, return_value=redis_mock),
            patch("src.scrapers.live_quotes.get_quote_session", new_callable=AsyncMock, return_value=session_mock),
            patch(
                "src.scrapers.live_quotes._fetch_batch_quotes",
                new_callable=AsyncMock,
                return_value={constituent: batch_quote},
            ),
            patch(
                "src.scrapers.live_quotes._fetch_single_quote",
                new_callable=AsyncMock,
                return_value=single_quote,
            ),
        ):
            query = ",".join(symbols_input)
            resp = client.get(f"/scraping/quotes?symbols={query}")

        assert resp.status_code == 200
        body = resp.json()
        quotes = body["quotes"]
        assert len(quotes) == 2

        # First position must match constituent
        assert quotes[0] is not None
        assert quotes[0]["symbol"] == constituent

        # Second position must match non-constituent
        assert quotes[1] is not None
        assert quotes[1]["symbol"] == non_constituent

    def test_null_entry_for_failed_non_constituent(self, client: TestClient) -> None:
        """When a non-constituent symbol fails to fetch, its position must be null."""
        non_constituent = "PAYTM"

        redis_mock = AsyncMock()
        redis_mock.get = AsyncMock(return_value=None)
        redis_mock.set = AsyncMock(return_value=True)

        with (
            patch("src.scrapers.live_quotes._get_redis", new_callable=AsyncMock, return_value=redis_mock),
            patch("src.scrapers.live_quotes.get_quote_session", new_callable=AsyncMock, return_value=MagicMock()),
            patch("src.scrapers.live_quotes._fetch_single_quote", new_callable=AsyncMock, return_value=None),
        ):
            resp = client.get(f"/scraping/quotes?symbols={non_constituent}")

        assert resp.status_code == 200
        body = resp.json()
        assert body["quotes"][0] is None
        assert body["count"] == 1

    def test_response_count_equals_input_length(self, client: TestClient) -> None:
        """count field in response must equal len(symbols) regardless of fetch outcome."""
        symbols = ["RELIANCE", "HDFCBANK", "PAYTM"]

        redis_mock = AsyncMock()
        redis_mock.get = AsyncMock(return_value=None)
        redis_mock.set = AsyncMock(return_value=True)

        constituent = "RELIANCE"
        batch_result = {constituent: _make_mdquote(constituent, 2800.0)}

        with (
            patch("src.scrapers.live_quotes._get_redis", new_callable=AsyncMock, return_value=redis_mock),
            patch("src.scrapers.live_quotes.get_quote_session", new_callable=AsyncMock, return_value=MagicMock()),
            patch("src.scrapers.live_quotes._fetch_batch_quotes", new_callable=AsyncMock, return_value=batch_result),
            patch("src.scrapers.live_quotes._fetch_single_quote", new_callable=AsyncMock, return_value=None),
        ):
            resp = client.get(f"/scraping/quotes?symbols={','.join(symbols)}")

        assert resp.status_code == 200
        body = resp.json()
        assert body["count"] == len(symbols)
        assert len(body["quotes"]) == len(symbols)

    def test_nifty200_constituents_use_batch_path(self, client: TestClient) -> None:
        """When all symbols are NIFTY 200 constituents, only batch fetch is called."""
        constituents = list(NIFTY_200_SYMBOLS)[:3]

        redis_mock = AsyncMock()
        redis_mock.get = AsyncMock(return_value=None)
        redis_mock.set = AsyncMock(return_value=True)

        batch_results = {sym: _make_mdquote(sym, float(i * 100)) for i, sym in enumerate(constituents)}

        with (
            patch("src.scrapers.live_quotes._get_redis", new_callable=AsyncMock, return_value=redis_mock),
            patch("src.scrapers.live_quotes.get_quote_session", new_callable=AsyncMock, return_value=MagicMock()),
            patch(
                "src.scrapers.live_quotes._fetch_batch_quotes",
                new_callable=AsyncMock,
                return_value=batch_results,
            ) as mock_batch,
            patch(
                "src.scrapers.live_quotes._fetch_single_quote",
                new_callable=AsyncMock,
                return_value=None,
            ) as mock_single,
        ):
            resp = client.get(f"/scraping/quotes?symbols={','.join(constituents)}")

        assert resp.status_code == 200
        mock_batch.assert_awaited_once()
        mock_single.assert_not_awaited()

    def test_non_constituents_use_single_path(self, client: TestClient) -> None:
        """When all symbols are non-constituents, only single fetch is called."""
        non_constituents = ["FAKESTOCK1", "FAKESTOCK2", "FAKESTOCK3"]

        redis_mock = AsyncMock()
        redis_mock.get = AsyncMock(return_value=None)
        redis_mock.set = AsyncMock(return_value=True)

        with (
            patch("src.scrapers.live_quotes._get_redis", new_callable=AsyncMock, return_value=redis_mock),
            patch("src.scrapers.live_quotes.get_quote_session", new_callable=AsyncMock, return_value=MagicMock()),
            patch(
                "src.scrapers.live_quotes._fetch_batch_quotes",
                new_callable=AsyncMock,
                return_value={},
            ) as mock_batch,
            patch(
                "src.scrapers.live_quotes._fetch_single_quote",
                new_callable=AsyncMock,
                return_value=None,
            ) as mock_single,
        ):
            resp = client.get(f"/scraping/quotes?symbols={','.join(non_constituents)}")

        assert resp.status_code == 200
        mock_batch.assert_not_awaited()
        assert mock_single.await_count == len(non_constituents)


class TestGetQuotesMdQuoteNormalization:
    """MDQuote normalization: all 14 required fields must be present in the response."""

    def test_all_mdquote_fields_present_in_response(self, client: TestClient) -> None:
        """Response quote entries must have all required MDQuote fields."""
        full_quote = MDQuote(
            symbol="WIPRO",
            exchange="NSE",
            ltp=500.0,
            change=5.0,
            changePct=1.0,
            open=495.0,
            high=505.0,
            low=492.0,
            prevClose=495.0,
            volume=1_000_000,
            oi=50_000,
            upperCircuit=545.0,
            lowerCircuit=445.0,
            provider="scrapling",
            fetchedAt=_utc_now_iso(),
        )
        cached_json = full_quote.model_dump_json().encode()

        redis_mock = AsyncMock()
        redis_mock.get = AsyncMock(return_value=cached_json)

        with (
            patch("src.scrapers.live_quotes._get_redis", new_callable=AsyncMock, return_value=redis_mock),
            patch("src.scrapers.live_quotes.get_quote_session"),
        ):
            resp = client.get("/scraping/quotes?symbols=WIPRO")

        assert resp.status_code == 200
        q = resp.json()["quotes"][0]
        required_fields = [
            "symbol", "ltp", "change", "changePct", "open", "high", "low",
            "prevClose", "volume", "oi", "upperCircuit", "lowerCircuit",
            "provider", "fetchedAt",
        ]
        for field in required_fields:
            assert field in q, f"Missing required field: {field}"
        assert q["provider"] == "scrapling"

    def test_provider_field_is_always_scrapling(self, client: TestClient) -> None:
        """provider field in every quote entry must equal 'scrapling'."""
        # KOTAKBANK is a NIFTY 200 constituent → uses batch path.
        fetched_quote = _make_mdquote("KOTAKBANK", 1800.0)
        redis_mock = AsyncMock()
        redis_mock.get = AsyncMock(return_value=None)
        redis_mock.set = AsyncMock(return_value=True)

        with (
            patch("src.scrapers.live_quotes._get_redis", new_callable=AsyncMock, return_value=redis_mock),
            patch("src.scrapers.live_quotes.get_quote_session", new_callable=AsyncMock, return_value=AsyncMock()),
            patch(
                "src.scrapers.live_quotes._fetch_batch_quotes",
                new_callable=AsyncMock,
                return_value={"KOTAKBANK": fetched_quote},
            ),
        ):
            resp = client.get("/scraping/quotes?symbols=KOTAKBANK")

        assert resp.status_code == 200
        q = resp.json()["quotes"][0]
        assert q is not None
        assert q["provider"] == "scrapling"


class TestGetQuotesSpecificNifty200Fixture:
    """Tests using the exact payload described in the task spec."""

    @pytest.mark.asyncio
    async def test_nifty_batch_payload_field_mapping(self) -> None:
        """Validate field mapping with the exact payload from the task spec."""
        # This test exercises _fetch_batch_quotes directly with the spec fixture.
        payload = _make_batch_payload(
            [
                {
                    "symbol": "NIFTY",
                    "lastPrice": 24850.60,
                    "change": 142.35,
                    "pChange": 0.58,
                    "open": 24712.00,
                    "dayHigh": 24891.45,
                    "dayLow": 24650.10,
                    "previousClose": 24708.25,
                    "totalTradedVolume": 23456789,
                }
            ]
        )
        xhr = _make_mock_xhr("equity-stockIndices?index=NIFTY%20200", payload)
        page = _make_mock_page([xhr])

        session = MagicMock()
        session.fetch = AsyncMock(return_value=page)

        results = await _fetch_batch_quotes(session, ["NIFTY"])

        assert "NIFTY" in results
        q = results["NIFTY"]
        assert q.ltp == 24850.60
        assert q.change == 142.35
        assert q.changePct == 0.58
        assert q.open == 24712.00
        assert q.high == 24891.45
        assert q.low == 24650.10
        assert q.prevClose == 24708.25
        assert q.volume == 23456789
        assert q.provider == "scrapling"
