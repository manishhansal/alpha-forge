"""
Symbol Normalization Layer — Phase 10.

Canonical single mapping layer for all symbol variants.
Normalizes Yahoo Finance, NSE, BSE, and broker-specific symbol formats
to the canonical AlphaForge instrument ID.

Rules:
- RELIANCE / RELIANCE.NS / RELIANCE-EQ / NSE:RELIANCE → "RELIANCE"
- NIFTY / ^NSEI / NSE:NIFTY / NIFTY 50 → "NIFTY"
- Yahoo-style symbols (^, .NS, .BO) are filtered from NSE-native APIs
- Never silently route an invalid symbol to another instrument

Usage:
    from src.core.symbol_normalizer import symbol_normalizer
    canonical = symbol_normalizer.normalize("NSE:RELIANCE")  # "RELIANCE"
    is_valid = symbol_normalizer.is_valid_nse_symbol("RELIANCE")
"""

from __future__ import annotations

import re
import structlog

logger = structlog.get_logger(__name__)

# ---------------------------------------------------------------------------
# Yahoo Finance → NSE canonical mappings
# ---------------------------------------------------------------------------

_YAHOO_TO_NSE: dict[str, str] = {
    "^NSEI": "NIFTY",
    "^NSEBANK": "BANKNIFTY",
    "^CNXFIN": "FINNIFTY",
    "^CNXMIDCAP": "MIDCPNIFTY",
    "^BSESN": "SENSEX",
    "NIFTY 50": "NIFTY",
    "NIFTY50": "NIFTY",
    "NIFTY BANK": "BANKNIFTY",
    "NIFTYBANK": "BANKNIFTY",
    "NIFTY FIN SERVICE": "FINNIFTY",
    "NIFTY MID SELECT": "MIDCPNIFTY",
}

# NSE API name → canonical symbol (used in index quote parsing)
_NSE_INDEX_NAME_TO_SYMBOL: dict[str, str] = {
    "NIFTY 50": "NIFTY",
    "NIFTY BANK": "BANKNIFTY",
    "NIFTY FIN SERVICE": "FINNIFTY",
    "NIFTY MID SELECT": "MIDCPNIFTY",
    "NIFTY MIDCAP 150": "MIDCPNIFTY150",
    "NIFTY 100": "NIFTY100",
    "NIFTY 200": "NIFTY200",
    "NIFTY 500": "NIFTY500",
    "NIFTY NEXT 50": "NIFTYNXT50",
    "INDIA VIX": "INDIAVIX",
    "NIFTY REALTY": "NIFTYREALTY",
    "NIFTY IT": "CNXIT",
    "NIFTY AUTO": "CNXAUTO",
    "NIFTY PHARMA": "CNXPHARMA",
    "NIFTY METAL": "CNXMETAL",
    "NIFTY MEDIA": "CNXMEDIA",
    "NIFTY FMCG": "CNXFMCG",
    "NIFTY ENERGY": "CNXENERGY",
    "NIFTY PSU BANK": "NIFPSUBNK",
    "NIFTY PRIVATE BANK": "NIFTYPVTBANK",
}

# Reverse map: canonical → NSE display name
_SYMBOL_TO_NSE_INDEX_NAME: dict[str, str] = {
    v: k for k, v in _NSE_INDEX_NAME_TO_SYMBOL.items()
}

# Patterns that identify Yahoo Finance-style symbols
_YAHOO_PATTERNS = re.compile(
    r"(\^)|"        # ^NSEI style
    r"(\.NS$)|"     # RELIANCE.NS
    r"(\.BO$)|"     # RELIANCE.BO (BSE)
    r"(\.NS\.)",    # rare embedded .NS.
    re.IGNORECASE,
)

# Exchange prefix patterns
_EXCHANGE_PREFIX_RE = re.compile(
    r"^(NSE:|BSE:|NFO:|BFO:|MCX:)",
    re.IGNORECASE,
)

