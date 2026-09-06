"""
Phase 3J — Champion vs Challenger Comparison.

Apples-to-apples comparison on a FROZEN evaluation snapshot.

Design rules
------------
1. Champion and challenger consume the SAME frozen evaluation snapshot
   (same universe, period, execution, cost model, portfolio constraints,
   horizon) — spec §25, §26.
2. The evaluation dataset is frozen (dataset_hash) before comparison so it
   cannot be a moving target (spec §26, §60).
3. Prediction correlation is surfaced — two models with 99% correlated
   predictions are flagged (spec §27).
4. No np.random.* — deterministic.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Optional

import numpy as np

UTC = timezone.utc


@dataclass
class FrozenEvalSnapshot:
    """
    Frozen evaluation snapshot (spec §26). Champion and challenger must both
    be evaluated on THIS snapshot for a fair comparison.
    """
    evaluation_dataset_id: str
    dataset_hash:          str
    observation_count:     int
    date_range:            str
    universe_hash:         str

    @classmethod
    def create(
        cls,
        evaluation_dataset_id: str,
        universe: list[str],
        date_range: str,
        observation_count: int,
    ) -> "FrozenEvalSnapshot":
        universe_hash = hashlib.sha256(
            json.dumps(sorted(universe), sort_keys=True).encode()
        ).hexdigest()[:16]
        dataset_hash = hashlib.sha256(
            json.dumps({
                "id": evaluation_dataset_id, "n": observation_count,
                "range": date_range, "universe": universe_hash,
            }, sort_keys=True).encode()
        ).hexdigest()[:16]
        return cls(
            evaluation_dataset_id=evaluation_dataset_id,
            dataset_hash=dataset_hash,
            observation_count=observation_count,
            date_range=date_range,
            universe_hash=universe_hash,
        )


@dataclass
class ComparisonResult:
    """Full apples-to-apples comparison (spec §64)."""
    comparison_id:        str
    scope:                str
    champion_id:          Optional[str]
    challenger_id:        str

    # Frozen snapshot proof (same-everything invariant)
    eval_snapshot:        Optional[dict] = None
    same_universe:        bool = False
    same_period:          bool = False
    same_execution:       bool = False
    same_cost_model:      bool = False
    same_portfolio_constraints: bool = False
    same_evaluation_horizon: bool = False

    # Prediction comparison (spec §27)
    prediction_correlation: Optional[float] = None
    rank_correlation:     Optional[float] = None
    predictions_near_identical: bool = False   # > 0.99 correlation

    # Metric deltas (challenger − champion)
    ic_delta:             Optional[float] = None
    rank_ic_delta:        Optional[float] = None
    icir_delta:           Optional[float] = None
    brier_delta:          Optional[float] = None
    net_return_delta:     Optional[float] = None
    drawdown_delta:       Optional[float] = None
    turnover_delta:       Optional[float] = None

    created_at:           str = ""

    def to_dict(self) -> dict:
        return asdict(self)


class ChampionChallengerComparator:
    """
    Compares a champion and challenger on a frozen evaluation snapshot.

    Both models must have been evaluated on the SAME frozen snapshot.
    """

    def compare(
        self,
        comparison_id: str,
        scope: str,
        challenger_id: str,
        champion_id: Optional[str],
        snapshot: FrozenEvalSnapshot,
        champion_predictions: Optional[np.ndarray],
        challenger_predictions: Optional[np.ndarray],
        champion_metrics: dict,
        challenger_metrics: dict,
        same_universe: bool = True,
        same_period: bool = True,
        same_execution: bool = True,
        same_cost_model: bool = True,
        same_portfolio_constraints: bool = True,
        same_evaluation_horizon: bool = True,
    ) -> ComparisonResult:
        """
        Compare champion vs challenger.

        Parameters
        ----------
        champion_predictions / challenger_predictions : aligned prediction arrays
            (same instruments/timestamps) for correlation analysis.
        champion_metrics / challenger_metrics : dicts with keys such as
            mean_rank_ic, icir, brier, net_return, max_drawdown, turnover.
        same_* flags : caller asserts the apples-to-apples invariants.

        Returns
        -------
        ComparisonResult
        """
        pred_corr = rank_corr = None
        near_identical = False

        if (champion_predictions is not None and challenger_predictions is not None
                and len(champion_predictions) == len(challenger_predictions)
                and len(champion_predictions) >= 5):
            a = np.asarray(champion_predictions, dtype=float)
            b = np.asarray(challenger_predictions, dtype=float)
            mask = np.isfinite(a) & np.isfinite(b)
            if mask.sum() >= 5:
                a, b = a[mask], b[mask]
                if np.std(a) > 1e-12 and np.std(b) > 1e-12:
                    pred_corr = float(np.corrcoef(a, b)[0, 1])
                    ar = _rankdata(a)
                    br = _rankdata(b)
                    if np.std(ar) > 1e-12 and np.std(br) > 1e-12:
                        rank_corr = float(np.corrcoef(ar, br)[0, 1])
                    near_identical = pred_corr is not None and pred_corr > 0.99

        def _delta(key):
            cv = challenger_metrics.get(key)
            hv = champion_metrics.get(key) if champion_metrics else None
            if cv is None or hv is None:
                return None
            return round(float(cv) - float(hv), 6)

        return ComparisonResult(
            comparison_id=comparison_id,
            scope=scope,
            champion_id=champion_id,
            challenger_id=challenger_id,
            eval_snapshot=asdict(snapshot),
            same_universe=same_universe,
            same_period=same_period,
            same_execution=same_execution,
            same_cost_model=same_cost_model,
            same_portfolio_constraints=same_portfolio_constraints,
            same_evaluation_horizon=same_evaluation_horizon,
            prediction_correlation=round(pred_corr, 6) if pred_corr is not None else None,
            rank_correlation=round(rank_corr, 6) if rank_corr is not None else None,
            predictions_near_identical=near_identical,
            ic_delta=_delta("mean_ic"),
            rank_ic_delta=_delta("mean_rank_ic"),
            icir_delta=_delta("icir"),
            brier_delta=_delta("brier"),
            net_return_delta=_delta("net_return"),
            drawdown_delta=_delta("max_drawdown"),
            turnover_delta=_delta("turnover"),
            created_at=datetime.now(UTC).isoformat(),
        )

    @staticmethod
    def is_apples_to_apples(result: ComparisonResult) -> bool:
        """All same-* invariants must hold for a valid comparison (spec §25)."""
        return all([
            result.same_universe, result.same_period, result.same_execution,
            result.same_cost_model, result.same_portfolio_constraints,
            result.same_evaluation_horizon,
        ])


def _rankdata(arr: np.ndarray) -> np.ndarray:
    """Average-rank transform."""
    order = np.argsort(arr, kind="stable")
    ranks = np.empty(len(arr), dtype=float)
    n = len(arr)
    i = 0
    while i < n:
        j = i
        while j < n - 1 and arr[order[j]] == arr[order[j + 1]]:
            j += 1
        avg = (i + j) / 2.0 + 1.0
        for k in range(i, j + 1):
            ranks[order[k]] = avg
        i = j + 1
    return ranks
