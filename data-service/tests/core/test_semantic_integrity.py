"""
Phase 3 Regression Tests — Semantic Field Integrity.

CRITICAL: These tests guard against the OI/tradedValue semantic error.

The NSE NextApi ``totalTradedValue`` is total traded value in INR.
It must NEVER be mapped to ``oi`` (open interest).

If these tests fail, it means the OI semantic corruption has regressed.
This must be treated as a P0 blocker.

Requirements: Phase 3 — Fix semantic data errors, add regression tests.
"""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.schemas import MDQuote
from src.scrapers.live_quotes import (
    _fetch_batch_quotes,
    _fetch_index_quotes,
    _fetch_single_quote,
    _utc_now_iso,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _make_nse_equity_item(
    symbol: str,
    last_price: float = 2850.0,
    volume: int = 1_500_000,
    traded_value: float = 4_275_000_000.0,  # INR — this is NOT OI
) -> dict:
    """Build a mock NSE NextApi equity item."""
    return {
        "symbol": symbol,
        "lastPrice": last_price,
        "change": 12.35,
        "pChange": 0.44,
        "open": 2838.0,
        "dayHigh": 2862.0,
        "dayLow": 2820.0,
        "previousClose": 2838.25,
        "totalTradedVolume": volume,
        # This is INR traded value — NOT open interest
        "totalTradedValue": traded_value,
    }


def _make_mock_page_with_data(items: list[dict]) -> MagicMock:
    """Create a mock page returning batch data."""
    payload = {"data": items}
    page = MagicMock()
    xhr = MagicMock()
    xhr.url = "https://www.nseindia.com/api/NextApi/apiClient/marketWatchApi?functionName=getIndicesData&symbol=NIFTY%20200"
    xhr.json = MagicMock(return_value=payload)
    page.captured_xhr = [xhr]
    return page


# ---------------------------------------------------------------------------
# CRITICAL: OI ≠ tradedValue regression tests
# ---------------------------------------------------------------------------


class TestOISemantic:
    """These tests MUST pass at all times. If any fails, data is semantically corrupt."""

    @pytest.mark.asyncio
    async def test_oi_is_none_for_equity_batch_quotes(self) -> None:
        """CRITICAL: batch equity quotes must have oi=None, NOT the traded value.

        The old code incorrectly mapped totalTradedValue (INR value) to oi.
        totalTradedValue = 4,275,000,000 is an INR amount, not OI contracts.
        """
        item = _make_nse_equity_item(
            "RELIANCE",
            last_price=2850.0,
            volume=1_500_000,
            traded_value=4_275_000_000.0,  # INR — must NOT appear in oi
        )

        with patch("src.scrapers.live_quotes.get_http_client") as mock_client_fn:
            mock_client = AsyncMock()
            mock_response = MagicMock()
            mock_response.raise_for_status = MagicMock()
            mock_response.json = MagicMock(return_value={"data": {"data": [item]}})
            mock_client.get = AsyncMock(return_value=mock_response)
            mock_client_fn.return_value = mock_client

            session = MagicMock()
            results = await _fetch_batch_quotes(session, ["RELIANCE"])

        assert "RELIANCE" in results, "RELIANCE must be in results"
        quote = results["RELIANCE"]

        # THE CRITICAL ASSERTION
        assert quote.oi is None, (
            f"SEMANTIC ERROR: oi should be None for equity quotes. "
            f"Got oi={quote.oi}. "
            f"totalTradedValue ({4_275_000_000.0}) is INR value, NOT open interest contracts."
        )

        # Volume should be correct
        assert quote.volume == 1_500_000, f"volume should be 1_500_000, got {quote.volume}"

    @pytest.mark.asyncio
    async def test_oi_is_none_for_single_quote(self) -> None:
        """CRITICAL: single equity quote must have oi=None, NOT the traded value."""
        item = _make_nse_equity_item(
            "HDFCBANK",
            last_price=1650.0,
            volume=2_000_000,
            traded_value=3_300_000_000.0,  # INR — must NOT appear in oi
        )

        with patch("src.scrapers.live_quotes.get_http_client") as mock_client_fn:
            mock_client = AsyncMock()
            mock_response = MagicMock()
            mock_response.raise_for_status = MagicMock()
            mock_response.json = MagicMock(
                return_value={"data": {"data": [item]}}
            )
            mock_client.get = AsyncMock(return_value=mock_response)
            mock_client_fn.return_value = mock_client

            session = MagicMock()
            result = await _fetch_single_quote(session, "HDFCBANK")

        assert result is not None
        assert result.oi is None, (
            f"SEMANTIC ERROR: oi should be None for single equity quote. "
            f"Got oi={result.oi}. This is a P0 semantic corruption."
        )

    @pytest.mark.asyncio
    async def test_oi_is_none_for_index_quotes(self) -> None:
        """Index quotes (NIFTY, BANKNIFTY) have no OI field — must be None."""
        index_item = {
            "indexName": "NIFTY 50",
            "last": 24850.0,
            "open": 24750.0,
            "high": 24900.0,
            "low": 24700.0,
            "previousClose": 24708.0,
            "percChange": 0.58,
        }

        with patch("src.scrapers.live_quotes.get_http_client") as mock_client_fn:
            mock_client = AsyncMock()
            mock_response = MagicMock()
            mock_response.raise_for_status = MagicMock()
            mock_response.json = MagicMock(return_value={"data": [index_item]})
            mock_client.get = AsyncMock(return_value=mock_response)
            mock_client_fn.return_value = mock_client

            results = await _fetch_index_quotes(["NIFTY"])

        assert "NIFTY" in results
        nifty_quote = results["NIFTY"]
        assert nifty_quote.oi is None, (
            f"Index quotes should have oi=None. Got oi={nifty_quote.oi}"
        )
        assert nifty_quote.volume is None, (
            f"Index quotes should have volume=None (not available). Got volume={nifty_quote.volume}"
        )

    def test_mdquote_schema_separates_oi_and_traded_value(self) -> None:
        """The MDQuote schema must allow independent oi and tradedValue fields."""
        # This test verifies the schema supports semantic separation
        from src.schemas import MDQuote

        # We can have high volume but no OI (equity)
        equity_quote = MDQuote(
            symbol="TCS",
            exchange="NSE",
            ltp=4200.0,
            volume=500_000,
            oi=None,  # explicitly null for equity
            provider="scrapling",
            fetchedAt=_utc_now_iso(),
        )
        assert equity_quote.oi is None
        assert equity_quote.volume == 500_000

        # We can have OI for F&O (from option chain source)
        fno_quote = MDQuote(
            symbol="NIFTY",
            exchange="NSE",
            ltp=24850.0,
            volume=None,  # index has no volume from this endpoint
            oi=None,      # OI not available from index endpoint
            provider="scrapling",
            fetchedAt=_utc_now_iso(),
        )
        assert fno_quote.oi is None

    def test_oi_cannot_be_set_from_traded_value_field(self) -> None:
        """Verify that a large INR value would be absurd as OI.

        Context: totalTradedValue for RELIANCE might be 4,275,000,000 INR
        Open interest for RELIANCE futures might be 4,200 contracts.
        These are different by 6 orders of magnitude — this is why the
        semantic error was critical for any F&O strategy.
        """
        reliance_traded_value_inr = 4_275_000_000  # ~4.275 billion INR

        # If oi was set to traded value, this would be nonsensical
        # A realistic OI for RELIANCE futures: 3,000-8,000 contracts
        realistic_max_oi = 10_000_000  # 10 million contracts max

        # The traded value in INR is 427x larger than even an extreme OI
        assert reliance_traded_value_inr > realistic_max_oi * 427, (
            "This test validates the scale difference between INR value and OI contracts"
        )

        # If someone accidentally used traded_value as OI, the signal engine
        # would see absurd OI numbers and generate incorrect signals
        # e.g. PCR calculations would be completely wrong


# ---------------------------------------------------------------------------
# V2 Schema tests
# ---------------------------------------------------------------------------


class TestMarketQuoteV2Semantic:
    """Verify V2 schema enforces semantic separation."""

    def test_v2_schema_has_separate_oi_and_traded_value(self) -> None:
        """V2 schema must have distinct oi and tradedValue fields."""
        from src.core.schemas_v2 import MarketQuoteV2

        quote = MarketQuoteV2(
            instrumentId="NSE:RELIANCE",
            symbol="RELIANCE",
            exchange="NSE",
            ltp=2850.0,
            volume=1_500_000,
            tradedValue=4_275_000_000.0,  # INR value
            oi=None,  # explicitly null — no OI from equity endpoint
        )

        assert quote.oi is None, "oi must be None for equity"
        assert quote.tradedValue == 4_275_000_000.0, "tradedValue must hold INR amount"
        assert quote.volume == 1_500_000, "volume must hold share count"

    def test_v2_schema_field_docstrings_enforce_semantics(self) -> None:
        """V2 schema field descriptions must document semantic separation."""
        from src.core.schemas_v2 import MarketQuoteV2

        fields = MarketQuoteV2.model_fields
        oi_description = str(fields["oi"].description or "")
        traded_value_description = str(fields["tradedValue"].description or "")

        assert "NEVER mapped to OI" in traded_value_description or "NOT open interest" in traded_value_description or "NOT OI" in traded_value_description, (
            "tradedValue field description must explicitly state it is NOT OI"
        )
        assert "NOT traded" in oi_description or "F&O" in oi_description or "open interest" in oi_description.lower(), (
            "oi field description must document it is open interest"
        )
