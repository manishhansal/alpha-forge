"""
Phase 3K — Incremental alpha, residual modeling, ensembling, disagreement.

Answers the CENTRAL research question (spec §30):
    Does the deep model contain information NOT already captured by the
    classical champion?

Provides:
  - incremental_alpha_report: incremental IC (deep on top of classical),
    prediction/error correlation (spec §30, §56)
  - fit_residual_target / ResidualModel: model the champion's residual errors
    (spec §31)
  - EnsembleWeighter: fit ensemble weights on TRAIN/VAL only (spec §32, §33)
  - disagreement_report: rank/prediction disagreement feeding Phase 3F
    abstention (spec §34)

All metrics use the existing Phase 3E IC functions. Determinism: no np.random.*.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

import numpy as np

from src.ranking.evaluation import compute_rank_ic, compute_ic


def _safe_corr(a: np.ndarray, b: np.ndarray) -> Optional[float]:
    a = np.asarray(a, dtype=float)
    b = np.asarray(b, dtype=float)
    m = np.isfinite(a) & np.isfinite(b)
    if m.sum() < 3:
        return None
    if np.std(a[m]) == 0 or np.std(b[m]) == 0:
        return None
    return float(np.corrcoef(a[m], b[m])[0, 1])


# ══════════════════════════════════════════════════════════════════════════════
# Incremental alpha (spec §30, §56)
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class IncrementalAlphaReport:
    champion_rank_ic:    Optional[float]
    challenger_rank_ic:  Optional[float]
    incremental_rank_ic: Optional[float]     # residual-of-challenger vs realized
    prediction_correlation: Optional[float]   # champion vs challenger predictions
    error_correlation:   Optional[float]      # champion vs challenger errors
    abs_error_correlation: Optional[float]
    tail_error_overlap:  Optional[float]      # fraction of shared worst-decile errors
    near_identical:      bool                  # predictions correlate > threshold
    verdict_note:        str = ""

    def to_dict(self) -> dict:
        d = self.__dict__.copy()
        return d


def incremental_alpha_report(
    champion_pred: np.ndarray,
    challenger_pred: np.ndarray,
    realized: np.ndarray,
    near_identical_threshold: float = 0.99,
) -> IncrementalAlphaReport:
    """
    Measure whether the challenger adds information beyond the champion.

    incremental_rank_ic: regress challenger onto champion (train-free, orthogonal
    projection on THIS OOS block for measurement only), take the residual, and
    compute its rank IC vs realized. A positive incremental IC means the
    challenger's UNIQUE component still predicts returns.

    NOTE: this projection is a *measurement* on the evaluation block; it is not a
    fitted model that later scores unseen data, so it does not constitute OOS
    hyperparameter selection.
    """
    cp = np.asarray(champion_pred, dtype=float)
    hp = np.asarray(challenger_pred, dtype=float)
    rz = np.asarray(realized, dtype=float)

    champ_ic = compute_rank_ic(cp, rz)
    chal_ic = compute_rank_ic(hp, rz)

    # residual of challenger after removing the champion's linear component
    m = np.isfinite(cp) & np.isfinite(hp) & np.isfinite(rz)
    incr_ic = None
    if m.sum() >= 5 and np.std(cp[m]) > 0:
        beta = np.cov(hp[m], cp[m])[0, 1] / np.var(cp[m])
        resid = hp[m] - beta * cp[m]
        incr_ic = compute_rank_ic(resid, rz[m])

    pred_corr = _safe_corr(cp, hp)
    err_c = cp - rz
    err_h = hp - rz
    err_corr = _safe_corr(err_c, err_h)
    abs_err_corr = _safe_corr(np.abs(err_c), np.abs(err_h))

    # tail-error overlap: fraction of shared worst-decile absolute errors
    tail_overlap = None
    if m.sum() >= 10:
        ac, ah = np.abs(err_c[m]), np.abs(err_h[m])
        k = max(1, int(0.1 * m.sum()))
        worst_c = set(np.argsort(-ac)[:k].tolist())
        worst_h = set(np.argsort(-ah)[:k].tolist())
        tail_overlap = len(worst_c & worst_h) / k

    near = bool(pred_corr is not None and pred_corr > near_identical_threshold)
    note = ""
    if near:
        note = "Predictions near-identical to champion — likely REDUNDANT."
    elif pred_corr is not None and pred_corr < 0.5 and (incr_ic is not None and incr_ic > 0):
        note = "Low correlation + positive incremental IC — potential COMPLEMENTARY diversifier."

    return IncrementalAlphaReport(
        champion_rank_ic=champ_ic,
        challenger_rank_ic=chal_ic,
        incremental_rank_ic=incr_ic,
        prediction_correlation=pred_corr,
        error_correlation=err_corr,
        abs_error_correlation=abs_err_corr,
        tail_error_overlap=tail_overlap,
        near_identical=near,
        verdict_note=note,
    )


# ══════════════════════════════════════════════════════════════════════════════
# Residual modeling (spec §31)
# ══════════════════════════════════════════════════════════════════════════════

def compute_residual_target(champion_pred: np.ndarray, realized: np.ndarray) -> np.ndarray:
    """
    Residual = realized - champion_prediction. A deep model can be trained to
    predict this residual (spec §31). Training/eval discipline is the caller's
    responsibility (fit on train residuals, evaluate on OOS residuals).
    """
    return np.asarray(realized, dtype=float) - np.asarray(champion_pred, dtype=float)


@dataclass
class ResidualModelReport:
    residual_rank_ic:  Optional[float]     # deep residual-pred vs true residual (OOS)
    combined_rank_ic:  Optional[float]     # (champion + residual_pred) vs realized
    champion_rank_ic:  Optional[float]
    improves_over_champion: bool

    def to_dict(self) -> dict:
        return self.__dict__.copy()


def evaluate_residual_model(
    champion_pred_oos: np.ndarray,
    residual_pred_oos: np.ndarray,
    realized_oos: np.ndarray,
) -> ResidualModelReport:
    """Evaluate a residual model's OOS contribution on top of the champion."""
    cp = np.asarray(champion_pred_oos, dtype=float)
    rp = np.asarray(residual_pred_oos, dtype=float)
    rz = np.asarray(realized_oos, dtype=float)
    true_resid = rz - cp
    resid_ic = compute_rank_ic(rp, true_resid)
    champ_ic = compute_rank_ic(cp, rz)
    combined_ic = compute_rank_ic(cp + rp, rz)
    improves = bool(
        combined_ic is not None and champ_ic is not None and combined_ic > champ_ic
    )
    return ResidualModelReport(
        residual_rank_ic=resid_ic,
        combined_rank_ic=combined_ic,
        champion_rank_ic=champ_ic,
        improves_over_champion=improves,
    )


