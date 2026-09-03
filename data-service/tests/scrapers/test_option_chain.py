"""
Unit tests for OptionChainScraper — task 15.4.

Covers:
- Full OptionChain shape from NSE XHR fixture
- All analytics fields computed correctly (pcrOi, maxPain, atmIv,
  maxCeOiStrike, maxPeOiStrike, pcrVolume)
- Fallback to FetcherSession on BrowserError (RuntimeError)
- HTTP 503 when both DynamicSession and fallback fail
- Redis cache write with TTL 20s; cached value returned on second call
- Warm endpoint returns {"warmed": true, "session_ready": true}

Requirements: 4.1–4.14
"""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

# ---------------------------------------------------------------------------
# Patch heavy lifespan before importing app
# ---------------------------------------------------------------------------
with patch("src.server.lifespan"):
    from src.server import app

from src.scrapers.option_chain import (
    compute_atm_iv,
    compute_max_pain,
    compute_oi_walls,
    compute_pcr_oi,
    compute_pcr_volume,
    _compute_analytics,
    _build_rows_from_nse_data,
    _normalize_expiry_to_iso,
    _select_nearest_expiry,
    reset_chain_session,
)
from src.schemas import Greeks, OptionChainRow, OptionContract

# ---------------------------------------------------------------------------
# NSE fixture payload
# ---------------------------------------------------------------------------

# Use a far-future expiry so _select_nearest_expiry always picks the first
# entry regardless of when the tests are run.
_FIXTURE_EXPIRY_NSE = "25-DEC-2099"
_FIXTURE_EXPIRY_NSE2 = "26-DEC-2099"
_FIXTURE_EXPIRY_ISO = "2099-12-25"

# Single-strike fixture with both CE and PE for a clean, deterministic
# computation of all analytics fields.
_NSE_FIXTURE: dict[str, Any] = {
    "records": {
        "data": [
            {
                "strikePrice": 24000,
                "expiryDate": _FIXTURE_EXPIRY_NSE,
                "CE": {
                    "lastPrice": 120.5,
                    "openInterest": 1234567,
                    "changeinOpenInterest": 45678,
                    "totalTradedVolume": 89012,
                    "impliedVolatility": 12.5,
                    "identifier": "NIFTY99DEC2024000CE",
                    "bidprice": 119.0,
                    "askPrice": 122.0,
                    "delta": 0.55,
                    "gamma": 0.001,
                    "theta": -10.5,
                    "vega": 25.3,
                },
                "PE": {
                    "lastPrice": 68.3,
                    "openInterest": 987654,
                    "changeinOpenInterest": -12345,
                    "totalTradedVolume": 56789,
                    "impliedVolatility": 11.8,
                    "identifier": "NIFTY99DEC2024000PE",
                    "bidprice": 67.0,
                    "askPrice": 69.5,
                    "delta": -0.45,
                    "gamma": 0.001,
                    "theta": -9.8,
                    "vega": 24.1,
                },
            }
        ],
        "expiryDates": [_FIXTURE_EXPIRY_NSE, _FIXTURE_EXPIRY_NSE2],
        "underlyingValue": 24850.60,
    }
}


# ---------------------------------------------------------------------------
# Helper: build a mock page with a captured_xhr entry
# ---------------------------------------------------------------------------


def _make_page_with_xhr(payload: dict[str, Any], xhr_url: str = "api/option-chain") -> MagicMock:
    """Return a mock page whose ``captured_xhr`` list holds one matching entry."""
    xhr_entry = MagicMock()
    xhr_entry.url = xhr_url
    xhr_entry.json = MagicMock(return_value=payload)

    page = MagicMock()
    page.captured_xhr = [xhr_entry]
    # Simulate auto_save call on css — should be silent
    page.css = MagicMock(return_value=MagicMock())
    return page


# ---------------------------------------------------------------------------
# Helper: build rows directly for pure-function tests
# ---------------------------------------------------------------------------


