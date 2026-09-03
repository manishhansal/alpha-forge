"""
Property-based tests for server-level and integration properties.

Properties covered:
- Property 1:  CORS origin rejection
- Property 2:  Historical response structural invariants
- Property 11: Tick publication null-LTP skip (unit-level)
- Property 16: Ban detection pattern matching completeness and soundness

**Validates: Requirements 1.3, 2.1, 5.3, 9.4, 9.5, 9.6**
"""

from __future__ import annotations

import sys
import os
from contextlib import asynccontextmanager
from typing import AsyncGenerator
from unittest.mock import AsyncMock, MagicMock, patch

# Ensure the data-service src/ package is importable when pytest is run from
# the repo root or from within data-service/.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "src"))

import pytest
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.testclient import TestClient
from hypothesis import assume, given
from hypothesis import settings as hyp_settings
from hypothesis import strategies as st

from src.scrapers.historical import _build_response
from src.publisher.tick_publisher import _quote_to_tick
from src.schemas import MDQuote


# ---------------------------------------------------------------------------
# Minimal FastAPI app fixture for CORS tests (bypasses the full lifespan)
# ---------------------------------------------------------------------------
# We create a *minimal* copy of the app that only applies the CORS middleware
# and the /health route — no Redis connection, no Chromium warm-up.  This
# makes the CORS tests fast, deterministic, and free of external dependencies.


def _make_cors_test_app() -> FastAPI:
    """Build a minimal FastAPI app with the same CORS configuration as server.py."""
    app = FastAPI(title="test-cors")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "http://localhost:3000",
            "http://127.0.0.1:3000",
        ],
        allow_credentials=True,
        allow_methods=["GET", "POST"],
        allow_headers=["*"],
    )

    from fastapi.responses import JSONResponse

    @app.get("/health")
    async def health() -> JSONResponse:
        return JSONResponse({"status": "healthy", "service": "data-service"})

    return app


# Module-level client — shared across all Property 1 tests.
_cors_client = TestClient(_make_cors_test_app(), raise_server_exceptions=True)


# ---------------------------------------------------------------------------
# Property 1: CORS origin rejection
# ---------------------------------------------------------------------------


@given(
    origin=st.text(
        # HTTP header values must be ASCII — constrain to printable ASCII
        # (codepoints 32-126) to avoid UnicodeEncodeError inside httpx.
        alphabet=st.characters(min_codepoint=32, max_codepoint=126),
        min_size=1,
    ).filter(
        lambda o: o not in ("http://localhost:3000", "http://127.0.0.1:3000")
    )
)
@hyp_settings(max_examples=200)
def test_property_1_cors_origin_rejection(origin: str) -> None:
    """
    Feature: scrapling-data-service
    Property 1: CORS origin rejection

    For any HTTP request carrying an ``Origin`` header whose value is not
    ``http://localhost:3000`` and not ``http://127.0.0.1:3000``, the
    Data_Service SHALL NOT include an ``Access-Control-Allow-Origin`` header
    in the response that echoes back the caller's origin.

    The CORSMiddleware only adds ``Access-Control-Allow-Origin`` when the
    incoming Origin is in the whitelist.  All other origins receive no ACAO
    header, which browsers interpret as a CORS failure.

    **Validates: Requirements 1.3**
    """
    response = _cors_client.get(
        "/health",
        headers={"Origin": origin},
    )

    # The server must respond (any 2xx/3xx/4xx); it must NOT echo back an
    # Access-Control-Allow-Origin header for a non-whitelisted origin.
    acao = response.headers.get("access-control-allow-origin", "")

    # ACAO must not be set to the caller's (non-whitelisted) origin.
    assert acao != origin, (
        f"CORS policy violated: Access-Control-Allow-Origin was set to "
        f"non-whitelisted origin '{origin}'"
    )

    # It also must not be the wildcard '*' — we explicitly list origins.
    assert acao != "*", (
        "CORS policy violated: Access-Control-Allow-Origin was set to '*' "
        "even though the app uses an explicit origin whitelist"
    )


