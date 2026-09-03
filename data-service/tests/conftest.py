"""
Shared pytest fixtures for the data-service test suite.

Heavy lifespan dependencies (Chromium, Redis, AntibanLayer, TickPublisher)
are patched *before* the FastAPI app is imported so that TestClient never
tries to spin up real infrastructure.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


# ---------------------------------------------------------------------------
# Redis mock
# ---------------------------------------------------------------------------


@pytest.fixture
def mock_redis() -> AsyncMock:
    """Return a mock aioredis client with the most-used methods stubbed."""
    redis = AsyncMock()
    redis.get = AsyncMock(return_value=None)
    redis.set = AsyncMock(return_value=True)
    redis.publish = AsyncMock(return_value=1)
    redis.ping = AsyncMock(return_value=True)
    redis.close = AsyncMock(return_value=None)
    return redis


# ---------------------------------------------------------------------------
# DynamicSession mock
# ---------------------------------------------------------------------------


@pytest.fixture
def mock_dynamic_session() -> MagicMock:
    """Return a mock AsyncDynamicSession that records fetch calls."""
    session = MagicMock()
    session.__aenter__ = AsyncMock(return_value=session)
    session.__aexit__ = AsyncMock(return_value=None)
    session.fetch = AsyncMock(return_value=MagicMock(json=lambda: {}, text=""))
    return session


# ---------------------------------------------------------------------------
# FetcherSession mock
# ---------------------------------------------------------------------------


@pytest.fixture
def mock_fetcher_session() -> MagicMock:
    """Return a mock FetcherSession that records get/post calls."""
    session = MagicMock()
    session.get = AsyncMock(return_value=MagicMock(text="", status=200))
    session.post = AsyncMock(return_value=MagicMock(text="", status=200))
    return session


# ---------------------------------------------------------------------------
# Settings fixture
# ---------------------------------------------------------------------------


@pytest.fixture
def settings_fixture():
    """Return a Settings instance with test-friendly defaults."""
    from src.config import Settings

    return Settings.__new__(Settings)


# ---------------------------------------------------------------------------
# TestClient fixture (lifespan patched to a no-op)
# ---------------------------------------------------------------------------


@pytest.fixture
def test_client():
    """FastAPI TestClient with lifespan replaced by a no-op.

    This prevents Chromium, Redis, AntibanLayer, and TickPublisher from
    being started during unit tests.  Individual test modules that need
    a specific component wired up should override this fixture or use the
    targeted ``mock_*`` fixtures above.
    """

    @asynccontextmanager
    async def _noop_lifespan(app):  # noqa: ANN001
        # Reset monitoring state so each test starts from a known baseline.
        import src.monitoring.router as _mon

        _mon._service_initialized = False
        _mon._proxy_manager = None
        _mon._session_warmer = None
        yield
        _mon._service_initialized = False

    with patch("src.server.lifespan", _noop_lifespan):
        # Import app *after* patching so the module-level lifespan reference
        # is replaced before FastAPI registers it.
        from fastapi.testclient import TestClient
        from src.server import app

        # Re-attach the patched lifespan so TestClient uses it.
        app.router.lifespan_context = _noop_lifespan

        with TestClient(app, raise_server_exceptions=False) as client:
            yield client