def _build_single_strike_rows() -> list[OptionChainRow]:
    """Build a single-row OptionChainRow list from the NSE fixture data."""
    return _build_rows_from_nse_data(
        data=_NSE_FIXTURE["records"]["data"],
        selected_expiry=_FIXTURE_EXPIRY_NSE,
        underlying="NIFTY",
        fetched_at="2099-12-25T04:00:00.000Z",
    )


# ---------------------------------------------------------------------------
# Pure-function unit tests (no HTTP)
# ---------------------------------------------------------------------------


class TestComputePcrOi:
    def test_single_strike_computes_correctly(self) -> None:
        rows = _build_single_strike_rows()
        # CE OI = 1_234_567, PE OI = 987_654
        result = compute_pcr_oi(rows)
        assert result == round(987654 / 1234567, 2)

    def test_returns_none_when_no_ce_rows(self) -> None:
        rows = [
            OptionChainRow(
                strike=24000.0,
                ce=None,
                pe=OptionContract(
                    token="T1",
                    tradingSymbol="NIFTY24JUL24000PE",
                    underlying="NIFTY",
                    expiry="2025-07-24",
                    strike=24000.0,
                    optionType="PE",
                    oi=500,
                    oiChange=0,
                    volume=100,
                    greeks=Greeks(),
                    fetchedAt="2025-07-24T04:00:00.000Z",
                ),
            )
        ]
        assert compute_pcr_oi(rows) is None

    def test_returns_none_when_ce_oi_is_zero(self) -> None:
        rows = _build_rows_from_nse_data(
            data=[
                {
                    "strikePrice": 24000,
                    "expiryDate": _FIXTURE_EXPIRY_NSE,
                    "CE": {
                        "lastPrice": 100.0,
                        "openInterest": 0,
                        "changeinOpenInterest": 0,
                        "totalTradedVolume": 0,
                    },
                    "PE": {
                        "lastPrice": 50.0,
                        "openInterest": 500,
                        "changeinOpenInterest": 0,
                        "totalTradedVolume": 100,
                    },
                }
            ],
            selected_expiry=_FIXTURE_EXPIRY_NSE,
            underlying="NIFTY",
            fetched_at="2099-12-25T04:00:00.000Z",
        )
        assert compute_pcr_oi(rows) is None

    def test_rounded_to_two_decimal_places(self) -> None:
        rows = _build_single_strike_rows()
        result = compute_pcr_oi(rows)
        assert result is not None
        # Must be rounded to exactly 2 dp
        assert result == round(result, 2)


class TestComputePcrVolume:
    def test_single_strike_computes_correctly(self) -> None:
        rows = _build_single_strike_rows()
        # CE vol = 89_012, PE vol = 56_789
        result = compute_pcr_volume(rows)
        assert result == round(56789 / 89012, 2)

    def test_returns_none_when_ce_volume_zero(self) -> None:
        rows = _build_rows_from_nse_data(
            data=[
                {
                    "strikePrice": 24000,
                    "expiryDate": _FIXTURE_EXPIRY_NSE,
                    "CE": {
                        "lastPrice": 100.0,
                        "openInterest": 1000,
                        "changeinOpenInterest": 0,
                        "totalTradedVolume": 0,
                    },
                    "PE": {
                        "lastPrice": 50.0,
                        "openInterest": 500,
                        "changeinOpenInterest": 0,
                        "totalTradedVolume": 200,
                    },
                }
            ],
            selected_expiry=_FIXTURE_EXPIRY_NSE,
            underlying="NIFTY",
            fetched_at="2099-12-25T04:00:00.000Z",
        )
        assert compute_pcr_volume(rows) is None