def test_property_1_cors_whitelisted_origins_pass() -> None:
    """
    Sanity check: the two whitelisted origins DO receive the ACAO header.
    This is the positive case that confirms the CORS middleware is working
    and Property 1's negative assertions are meaningful.
    """
    for origin in ("http://localhost:3000", "http://127.0.0.1:3000"):
        response = _cors_client.get("/health", headers={"Origin": origin})
        acao = response.headers.get("access-control-allow-origin", "")
        assert acao == origin, (
            f"Expected whitelisted origin '{origin}' to be echoed back in "
            f"Access-Control-Allow-Origin, got '{acao}'"
        )


# ---------------------------------------------------------------------------
# Property 2: Historical response structural invariants
# ---------------------------------------------------------------------------


@given(
    candle_list=st.lists(
        st.fixed_dictionaries(
            {
                "time": st.integers(min_value=0, max_value=2**32),
                "open": st.floats(
                    min_value=0.01,
                    max_value=999_999.0,
                    allow_nan=False,
                    allow_infinity=False,
                ),
                "high": st.floats(
                    min_value=0.01,
                    max_value=999_999.0,
                    allow_nan=False,
                    allow_infinity=False,
                ),
                "low": st.floats(
                    min_value=0.01,
                    max_value=999_999.0,
                    allow_nan=False,
                    allow_infinity=False,
                ),
                "close": st.floats(
                    min_value=0.01,
                    max_value=999_999.0,
                    allow_nan=False,
                    allow_infinity=False,
                ),
                "volume": st.integers(min_value=0),
            }
        ),
        min_size=0,
        max_size=20,
    )
)
@hyp_settings(max_examples=200)
def test_property_2_historical_response_structural_invariants(
    candle_list: list[dict],
) -> None:
    """
    Feature: scrapling-data-service
    Property 2: Historical response structural invariants

    For any valid historical candle response from ``GET /scraping/historical``,
    the ``count`` field SHALL equal the length of the ``candles`` array, and
    the ``candles`` array SHALL be sorted in ascending order by ``time``.

    We test the ``_build_response()`` helper directly because it is the single
    function that enforces both invariants for all callers (cached + live paths).

    **Validates: Requirements 2.1**
    """
    response = _build_response(
        symbol="TESTSTOCK",
        exchange="NSE",
        interval="1d",
        candles=candle_list,
        source="bhavcopy",
    )

    # --- Invariant 1: count == len(candles) ----------------------------------
    assert response["count"] == len(response["candles"]), (
        f"count mismatch: count={response['count']}, "
        f"len(candles)={len(response['candles'])}"
    )

    # --- Invariant 2: candles sorted ascending by time ----------------------
    times = [c["time"] for c in response["candles"]]
    assert times == sorted(times), (
        f"candles are not sorted ascending by time: {times}"
    )

    # --- Invariant 3: count matches original input length -------------------
    # _build_response() must not silently drop or duplicate any candle.
    assert response["count"] == len(candle_list), (
        f"response count {response['count']} does not match "
        f"input length {len(candle_list)}"
    )


def test_property_2_empty_candle_list() -> None:
    """
    Edge case: an empty candle list must produce count=0 and an empty array.
    This corresponds to Requirement 2.10 (symbol not found / empty date range).
    """
    response = _build_response(
        symbol="NIFTY",
        exchange="NSE",
        interval="5m",
        candles=[],
        source="redis",
    )
    assert response["count"] == 0
    assert response["candles"] == []


# ---------------------------------------------------------------------------
# Property 11: Tick publication null-LTP skip
# ---------------------------------------------------------------------------
#
# We test the ``_quote_to_tick()`` pure function directly.  This function
# encapsulates the null-LTP skip rule: when ltp is None (or token/exchange is
# absent), it returns None; the TickPublisher loop then skips the PUBLISH call
# and does NOT increment publish_count.


def _make_mdquote(
    symbol: str,
    ltp: float | None,
    token: str | None = "T001",
    exchange: str | None = "NSE",
) -> MDQuote:
    """Construct an MDQuote for testing, with controllable ltp/token/exchange."""
    return MDQuote(
        symbol=symbol,
        token=token,
        exchange=exchange,
        ltp=ltp,
        fetchedAt="2025-01-01T00:00:00.000Z",
    )


