"""
Request context and correlation — Phases 86-88.

Every request gets a requestId that is propagated through the entire
data-service → Next.js → worker → signal → paper trade pipeline.

Also provides the canonical API error contract.

Phase 86: Error contract — code, message, retryable, source, timestamp, requestId
Phase 87: Request correlation — requestId propagated everywhere
Phase 88: Structured logging with requestId
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi.responses import JSONResponse


def new_request_id() -> str:
    """Generate a new unique request ID."""
    return str(uuid.uuid4())


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def error_response(
    status_code: int,
    code: str,
    message: str,
    retryable: bool = False,
    source: str = "data-service",
    request_id: Optional[str] = None,
    extra: Optional[dict] = None,
) -> JSONResponse:
    """Build a canonical API error response.

    Phase 86: Every API error contains code, message, retryable, source,
    timestamp, requestId. No internal stack traces exposed.
    """
    body: dict[str, Any] = {
        "error": {
            "code": code,
            "message": message,
            "retryable": retryable,
            "source": source,
            "timestamp": _utc_now_iso(),
            "requestId": request_id or new_request_id(),
        }
    }
    if extra:
        body["error"].update(extra)
    return JSONResponse(status_code=status_code, content=body)


# Pre-defined error codes
class ErrorCode:
    VALIDATION_ERROR = "VALIDATION_ERROR"
    UPSTREAM_TIMEOUT = "UPSTREAM_TIMEOUT"
    UPSTREAM_ERROR = "UPSTREAM_ERROR"
    RATE_LIMITED = "RATE_LIMITED"
    BANNED = "BANNED"
    SESSION_UNAVAILABLE = "SESSION_UNAVAILABLE"
    DATA_UNAVAILABLE = "DATA_UNAVAILABLE"
    DATA_DEGRADED = "DATA_DEGRADED"
    SYMBOL_NOT_FOUND = "SYMBOL_NOT_FOUND"
    INVALID_SYMBOL = "INVALID_SYMBOL"
    CIRCUIT_OPEN = "CIRCUIT_OPEN"
    SECURITY_VIOLATION = "SECURITY_VIOLATION"


# Retryable HTTP status codes
RETRYABLE_STATUS_CODES = {408, 429, 500, 502, 503, 504}
NON_RETRYABLE_STATUS_CODES = {400, 401, 403, 404, 422}


def is_retryable_http_status(status_code: int) -> bool:
    """Return True when an HTTP status code warrants a retry."""
    return status_code in RETRYABLE_STATUS_CODES
