"""
Probability Calibration for Meta Decision Engine.

Implements Platt scaling (logistic regression over raw scores) and
isotonic regression for each base model. Stores calibration quality
metrics (ECE, MCE, reliability curve) so the meta layer can weight
better-calibrated models more heavily.

Design notes
------------
- Each base model gets its own independent calibrator.
- Calibrators are trained on OOS hold-out predictions (never in-sample).
- If a calibrator has not been trained yet the raw score is returned
  unchanged so the system always produces a valid prediction.
- ``CalibrationStore`` is the single source of truth for all stored
  calibrators and their quality metrics.
"""

from __future__ import annotations

import json
import pickle  # noqa: S403 — used only for internal model serialisation
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

import numpy as np
import structlog

logger = structlog.get_logger()

# ---------------------------------------------------------------------------
# Types
# ---------------------------------------------------------------------------

CalibratorKind = Literal["platt", "isotonic"]

MODEL_NAMES = [
    "regime",
    "ranker",
    "strategy",
    "risk",
    "price_forecaster",
    "iv_classifier",
    "quant_engine",
]


@dataclass
class CalibrationQuality:
    """Stored quality metrics for a single model's calibrator."""

    model_name: str
    calibrator_kind: CalibratorKind
    ece: float = 0.0          # Expected Calibration Error  (lower = better)
    mce: float = 0.0          # Maximum Calibration Error   (lower = better)
    brier_score: float = 1.0  # Brier score                 (lower = better)
    n_samples: int = 0        # Number of OOS samples used
    is_fitted: bool = False

    @property
    def quality_score(self) -> float:
        """
        Composite calibration quality in [0, 1].
        Returns 0.5 (neutral) when the calibrator is not yet fitted so the
        meta layer does not penalise unfitted calibrators too harshly.
        """
        if not self.is_fitted or self.n_samples == 0:
            return 0.5
        # ECE and MCE in [0,1]; Brier in [0,1].
        # A perfectly calibrated model scores 1.0 here.
        return float(np.clip(1.0 - self.ece - 0.5 * self.brier_score, 0.0, 1.0))


# ---------------------------------------------------------------------------
# Individual calibrators
# ---------------------------------------------------------------------------

class PlattCalibrator:
    """
    Platt scaling: fits a logistic sigmoid on top of raw model scores.

    Suitable for models that output monotonic but poorly-scaled scores
    (e.g. SVM margins, tree ensemble leaf scores).
    """

    def __init__(self) -> None:
        self._a: float = 1.0   # scale
        self._b: float = 0.0   # bias
        self._fitted: bool = False

    # ------------------------------------------------------------------
    def fit(self, scores: np.ndarray, labels: np.ndarray) -> "PlattCalibrator":
        """
        Fit Platt parameters via maximum-likelihood logistic regression.

        Parameters
        ----------
        scores : 1-D array of raw model scores (any range)
        labels : 1-D binary array {0, 1}
        """
        from sklearn.linear_model import LogisticRegression

        scores = np.asarray(scores, dtype=float).reshape(-1, 1)
        labels = np.asarray(labels, dtype=float)

        lr = LogisticRegression(C=1e6, solver="lbfgs", max_iter=1000)
        lr.fit(scores, labels)

        self._a = float(lr.coef_[0, 0])
        self._b = float(lr.intercept_[0])
        self._fitted = True
        return self

    # ------------------------------------------------------------------
    def predict_proba(self, scores: np.ndarray) -> np.ndarray:
        """Return calibrated probabilities for *scores*."""
        scores = np.asarray(scores, dtype=float)
        if not self._fitted:
            # pass-through: sigmoid centred at 0
            return 1.0 / (1.0 + np.exp(-scores))
        return 1.0 / (1.0 + np.exp(-(self._a * scores + self._b)))

    # ------------------------------------------------------------------
    @property
    def is_fitted(self) -> bool:
        return self._fitted

    def to_dict(self) -> dict:
        return {"a": self._a, "b": self._b, "fitted": self._fitted}

    @classmethod
    def from_dict(cls, d: dict) -> "PlattCalibrator":
        obj = cls()
        obj._a = d["a"]
        obj._b = d["b"]
        obj._fitted = d["fitted"]
        return obj