class TestComputeMaxPain:
    def test_single_strike_returns_that_strike(self) -> None:
        rows = _build_single_strike_rows()
        # With a single strike the pain is trivially minimised there.
        result = compute_max_pain(rows)
        assert result == 24000.0

    def test_empty_rows_returns_none(self) -> None:
        assert compute_max_pain([]) is None

    def test_two_strikes_picks_lower_pain(self) -> None:
        """Hand-crafted example so we can compute the expected result manually.

        Strike 24000: CE_OI=1000, PE_OI=0
        Strike 25000: CE_OI=0,    PE_OI=1000

        pain(24000) = max(0,24000-24000)*1000 + max(0,24000-25000)*1000
                     = 0 + 1000*(1000) = 1_000_000
        pain(25000) = max(0,25000-24000)*1000 + max(0,25000-25000)*1000
                     = 1000*1000 + 0 = 1_000_000

        Tie → pick highest CE OI → 24000 has CE_OI=1000 vs 25000 has CE_OI=0.
        """
        data = [
            {
                "strikePrice": 24000,
                "expiryDate": _FIXTURE_EXPIRY_NSE,
                "CE": {"lastPrice": 100.0, "openInterest": 1000, "changeinOpenInterest": 0, "totalTradedVolume": 0},
            },
            {
                "strikePrice": 25000,
                "expiryDate": _FIXTURE_EXPIRY_NSE,
                "PE": {"lastPrice": 50.0, "openInterest": 1000, "changeinOpenInterest": 0, "totalTradedVolume": 0},
            },
        ]
        rows = _build_rows_from_nse_data(data, _FIXTURE_EXPIRY_NSE, "NIFTY", "2099-12-25T04:00:00.000Z")
        assert compute_max_pain(rows) == 24000.0


class TestComputeAtmIv:
    def test_returns_mean_of_ce_and_pe_iv(self) -> None:
        rows = _build_single_strike_rows()
        # CE IV = 12.5, PE IV = 11.8 → mean = 12.15
        result = compute_atm_iv(rows, spot=24850.60)
        assert result == round((12.5 + 11.8) / 2, 2)

    def test_returns_none_when_spot_is_none(self) -> None:
        rows = _build_single_strike_rows()
        assert compute_atm_iv(rows, spot=None) is None

    def test_returns_none_when_fewer_than_two_valid_ivs(self) -> None:
        # One CE with IV, one PE with OI=0 (excluded) → only 1 valid IV
        data = [
            {
                "strikePrice": 24000,
                "expiryDate": _FIXTURE_EXPIRY_NSE,
                "CE": {"lastPrice": 100.0, "openInterest": 500, "changeinOpenInterest": 0, "totalTradedVolume": 0, "impliedVolatility": 12.5},
                "PE": {"lastPrice": 50.0, "openInterest": 0, "changeinOpenInterest": 0, "totalTradedVolume": 0, "impliedVolatility": 11.0},
            }
        ]
        rows = _build_rows_from_nse_data(data, _FIXTURE_EXPIRY_NSE, "NIFTY", "2099-12-25T04:00:00.000Z")
        assert compute_atm_iv(rows, spot=24000.0) is None


class TestComputeOiWalls:
    def test_single_strike_returns_that_strike_for_both(self) -> None:
        rows = _build_single_strike_rows()
        max_ce, max_pe = compute_oi_walls(rows)
        assert max_ce == 24000.0
        assert max_pe == 24000.0

    def test_empty_rows_returns_none_none(self) -> None:
        assert compute_oi_walls([]) == (None, None)

    def test_tie_breaks_by_lowest_strike(self) -> None:
        """Two strikes with equal CE OI → lowest strike wins."""
        data = [
            {
                "strikePrice": 24000,
                "expiryDate": _FIXTURE_EXPIRY_NSE,
                "CE": {"lastPrice": 100.0, "openInterest": 500, "changeinOpenInterest": 0, "totalTradedVolume": 0},
            },
            {
                "strikePrice": 25000,
                "expiryDate": _FIXTURE_EXPIRY_NSE,
                "CE": {"lastPrice": 80.0, "openInterest": 500, "changeinOpenInterest": 0, "totalTradedVolume": 0},
            },
        ]
        rows = _build_rows_from_nse_data(data, _FIXTURE_EXPIRY_NSE, "NIFTY", "2099-12-25T04:00:00.000Z")
        max_ce, _ = compute_oi_walls(rows)
        assert max_ce == 24000.0  # lowest strike wins on tie


# ---------------------------------------------------------------------------
# HTTP endpoint tests via TestClient
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def reset_session():
    """Reset the singleton chain session before each test so state doesn't leak."""
    import src.scrapers.option_chain as _oc
    _oc._chain_session = None
    yield
    _oc._chain_session = None