@given(
    symbol=st.text(
        min_size=1,
        max_size=10,
        alphabet=st.characters(whitelist_categories=("Lu",)),  # uppercase letters
    ),
    ltp=st.one_of(
        st.none(),
        st.floats(
            min_value=0.01,
            max_value=999_999.0,
            allow_nan=False,
            allow_infinity=False,
        ),
    ),
)
@hyp_settings(max_examples=300)
def test_property_11_tick_null_ltp_skip(
    symbol: str,
    ltp: float | None,
) -> None:
    """
    Feature: scrapling-data-service
    Property 11: Tick publication null-LTP skip

    For any MDQuote:
    - When ``ltp`` is ``None``: ``_quote_to_tick()`` SHALL return ``None``
      (indicating that NO message should be published and publish_count MUST
      NOT be incremented).
    - When ``ltp`` is a non-null positive float: ``_quote_to_tick()`` SHALL
      return a LiveTick with ``ltp`` equal to the quote's ltp and all required
      fields present.

    Required LiveTick fields (per Requirement 5.2):
        token, symbol, exchange, ltp, exchangeTimestampMs, receivedAtMs, provider

    **Validates: Requirements 5.3**
    """
    quote = _make_mdquote(symbol=symbol, ltp=ltp)
    tick = _quote_to_tick(quote)

    if ltp is None:
        # null ltp → must return None (skip publishing)
        assert tick is None, (
            f"Expected _quote_to_tick() to return None for ltp=None, "
            f"but got: {tick}"
        )
    else:
        # non-null ltp → must return a valid LiveTick
        assert tick is not None, (
            f"Expected _quote_to_tick() to return a LiveTick for "
            f"ltp={ltp}, but got None"
        )
        # ltp value is preserved exactly
        assert tick.ltp == ltp, (
            f"tick.ltp={tick.ltp} does not match quote.ltp={ltp}"
        )
        # All required fields are present and non-None
        assert tick.token, f"tick.token must be non-empty"
        assert tick.symbol, f"tick.symbol must be non-empty"
        assert tick.exchange, f"tick.exchange must be non-empty"
        assert tick.exchangeTimestampMs is not None, (
            "tick.exchangeTimestampMs must be present"
        )
        assert tick.receivedAtMs is not None, (
            "tick.receivedAtMs must be present"
        )
        assert tick.provider == "scrapling", (
            f"tick.provider must be 'scrapling', got '{tick.provider}'"
        )
        # symbol is uppercased by _quote_to_tick
        assert tick.symbol == symbol.upper(), (
            f"tick.symbol '{tick.symbol}' must be the uppercase of "
            f"quote.symbol '{symbol}'"
        )


def test_property_11_missing_token_returns_none() -> None:
    """
    When token is absent (None or empty), _quote_to_tick() returns None even
    if ltp is present — the tick is missing a required field.
    """
    quote_no_token = _make_mdquote(symbol="NIFTY", ltp=24800.0, token=None)
    assert _quote_to_tick(quote_no_token) is None

    quote_empty_token = _make_mdquote(symbol="NIFTY", ltp=24800.0, token="")
    assert _quote_to_tick(quote_empty_token) is None


def test_property_11_missing_exchange_returns_none() -> None:
    """
    When exchange is absent (None or empty), _quote_to_tick() returns None
    even if ltp is present — the tick is missing a required field.
    """
    quote_no_exchange = _make_mdquote(symbol="NIFTY", ltp=24800.0, exchange=None)
    assert _quote_to_tick(quote_no_exchange) is None

    quote_empty_exchange = _make_mdquote(symbol="NIFTY", ltp=24800.0, exchange="")
    assert _quote_to_tick(quote_empty_exchange) is None