class IsotonicCalibrator:
    """
    Isotonic regression calibrator.

    More flexible than Platt scaling but requires more data (≥300 samples
    recommended). Uses sklearn's IsotonicRegression with out-of-bounds
    extrapolation clipped to [0, 1].

    Serialisation note
    ------------------
    sklearn's IsotonicRegression stores several private attributes beyond
    X_thresholds_ / y_thresholds_ that its predict() path requires (e.g.
    X_min_, X_max_, f_). Rather than reconstructing all of them by hand,
    we persist the fitted model via pickle (base64-encoded) inside the
    JSON payload so the round-trip is always exact.
    """

    def __init__(self) -> None:
        self._model = None
        self._fitted: bool = False

    # ------------------------------------------------------------------
    def fit(self, scores: np.ndarray, labels: np.ndarray) -> "IsotonicCalibrator":
        from sklearn.isotonic import IsotonicRegression

        scores = np.asarray(scores, dtype=float)
        labels = np.asarray(labels, dtype=float)

        self._model = IsotonicRegression(out_of_bounds="clip", y_min=0.0, y_max=1.0)
        self._model.fit(scores, labels)
        self._fitted = True
        return self

    # ------------------------------------------------------------------
    def predict_proba(self, scores: np.ndarray) -> np.ndarray:
        scores = np.asarray(scores, dtype=float)
        if not self._fitted or self._model is None:
            return np.clip(scores, 0.0, 1.0)
        return np.clip(self._model.predict(scores), 0.0, 1.0)

    # ------------------------------------------------------------------
    @property
    def is_fitted(self) -> bool:
        return self._fitted

    def to_dict(self) -> dict:
        """
        Serialise to a JSON-compatible dict.

        The fitted sklearn model is pickled and base64-encoded so that
        all internal attributes (X_min_, X_max_, f_, etc.) survive the
        round-trip without manual reconstruction.
        """
        import base64

        if self._model is None:
            return {"fitted": False, "model_b64": None}

        model_bytes = pickle.dumps(self._model, protocol=4)
        return {
            "fitted": self._fitted,
            "model_b64": base64.b64encode(model_bytes).decode("ascii"),
        }

    @classmethod
    def from_dict(cls, d: dict) -> "IsotonicCalibrator":
        import base64

        obj = cls()
        if d.get("fitted") and d.get("model_b64"):
            model_bytes = base64.b64decode(d["model_b64"].encode("ascii"))
            obj._model = pickle.loads(model_bytes)  # noqa: S301 — internal use only
            obj._fitted = True
        return obj


# ---------------------------------------------------------------------------
# Calibration quality measurement helpers
# ---------------------------------------------------------------------------

def _expected_calibration_error(
    probs: np.ndarray,
    labels: np.ndarray,
    n_bins: int = 10,
) -> tuple[float, float]:
    """
    Compute ECE and MCE.

    Returns
    -------
    ece : float — weighted average miscalibration across bins
    mce : float — worst-bin miscalibration
    """
    probs = np.clip(probs, 1e-9, 1 - 1e-9)
    bin_edges = np.linspace(0.0, 1.0, n_bins + 1)
    ece_acc = 0.0
    mce = 0.0
    n = len(probs)

    for lo, hi in zip(bin_edges[:-1], bin_edges[1:]):
        mask = (probs >= lo) & (probs < hi)
        if mask.sum() == 0:
            continue
        bin_conf = probs[mask].mean()
        bin_acc = labels[mask].mean()
        bin_n = mask.sum()
        gap = abs(bin_conf - bin_acc)
        ece_acc += (bin_n / n) * gap
        mce = max(mce, gap)

    return float(ece_acc), float(mce)


def _brier_score(probs: np.ndarray, labels: np.ndarray) -> float:
    return float(np.mean((probs - labels) ** 2))


# ---------------------------------------------------------------------------
# CalibrationStore — central registry
# ---------------------------------------------------------------------------

@dataclass
class _ModelCalibrators:
    """Pair of calibrators for a single model."""

    platt: PlattCalibrator = field(default_factory=PlattCalibrator)
    isotonic: IsotonicCalibrator = field(default_factory=IsotonicCalibrator)
    quality_platt: CalibrationQuality = field(default=None)  # type: ignore[assignment]
    quality_isotonic: CalibrationQuality = field(default=None)  # type: ignore[assignment]
    active_kind: CalibratorKind = "platt"

    def __post_init__(self) -> None:
        # Default quality objects so attribute access is always safe
        if self.quality_platt is None:
            self.quality_platt = CalibrationQuality("", "platt")
        if self.quality_isotonic is None:
            self.quality_isotonic = CalibrationQuality("", "isotonic")


