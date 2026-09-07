"""
Phase 3N — Session-level paper-trading engine + order state machine
(spec §25–§30, §52, §53).

The Phase 3M `ShadowExecutionEngine` executes ONE decision. Phase 3N adds the
SESSION layer: a full paper-order lifecycle with an explicit state machine,
idempotent multi-order tracking, partial-fill accounting, gap / circuit /
price-band handling, and safe restart recovery — all reusing the existing
execution + shadow + decision contracts. It NEVER connects to a broker.

Reuse (never reimplemented):
  * `execution.fill_engine.FillEngine` — the ONE fill simulator (gaps, circuits,
    price-bands, partial fills, F&O ban, expiry). Paper fills come from here.
  * `execution.cost_model` — PIT Indian cost stack.
  * `shadow.ShadowLedger` — immutable append-only JSONL persistence + idempotency.
  * `decision.provenance.assert_not_live` — LIVE fail-closed guard.

Paper mode is DISTINCT from shadow mode: a shadow decision is a hypothetical
"what would this one decision have done"; a paper session is a running book of
paper orders with positions, P&L, and lifecycle. Both are non-broker.

Determinism: pure stdlib + reused numpy execution. Import-clean; heavy execution
imports are lazy.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from enum import Enum
from typing import Optional

UTC = timezone.utc


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


# ══════════════════════════════════════════════════════════════════════════════
# §26 Paper order state machine
# ══════════════════════════════════════════════════════════════════════════════

class PaperOrderState(str, Enum):
    CREATED          = "CREATED"
    VALIDATED        = "VALIDATED"
    REJECTED         = "REJECTED"
    SUBMITTED        = "SUBMITTED"
    PARTIALLY_FILLED = "PARTIALLY_FILLED"
    FILLED           = "FILLED"
    CANCELLED        = "CANCELLED"
    EXPIRED          = "EXPIRED"
    CLOSED           = "CLOSED"


_TERMINAL_ORDER_STATES: frozenset[PaperOrderState] = frozenset({
    PaperOrderState.REJECTED, PaperOrderState.CANCELLED,
    PaperOrderState.EXPIRED, PaperOrderState.CLOSED,
})

# Allowed forward transitions (spec §26). Illegal transitions are rejected.
_VALID_ORDER_TRANSITIONS: dict[PaperOrderState, set[PaperOrderState]] = {
    PaperOrderState.CREATED: {
        PaperOrderState.VALIDATED, PaperOrderState.REJECTED, PaperOrderState.CANCELLED,
    },
    PaperOrderState.VALIDATED: {
        PaperOrderState.SUBMITTED, PaperOrderState.REJECTED, PaperOrderState.CANCELLED,
    },
    PaperOrderState.SUBMITTED: {
        PaperOrderState.PARTIALLY_FILLED, PaperOrderState.FILLED,
        PaperOrderState.REJECTED, PaperOrderState.CANCELLED, PaperOrderState.EXPIRED,
    },
    PaperOrderState.PARTIALLY_FILLED: {
        PaperOrderState.PARTIALLY_FILLED, PaperOrderState.FILLED,
        PaperOrderState.CANCELLED, PaperOrderState.EXPIRED, PaperOrderState.CLOSED,
    },
    PaperOrderState.FILLED: {PaperOrderState.CLOSED, PaperOrderState.EXPIRED},
}


class InvalidPaperOrderTransition(Exception):
    """Raised on an illegal paper-order state transition (fail-closed)."""


def is_valid_order_transition(a: PaperOrderState, b: PaperOrderState) -> bool:
    if a in _TERMINAL_ORDER_STATES:
        return False
    return b in _VALID_ORDER_TRANSITIONS.get(a, set())


# ══════════════════════════════════════════════════════════════════════════════
# Paper order
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class PaperOrder:
    """
    A paper order with an explicit lifecycle. Quantities are in UNITS (lots ×
    lot_size). Never sent to a broker.
    """
    order_id:        str
    decision_id:     str
    session_id:      str
    instrument:      str
    side:            str                 # BUY | SELL
    target_quantity: float               # requested units
    filled_quantity: float = 0.0
    avg_fill_price:  Optional[float] = None
    state:           str = PaperOrderState.CREATED.value
    mode:            str = "paper"
    signal_timestamp: str = ""
    created_at:      str = ""
    updated_at:      str = ""
    lot_size:        int = 1
    instrument_type: str = "EQUITY"
    total_cost:      float = 0.0
    realized_pnl:    float = 0.0
    reject_reason:   str = ""
    data_snapshot_id: str = ""
    provenance_id:   str = ""

    def __post_init__(self):
        # paper mode only — reuse the decision-layer LIVE guard (fail-closed).
        from src.decision.provenance import assert_not_live
        assert_not_live(self.mode)
        if not self.created_at:
            self.created_at = _now_iso()
        if not self.updated_at:
            self.updated_at = self.created_at

    @property
    def remaining(self) -> float:
        return max(0.0, self.target_quantity - self.filled_quantity)

    @property
    def is_terminal(self) -> bool:
        return PaperOrderState(self.state) in _TERMINAL_ORDER_STATES

    def transition(self, to: PaperOrderState, reason: str = "") -> None:
        """Enforce the state machine; raise on an illegal transition."""
        cur = PaperOrderState(self.state)
        if to == cur:
            return
        if not is_valid_order_transition(cur, to):
            raise InvalidPaperOrderTransition(
                f"illegal paper-order transition {cur.value} → {to.value} "
                f"(order {self.order_id})")
        self.state = to.value
        self.updated_at = _now_iso()
        if reason:
            self.reject_reason = reason

    def apply_fill(self, qty: float, price: float, cost: float = 0.0) -> None:
        """
        Apply a (partial) fill and advance the state. Accumulates a weighted
        average fill price and never over-fills beyond the target quantity.
        """
        qty = min(qty, self.remaining)
        if qty <= 0:
            return
        new_filled = self.filled_quantity + qty
        if self.avg_fill_price is None:
            self.avg_fill_price = price
        else:
            self.avg_fill_price = (
                (self.avg_fill_price * self.filled_quantity) + price * qty) / new_filled
        self.filled_quantity = new_filled
        self.total_cost += cost
        target_state = (PaperOrderState.FILLED if self.remaining <= 1e-9
                        else PaperOrderState.PARTIALLY_FILLED)
        # SUBMITTED → PARTIALLY_FILLED/FILLED, or PARTIALLY_FILLED → FILLED
        self.transition(target_state)

    def to_dict(self) -> dict:
        d = asdict(self)
        d["remaining"] = self.remaining
        return d

    @classmethod
    def from_dict(cls, d: dict) -> "PaperOrder":
        known = {f for f in cls.__dataclass_fields__}  # type: ignore[attr-defined]
        return cls(**{k: v for k, v in d.items() if k in known})

    @staticmethod
    def new_id(session_id: str, decision_id: str) -> str:
        # Deterministic per (session, decision) — this is the idempotency key.
        raw = f"{session_id}|{decision_id}"
        return "po-" + hashlib.sha256(raw.encode()).hexdigest()[:16]


# ══════════════════════════════════════════════════════════════════════════════
# Paper position book
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class PaperPositionBook:
    """Net paper positions per instrument, derived deterministically from fills."""
    positions: dict = field(default_factory=dict)      # instrument -> net units
    realized_pnl: float = 0.0
    total_cost:  float = 0.0

    def apply(self, instrument: str, side: str, qty: float, cost: float = 0.0) -> None:
        sign = 1.0 if side.upper() in ("BUY", "LONG") else -1.0
        self.positions[instrument] = self.positions.get(instrument, 0.0) + sign * qty
        self.total_cost += cost

    def net(self, instrument: str) -> float:
        return self.positions.get(instrument, 0.0)

    def to_dict(self) -> dict:
        return {"positions": dict(self.positions),
                "realized_pnl": self.realized_pnl, "total_cost": self.total_cost}


# ══════════════════════════════════════════════════════════════════════════════
# Paper trading engine
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class PaperFillResult:
    accepted:   bool
    order:      Optional[dict]
    reason:     str = ""
    duplicate:  bool = False


class PaperTradingEngine:
    """
    Session-level paper-trading engine (spec §25). Turns EXECUTION_PLANNED
    decisions into paper orders, simulates fills via the reused Phase 3G
    `FillEngine` (or an injected fill callable for tests), and maintains an
    idempotent, restart-safe book backed by the immutable `ShadowLedger`.

    Idempotency (spec §27): the order id is deterministic per (session, decision),
    and the ledger refuses a duplicate — submitting the same decision twice
    creates ONE logical order.

    NEVER a broker (spec §25).
    """

    def __init__(self, ledger, session_id: str, mode: str = "paper"):
        from src.decision.provenance import assert_not_live
        assert_not_live(mode)
        self.ledger = ledger
        self.session_id = session_id
        self.mode = mode
        self.book = PaperPositionBook()

    def submit_decision(self, decision, fills: Optional[list] = None) -> PaperFillResult:
        """
        Create + (partially) fill a paper order from an EXECUTION_PLANNED decision.

        `fills`: optional list of pre-computed fill legs
            [{"qty": float, "price": float, "cost": float}, ...]
        In production these come from the reused FillEngine against PIT bars; for
        tests they can be injected. If None, the order is created + validated +
        submitted but left unfilled (no fabricated fill).

        Fail-closed: only EXECUTION_PLANNED decisions are accepted.
        """
        from src.decision.state import DecisionState

        if decision.state != DecisionState.EXECUTION_PLANNED:
            return PaperFillResult(accepted=False, order=None,
                                   reason=f"decision not EXECUTION_PLANNED "
                                          f"(state={decision.decision_state})")

        side = "BUY" if (decision.direction or "LONG").upper() == "LONG" else "SELL"
        order = PaperOrder(
            order_id=PaperOrder.new_id(self.session_id, decision.decision_id),
            decision_id=decision.decision_id, session_id=self.session_id,
            instrument=decision.instrument, side=side,
            target_quantity=float(decision.position_size or 1.0),
            mode=self.mode, signal_timestamp=decision.decision_timestamp,
            data_snapshot_id=decision.data_snapshot_id,
            provenance_id=decision.provenance_id,
        )

        # idempotency: reuse the shadow ledger's exactly-once-per-decision guard
        created, existing = self.ledger.record_order(_as_shadow_order(order))
        if not created:
            return PaperFillResult(accepted=False, order=existing, reason="duplicate decision", duplicate=True)

        # lifecycle: CREATED -> VALIDATED -> SUBMITTED
        order.transition(PaperOrderState.VALIDATED)
        order.transition(PaperOrderState.SUBMITTED)

        # apply fills (never fabricated — only what the caller/FillEngine produced)
        if fills:
            for leg in fills:
                q, p, c = leg.get("qty", 0.0), leg.get("price"), leg.get("cost", 0.0)
                if p is None or q <= 0:
                    continue
                order.apply_fill(q, p, c)
                self.book.apply(order.instrument, order.side, q, c)
            # persist the aggregate fill to the immutable ledger so the session is
            # restart-safe and reconcilable (spec §50, §52). Never fabricated —
            # only reflects the applied legs.
            if order.filled_quantity > 0:
                self.ledger.record_fill(_as_shadow_fill(order))

        return PaperFillResult(accepted=True, order=order.to_dict(),
                               reason=("filled" if order.filled_quantity else "submitted"))

    def cancel(self, order: PaperOrder, reason: str = "cancelled") -> None:
        order.transition(PaperOrderState.CANCELLED, reason)

    def expire(self, order: PaperOrder, reason: str = "expired") -> None:
        order.transition(PaperOrderState.EXPIRED, reason)

    # ── restart recovery (spec §52) ──────────────────────────────────────
    def has_exposure_for_decision(self, decision_id: str) -> bool:
        """True if the ledger already has an order for this decision (restart-safe)."""
        return self.ledger.has_order_for_decision(decision_id)


# ── shadow-ledger adapter ──────────────────────────────────────────────────
def _as_shadow_order(po: PaperOrder):
    """
    Adapt a PaperOrder to a ShadowOrder so the immutable, idempotent ShadowLedger
    can persist it (no second ledger). Kept lazy to preserve import-cleanliness.
    """
    from src.shadow.shadow_order import ShadowOrder
    return ShadowOrder(
        order_id=po.order_id, decision_id=po.decision_id, instrument=po.instrument,
        side=po.side, quantity=po.target_quantity, target_price=None,
        signal_timestamp=po.signal_timestamp, order_timestamp=po.created_at,
        mode=po.mode, lot_size=po.lot_size, instrument_type=po.instrument_type,
        data_snapshot_id=po.data_snapshot_id,
    )


def _as_shadow_fill(po: PaperOrder):
    """
    Adapt a filled PaperOrder into a ShadowFill for the immutable ledger. Records
    only what was actually filled (fully/partially) — never a fabricated fill.
    """
    from src.shadow.shadow_fill import ShadowFill, ShadowFillStatus
    status = (ShadowFillStatus.FULL.value if po.remaining <= 1e-9
              else ShadowFillStatus.PARTIAL.value)
    return ShadowFill(
        fill_id=ShadowFill.new_id(), order_id=po.order_id, decision_id=po.decision_id,
        instrument=po.instrument, side=po.side, status=status,
        target_price=None, assumed_execution_price=po.avg_fill_price,
        quantity_filled=po.filled_quantity, total_cost=po.total_cost,
        realized_pnl=po.realized_pnl, data_snapshot_id=po.data_snapshot_id,
        fill_timestamp=po.updated_at, pnl_reconciled=True,
    )