# ---------------------------------------------------------------------------
# Property 16: Ban detection pattern matching completeness and soundness
# ---------------------------------------------------------------------------
#
# The BanDetector checks three patterns in order:
#   1. ShadowBanPattern  — dict with records.data == [] AND market hours
#   2. AkamaiChallengePattern — string containing "window._atsb"
#   3. RateLimitPattern  — string containing "Too Many Requests"
#
# The ShadowBanPattern is time-dependent (_is_market_hours_ist()).  We inject
# test doubles for both paths (market hours = True and = False) so the test is
# fully deterministic regardless of when it runs.


_SHADOW_BAN_BODY = {"records": {"data": []}}
_AKAMAI_BODY = "<!DOCTYPE html><script>window._atsb = 1;</script>"
_RATE_LIMIT_BODY = "Too Many Requests - you have exceeded your rate limit"


def _make_detector_during_market_hours() -> "BanDetector":  # noqa: F821
    """Return a BanDetector whose ShadowBanPattern always sees market hours."""
    from src.anti_ban.ban_detector import BanDetector, ShadowBanPattern

    det = BanDetector()
    # Patch the module-level helper used by ShadowBanPattern.matches()
    for pattern in det._patterns:
        if isinstance(pattern, ShadowBanPattern):
            pattern._market_hours_override = True  # type: ignore[attr-defined]
    return det


def _is_banned_with_market_hours(body: object, market_hours: bool) -> bool:
    """
    Evaluate BanDetector.is_banned(body) with a controlled market-hours state.

    We patch `src.anti_ban.ban_detector._is_market_hours_ist` globally so the
    ShadowBanPattern uses our injected value.
    """
    with patch(
        "src.anti_ban.ban_detector._is_market_hours_ist",
        return_value=market_hours,
    ):
        from src.anti_ban.ban_detector import BanDetector
        detector = BanDetector()
        return detector.is_banned(body)  # type: ignore[arg-type]


@given(
    body=st.one_of(
        # Strings that do NOT contain trigger phrases
        st.text().filter(
            lambda s: "window._atsb" not in s and "Too Many Requests" not in s
        ),
        # Shadow-ban dicts with non-empty data list (should NOT trigger)
        st.fixed_dictionaries(
            {
                "records": st.fixed_dictionaries(
                    {"data": st.lists(st.integers(), min_size=1)}
                )
            }
        ),
        # Non-matching dicts (no "records" key at all)
        st.fixed_dictionaries(
            {
                "other_key": st.text(),
            }
        ),
        # Integers, floats, and other non-str/non-dict types (should NOT trigger)
        st.integers(),
        st.none(),
    )
)
@hyp_settings(max_examples=300)
def test_property_16_non_banned_bodies_return_false(body: object) -> None:
    """
    Feature: scrapling-data-service
    Property 16 (soundness): Ban detection pattern matching is sound

    For any body that does NOT match any of the three trigger conditions,
    BanDetector.is_banned() SHALL return False.

    Trigger conditions (from the design doc):
    1. dict with records.data == [] AND within market hours
    2. str containing "window._atsb"
    3. str containing "Too Many Requests"

    We test with BOTH market hours states to ensure the result is False in
    all non-trigger cases regardless of time.

    **Validates: Requirements 9.4, 9.5, 9.6**
    """
    # Test with market hours = True
    result_mh = _is_banned_with_market_hours(body, market_hours=True)
    assert not result_mh, (
        f"is_banned() returned True for non-trigger body (market_hours=True): {body!r}"
    )

    # Test with market hours = False
    result_no_mh = _is_banned_with_market_hours(body, market_hours=False)
    assert not result_no_mh, (
        f"is_banned() returned True for non-trigger body (market_hours=False): {body!r}"
    )


def test_property_16_akamai_pattern_triggers() -> None:
    """
    Property 16 (completeness): AkamaiChallengePattern triggers on any string
    that contains "window._atsb" — regardless of surrounding content.

    **Validates: Requirements 9.5**
    """
    trigger_bodies = [
        "window._atsb",
        'some prefix window._atsb',
        "<!DOCTYPE html>\n<script>window._atsb = 1;</script>",
        "prefix window._atsb suffix",
    ]
    for body in trigger_bodies:
        result = _is_banned_with_market_hours(body, market_hours=True)
        assert result is True, (
            f"AkamaiChallengePattern did not trigger for body: {body!r}"
        )
        # Should also trigger outside market hours (market hours irrelevant for Akamai)
        result_no_mh = _is_banned_with_market_hours(body, market_hours=False)
        assert result_no_mh is True, (
            f"AkamaiChallengePattern did not trigger outside market hours for: {body!r}"
        )