class CalibrationStore:
    """
    Central store for all model calibrators.

    Usage
    -----
    ::

        store = CalibrationStore()

        # Training (call once per model after collecting OOS predictions)
        store.fit("regime", scores=oos_scores, labels=oos_labels)

        # Inference
        calibrated_prob = store.calibrate("regime", raw_score=0.73)

        # Persist / reload
        store.save(Path("artifacts/calibration"))
        store.load(Path("artifacts/calibration"))
    """

    def __init__(self) -> None:
        self._store: dict[str, _ModelCalibrators] = {
            name: _ModelCalibrators() for name in MODEL_NAMES
        }

    # ------------------------------------------------------------------
    # Training
    # ------------------------------------------------------------------

    def fit(
        self,
        model_name: str,
        scores: np.ndarray,
        labels: np.ndarray,
        kind: CalibratorKind = "platt",
    ) -> CalibrationQuality:
        """
        Fit a calibrator for *model_name* using OOS predictions.

        **Never call this with in-sample predictions** — stacking leakage
        will make the calibrator over-confident.

        Parameters
        ----------
        model_name : one of MODEL_NAMES
        scores     : raw model scores (floats, any range)
        labels     : ground-truth binary labels {0, 1}
        kind       : "platt" | "isotonic"

        Returns
        -------
        CalibrationQuality with ECE / MCE / Brier score
        """
        scores = np.asarray(scores, dtype=float)
        labels = np.asarray(labels, dtype=float)

        if model_name not in self._store:
            self._store[model_name] = _ModelCalibrators()

        entry = self._store[model_name]

        if kind == "platt":
            entry.platt.fit(scores, labels)
            cal_probs = entry.platt.predict_proba(scores)
            ece, mce = _expected_calibration_error(cal_probs, labels)
            brier = _brier_score(cal_probs, labels)
            quality = CalibrationQuality(
                model_name=model_name,
                calibrator_kind="platt",
                ece=ece,
                mce=mce,
                brier_score=brier,
                n_samples=len(scores),
                is_fitted=True,
            )
            entry.quality_platt = quality

        else:  # isotonic
            entry.isotonic.fit(scores, labels)
            cal_probs = entry.isotonic.predict_proba(scores)
            ece, mce = _expected_calibration_error(cal_probs, labels)
            brier = _brier_score(cal_probs, labels)
            quality = CalibrationQuality(
                model_name=model_name,
                calibrator_kind="isotonic",
                ece=ece,
                mce=mce,
                brier_score=brier,
                n_samples=len(scores),
                is_fitted=True,
            )
            entry.quality_isotonic = quality

        # Prefer whichever calibrator has lower ECE (only switch when both fitted)
        if entry.quality_platt.is_fitted and entry.quality_isotonic.is_fitted:
            entry.active_kind = (
                "isotonic"
                if entry.quality_isotonic.ece < entry.quality_platt.ece
                else "platt"
            )
        else:
            entry.active_kind = kind

        logger.info(
            "calibrator_fitted",
            model=model_name,
            kind=kind,
            ece=round(quality.ece, 4),
            brier=round(quality.brier_score, 4),
            n=len(scores),
        )
        return quality

    def fit_both(
        self,
        model_name: str,
        scores: np.ndarray,
        labels: np.ndarray,
    ) -> tuple[CalibrationQuality, CalibrationQuality]:
        """Fit both calibrator types and return (platt_quality, isotonic_quality)."""
        q_platt = self.fit(model_name, scores, labels, kind="platt")
        q_iso = self.fit(model_name, scores, labels, kind="isotonic")
        return q_platt, q_iso

    # ------------------------------------------------------------------
    # Inference
    # ------------------------------------------------------------------

    def calibrate(
        self,
        model_name: str,
        raw_score: float,
        kind: CalibratorKind | None = None,
    ) -> float:
        """
        Return calibrated probability for a single raw score.

        Falls back to raw score (clipped to [0,1]) if the calibrator is
        not yet fitted.
        """
        if model_name not in self._store:
            return float(np.clip(raw_score, 0.0, 1.0))

        entry = self._store[model_name]
        effective_kind = kind or entry.active_kind

        arr = np.array([raw_score])
        if effective_kind == "platt":
            return float(entry.platt.predict_proba(arr)[0])
        else:
            return float(entry.isotonic.predict_proba(arr)[0])

    def calibrate_batch(
        self,
        model_name: str,
        raw_scores: np.ndarray,
        kind: CalibratorKind | None = None,
    ) -> np.ndarray:
        """Batch version of :meth:`calibrate`."""
        if model_name not in self._store:
            return np.clip(raw_scores, 0.0, 1.0)

        entry = self._store[model_name]
        effective_kind = kind or entry.active_kind

        if effective_kind == "platt":
            return entry.platt.predict_proba(raw_scores)
        else:
            return entry.isotonic.predict_proba(raw_scores)

    # ------------------------------------------------------------------
    # Quality reporting
    # ------------------------------------------------------------------

    def get_quality(
        self,
        model_name: str,
        kind: CalibratorKind | None = None,
    ) -> CalibrationQuality:
        """Return stored quality metrics for *model_name*."""
        if model_name not in self._store:
            return CalibrationQuality(model_name, "platt")

        entry = self._store[model_name]
        effective_kind = kind or entry.active_kind

        return (
            entry.quality_platt if effective_kind == "platt"
            else entry.quality_isotonic
        )

    def all_quality_scores(self) -> dict[str, float]:
        """
        Return {model_name: quality_score} for every model.
        Quality score ∈ [0, 1], higher = better calibrated.
        """
        return {
            name: self._store[name].quality_platt.quality_score
            if self._store[name].active_kind == "platt"
            else self._store[name].quality_isotonic.quality_score
            for name in self._store
        }

    # ------------------------------------------------------------------
    # Persistence
    # ------------------------------------------------------------------

    def save(self, directory: Path) -> None:
        """Persist all calibrators and quality metrics to *directory*."""
        directory = Path(directory)
        directory.mkdir(parents=True, exist_ok=True)

        payload: dict = {}
        for name, entry in self._store.items():
            payload[name] = {
                "active_kind": entry.active_kind,
                "platt": entry.platt.to_dict(),
                "isotonic": entry.isotonic.to_dict(),
                "quality_platt": {
                    "ece": entry.quality_platt.ece,
                    "mce": entry.quality_platt.mce,
                    "brier_score": entry.quality_platt.brier_score,
                    "n_samples": entry.quality_platt.n_samples,
                    "is_fitted": entry.quality_platt.is_fitted,
                },
                "quality_isotonic": {
                    "ece": entry.quality_isotonic.ece,
                    "mce": entry.quality_isotonic.mce,
                    "brier_score": entry.quality_isotonic.brier_score,
                    "n_samples": entry.quality_isotonic.n_samples,
                    "is_fitted": entry.quality_isotonic.is_fitted,
                },
            }

        out_path = directory / "calibration_store.json"
        with out_path.open("w") as fh:
            json.dump(payload, fh, indent=2)

        logger.info("calibration_store_saved", path=str(out_path))

    def load(self, directory: Path) -> None:
        """Reload calibrators from a previously saved directory."""
        directory = Path(directory)
        store_path = directory / "calibration_store.json"

        if not store_path.exists():
            logger.warning("calibration_store_not_found", path=str(store_path))
            return

        with store_path.open() as fh:
            payload = json.load(fh)

        for name, data in payload.items():
            entry = _ModelCalibrators()
            entry.active_kind = data["active_kind"]
            entry.platt = PlattCalibrator.from_dict(data["platt"])
            entry.isotonic = IsotonicCalibrator.from_dict(data["isotonic"])

            qp = data["quality_platt"]
            entry.quality_platt = CalibrationQuality(
                model_name=name, calibrator_kind="platt",
                ece=qp["ece"], mce=qp["mce"],
                brier_score=qp["brier_score"], n_samples=qp["n_samples"],
                is_fitted=qp["is_fitted"],
            )
            qi = data["quality_isotonic"]
            entry.quality_isotonic = CalibrationQuality(
                model_name=name, calibrator_kind="isotonic",
                ece=qi["ece"], mce=qi["mce"],
                brier_score=qi["brier_score"], n_samples=qi["n_samples"],
                is_fitted=qi["is_fitted"],
            )
            self._store[name] = entry

        logger.info("calibration_store_loaded", path=str(store_path))