# Series suffix patterns (e.g. -EQ, -FUT)
_SERIES_SUFFIX_RE = re.compile(
    r"(-EQ|-FUT|-CE|-PE|-BE|-SM|-ST)$",
    re.IGNORECASE,
)

# Valid NSE symbol pattern: alphanumeric + & + - + . (for some like M&M, BAJAJ-AUTO)
_VALID_NSE_SYMBOL_RE = re.compile(r"^[A-Z0-9&\-\.]{1,30}$")


class SymbolNormalizer:
    """Single entry point for all symbol normalization."""

    def normalize(self, symbol: str) -> str:
        """Normalize a symbol to its canonical AlphaForge form.

        Strips exchange prefixes, series suffixes, and maps common aliases.
        Returns the symbol uppercased.
        """
        if not symbol:
            return ""

        sym = symbol.strip().upper()

        # 1. Check direct Yahoo → NSE mapping
        if sym in _YAHOO_TO_NSE:
            return _YAHOO_TO_NSE[sym]

        # 2. Strip exchange prefix (NSE:, BSE:, NFO:, etc.)
        sym = _EXCHANGE_PREFIX_RE.sub("", sym)

        # 3. Strip .NS / .BO suffix (Yahoo Finance format)
        sym = re.sub(r"\.(NS|BO)$", "", sym, flags=re.IGNORECASE)

        # 4. Strip series suffix (-EQ, -FUT, etc.)
        sym = _SERIES_SUFFIX_RE.sub("", sym)

        # 5. Trim whitespace and uppercase
        sym = sym.strip().upper()

        # 6. Map NSE index display names
        if sym in _NSE_INDEX_NAME_TO_SYMBOL:
            return _NSE_INDEX_NAME_TO_SYMBOL[sym]

        return sym

    def normalize_many(self, symbols: list[str]) -> list[str]:
        """Normalize a list of symbols."""
        return [self.normalize(s) for s in symbols]

    def is_yahoo_style(self, symbol: str) -> bool:
        """Return True when the symbol looks like a Yahoo Finance format."""
        return bool(_YAHOO_PATTERNS.search(symbol))

    def is_valid_nse_symbol(self, symbol: str) -> bool:
        """Return True when the symbol is a valid NSE trading symbol format.

        Does NOT check if the instrument actually exists — only format validation.
        """
        sym = symbol.strip().upper()
        if not sym:
            return False
        if self.is_yahoo_style(sym):
            return False
        return bool(_VALID_NSE_SYMBOL_RE.match(sym))

    def filter_invalid_for_nse_api(self, symbols: list[str]) -> tuple[list[str], list[str]]:
        """Split symbols into (valid_for_nse, rejected).

        Rejected symbols are those with Yahoo Finance format or other
        formats that would fail NSE API calls.
        """
        valid = []
        rejected = []
        for sym in symbols:
            normalized = self.normalize(sym)
            if self.is_yahoo_style(sym) or not self.is_valid_nse_symbol(normalized):
                rejected.append(sym)
                logger.debug(
                    "symbol_rejected_for_nse",
                    original=sym,
                    normalized=normalized,
                )
            else:
                valid.append(normalized)
        return valid, rejected

    def nse_index_name_to_symbol(self, nse_name: str) -> str:
        """Map an NSE API index name to the canonical symbol."""
        return _NSE_INDEX_NAME_TO_SYMBOL.get(nse_name.strip(), nse_name.strip().upper())

    def symbol_to_nse_index_name(self, symbol: str) -> str | None:
        """Map a canonical symbol to the NSE API index name, or None."""
        return _SYMBOL_TO_NSE_INDEX_NAME.get(symbol.upper())

    def instrument_id(self, symbol: str, exchange: str = "NSE") -> str:
        """Generate the canonical internal instrument ID.

        Format: {EXCHANGE}:{SYMBOL}
        """
        return f"{exchange.upper()}:{self.normalize(symbol)}"


# ---------------------------------------------------------------------------
# Module-level singleton
# ---------------------------------------------------------------------------

symbol_normalizer = SymbolNormalizer()
