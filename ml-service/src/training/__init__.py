"""
Training pipelines and data preparation utilities.

Lazy-import design
------------------
data_pipeline.py imports features.engineer which requires TA-Lib.
We defer those imports so that importing src.training does not force
TA-Lib to load — only calling the functions does.

Tests that only need _build_temporal_splits or _hpo_temporal from
train_all.py can import train_all directly without triggering the
data_pipeline → engineer → talib chain.
"""

from __future__ import annotations


def __getattr__(name: str):
    """Lazily import heavy symbols on first access."""
    if name in ("run_pipeline", "check_structural_leakage", "assert_no_future_leakage"):
        from .data_pipeline import (  # noqa: PLC0415
            assert_no_future_leakage,
            check_structural_leakage,
            run_pipeline,
        )
        _MAP = {
            "run_pipeline":              run_pipeline,
            "check_structural_leakage":  check_structural_leakage,
            "assert_no_future_leakage":  assert_no_future_leakage,
        }
        return _MAP[name]

    if name == "train_all":
        from .train_all import train_all  # noqa: PLC0415
        return train_all

    raise AttributeError(f"module 'src.training' has no attribute '{name}'")


__all__ = [
    "run_pipeline",
    "train_all",
    "check_structural_leakage",
    "assert_no_future_leakage",
]