class TestGetOptionChainNSEShape:
    """Test 1: Mock DynamicSession.fetch() with NSE XHR fixture → assert OptionChain shape."""

    def test_full_option_chain_shape_from_nse_fixture(self) -> None:
        mock_page = _make_page_with_xhr(_NSE_FIXTURE)
        mock_session = MagicMock()
        mock_session.fetch = AsyncMock(return_value=mock_page)

        with (
            patch("src.scrapers.option_chain.get_chain_session", new_callable=AsyncMock, return_value=mock_session),
            patch("src.scrapers.option_chain._get_redis", new_callable=AsyncMock, return_value=None),
        ):
            with TestClient(app, raise_server_exceptions=False) as client:
                # Pass expiry explicitly so nearest-expiry selection is bypassed
                resp = client.get(
                    f"/scraping/option-chain?underlying=NIFTY&exchange=NSE&expiry={_FIXTURE_EXPIRY_ISO}"
                )

        assert resp.status_code == 200
        body = resp.json()

        # Top-level fields
        assert body["underlying"] == "NIFTY"
        assert body["spot"] == pytest.approx(24850.60)
        assert body["provider"] == "scrapling"
        assert "fetchedAt" in body
        assert "expiry" in body
        assert "expiries" in body
        assert len(body["expiries"]) == 2

        # Rows
        rows = body["rows"]
        assert len(rows) == 1
        assert rows[0]["strike"] == 24000.0

        # CE contract
        ce = rows[0]["ce"]
        assert ce is not None
        assert ce["ltp"] == pytest.approx(120.5)
        assert ce["oi"] == 1234567
        assert ce["oiChange"] == 45678
        assert ce["volume"] == 89012
        assert ce["optionType"] == "CE"
        assert ce["greeks"]["iv"] == pytest.approx(12.5)

        # PE contract
        pe = rows[0]["pe"]
        assert pe is not None
        assert pe["ltp"] == pytest.approx(68.3)
        assert pe["oi"] == 987654
        assert pe["oiChange"] == -12345
        assert pe["volume"] == 56789
        assert pe["optionType"] == "PE"
        assert pe["greeks"]["iv"] == pytest.approx(11.8)

        # analytics block must be present
        analytics = body["analytics"]
        assert "pcrOi" in analytics
        assert "maxPain" in analytics
        assert "atmIv" in analytics
        assert "maxCeOiStrike" in analytics
        assert "maxPeOiStrike" in analytics
        assert "pcrVolume" in analytics
        assert "totalCeOi" in analytics
        assert "totalPeOi" in analytics


class TestGetOptionChainAnalytics:
    """Test 2: Assert analytics fields computed correctly from the fixture."""

    def _get_analytics(self) -> dict[str, Any]:
        mock_page = _make_page_with_xhr(_NSE_FIXTURE)
        mock_session = MagicMock()
        mock_session.fetch = AsyncMock(return_value=mock_page)

        with (
            patch("src.scrapers.option_chain.get_chain_session", new_callable=AsyncMock, return_value=mock_session),
            patch("src.scrapers.option_chain._get_redis", new_callable=AsyncMock, return_value=None),
        ):
            with TestClient(app, raise_server_exceptions=False) as client:
                resp = client.get(
                    f"/scraping/option-chain?underlying=NIFTY&exchange=NSE&expiry={_FIXTURE_EXPIRY_ISO}"
                )

        assert resp.status_code == 200
        return resp.json()["analytics"]

    def test_pcr_oi(self) -> None:
        analytics = self._get_analytics()
        expected = round(987654 / 1234567, 2)
        assert analytics["pcrOi"] == pytest.approx(expected)

    def test_pcr_volume(self) -> None:
        analytics = self._get_analytics()
        expected = round(56789 / 89012, 2)
        assert analytics["pcrVolume"] == pytest.approx(expected)

    def test_atm_iv(self) -> None:
        analytics = self._get_analytics()
        expected = round((12.5 + 11.8) / 2, 2)
        assert analytics["atmIv"] == pytest.approx(expected)

    def test_max_ce_oi_strike(self) -> None:
        analytics = self._get_analytics()
        # Only one strike, so it must be 24000
        assert analytics["maxCeOiStrike"] == 24000.0

    def test_max_pe_oi_strike(self) -> None:
        analytics = self._get_analytics()
        assert analytics["maxPeOiStrike"] == 24000.0

    def test_max_pain(self) -> None:
        analytics = self._get_analytics()
        # Single strike → max pain = 24000
        assert analytics["maxPain"] == 24000.0

    def test_total_oi_aggregates(self) -> None:
        analytics = self._get_analytics()
        assert analytics["totalCeOi"] == 1234567
        assert analytics["totalPeOi"] == 987654


