"""
Feature engineering layer for Indian market data.

Lazy-import design
------------------
The engineer module imports TA-Lib (a C extension) which is optional at test
time. Importing features/__init__.py should NOT force TA-Lib to load. Only
importing from features.engineer (or calling compute_stock_features directly)
should trigger the TA-Lib dependency.

Tests that only need features.derivatives / features.volume /
features.market_structure can import those sub-modules directly without
pulling in TA-Lib.
"""

from __future__ import annotations


def __getattr__(name: str):
    """
    Lazily import heavy symbols only when first accessed.
    This prevents TA-Lib from being imported at package load time.
    """
    _LAZY = {
        "compute_stock_features",
        "compute_regime_features",
        "REGIME_FEATURES",
        "RANKING_FEATURES",
        "STRATEGY_FEATURES",
        "RISK_FEATURES",
    }
    if name in _LAZY:
        from .engineer import (  # noqa: PLC0415
            RANKING_FEATURES,
            REGIME_FEATURES,
            RISK_FEATURES,
            STRATEGY_FEATURES,
            compute_regime_features,
            compute_stock_features,
        )
        _MAP = {
            "compute_stock_features":  compute_stock_features,
            "compute_regime_features": compute_regime_features,
            "REGIME_FEATURES":         REGIME_FEATURES,
            "RANKING_FEATURES":        RANKING_FEATURES,
            "STRATEGY_FEATURES":       STRATEGY_FEATURES,
            "RISK_FEATURES":           RISK_FEATURES,
        }
        return _MAP[name]
    raise AttributeError(f"module 'src.features' has no attribute '{name}'")


__all__ = [
    "compute_stock_features",
    "compute_regime_features",
    "REGIME_FEATURES",
    "RANKING_FEATURES",
    "STRATEGY_FEATURES",
    "RISK_FEATURES",
]
