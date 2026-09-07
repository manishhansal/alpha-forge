"""
Phase 3M — Shadow / paper execution (spec §10, §11, §12, §13, §22, §23).

Shadow execution turns a VALIDATED / EXECUTION_PLANNED decision into a
HYPOTHETICAL order, determines a hypothetical fill via the ONE Phase 3G
execution simulator (reused through the Phase 3L `SimulatorBridge`), and records
the result in an IMMUTABLE append-only ledger. It NEVER sends an order to a
broker (spec §10, §23).

Distinguishes RESEARCH / SHADOW / PAPER modes; LIVE is forbidden (reused from
`decision.provenance.assert_not_live`).

Modules
-------
shadow_order.py         ShadowOrder (hypothetical order intent)
shadow_fill.py          ShadowFill (hypothetical fill result)
shadow_ledger.py        immutable append-only ShadowLedger (corrections = new events)
shadow_engine.py        ShadowExecutionEngine (reuses Phase 3G simulator; no second sim)
shadow_reconciliation.py predicted-vs-realized reconciliation, aggregatable

Determinism: pure stdlib + reused numpy execution; no np.random.*.
"""

from .shadow_order import ShadowOrder, ShadowMode
from .shadow_fill import ShadowFill, ShadowFillStatus
from .shadow_ledger import ShadowLedger, ShadowLedgerEvent
from .shadow_engine import ShadowExecutionEngine
from .shadow_reconciliation import (
    ReconciliationRecord, ReconciliationEngine, ReconciliationAggregate,
)

__all__ = [
    "ShadowOrder", "ShadowMode",
    "ShadowFill", "ShadowFillStatus",
    "ShadowLedger", "ShadowLedgerEvent",
    "ShadowExecutionEngine",
    "ReconciliationRecord", "ReconciliationEngine", "ReconciliationAggregate",
]