class TestFallbackToFetcherSession:
    """Test 3: Assert fallback to FetcherSession when DynamicSession raises RuntimeError."""

    def test_fallback_called_on_browser_error(self) -> None:
        # DynamicSession raises RuntimeError (simulates BrowserError)
        mock_session = MagicMock()
        mock_session.fetch = AsyncMock(side_effect=RuntimeError("BrowserError: page crash"))

        # Build a fallback response that mirrors the NSE API shape
        fallback_payload = {
            "records": {
                "data": [
                    {
                        "strikePrice": 24000,
                        "expiryDate": "24-JUL-2025",
                        "CE": {
                            "lastPrice": 120.5,
                            "openInterest": 1234567,
                            "changeinOpenInterest": 45678,
                            "totalTradedVolume": 89012,
                            "impliedVolatility": 12.5,
                        },
                    }
                ],
                "expiryDates": ["24-JUL-2025"],
                "underlyingValue": 24850.60,
            }
        }

        mock_fetcher_response = MagicMock()
        mock_fetcher_response.json = MagicMock(return_value=fallback_payload)

        mock_fetcher_instance = MagicMock()
        mock_fetcher_instance.get = MagicMock(return_value=mock_fetcher_response)
        mock_fetcher_context = MagicMock()
        mock_fetcher_context.__enter__ = MagicMock(return_value=mock_fetcher_instance)
        mock_fetcher_context.__exit__ = MagicMock(return_value=False)

        with (
            patch("src.scrapers.option_chain.get_chain_session", new_callable=AsyncMock, return_value=mock_session),
            patch("src.scrapers.option_chain._get_redis", new_callable=AsyncMock, return_value=None),
            patch("src.scrapers.option_chain._fetch_nse_option_chain_fallback", new_callable=AsyncMock) as mock_fallback,
        ):
            # Fallback returns a valid OptionChain
            from src.schemas import OptionChain, OptionChainAnalytics, OptionChainRow as OCR

            fallback_chain = OptionChain(
                underlying="NIFTY",
                spot=24850.60,
                expiry=_FIXTURE_EXPIRY_ISO,
                expiries=[_FIXTURE_EXPIRY_ISO],
                rows=[],
                analytics=OptionChainAnalytics(
                    totalCeOi=0,
                    totalPeOi=0,
                    totalCeOiChange=0,
                    totalPeOiChange=0,
                ),
                fetchedAt="2099-12-25T04:00:00.000Z",
            )
            mock_fallback.return_value = fallback_chain

            with TestClient(app, raise_server_exceptions=False) as client:
                resp = client.get("/scraping/option-chain?underlying=NIFTY&exchange=NSE")

        assert resp.status_code == 200
        # The fallback must have been called exactly once
        mock_fallback.assert_called_once()
        body = resp.json()
        assert body["underlying"] == "NIFTY"

    def test_fallback_called_on_timeout(self) -> None:
        """asyncio.TimeoutError from DynamicSession should also trigger fallback."""
        import asyncio

        mock_session = MagicMock()
        mock_session.fetch = AsyncMock(side_effect=asyncio.TimeoutError())

        from src.schemas import OptionChain, OptionChainAnalytics

        fallback_chain = OptionChain(
            underlying="NIFTY",
            spot=None,
            expiry=_FIXTURE_EXPIRY_ISO,
            expiries=[_FIXTURE_EXPIRY_ISO],
            rows=[],
            analytics=OptionChainAnalytics(
                totalCeOi=0,
                totalPeOi=0,
                totalCeOiChange=0,
                totalPeOiChange=0,
            ),
            fetchedAt="2099-12-25T04:00:00.000Z",
        )

        with (
            patch("src.scrapers.option_chain.get_chain_session", new_callable=AsyncMock, return_value=mock_session),
            patch("src.scrapers.option_chain._get_redis", new_callable=AsyncMock, return_value=None),
            patch("src.scrapers.option_chain._fetch_nse_option_chain_fallback", new_callable=AsyncMock, return_value=fallback_chain) as mock_fallback,
        ):
            with TestClient(app, raise_server_exceptions=False) as client:
                resp = client.get("/scraping/option-chain?underlying=NIFTY&exchange=NSE")

        assert resp.status_code == 200
        mock_fallback.assert_called_once()


