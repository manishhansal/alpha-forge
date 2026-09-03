"""
Publisher router — REST endpoints for the TickPublisher background task.

Endpoints
---------
GET  /publisher/status   — snapshot of running state, symbols, and counters
POST /publisher/symbols  — add/remove symbols from the broadcast set

Requirements: 5.4, 5.5, 5.8
"""

from __future__ import annotations

from typing import Any

import structlog
from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, field_validator

logger = structlog.get_logger(__name__)

publisher_router = APIRouter(tags=["publisher"])

# ---------------------------------------------------------------------------
# Request model
# ---------------------------------------------------------------------------

_MAX_SYMBOL_LEN = 50
_MAX_ARRAY_LEN = 100


class SymbolUpdateRequest(BaseModel):
    add: list[str] = Field(default_factory=list)
    remove: list[str] = Field(default_factory=list)

    @field_validator("add", "remove")
    @classmethod
    def validate_array_length(cls, v: list[str]) -> list[str]:
        if len(v) > _MAX_ARRAY_LEN:
            raise ValueError(
                f"array must not exceed {_MAX_ARRAY_LEN} entries; got {len(v)}"
            )
        return v

    @field_validator("add", "remove")
    @classmethod
    def validate_symbol_lengths(cls, v: list[str]) -> list[str]:
        for sym in v:
            if len(sym) > _MAX_SYMBOL_LEN:
                raise ValueError(
                    f"symbol '{sym}' exceeds maximum length of {_MAX_SYMBOL_LEN} characters"
                )
        return v


# ---------------------------------------------------------------------------
# GET /publisher/status
# ---------------------------------------------------------------------------


@publisher_router.get("/publisher/status", response_class=JSONResponse)
async def get_publisher_status() -> JSONResponse:
    """Return a snapshot of the TickPublisher state.

    Always responds within 2 seconds — reads in-memory state only, no I/O.

    Response shape::

        {
            "running": true | false | "reconnecting",
            "symbols": ["NIFTY", "BANKNIFTY", ...],   // capped at 500 entries
            "publish_count": 1250,
            "last_publish_ms": 1700000000000 | null
        }
    """
    from src.publisher.tick_publisher import tick_publisher  # local import avoids circular refs

    return JSONResponse(content=tick_publisher.status, status_code=200)


# ---------------------------------------------------------------------------
# POST /publisher/symbols
# ---------------------------------------------------------------------------


@publisher_router.post("/publisher/symbols", response_class=JSONResponse)
async def update_publisher_symbols(body: SymbolUpdateRequest) -> JSONResponse:
    """Atomically add and/or remove symbols from the TickPublisher broadcast set.

    Validation rules (HTTP 400 on violation — symbol list left unchanged):
    - Each symbol string: max 50 characters
    - Each array (`add` / `remove`): max 100 entries

    Success response::

        {
            "symbols": [...],
            "count": N,
            "added": N,
            "removed": N
        }
    """
    from src.publisher.tick_publisher import tick_publisher  # local import avoids circular refs

    # Capture counts before mutation
    symbols_before: set[str] = set(tick_publisher.status["symbols"])

    # Apply changes synchronously — safe inside the asyncio event loop since
    # the sync variants only mutate the in-memory list (no I/O).
    tick_publisher.add_symbols_sync(body.add)
    tick_publisher.remove_symbols_sync(body.remove)

    # Capture counts after mutation
    symbols_after: list[str] = tick_publisher.status["symbols"]
    symbols_after_set: set[str] = set(symbols_after)

    added = len(symbols_after_set - symbols_before)
    removed = len(symbols_before - symbols_after_set)

    response_body: dict[str, Any] = {
        "symbols": symbols_after,
        "count": len(symbols_after),
        "added": added,
        "removed": removed,
    }

    logger.info(
        "publisher_symbols_updated",
        added=added,
        removed=removed,
        total=len(symbols_after),
    )

    return JSONResponse(content=response_body, status_code=200)
