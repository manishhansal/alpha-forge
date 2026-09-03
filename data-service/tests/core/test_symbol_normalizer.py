"""
Tests for SymbolNormalizer — Phase 10.
"""

from __future__ import annotations

import pytest

from src.core.symbol_normalizer import SymbolNormalizer, symbol_normalizer


class TestSymbolNormalizer:
    def test_uppercase_passthrough(self) -> None:
        assert symbol_normalizer.normalize("RELIANCE") == "RELIANCE"

    def test_nse_prefix_stripped(self) -> None:
        assert symbol_normalizer.normalize("NSE:RELIANCE") == "RELIANCE"

    def test_bse_prefix_stripped(self) -> None:
        assert symbol_normalizer.normalize("BSE:RELIANCE") == "RELIANCE"

    def test_eq_suffix_stripped(self) -> None:
        assert symbol_normalizer.normalize("RELIANCE-EQ") == "RELIANCE"

    def test_dot_ns_suffix_stripped(self) -> None:
        assert symbol_normalizer.normalize("RELIANCE.NS") == "RELIANCE"

    def test_dot_bo_suffix_stripped(self) -> None:
        assert symbol_normalizer.normalize("RELIANCE.BO") == "RELIANCE"

    def test_yahoo_nsei_maps_to_nifty(self) -> None:
        assert symbol_normalizer.normalize("^NSEI") == "NIFTY"

    def test_yahoo_nsebank_maps_to_banknifty(self) -> None:
        assert symbol_normalizer.normalize("^NSEBANK") == "BANKNIFTY"

    def test_nifty_50_display_name_maps(self) -> None:
        assert symbol_normalizer.normalize("NIFTY 50") == "NIFTY"

    def test_nifty_bank_display_name_maps(self) -> None:
        assert symbol_normalizer.normalize("NIFTY BANK") == "BANKNIFTY"

    def test_lowercase_normalized(self) -> None:
        assert symbol_normalizer.normalize("reliance") == "RELIANCE"

    def test_mixed_case_normalized(self) -> None:
        assert symbol_normalizer.normalize("Reliance.NS") == "RELIANCE"

    def test_empty_string_returns_empty(self) -> None:
        assert symbol_normalizer.normalize("") == ""

    def test_normalize_many(self) -> None:
        results = symbol_normalizer.normalize_many(["RELIANCE", "NSE:HDFCBANK", "^NSEI"])
        assert results == ["RELIANCE", "HDFCBANK", "NIFTY"]

    def test_is_yahoo_style_caret(self) -> None:
        assert symbol_normalizer.is_yahoo_style("^NSEI")

    def test_is_yahoo_style_dot_ns(self) -> None:
        assert symbol_normalizer.is_yahoo_style("RELIANCE.NS")

    def test_is_not_yahoo_style_plain(self) -> None:
        assert not symbol_normalizer.is_yahoo_style("RELIANCE")

    def test_is_valid_nse_symbol(self) -> None:
        assert symbol_normalizer.is_valid_nse_symbol("RELIANCE")
        assert symbol_normalizer.is_valid_nse_symbol("M&M")
        assert symbol_normalizer.is_valid_nse_symbol("BAJAJ-AUTO")
        assert symbol_normalizer.is_valid_nse_symbol("NIFTY")

    def test_invalid_nse_symbol_yahoo_format(self) -> None:
        assert not symbol_normalizer.is_valid_nse_symbol("^NSEI")
        assert not symbol_normalizer.is_valid_nse_symbol("RELIANCE.NS")

    def test_invalid_nse_symbol_too_long(self) -> None:
        assert not symbol_normalizer.is_valid_nse_symbol("A" * 31)

    def test_filter_invalid_for_nse_api(self) -> None:
        symbols = ["RELIANCE", "^NSEI", "HDFCBANK", "RELIANCE.NS"]
        valid, rejected = symbol_normalizer.filter_invalid_for_nse_api(symbols)
        assert "RELIANCE" in valid
        assert "HDFCBANK" in valid
        assert "^NSEI" in rejected
        assert "RELIANCE.NS" in rejected

    def test_instrument_id_format(self) -> None:
        assert symbol_normalizer.instrument_id("RELIANCE") == "NSE:RELIANCE"
        assert symbol_normalizer.instrument_id("RELIANCE", "BSE") == "BSE:RELIANCE"

    def test_nse_index_name_roundtrip(self) -> None:
        assert symbol_normalizer.nse_index_name_to_symbol("NIFTY 50") == "NIFTY"
        assert symbol_normalizer.symbol_to_nse_index_name("NIFTY") == "NIFTY 50"