class TestHTTP503WhenBothFail:
    """Test 4: Assert HTTP 503 when DynamicSession and fallback both fail."""

    def test_503_when_primary_and_fallback_fail(self) -> None:
        mock_session = MagicMock()
        mock_session.fetch = AsyncMock(side_effect=RuntimeError("BrowserError"))

        with (
            patch("src.scrapers.option_chain.get_chain_session", new_callable=AsyncMock, return_value=mock_session),
            patch("src.scrapers.option_chain._get_redis", new_callable=AsyncMock, return_value=None),
            patch(
                "src.scrapers.option_chain._fetch_nse_option_chain_fallback",
                new_callable=AsyncMock,
                side_effect=RuntimeError("fallback also failed"),
            ),
        ):
            with TestClient(app, raise_server_exceptions=False) as client:
                resp = client.get("/scraping/option-chain?underlying=NIFTY&exchange=NSE")

        assert resp.status_code == 503
        body = resp.json()
        assert body["available"] is False
        assert "reason" in body

    def test_503_missing_underlying(self) -> None:
        with TestClient(app, raise_server_exceptions=False) as client:
            resp = client.get("/scraping/option-chain?exchange=NSE")
        # underlying is a required query param — FastAPI returns 422 by default
        # but the app overrides validation errors to 400, OR returns 400 from the route.
        assert resp.status_code in (400, 422)

    def test_400_invalid_exchange(self) -> None:
        with (
            patch("src.scrapers.option_chain._get_redis", new_callable=AsyncMock, return_value=None),
        ):
            with TestClient(app, raise_server_exceptions=False) as client:
                resp = client.get("/scraping/option-chain?underlying=NIFTY&exchange=INVALID")

        assert resp.status_code == 400
        body = resp.json()
        assert "error" in body