def test_property_16_rate_limit_pattern_triggers() -> None:
    """
    Property 16 (completeness): RateLimitPattern triggers on any string
    that contains "Too Many Requests" — regardless of surrounding content.

    **Validates: Requirements 9.6**
    """
    trigger_bodies = [
        "Too Many Requests",
        "HTTP 429 Too Many Requests",
        "Error: Too Many Requests - slow down",
        "prefix Too Many Requests suffix",
    ]
    for body in trigger_bodies:
        result = _is_banned_with_market_hours(body, market_hours=True)
        assert result is True, (
            f"RateLimitPattern did not trigger for body: {body!r}"
        )
        result_no_mh = _is_banned_with_market_hours(body, market_hours=False)
        assert result_no_mh is True, (
            f"RateLimitPattern did not trigger outside market hours for: {body!r}"
        )


def test_property_16_shadow_ban_triggers_during_market_hours() -> None:
    """
    Property 16 (completeness): ShadowBanPattern triggers when both:
    - body has records.data == [] (empty list, NOT None or non-empty)
    - current time is within IST market hours (03:30–10:30 UTC)

    **Validates: Requirements 9.4**
    """
    shadow_body = {"records": {"data": []}}

    # During market hours → must be banned
    result_mh = _is_banned_with_market_hours(shadow_body, market_hours=True)
    assert result_mh is True, (
        "ShadowBanPattern did not trigger during market hours for records.data == []"
    )

    # Outside market hours → must NOT be banned
    result_no_mh = _is_banned_with_market_hours(shadow_body, market_hours=False)
    assert result_no_mh is False, (
        "ShadowBanPattern incorrectly triggered outside market hours"
    )


def test_property_16_shadow_ban_non_empty_data_no_trigger() -> None:
    """
    ShadowBanPattern must NOT trigger when records.data is non-empty
    (even during market hours).
    """
    non_empty_body = {"records": {"data": [{"symbol": "NIFTY"}]}}
    result = _is_banned_with_market_hours(non_empty_body, market_hours=True)
    assert result is False, (
        "ShadowBanPattern incorrectly triggered for non-empty records.data"
    )


def test_property_16_ban_count_increments() -> None:
    """
    Each detected ban increments BanDetector.ban_count by exactly 1.
    Verifying this separately ensures the counter is correctly wired per
    Requirement 9.5 (monitoring integration).
    """
    with patch(
        "src.anti_ban.ban_detector._is_market_hours_ist",
        return_value=False,  # market hours don't matter for Akamai / RateLimit
    ):
        from src.anti_ban.ban_detector import BanDetector

        detector = BanDetector()
        assert detector.ban_count == 0

        detector.is_banned(_AKAMAI_BODY)
        assert detector.ban_count == 1

        detector.is_banned(_RATE_LIMIT_BODY)
        assert detector.ban_count == 2

        # Non-matching body must not increment
        detector.is_banned("normal response body")
        assert detector.ban_count == 2


@given(
    body=st.one_of(
        st.just(_AKAMAI_BODY),
        st.just(_RATE_LIMIT_BODY),
        # Akamai variants with additional text
        st.text().map(lambda prefix: f"{prefix} window._atsb"),
        st.text().map(lambda suffix: f"window._atsb {suffix}"),
    )
)
@hyp_settings(max_examples=100)
def test_property_16_trigger_bodies_always_detected(body: str) -> None:
    """
    Feature: scrapling-data-service
    Property 16 (completeness): Any body that satisfies an Akamai or rate-limit
    trigger condition SHALL always cause is_banned() to return True.

    **Validates: Requirements 9.5, 9.6**
    """
    result = _is_banned_with_market_hours(body, market_hours=True)
    assert result is True, (
        f"Trigger body was not detected as banned: {body!r}"
    )