# ══════════════════════════════════════════════════════════════════════════════
# Ensemble (spec §32, §33) — weights fit on TRAIN/VAL only
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class EnsembleWeights:
    names:   list[str]
    weights: list[float]
    fit_on:  str = "TRAIN_VAL"           # NEVER "OOS"

    def to_dict(self) -> dict:
        return {"names": self.names, "weights": self.weights, "fit_on": self.fit_on}


class EnsembleWeighter:
    """
    Fit non-negative ensemble weights to MAXIMISE rank IC on VALIDATION data
    (spec §33 — never OOS). Uses a deterministic simplex grid search over
    normalized weights (small model count → exhaustive & reproducible).
    """

    def __init__(self, grid_steps: int = 5):
        self.grid_steps = grid_steps

    def fit(self, val_preds: dict[str, np.ndarray], val_realized: np.ndarray) -> EnsembleWeights:
        names = list(val_preds.keys())
        P = np.column_stack([np.asarray(val_preds[n], dtype=float) for n in names])
        rz = np.asarray(val_realized, dtype=float)
        best_w = np.ones(len(names)) / len(names)
        best_ic = -np.inf
        for w in _simplex_grid(len(names), self.grid_steps):
            combined = P @ w
            ic = compute_rank_ic(combined, rz)
            if ic is not None and ic > best_ic:
                best_ic, best_w = ic, w
        return EnsembleWeights(names=names, weights=[float(x) for x in best_w], fit_on="TRAIN_VAL")

    @staticmethod
    def combine(preds: dict[str, np.ndarray], weights: EnsembleWeights) -> np.ndarray:
        P = np.column_stack([np.asarray(preds[n], dtype=float) for n in weights.names])
        w = np.asarray(weights.weights, dtype=float)
        return P @ w


def _simplex_grid(k: int, steps: int):
    """
    Deterministic weight vectors on the k-simplex (weights >= 0, sum == 1) using
    integer counts out of `steps`. Enumerates all compositions of `steps` into
    k non-negative parts, divided by `steps`.
    """
    def _compositions(total: int, parts: int):
        if parts == 1:
            yield [total]
            return
        for first in range(total + 1):
            for rest in _compositions(total - first, parts - 1):
                yield [first] + rest

    for comp in _compositions(steps, k):
        yield np.array(comp, dtype=float) / steps


# ══════════════════════════════════════════════════════════════════════════════
# Disagreement / abstention (spec §34)
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class DisagreementReport:
    rank_disagreement:       Optional[float]   # 1 - Spearman(rank_a, rank_b)
    prediction_disagreement: Optional[float]   # normalized L2 of standardized preds
    high_disagreement:       bool
    recommend_abstain:       bool
    threshold:               float

    def to_dict(self) -> dict:
        return self.__dict__.copy()


def disagreement_report(
    pred_a: np.ndarray,
    pred_b: np.ndarray,
    disagreement_threshold: float = 0.5,
) -> DisagreementReport:
    """
    Measure model disagreement. High disagreement suggests the Phase 3F
    abstention system should ABSTAIN rather than force an action (spec §34).
    """
    a = np.asarray(pred_a, dtype=float)
    b = np.asarray(pred_b, dtype=float)
    corr = _safe_corr(a, b)
    rank_disagreement = None if corr is None else float(1.0 - corr)

    m = np.isfinite(a) & np.isfinite(b)
    pred_dis = None
    if m.sum() >= 3:
        za = (a[m] - a[m].mean()) / (a[m].std() + 1e-12)
        zb = (b[m] - b[m].mean()) / (b[m].std() + 1e-12)
        pred_dis = float(np.sqrt(np.mean((za - zb) ** 2)) / np.sqrt(2.0))  # in [0,~1]

    high = bool(rank_disagreement is not None and rank_disagreement > disagreement_threshold)
    return DisagreementReport(
        rank_disagreement=rank_disagreement,
        prediction_disagreement=pred_dis,
        high_disagreement=high,
        recommend_abstain=high,
        threshold=disagreement_threshold,
    )