class TestRedisCache:
    """Test 5: Redis cache write with TTL 20s; cached value returned on second call."""

    def test_cache_write_with_ttl_20s(self) -> None:
        """After a successful fetch, the result must be written to Redis with TTL=20."""
        mock_page = _make_page_with_xhr(_NSE_FIXTURE)
        mock_session = MagicMock()
        mock_session.fetch = AsyncMock(return_value=mock_page)

        mock_redis = AsyncMock()
        mock_redis.get = AsyncMock(return_value=None)   # cache miss
        mock_redis.set = AsyncMock(return_value=True)

        with (
            patch("src.scrapers.option_chain.get_chain_session", new_callable=AsyncMock, return_value=mock_session),
            patch("src.scrapers.option_chain._get_redis", new_callable=AsyncMock, return_value=mock_redis),
        ):
            with TestClient(app, raise_server_exceptions=False) as client:
                resp = client.get(
                    f"/scraping/option-chain?underlying=NIFTY&exchange=NSE&expiry={_FIXTURE_EXPIRY_ISO}"
                )

        assert resp.status_code == 200
        # redis.set must have been called with ex=20
        assert mock_redis.set.called
        call_kwargs = mock_redis.set.call_args
        # call_args is (args, kwargs) or just use call_args.kwargs
        ex_value = call_kwargs.kwargs.get("ex") or (
            call_kwargs.args[2] if len(call_kwargs.args) > 2 else None
        )
        assert ex_value == 20, f"Expected TTL=20, got {ex_value}"

    def test_cached_value_returned_on_second_call(self) -> None:
        """When Redis returns a cached entry the DynamicSession must NOT be called."""
        mock_page = _make_page_with_xhr(_NSE_FIXTURE)
        mock_session = MagicMock()
        mock_session.fetch = AsyncMock(return_value=mock_page)

        # Prepare cached chain JSON
        from src.schemas import OptionChain, OptionChainAnalytics

        cached_chain = OptionChain(
            underlying="NIFTY",
            spot=24850.60,
            expiry=_FIXTURE_EXPIRY_ISO,
            expiries=[_FIXTURE_EXPIRY_ISO, "2099-12-26"],
            rows=[],
            analytics=OptionChainAnalytics(
                totalCeOi=1234567,
                totalPeOi=987654,
                totalCeOiChange=45678,
                totalPeOiChange=-12345,
                pcrOi=round(987654 / 1234567, 2),
            ),
            fetchedAt="2099-12-25T04:00:00.000Z",
        )
        cached_json = cached_chain.model_dump_json()

        mock_redis = AsyncMock()
        mock_redis.get = AsyncMock(return_value=cached_json)  # cache hit
        mock_redis.set = AsyncMock(return_value=True)

        with (
            patch("src.scrapers.option_chain.get_chain_session", new_callable=AsyncMock, return_value=mock_session),
            patch("src.scrapers.option_chain._get_redis", new_callable=AsyncMock, return_value=mock_redis),
        ):
            with TestClient(app, raise_server_exceptions=False) as client:
                resp = client.get(
                    f"/scraping/option-chain?underlying=NIFTY&exchange=NSE&expiry={_FIXTURE_EXPIRY_ISO}"
                )

        assert resp.status_code == 200
        # DynamicSession fetch must NOT have been called (served from cache)
        mock_session.fetch.assert_not_called()

        body = resp.json()
        assert body["underlying"] == "NIFTY"
        assert body["spot"] == pytest.approx(24850.60)


class TestWarmEndpoint:
    """Test 6: POST /scraping/option-chain/warm returns {"warmed": true, "session_ready": true}."""

    def test_warm_returns_200_with_session_ready(self) -> None:
        # The XHR URL must contain "option-chain" for the warm logic to confirm capture
        warm_page = _make_page_with_xhr(
            _NSE_FIXTURE,
            xhr_url="https://www.nseindia.com/api/option-chain-indices?symbol=NIFTY",
        )

        mock_session = MagicMock()
        mock_session.fetch = AsyncMock(return_value=warm_page)

        with patch("src.scrapers.option_chain.get_chain_session", new_callable=AsyncMock, return_value=mock_session):
            with TestClient(app, raise_server_exceptions=False) as client:
                resp = client.post("/scraping/option-chain/warm")

        assert resp.status_code == 200
        body = resp.json()
        assert body["warmed"] is True
        assert body["session_ready"] is True

    def test_warm_returns_503_when_session_unavailable(self) -> None:
        """If get_chain_session raises RuntimeError, warm must return 503."""
        with patch(
            "src.scrapers.option_chain.get_chain_session",
            new_callable=AsyncMock,
            side_effect=RuntimeError("scrapling not available"),
        ):
            with TestClient(app, raise_server_exceptions=False) as client:
                resp = client.post("/scraping/option-chain/warm")

        assert resp.status_code == 503
        body = resp.json()
        assert body["available"] is False
        assert "reason" in body

    def test_warm_returns_503_when_no_xhr_captured(self) -> None:
        """Session loads but captures no XHR → 503."""
        empty_page = MagicMock()
        empty_page.captured_xhr = []  # no XHR entries

        mock_session = MagicMock()
        mock_session.fetch = AsyncMock(return_value=empty_page)

        with patch("src.scrapers.option_chain.get_chain_session", new_callable=AsyncMock, return_value=mock_session):
            with TestClient(app, raise_server_exceptions=False) as client:
                resp = client.post("/scraping/option-chain/warm")

        assert resp.status_code == 503
        body = resp.json()
        assert body["available"] is False

    def test_warm_returns_503_on_timeout(self) -> None:
        """asyncio.TimeoutError during warm → 503."""
        import asyncio

        mock_session = MagicMock()
        mock_session.fetch = AsyncMock(side_effect=asyncio.TimeoutError())

        with patch("src.scrapers.option_chain.get_chain_session", new_callable=AsyncMock, return_value=mock_session):
            with TestClient(app, raise_server_exceptions=False) as client:
                resp = client.post("/scraping/option-chain/warm")

        assert resp.status_code == 503


