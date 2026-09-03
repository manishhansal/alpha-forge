"""
Canonical Pydantic v2 schemas for data-service.

Field names and nesting are intentionally identical to the TypeScript types in
`src/lib/market-data/types.ts`. ScraplingProvider returns these responses
directly without any transformation — the structural identity is enforced by
the contract test in `data-service/tests/test_option_chain_schema_compat.py`.

All timestamps are UTC internally.
All prices are in INR (rupees), never paisa.
"""

from __future__ import annotations

from typing import Annotated, Literal, Optional

from pydantic import BaseModel, Field


# ── OHLCVCandle ──────────────────────────────────────────────────────────────


class OHLCVCandle(BaseModel):
    """Single OHLCV bar.

    ``time`` is UTC epoch seconds for the candle open time.
    All prices are in INR (rupees). ``oi`` is present for F&O candles only.
    """

    time: int  # UTC epoch seconds
    open: float
    high: float
    low: float
    close: float
    volume: int
    oi: Optional[int] = None


# ── Greeks ───────────────────────────────────────────────────────────────────


class Greeks(BaseModel):
    """Option Greeks. All fields are optional — upstream may not compute them."""

    iv: Optional[float] = None      # Implied volatility (annualised %)
    delta: Optional[float] = None
    gamma: Optional[float] = None
    theta: Optional[float] = None
    vega: Optional[float] = None
    rho: Optional[float] = None


# ── OptionContract ───────────────────────────────────────────────────────────


class OptionContract(BaseModel):
    """A single CE or PE option contract row within an option chain."""

    token: str
    tradingSymbol: str
    underlying: str
    expiry: str              # ISO-8601 date (UTC)
    strike: float
    optionType: str          # "CE" | "PE"
    ltp: Optional[float] = None
    bid: Optional[float] = None
    ask: Optional[float] = None
    oi: int
    oiChange: int
    volume: int
    greeks: Greeks
    fetchedAt: str           # UTC ISO-8601


# ── OptionChainRow ───────────────────────────────────────────────────────────


class OptionChainRow(BaseModel):
    """A single strike row in an option chain; may have CE, PE, or both."""

    strike: float
    ce: Optional[OptionContract] = None
    pe: Optional[OptionContract] = None


# ── OptionChainAnalytics ─────────────────────────────────────────────────────


class OptionChainAnalytics(BaseModel):
    """Computed analytics for an option chain snapshot."""

    pcrOi: Optional[float] = None         # Put-call ratio by open interest
    pcrVolume: Optional[float] = None     # Put-call ratio by volume
    maxCeOiStrike: Optional[float] = None # Strike with highest CE OI (resistance)
    maxPeOiStrike: Optional[float] = None # Strike with highest PE OI (support)
    totalCeOi: int
    totalPeOi: int
    totalCeOiChange: int
    totalPeOiChange: int
    atmIv: Optional[float] = None         # ATM implied volatility (%)
    maxPain: Optional[float] = None       # Max pain strike price


# ── OptionChain ──────────────────────────────────────────────────────────────


class OptionChain(BaseModel):
    """Full option chain response. Shape is identical to the TypeScript OptionChain type."""

    underlying: str
    spot: Optional[float] = None          # Underlying spot price
    expiry: str                           # Selected expiry (ISO-8601 date)
    expiries: list[str]                   # All available expiries, nearest-first
    rows: list[OptionChainRow]
    analytics: OptionChainAnalytics
    provider: Literal["scrapling"] = "scrapling"
    fetchedAt: str                        # UTC ISO-8601


# ── MDQuote ──────────────────────────────────────────────────────────────────


class MDQuote(BaseModel):
    """Normalised market quote. Shape is identical to the TypeScript MDQuote type."""

    symbol: str
    token: Optional[str] = None
    exchange: Optional[str] = None
    name: Optional[str] = None
    ltp: Optional[float] = None
    change: Optional[float] = None
    changePct: Optional[float] = None
    prevClose: Optional[float] = None
    open: Optional[float] = None
    high: Optional[float] = None
    low: Optional[float] = None
    volume: Optional[int] = None
    oi: Optional[int] = None
    upperCircuit: Optional[float] = None
    lowerCircuit: Optional[float] = None
    weekHigh52: Optional[float] = None
    weekLow52: Optional[float] = None
    totalBuyQty: Optional[int] = None
    totalSellQty: Optional[int] = None
    lastTradeTime: Optional[str] = None  # UTC ISO-8601
    provider: Literal["scrapling"] = "scrapling"
    fetchedAt: str                       # UTC ISO-8601


# ── LiveTick ─────────────────────────────────────────────────────────────────


class LiveTick(BaseModel):
    """A single live price tick published to Redis ``af:ticks:{symbol}``."""

    token: str
    symbol: str
    exchange: str
    ltp: float                           # Last traded price (INR)
    change: Optional[float] = None
    changePct: Optional[float] = None
    volume: Optional[int] = None
    oi: Optional[int] = None
    exchangeTimestampMs: int             # UTC epoch milliseconds (exchange side)
    receivedAtMs: int                    # UTC epoch milliseconds (received by us)
    provider: Literal["scrapling"] = "scrapling"


# ── Instrument ───────────────────────────────────────────────────────────────


class Instrument(BaseModel):
    """A single tradeable instrument from the NSE/BSE master."""

    token: str
    tradingSymbol: Annotated[str, Field(max_length=50)]
    name: Annotated[str, Field(max_length=100)]
    exchange: str                        # NSE | BSE | NFO | BFO
    lotSize: int                         # >= 0; 0 when unknown
    instrumentType: str                  # EQ | FUT | CE | PE
    expiry: str                          # YYYY-MM-DD or "" for equities
    strike: float                        # 0.0 for non-options
    optionType: str                      # "CE" | "PE" | "" for non-options
    isin: Optional[str] = None
