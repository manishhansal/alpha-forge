"""
Upstox instrument-master resolver (data-service).

Mirrors the TypeScript resolver (src/lib/market-data/providers/upstox-instruments.ts).

WHY: Upstox market-data endpoints identify NSE/BSE *equities* by an ISIN-based
instrument key (e.g. RELIANCE -> NSE_EQ|INE002A01018). A symbol-based key such as
NSE_EQ|RELIANCE is REJECTED (HTTP 400 "Invalid Instrument key" / empty quotes).
Indices (NSE_INDEX|Nifty 50) and F&O keep their name/token form.

This downloads Upstox's public instrument master (gzip JSON, no auth), builds a
trading_symbol -> instrument_key map for the equity segments, and caches it in
process memory for 12h with single-flight so we never re-download within a hot
window. Falls back gracefully (returns None) when the master is unavailable.
"""

from __future__ import annotations

import asyncio
import gzip
import json
import time
from typing import Optional

import httpx
import structlog

logger = structlog.get_logger(__name__)

_NSE_MASTER_URL = "https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz"
_BSE_MASTER_URL = "https://assets.upstox.com/market-quote/instruments/exchange/BSE.json.gz"
_TTL_S = 12 * 60 * 60  # 12h
_FETCH_TIMEOUT_S = 30.0

# segment -> {trading_symbol: instrument_key}
_maps: dict[str, dict[str, str]] = {}
_maps_ts: dict[str, float] = {}
_locks: dict[str, asyncio.Lock] = {}


def _lock_for(segment: str) -> asyncio.Lock:
    lk = _locks.get(segment)
    if lk is None:
        lk = asyncio.Lock()
        _locks[segment] = lk
    return lk


async def _download_map(url: str, segment: str) -> dict[str, str]:
    async with httpx.AsyncClient(timeout=_FETCH_TIMEOUT_S) as client:
        resp = await client.get(url)
        resp.raise_for_status()
        raw = resp.content
    # The endpoint serves RAW gzip bytes (Content-Type: application/gzip, no
    # Content-Encoding) — decompress manually. Detect the gzip magic (1f 8b).
    if len(raw) >= 2 and raw[0] == 0x1F and raw[1] == 0x8B:
        text = gzip.decompress(raw).decode("utf-8")
    else:
        text = raw.decode("utf-8")
    rows = json.loads(text)
    out: dict[str, str] = {}
    for row in rows:
        if row.get("segment") != segment or row.get("instrument_type") != "EQ":
            continue
        sym = row.get("trading_symbol")
        key = row.get("instrument_key")
        if sym and key:
            out[sym.upper()] = key
    return out


async def _get_map(segment: str) -> dict[str, str]:
    now = time.monotonic()
    existing = _maps.get(segment)
    if existing and (now - _maps_ts.get(segment, 0.0)) < _TTL_S:
        return existing
    async with _lock_for(segment):
        existing = _maps.get(segment)
        if existing and (time.monotonic() - _maps_ts.get(segment, 0.0)) < _TTL_S:
            return existing
        url = _NSE_MASTER_URL if segment == "NSE_EQ" else _BSE_MASTER_URL
        m = await _download_map(url, segment)
        _maps[segment] = m
        _maps_ts[segment] = time.monotonic()
        logger.info("upstox_instrument_map_loaded", segment=segment, count=len(m))
        return m


async def resolve_equity_instrument_key(symbol: str, exchange: str = "NSE") -> Optional[str]:
    """Resolve an NSE/BSE equity trading symbol to its ISIN-based Upstox key.

    Returns None when the symbol isn't in the master (caller falls back to the
    symbol-based form).
    """
    segment = "BSE_EQ" if exchange == "BSE" else "NSE_EQ"
    clean = symbol.upper().replace(".NS", "").replace(".BO", "")
    try:
        m = await _get_map(segment)
        return m.get(clean)
    except Exception as exc:  # network / parse failure -> graceful fallback
        logger.warning("upstox_instrument_resolve_failed", symbol=symbol, error=str(exc))
        return None


def _reset_cache_for_tests() -> None:
    _maps.clear()
    _maps_ts.clear()
