"""Service-wide configuration loaded from environment variables."""

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()


@dataclass(frozen=True)
class Settings:
    """ML service configuration. Values are read from env vars / .env file."""

    # Server
    port: int = field(default_factory=lambda: int(os.getenv("ML_SERVICE_PORT", "8100")))
    log_level: str = field(default_factory=lambda: os.getenv("ML_LOG_LEVEL", "INFO"))

    # Model artifacts
    model_artifacts_path: Path = field(
        default_factory=lambda: Path(os.getenv("MODEL_ARTIFACTS_PATH", "./artifacts"))
    )

    # Feature cache TTL (seconds)
    feature_cache_ttl: int = field(
        default_factory=lambda: int(os.getenv("FEATURE_CACHE_TTL", "60"))
    )

    # Upstream data (Next.js API)
    nextjs_api_base_url: str = field(
        default_factory=lambda: os.getenv("NEXTJS_API_BASE_URL", "http://localhost:3000/api/in")
    )

    # Training
    training_data_path: Path = field(
        default_factory=lambda: Path(os.getenv("TRAINING_DATA_PATH", "./data"))
    )
    optuna_study_name: str = field(
        default_factory=lambda: os.getenv("OPTUNA_STUDY_NAME", "alphaforge-hpo")
    )


settings = Settings()


settings = Settings()
