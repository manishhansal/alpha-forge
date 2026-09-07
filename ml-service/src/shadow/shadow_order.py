"""
Phase 3M — Shadow order (spec §10, §12).

A ShadowOrder is a HYPOTHETICAL order derived from a decision. It is never sent
to a broker. RESEARCH / SHADOW / PAPER modes are permitted; LIVE is forbidden
(guarded via decision.provenance.assert_not_live).
"""

from __future__ import annotations

import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Optional

from src.decision.provenance import assert_not_live

UTC = timezone.utc


class ShadowMode(str, Enum):
    """Execution modes for shadow layer. LIVE is intentionally absent."""
    RESEARCH = "research"
    SHADOW   = "shadow"
    PAPER    = "paper"


@dataclass
class ShadowOrder:
    """A hypothetical order. NEVER routed to a broker (spec §10, §23)."""
    order_id:               str
    decision_id:            str
    instrument:             str
    side:                   str                     # BUY | SELL
    quantity:               float
    target_price:           Optional[float]
    signal_timestamp:       str
    order_timestamp:        str
    mode:                   str = ShadowMode.SHADOW.value

    # execution config / provenance carried onto the order
    execution_policy:       str = ""
    execution_policy_version: str = ""
    rl_policy_id:           str = ""
    rl_action:              str = ""
    horizon_bars:           int = 5
    lot_size:               int = 1
    instrument_type:        str = "FUT_IDX"

    # provenance links
    data_snapshot_id:       str = ""
    model_ids:              list[str] = field(default_factory=list)
    feature_version:        str = ""
    market_regime:          Optional[str] = None
    created_at:             str = ""

    def __post_init__(self):
        assert_not_live(self.mode)     # fail closed on any live mode
        if not self.created_at:
            self.created_at = datetime.now(UTC).isoformat()

    @staticmethod
    def new_id() -> str:
        return f"sorder-{uuid.uuid4().hex[:16]}"

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "ShadowOrder":
        known = {f for f in cls.__dataclass_fields__}  # type: ignore[attr-defined]
        return cls(**{k: v for k, v in d.items() if k in known})
