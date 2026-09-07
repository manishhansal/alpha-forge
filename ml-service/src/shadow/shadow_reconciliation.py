"""
Phase 3M — Predicted-vs-realized reconciliation (spec §13).

For every decision, compare what was predicted against what the shadow/paper
execution realized:
    predicted probability   vs realized outcome (0/1)
    predicted expected value vs realized net P&L
    predicted cost          vs realized/shadow cost
    predicted slippage      vs realized/shadow slippage
    target position         vs executed position
    RL expected reward      vs realized execution reward

Aggregatable by model / horizon / instrument / sector / regime / strategy /
direction / liquidity bucket / volatility bucket / confidence bucket (spec §13).

Determinism: pure stdlib; no np.random.*.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from src.lifecycle._storage import append_jsonl, read_jsonl, FileLock

UTC = timezone.utc


def _now() -> str:
    return datetime.now(UTC).isoformat()


@dataclass
class ReconciliationRecord:
    """One predicted-vs-realized reconciliation for a decision (spec §13)."""
    decision_id:            str
    instrument:             str
    # predicted
    predicted_probability:  Optional[float] = None
    predicted_expected_value: Optional[float] = None
    predicted_cost:         Optional[float] = None
    predicted_slippage:     Optional[float] = None
    target_position:        Optional[float] = None
    rl_expected_reward:     Optional[float] = None
    # realized (from shadow fill)
    realized_outcome:       Optional[float] = None   # 1.0 win / 0.0 loss (net pnl > 0)
    realized_net_pnl:       Optional[float] = None
    realized_cost:          Optional[float] = None
    realized_slippage:      Optional[float] = None
    executed_position:      Optional[float] = None
    realized_execution_reward: Optional[float] = None
    # aggregation dimensions
    model_id:               str = ""
    horizon:                Optional[int] = None
    sector:                 str = ""
    regime:                 Optional[str] = None
    strategy:               Optional[str] = None
    direction:              Optional[str] = None
    liquidity_bucket:       str = ""
    volatility_bucket:      str = ""
    confidence_bucket:      str = ""
    created_at:             str = ""

    def __post_init__(self):
        if not self.created_at:
            self.created_at = _now()

    # ── derived errors (never fabricated; None when inputs absent) ────────

    @property
    def cost_error(self) -> Optional[float]:
        if self.predicted_cost is None or self.realized_cost is None:
            return None
        return self.realized_cost - self.predicted_cost

    @property
    def slippage_error(self) -> Optional[float]:
        if self.predicted_slippage is None or self.realized_slippage is None:
            return None
        return self.realized_slippage - self.predicted_slippage

    @property
    def ev_error(self) -> Optional[float]:
        if self.predicted_expected_value is None or self.realized_net_pnl is None:
            return None
        return self.realized_net_pnl - self.predicted_expected_value

    @property
    def position_error(self) -> Optional[float]:
        if self.target_position is None or self.executed_position is None:
            return None
        return self.executed_position - self.target_position

    def to_dict(self) -> dict:
        d = asdict(self)
        d["cost_error"] = self.cost_error
        d["slippage_error"] = self.slippage_error
        d["ev_error"] = self.ev_error
        d["position_error"] = self.position_error
        return d


@dataclass
class ReconciliationAggregate:
    """Aggregated reconciliation stats over a group (spec §13)."""
    group_key:              str
    n:                      int
    mean_predicted_prob:    Optional[float]
    realized_win_rate:      Optional[float]
    mean_predicted_ev:      Optional[float]
    mean_realized_pnl:      Optional[float]
    mean_cost_error:        Optional[float]
    mean_slippage_error:    Optional[float]

    def to_dict(self) -> dict:
        return asdict(self)


class ReconciliationEngine:
    """
    Append-only reconciliation store + aggregation (spec §13). Records are never
    overwritten; a corrected reconciliation appends a new record.
    """

    def __init__(self, root: str | Path):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.path = self.root / "reconciliation.jsonl"
        self.lock_path = self.root / ".reconciliation.lock"

    def record(self, rec: ReconciliationRecord) -> ReconciliationRecord:
        with FileLock(self.lock_path):
            append_jsonl(self.path, rec.to_dict())
        return rec

    def all(self) -> list[dict]:
        return read_jsonl(self.path)

    def for_decision(self, decision_id: str) -> list[dict]:
        return [r for r in self.all() if r.get("decision_id") == decision_id]

    @staticmethod
    def _mean(vals: list) -> Optional[float]:
        xs = [v for v in vals if v is not None]
        return sum(xs) / len(xs) if xs else None

    def aggregate(self, by: str) -> list[ReconciliationAggregate]:
        """
        Aggregate reconciliation records by a dimension (spec §13). Valid `by`
        values: model_id, horizon, instrument, sector, regime, strategy,
        direction, liquidity_bucket, volatility_bucket, confidence_bucket.
        """
        rows = self.all()
        groups: dict[str, list[dict]] = {}
        for r in rows:
            key = str(r.get(by, ""))
            groups.setdefault(key, []).append(r)

        out: list[ReconciliationAggregate] = []
        for key, rs in sorted(groups.items()):
            outcomes = [r.get("realized_outcome") for r in rs]
            out.append(ReconciliationAggregate(
                group_key=key, n=len(rs),
                mean_predicted_prob=self._mean([r.get("predicted_probability") for r in rs]),
                realized_win_rate=self._mean([o for o in outcomes if o is not None]),
                mean_predicted_ev=self._mean([r.get("predicted_expected_value") for r in rs]),
                mean_realized_pnl=self._mean([r.get("realized_net_pnl") for r in rs]),
                mean_cost_error=self._mean([r.get("cost_error") for r in rs]),
                mean_slippage_error=self._mean([r.get("slippage_error") for r in rs]),
            ))
        return out

    def reconcile_from_fill(self, decision, fill_dict: dict) -> ReconciliationRecord:
        """Build a reconciliation record from a decision + a shadow fill dict."""
        net = fill_dict.get("realized_pnl")
        rec = ReconciliationRecord(
            decision_id=decision.decision_id,
            instrument=decision.instrument,
            predicted_probability=decision.calibrated_probability,
            predicted_expected_value=decision.expected_value,
            predicted_cost=decision.expected_cost,
            target_position=decision.position_size,
            realized_outcome=(1.0 if (net is not None and net > 0) else 0.0) if net is not None else None,
            realized_net_pnl=net,
            realized_cost=fill_dict.get("total_cost"),
            realized_slippage=fill_dict.get("slippage"),
            executed_position=fill_dict.get("quantity_filled"),
            model_id=(decision.model_ids[0] if decision.model_ids else ""),
            regime=decision.market_regime,
            strategy=decision.strategy,
            direction=decision.direction,
        )
        return self.record(rec)
