"""
Phase 3K — PIT-safe normalization (spec §13, §14).

CRITICAL leakage surface. All scaling statistics are fit ONLY on historical
training data and then APPLIED (never re-fit) to validation and OOS. There is
NO `fit_transform` on the full dataset before temporal splitting.

Two families:
  1. Feature scalers (fit on train window, transform val/OOS):
     - StandardScaler (mean/std)
     - RobustScaler (median/IQR)
  2. Cross-sectional transforms (computed per-timestamp using ONLY the values
     available at that timestamp — inherently PIT-safe, no fitted state):
     - date-wise z-score
     - rank transform
     - sector-neutral transform

Every scaler carries a `scaler_version` hash recording exactly how it was fit
(method + fit window + feature order) so it can be persisted and audited
(spec §13 k8norm, §60).

Determinism: no np.random.*.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, field
from enum import Enum
from typing import Optional

import numpy as np


class ScalerMethod(str, Enum):
    STANDARD = "STANDARD"     # (x - mean) / std
    ROBUST   = "ROBUST"       # (x - median) / IQR
    NONE     = "NONE"         # identity (documented, not silent)


class NormalizationError(Exception):
    """Raised on PIT-unsafe or misconfigured normalization use."""


@dataclass
class FittedScaler:
    """
    A scaler fit on a specific training window. Immutable once fit.

    center/scale are per-feature vectors. transform() applies them; it NEVER
    re-fits. Applying to val/OOS uses the SAME train statistics (spec §13).
    """
    method:          str                    # ScalerMethod value
    center:          list[float]
    scale:           list[float]
    feature_names:   list[str]
    fit_start:       str = ""               # ISO timestamp of first train bar
    fit_end:         str = ""               # ISO timestamp of last train bar
    fit_sample_count: int = 0
    version_tag:     str = "scaler-v1"

    @property
    def scaler_version(self) -> str:
        key = {
            "method":        self.method,
            "feature_names": self.feature_names,
            "fit_start":     self.fit_start,
            "fit_end":       self.fit_end,
            "fit_sample_count": self.fit_sample_count,
            # center/scale rounded so tiny float noise doesn't churn the hash
            "center": [round(float(c), 10) for c in self.center],
            "scale":  [round(float(s), 10) for s in self.scale],
            "version_tag": self.version_tag,
        }
        raw = json.dumps(key, sort_keys=True)
        return f"{self.version_tag}-{hashlib.sha256(raw.encode()).hexdigest()[:12]}"

    def transform(self, X: np.ndarray) -> np.ndarray:
        """Apply the fitted statistics. Does NOT fit. PIT-safe for val/OOS."""
        X = np.asarray(X, dtype=float)
        if X.shape[-1] != len(self.center):
            raise NormalizationError(
                f"transform got {X.shape[-1]} features, scaler fit on {len(self.center)}"
            )
        center = np.asarray(self.center, dtype=float)
        scale = np.asarray(self.scale, dtype=float)
        return (X - center) / scale

    def to_dict(self) -> dict:
        d = asdict(self)
        d["scaler_version"] = self.scaler_version
        return d

    @classmethod
    def from_dict(cls, d: dict) -> "FittedScaler":
        known = {f for f in cls.__dataclass_fields__}  # type: ignore[attr-defined]
        return cls(**{k: v for k, v in d.items() if k in known})


def fit_scaler(
    X_train: np.ndarray,
    feature_names: list[str],
    method: ScalerMethod = ScalerMethod.STANDARD,
    fit_start: str = "",
    fit_end: str = "",
) -> FittedScaler:
    """
    Fit a scaler on TRAINING data only (spec §13).

    Args:
        X_train: (n_train, n_features) — training window only.
        feature_names: canonical feature order.
        method: STANDARD (mean/std) or ROBUST (median/IQR).

    Returns:
        FittedScaler with per-feature center/scale, ready to .transform() val/OOS.

    NaN-safe: statistics computed with nan-aware reducers; zero scale replaced
    with 1.0 (a constant feature contributes nothing, never divides by zero).
    """
    X = np.asarray(X_train, dtype=float)
    if X.ndim != 2:
        raise NormalizationError(f"X_train must be 2-D, got {X.shape}")
    n, n_feat = X.shape
    if len(feature_names) != n_feat:
        raise NormalizationError(
            f"feature_names length {len(feature_names)} != n_features {n_feat}"
        )

    if method == ScalerMethod.STANDARD:
        center = np.nanmean(X, axis=0)
        scale = np.nanstd(X, axis=0)
    elif method == ScalerMethod.ROBUST:
        center = np.nanmedian(X, axis=0)
        q75 = np.nanpercentile(X, 75, axis=0)
        q25 = np.nanpercentile(X, 25, axis=0)
        scale = q75 - q25
    else:  # NONE — identity
        center = np.zeros(n_feat)
        scale = np.ones(n_feat)

    center = np.nan_to_num(center, nan=0.0)
    scale = np.nan_to_num(scale, nan=1.0)
    scale[scale == 0.0] = 1.0

    return FittedScaler(
        method=method.value,
        center=[float(c) for c in center],
        scale=[float(s) for s in scale],
        feature_names=list(feature_names),
        fit_start=fit_start,
        fit_end=fit_end,
        fit_sample_count=int(n),
    )


# ══════════════════════════════════════════════════════════════════════════════
# Cross-sectional transforms (spec §14) — inherently PIT-safe (per-timestamp)
# ══════════════════════════════════════════════════════════════════════════════

class CrossSectionalMethod(str, Enum):
    ZSCORE       = "ZSCORE"          # date-wise z-score
    RANK         = "RANK"            # date-wise percentile rank in [0,1]
    SECTOR_Z     = "SECTOR_Z"        # z-score within (date, sector)


def cross_sectional_zscore(values: np.ndarray) -> np.ndarray:
    """
    Z-score a single cross-section (one timestamp). Uses ONLY the values present
    at that timestamp — no lookahead. NaN-safe.
    """
    v = np.asarray(values, dtype=float)
    mu = np.nanmean(v)
    sd = np.nanstd(v)
    if not np.isfinite(sd) or sd == 0.0:
        return np.zeros_like(v)
    return (v - mu) / sd


def cross_sectional_rank(values: np.ndarray) -> np.ndarray:
    """
    Percentile rank of a single cross-section in [0,1]. NaN stays NaN.
    Ties get average rank. PIT-safe (per-timestamp only).
    """
    v = np.asarray(values, dtype=float)
    out = np.full_like(v, np.nan, dtype=float)
    finite = np.isfinite(v)
    n = int(finite.sum())
    if n == 0:
        return out
    vals = v[finite]
    order = np.argsort(vals, kind="mergesort")
    ranks = np.empty(n, dtype=float)
    # average-rank for ties
    sorted_vals = vals[order]
    i = 0
    while i < n:
        j = i
        while j + 1 < n and sorted_vals[j + 1] == sorted_vals[i]:
            j += 1
        avg = (i + j) / 2.0
        ranks[order[i:j + 1]] = avg
        i = j + 1
    out[finite] = ranks / (n - 1) if n > 1 else 0.5
    return out


def cross_sectional_sector_neutral(values: np.ndarray, sectors: np.ndarray) -> np.ndarray:
    """
    Z-score within each sector group at a single timestamp. PIT-safe.
    """
    v = np.asarray(values, dtype=float)
    s = np.asarray(sectors)
    out = np.full_like(v, np.nan, dtype=float)
    for sec in np.unique(s):
        idx = (s == sec)
        out[idx] = cross_sectional_zscore(v[idx])
    return out


@dataclass
class CrossSectionalNormalizer:
    """
    Stateless per-timestamp normalizer (spec §14). Carries NO fitted state, so
    it is inherently PIT-safe — it can only ever see one cross-section at a time.
    """
    method: CrossSectionalMethod = CrossSectionalMethod.ZSCORE
    version_tag: str = "cs-norm-v1"

    def apply(self, values: np.ndarray, sectors: Optional[np.ndarray] = None) -> np.ndarray:
        if self.method == CrossSectionalMethod.ZSCORE:
            return cross_sectional_zscore(values)
        if self.method == CrossSectionalMethod.RANK:
            return cross_sectional_rank(values)
        if self.method == CrossSectionalMethod.SECTOR_Z:
            if sectors is None:
                raise NormalizationError("SECTOR_Z requires sectors array")
            return cross_sectional_sector_neutral(values, sectors)
        raise NormalizationError(f"Unknown cross-sectional method: {self.method}")

    @property
    def version(self) -> str:
        return f"{self.version_tag}-{self.method.value}"