# ---------------------------------------------------------------------------
# Additional shape / field invariant tests
# ---------------------------------------------------------------------------


class TestOptionChainFieldInvariants:
    """Assert that the OptionChain response shape matches the canonical TypeScript type."""

    def _fetch(self) -> dict[str, Any]:
        mock_page = _make_page_with_xhr(_NSE_FIXTURE)
        mock_session = MagicMock()
        mock_session.fetch = AsyncMock(return_value=mock_page)

        with (
            patch("src.scrapers.option_chain.get_chain_session", new_callable=AsyncMock, return_value=mock_session),
            patch("src.scrapers.option_chain._get_redis", new_callable=AsyncMock, return_value=None),
        ):
            with TestClient(app, raise_server_exceptions=False) as client:
                resp = client.get(
                    f"/scraping/option-chain?underlying=NIFTY&exchange=NSE&expiry={_FIXTURE_EXPIRY_ISO}"
                )

        assert resp.status_code == 200
        return resp.json()

    def test_provider_is_scrapling(self) -> None:
        assert self._fetch()["provider"] == "scrapling"

    def test_expiries_is_list_of_iso_dates(self) -> None:
        expiries = self._fetch()["expiries"]
        assert isinstance(expiries, list)
        # All entries should be ISO-8601 date strings (YYYY-MM-DD)
        import re

        iso_pattern = re.compile(r"^\d{4}-\d{2}-\d{2}$")
        for exp in expiries:
            assert iso_pattern.match(exp), f"Not an ISO date: {exp!r}"

    def test_row_fields_present(self) -> None:
        body = self._fetch()
        row = body["rows"][0]
        assert "strike" in row
        assert "ce" in row
        assert "pe" in row

    def test_ce_greeks_fields_present(self) -> None:
        body = self._fetch()
        greeks = body["rows"][0]["ce"]["greeks"]
        for field in ("iv", "delta", "gamma", "theta", "vega"):
            assert field in greeks

    def test_fetch_at_is_iso8601_utc(self) -> None:
        body = self._fetch()
        import re

        ts_pattern = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$")
        assert ts_pattern.match(body["fetchedAt"]), f"Bad timestamp: {body['fetchedAt']!r}"


class TestNormalizeExpiry:
    def test_nse_format_to_iso(self) -> None:
        assert _normalize_expiry_to_iso("24-JUL-2025") == "2025-07-24"

    def test_iso_format_unchanged(self) -> None:
        assert _normalize_expiry_to_iso("2025-07-24") == "2025-07-24"

    def test_full_month_name(self) -> None:
        assert _normalize_expiry_to_iso("24-JULY-2025") == "2025-07-24"

    def test_unknown_format_returns_input(self) -> None:
        assert _normalize_expiry_to_iso("24/07/2025") == "24/07/2025"


class TestSelectNearestExpiry:
    def test_selects_first_future_expiry(self) -> None:
        expiries = ["01-JAN-2020", _FIXTURE_EXPIRY_NSE, _FIXTURE_EXPIRY_NSE2]
        result = _select_nearest_expiry(expiries)
        assert result == _FIXTURE_EXPIRY_NSE

    def test_returns_last_when_all_in_past(self) -> None:
        expiries = ["01-JAN-2020", "01-FEB-2020"]
        result = _select_nearest_expiry(expiries)
        assert result == "01-FEB-2020"
