"""
Upstox REST API client for the data-service.

Provides market data (quotes, historical candles, option chain) via the
Upstox v2 REST APIs using the UPSTOX_ANALYTICS_TOKEN (preferred) or
UPSTOX_ACCESS_TOKEN environment variables.

All calls are server-side only. No token is ever exposed to the browser.

Authentication priority:
  1. UPSTOX_ANALYTICS_TOKEN  — long-lived read-only bearer (preferred)
  2. UPSTOX_ACCESS_TOKEN     — legacy direct token (backward compat)

When neither token is configured, all methods return empty results and
the circuit breaker remains CLOSED (not a failure — just unconfigured).
"""

from __future__ import annotations

import os
import time
from datetime import date, datetime, timezone
from typing import Any

import httpx
import structlog

from src.core.circuit_breaker import get_breaker
from src.core.lineage import lineage_store
from src.core.schemas_v2 import DataSource
from src.schemas import MDQuote, OHLCVCandle

logger = structlog.get_logger(__name__)

_UPSTOX_BASE = "https://api.upstox.com"
_TIMEOUT_S = 10.0

# ---------------------------------------------------------------------------
# Well-known Upstox index instrument keys
# ---------------------------------------------------------------------------
_INDEX_KEYS: dict[str, str] = {
    "NIFTY":        "NSE_INDEX|Nifty 50",
    "BANKNIFTY":    "NSE_INDEX|Nifty Bank",
    "FINNIFTY":     "NSE_INDEX|Nifty Fin Service",
    "MIDCPNIFTY":   "NSE_INDEX|Nifty MidCap Select",
    "NIFTYNXT50":   "NSE_INDEX|Nifty Next 50",
    "SENSEX":       "BSE_INDEX|SENSEX",
    "BANKEX":       "BSE_INDEX|BANKEX",
    "INDIAVIX":     "NSE_INDEX|India VIX",
    "^NSEI":        "NSE_INDEX|Nifty 50",
    "^NSEBANK":     "NSE_INDEX|Nifty Bank",
}

# Map Upstox v2 intervals to canonical names
_INTERVAL_MAP: dict[str, str] = {
    "1m":  "1minute",
    "3m":  "3minute",
    "5m":  "5minute",
    "10m": "10minute",
    "15m": "15minute",
    "30m": "30minute",
    "1h":  "60minute",
    "1d":  "day",
    "1w":  "week",
    "1M":  "month",
}


def _get_bearer_token() -> str | None:
    """Return the best available bearer token. Server-side only."""
    return os.environ.get("UPSTOX_ANALYTICS_TOKEN") or os.environ.get("UPSTOX_ACCESS_TOKEN") or None


def _is_configured() -> bool:
    return bool(_get_bearer_token())


def _to_instrument_key(symbol: str, exchange: str = "NSE") -> str:
    """Convert canonical symbol + exchange to Upstox instrument key."""
    clean = symbol.upper().replace(".NS", "").replace(".BO", "")
    if clean in _INDEX_KEYS:
        return _INDEX_KEYS[clean]
    if exchange == "NFO" or exchange == "NSE_FO":
        return f"NSE_FO|{clean}"
    if exchange == "BSE":
        return f"BSE_EQ|{clean}"
    return f"NSE_EQ|{clean}"


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Upstox HTTP helper
# ---------------------------------------------------------------------------

async def _upstox_get(path: str, params: dict | None = None) -> Any:
    """Execute an authenticated GET request to the Upstox API."""
    token = _get_bearer_token()
    if not token:
        raise RuntimeError("Upstox: no bearer token configured (UPSTOX_ANALYTICS_TOKEN)")

    url = f"{_UPSTOX_BASE}{path}"
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        "Api-Version": "2.0",
    }

    async with httpx.AsyncClient(timeout=_TIMEOUT_S) as client:
        resp = await client.get(url, headers=headers, params=params or {})

    if resp.status_code == 401:
        raise RuntimeError(f"Upstox {path}: HTTP 401 unauthorized — check UPSTOX_ANALYTICS_TOKEN")
    if not resp.is_success:
        raise RuntimeError(f"Upstox {path}: HTTP {resp.status_code}")

    envelope = resp.json()
    if envelope.get("status") != "success":
        raise RuntimeError(f"Upstox {path}: status={envelope.get('status')}, errors={envelope.get('errors')}")

    return envelope.get("data")


# ---------------------------------------------------------------------------
# Market quotes
# ---------------------------------------------------------------------------

