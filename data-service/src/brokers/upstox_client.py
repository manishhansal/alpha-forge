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
from src.core.provider_http import (
    ProviderError,
    ProviderRateLimitError,
    resilient_get,
)
from src.schemas import MDQuote, OHLCVCandle

logger = structlog.get_logger(__name__)

_UPSTOX_BASE = "https://api.upstox.com"
_TIMEOUT_S = 10.0
_PROVIDER = "upstox"

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

# Canonical interval -> Upstox v2 historical interval unit.
# Upstox v2 historical-candle accepts ONLY these units (verified against the live
# API — everything else returns HTTP 400 "UDAPI1020 Interval accepts one of
# (1minute, 30minute, day, week, month)"). Unsupported canonical intervals
# (3m/5m/10m/15m/1h) map to None so the caller returns empty and the wider chain
# falls over to a provider that DOES support them.
_INTERVAL_MAP: dict[str, str] = {
    "1m":  "1minute",
    "30m": "30minute",
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
    """Convert canonical symbol + exchange to Upstox instrument key (sync form).

    NOTE: for NSE/BSE equities this returns the SYMBOL-based key, which Upstox
    REJECTS. Prefer the async ``_resolve_instrument_key`` which resolves the
    ISIN-based key from the instrument master; this sync form is the fallback.
    """
    clean = symbol.upper().replace(".NS", "").replace(".BO", "")
    if clean in _INDEX_KEYS:
        return _INDEX_KEYS[clean]
    if exchange == "NFO" or exchange == "NSE_FO":
        return f"NSE_FO|{clean}"
    if exchange == "BSE":
        return f"BSE_EQ|{clean}"
    return f"NSE_EQ|{clean}"


async def _resolve_instrument_key(symbol: str, exchange: str = "NSE") -> str:
    """Async key resolver — the CORRECT path.

    Indices / F&O keep the sync (name/token) form. NSE/BSE equities resolve the
    ISIN-based key from the instrument master (Upstox rejects symbol-based equity
    keys), falling back to the sync form when the master is unavailable.
    """
    clean = symbol.upper().replace(".NS", "").replace(".BO", "")
    if clean in _INDEX_KEYS or exchange in ("NFO", "NSE_FO"):
        return _to_instrument_key(symbol, exchange)
    if exchange in ("NSE", "BSE"):
        try:
            from src.brokers.upstox_instruments import resolve_equity_instrument_key

            resolved = await resolve_equity_instrument_key(clean, exchange)
            if resolved:
                return resolved
        except Exception:  # pragma: no cover - defensive
            pass
    return _to_instrument_key(symbol, exchange)


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Upstox HTTP helper
# ---------------------------------------------------------------------------

async def _upstox_get(path: str, params: dict | None = None) -> Any:
    """Execute an authenticated GET request to the Upstox API.

    Uses the shared resilient HTTP layer: a pooled keep-alive client, typed
    error classification (403 / 503 / 429 / timeout / network / malformed),
    Retry-After honouring, and exponential backoff + jitter on transient
    failures. Non-retryable failures (401 / 403 / 404) are raised immediately —
    we never retry a 403 or hammer an auth failure.

    Raises a ``ProviderError`` subclass on failure.
    """
    token = _get_bearer_token()
    if not token:
        raise ProviderError("Upstox: no bearer token configured (UPSTOX_ANALYTICS_TOKEN)", _PROVIDER)

    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        "Api-Version": "2.0",
    }

    result = await resilient_get(
        provider=_PROVIDER,
        base_url=_UPSTOX_BASE,
        path=path,
        headers=headers,
        params=params or {},
        timeout_s=_TIMEOUT_S,
    )

    envelope = result.json
    if not isinstance(envelope, dict) or envelope.get("status") != "success":
        from src.core.provider_http import ProviderMalformedResponseError

        errors = envelope.get("errors") if isinstance(envelope, dict) else None
        status = envelope.get("status") if isinstance(envelope, dict) else None
        raise ProviderMalformedResponseError(
            f"Upstox {path}: status={status}, errors={errors}", _PROVIDER, result.status
        )

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

    instrument_keys = [await _resolve_instrument_key(sym, exchange) for sym in symbols]
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

    # Upstox echoes the instrument key back with EITHER delimiter — the request
    # uses "SEGMENT|VALUE" but the response keys use "SEGMENT:VALUE" (verified
    # against the live API). Build a lookup from BOTH forms of each requested key
    # → the canonical symbol so we remap reliably regardless of delimiter.
    key_to_symbol: dict[str, str] = {}
    for sym, k in zip(symbols, instrument_keys):
        key_to_symbol[k] = sym.upper()
        key_to_symbol[k.replace("|", ":")] = sym.upper()

    for instrument_key, item in (data or {}).items():
        # Prefer the exact requested-key mapping; fall back to splitting on either
        # delimiter, then to the index display-name reverse map.
        sym = key_to_symbol.get(instrument_key)
        if sym is None:
            parts = instrument_key.replace(":", "|").split("|", 1)
            sym = parts[1].upper() if len(parts) == 2 else instrument_key.upper()
            for canon_sym, key in _INDEX_KEYS.items():
                if key == instrument_key or key.replace("|", ":") == instrument_key:
                    sym = canon_sym
                    break

        try:
            ltp = item.get("last_price")
            ohlc = item.get("ohlc") or {}
            # prevClose comes from ohlc.close (the previous session close).
            prev_close = ohlc.get("close")
            net_change = item.get("net_change")

            # Upstox /v2/market-quote/quotes does NOT return net_change_percentage
            # (verified against the live API). Compute changePct from net_change
            # and the previous close, matching the TypeScript provider.
            change_pct = None
            if net_change is not None and prev_close not in (None, 0):
                try:
                    change_pct = (float(net_change) / float(prev_close)) * 100.0
                except (TypeError, ValueError, ZeroDivisionError):
                    change_pct = None

            quote = MDQuote(
                symbol=sym,
                token=instrument_key,
                exchange=exchange,
                ltp=float(ltp) if ltp is not None else None,
                change=float(net_change) if net_change is not None else None,
                changePct=change_pct,
                open=float(ohlc["open"]) if ohlc.get("open") is not None else None,
                high=float(ohlc["high"]) if ohlc.get("high") is not None else None,
                low=float(ohlc["low"]) if ohlc.get("low") is not None else None,
                prevClose=float(prev_close) if prev_close is not None else None,
                volume=int(item["volume"]) if item.get("volume") is not None else None,
                oi=float(item["oi"]) if item.get("oi") is not None else None,
                totalBuyQty=int(item["total_buy_quantity"]) if item.get("total_buy_quantity") is not None else None,
                totalSellQty=int(item["total_sell_quantity"]) if item.get("total_sell_quantity") is not None else None,
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

    # Skip intervals Upstox v2 doesn't support (would 400). Empty return lets the
    # wider chain fall over to a provider that serves them (Angel/Yahoo).
    upstox_interval = _INTERVAL_MAP.get(interval)
    if upstox_interval is None:
        logger.debug("upstox_historical_unsupported_interval", symbol=symbol, interval=interval)
        return []

    breaker = get_breaker("upstox_historical")
    if not breaker.allow_request():
        logger.warning("upstox_historical_circuit_open", symbol=symbol)
        return []

    instrument_key = await _resolve_instrument_key(symbol, exchange)

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
