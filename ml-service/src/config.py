"""Service-wide configuration loaded from environment variables."""

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()


@dataclass(frozen=True)
class Settings:
    """
    ML service configuration.  All values are read from environment variables
    or the .env file located next to the service root.

    Training data-source hierarchy
    ──────────────────────────────
    1. AlphaForge API  (alphaforge_api_base_url)  — Angel One + Upstox, normalised
    2. PostgreSQL      (database_url)              — stored snapshots
    3. yfinance        (always available as last-resort fallback)
    """

    # ── Server ────────────────────────────────────────────────────────────
    port: int = field(
        default_factory=lambda: int(os.getenv("ML_SERVICE_PORT", "8100"))
    )
    log_level: str = field(
        default_factory=lambda: os.getenv("ML_LOG_LEVEL", "INFO")
    )

    # ── Model artifacts ───────────────────────────────────────────────────
    model_artifacts_path: Path = field(
        default_factory=lambda: Path(
            os.getenv("MODEL_ARTIFACTS_PATH", "./artifacts")
        )
    )

    # ── Feature cache TTL (seconds) ───────────────────────────────────────
    feature_cache_ttl: int = field(
        default_factory=lambda: int(os.getenv("FEATURE_CACHE_TTL", "60"))
    )

    # ── AlphaForge normalized Indian Market Data Layer ────────────────────
    #
    # Primary training data source: the AlphaForge Next.js API layer.
    # Sub-paths served under this base URL:
    #   /historical          — OHLCV candles (Angel One primary / Upstox fallback)
    #   /option-chain/history — daily OC snapshots (PCR, IV, OI walls, max pain)
    #   /market-breadth      — advance/decline, % above SMAs
    #   /vix                 — India VIX daily series
    #
    # Falls back to nextjs_api_base_url when ALPHAFORGE_API_BASE_URL is unset
    # so that existing deployments that set only NEXTJS_API_BASE_URL continue
    # to work without any configuration change.
    alphaforge_api_base_url: str = field(
        default_factory=lambda: os.getenv(
            "ALPHAFORGE_API_BASE_URL",
            os.getenv("NEXTJS_API_BASE_URL", "http://localhost:3000/api/in"),
        )
    )

    # ── PostgreSQL (secondary data source) ───────────────────────────────
    #
    # Direct database connection for offline training runs.  Queries the
    # option_chain_snapshots and price_history tables.
    # Leave unset (or empty) to skip the PostgreSQL tier.
    database_url: str | None = field(
        default_factory=lambda: os.getenv("DATABASE_URL") or None
    )

    # ── Request pacing (Angel One / Upstox rate limits) ───────────────────
    #
    # Seconds to sleep between consecutive symbol requests during batch fetch.
    # Angel One SmartAPI: 3 requests/second sustained — 0.2 s is safe.
    ml_data_request_delay: float = field(
        default_factory=lambda: float(
            os.getenv("ML_DATA_REQUEST_DELAY", "0.2")
        )
    )

    # ── Upstream data (Next.js API — used by the live inference server) ───
    #
    # Kept for backward compatibility with the live server code that calls
    # /api/in/* for real-time feature data.  The training pipeline prefers
    # alphaforge_api_base_url above.
    nextjs_api_base_url: str = field(
        default_factory=lambda: os.getenv(
            "NEXTJS_API_BASE_URL", "http://localhost:3000/api/in"
        )
    )

    # ── Training ──────────────────────────────────────────────────────────
    training_data_path: Path = field(
        default_factory=lambda: Path(
            os.getenv("TRAINING_DATA_PATH", "./data")
        )
    )
    optuna_study_name: str = field(
        default_factory=lambda: os.getenv("OPTUNA_STUDY_NAME", "alphaforge-hpo")
    )


settings = Settings()