async def get_quotes(symbols: list[str], exchange: str = "NSE") -> dict[str, MDQuote]:
    """
    Fetch live quotes for multiple symbols via Upstox market-quote API.

    Uses /v2/market-quote/quotes (bulk, up to 500 instruments per request).
    No NSE direct calls — authenticated broker API only.
    """
    if not _is_configured():
        logger.debug("upstox_not_configured")
        return {}

    breaker = get_breaker("upstox_quotes")
    if not breaker.allow_request():
        logger.warning("upstox_quotes_circuit_open")
        return {}

    instrument_keys = [_to_instrument_key(sym, exchange) for sym in symbols]
    received_at_ms = int(time.time() * 1000)

    try:
        data = await _upstox_get(
            "/v2/market-quote/quotes",
            params={"instrument_key": ",".join(instrument_keys)},
        )
        available_at_ms = int(time.time() * 1000)
        breaker.record_success()
    except Exception as exc:
        breaker.record_failure(str(exc))
        logger.warning("upstox_quotes_failed", error=str(exc))
        return {}

    results: dict[str, MDQuote] = {}
    fetched_at = _utc_now_iso()

    for instrument_key, item in (data or {}).items():
        # Resolve back to canonical symbol
        # instrument_key format: NSE_EQ|RELIANCE or NSE_INDEX|Nifty 50
        parts = instrument_key.split("|", 1)
        sym = parts[1].upper() if len(parts) == 2 else instrument_key.upper()
        # For indices, map display name back to trading symbol
        for canon_sym, key in _INDEX_KEYS.items():
            if key == instrument_key:
                sym = canon_sym
                break

        try:
            ltp = item.get("last_price")
            ohlc = item.get("ohlc") or {}
            prev_close = item.get("net_change", None)

            quote = MDQuote(
                symbol=sym,
                token=instrument_key,
                exchange=exchange,
                ltp=float(ltp) if ltp is not None else None,
                change=float(item["net_change"]) if item.get("net_change") is not None else None,
                changePct=float(item["net_change_percentage"]) if item.get("net_change_percentage") is not None else None,
                open=float(ohlc["open"]) if ohlc.get("open") is not None else None,
                high=float(ohlc["high"]) if ohlc.get("high") is not None else None,
                low=float(ohlc["low"]) if ohlc.get("low") is not None else None,
                prevClose=float(ohlc["close"]) if ohlc.get("close") is not None else None,
                volume=int(item["volume"]) if item.get("volume") is not None else None,
                oi=float(item["oi"]) if item.get("oi") is not None else None,
                upperCircuit=float(item["upper_circuit_limit"]) if item.get("upper_circuit_limit") else None,
                lowerCircuit=float(item["lower_circuit_limit"]) if item.get("lower_circuit_limit") else None,
                provider="upstox",
                fetchedAt=fetched_at,
            )
            results[sym] = quote

            # Record lineage
            lineage_store.record(
                instrument_id=instrument_key,
                symbol=sym,
                data_type="QUOTE",
                source=DataSource.BROKER_UPSTOX,
                event_time_ms=None,
                received_at_ms=received_at_ms,
                available_at_ms=available_at_ms,
                normalization_version="2.0.0",
                validation_applied=True,
                is_fallback=False,
            )
        except Exception as exc:
            logger.warning("upstox_quote_parse_error", symbol=sym, error=str(exc))
            continue

    return results


# ---------------------------------------------------------------------------
# Historical candles
# ---------------------------------------------------------------------------

async def get_historical_candles(
    symbol: str,
    interval: str,
    from_date: date,
    to_date: date,
    exchange: str = "NSE",
) -> list[OHLCVCandle]:
    """
    Fetch historical OHLCV candles via Upstox v2 historical-candle API.

    Endpoint: GET /v2/historical-candle/{instrumentKey}/{interval}/{to}/{from}

    No NSE direct calls — authenticated broker API only.
    """
    if not _is_configured():
        return []

    breaker = get_breaker("upstox_historical")
    if not breaker.allow_request():
        logger.warning("upstox_historical_circuit_open", symbol=symbol)
        return []

    instrument_key = _to_instrument_key(symbol, exchange)
    upstox_interval = _INTERVAL_MAP.get(interval, "day")

    # Upstox date format: YYYY-MM-DD
    from_str = from_date.strftime("%Y-%m-%d")
    to_str   = to_date.strftime("%Y-%m-%d")

    received_at_ms = int(time.time() * 1000)

    try:
        data = await _upstox_get(
            f"/v2/historical-candle/{instrument_key}/{upstox_interval}/{to_str}/{from_str}",
        )
        available_at_ms = int(time.time() * 1000)
        breaker.record_success()
    except Exception as exc:
        breaker.record_failure(str(exc))
        logger.warning("upstox_historical_failed", symbol=symbol, error=str(exc))
        return []

    candles: list[OHLCVCandle] = []
    raw_candles = (data or {}).get("candles", [])

    for raw in raw_candles:
        try:
            # Upstox format: [timestamp_str, open, high, low, close, volume, oi]
            ts_str, o, h, l, c, v, oi = (raw + [0, 0])[:7]
            # Parse ISO timestamp to UTC epoch seconds
            dt = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
            ts_epoch = int(dt.timestamp())

            candle = OHLCVCandle(
                time=ts_epoch,
                open=float(o),
                high=float(h),
                low=float(l),
                close=float(c),
                volume=float(v),
                oi=float(oi) if oi else None,
            )

            # Basic OHLC validation
            if candle.high < candle.low or candle.open <= 0 or candle.close <= 0:
                logger.warning("upstox_invalid_candle", symbol=symbol, time=ts_epoch)
                continue

            candles.append(candle)
        except Exception as exc:
            logger.warning("upstox_candle_parse_error", symbol=symbol, error=str(exc))
            continue

    # Record lineage for the batch
    if candles:
        lineage_store.record(
            instrument_id=instrument_key,
            symbol=symbol,
            data_type="CANDLE",
            source=DataSource.BROKER_UPSTOX,
            event_time_ms=int(candles[-1].time * 1000) if candles else None,
            received_at_ms=received_at_ms,
            available_at_ms=available_at_ms,
            normalization_version="2.0.0",
            validation_applied=True,
            is_fallback=False,
        )

    return candles
