"""
Phase 3M — Shadow fill (spec §12).

A ShadowFill is the hypothetical fill result produced by the Phase 3G execution
simulator (via the Phase 3L SimulatorBridge). It records assumed execution price,
slippage, fees/taxes, total cost, fill status, and realized/unrealized P&L — all
hypothetical. It is NEVER a broker fill.
"""

from __future__ import annotations

import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Optional

UTC = timezone.utc


class ShadowFillStatus(str, Enum):
    FULL        = "FULL"
    PARTIAL     = "PARTIAL"
    REJECTED    = "REJECTED"
    UNAVAILABLE = "UNAVAILABLE"


@dataclass
class ShadowFill:
    """Hypothetical fill (spec §12). All values are simulated."""
    fill_id:                str
    order_id:               str
    decision_id:            str
    instrument:             str
    side:                   str
    status:                 str

    target_price:           Optional[float]
    assumed_execution_price: Optional[float]
    quantity_filled:        float

    slippage:               float = 0.0
    fees:                   float = 0.0
    taxes:                  float = 0.0
    total_cost:             float = 0.0

    realized_pnl:           float = 0.0
    unrealized_pnl:         float = 0.0

    execution_policy:       str = ""
    execution_policy_version: str = ""
    rl_policy_id:           str = ""
    rl_action:              str = ""

    market_regime:          Optional[str] = None
    data_snapshot_id:       str = ""
    model_ids:              list[str] = field(default_factory=list)
    feature_version:        str = ""

    simulator_version:      str = ""
    pnl_reconciled:         bool = True
    fill_timestamp:         str = ""
    created_at:             str = ""

    def __post_init__(self):
        if not self.created_at:
            self.created_at = datetime.now(UTC).isoformat()

    @staticmethod
    def new_id() -> str:
        return f"sfill-{uuid.uuid4().hex[:16]}"

    @property
    def filled(self) -> bool:
        return self.status in (ShadowFillStatus.FULL.value, ShadowFillStatus.PARTIAL.value)

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "ShadowFill":
        known = {f for f in cls.__dataclass_fields__}  # type: ignore[attr-defined]
        return cls(**{k: v for k, v in d.items() if k in known})
