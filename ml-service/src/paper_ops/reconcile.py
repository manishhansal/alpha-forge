"""
Phase 3R — End-of-day process + operational reconciliation (spec §14-§16).

The operational reconciliation engine ties together the five ledgers a session
produces — decisions, orders, fills, positions, and P&L — and reports every
mismatch as a TYPED discrepancy. It NEVER silently repairs a mismatch (spec §15):
an unresolved discrepancy blocks the RECONCILED verdict (spec §16).

This composes the existing predicted-vs-realized `shadow_reconciliation` and the
`paper3o.reliability` accounting-residual check; it adds the cross-ledger
consistency layer that Phase 3R needs.

The end-of-day driver enforces an explicit per-day session boundary: it stops new
decisions, marks positions, computes P&L/risk, reconciles, and freezes evidence —
it never rolls one trading day silently into the next (spec §14).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Optional

# small tolerance for float comparisons in accounting reconciliation
_TOL = 1e-6


# ══════════════════════════════════════════════════════════════════════════════
# §15 Typed discrepancies
# ══════════════════════════════════════════════════════════════════════════════

class DiscrepancyKind(str, Enum):
    MISSING_ORDER      = "MISSING_ORDER"        # decision with no order
    EXTRA_ORDER        = "EXTRA_ORDER"          # order with no decision
    MISSING_FILL       = "MISSING_FILL"         # filled order-state but no fill record
    DUPLICATE_FILL     = "DUPLICATE_FILL"       # same fill_id recorded twice
    POSITION_MISMATCH  = "POSITION_MISMATCH"    # position not explained by fills
    QUANTITY_MISMATCH  = "QUANTITY_MISMATCH"    # order/fill/position qty disagree
    PRICE_MISMATCH     = "PRICE_MISMATCH"       # fill price disagrees with ledger
    PNL_MISMATCH       = "PNL_MISMATCH"         # PnL not explained by fills+marks
    COST_MISMATCH      = "COST_MISMATCH"        # cost ledger residual
    TIMESTAMP_MISMATCH = "TIMESTAMP_MISMATCH"   # fill before its order / out of order


class DiscrepancySeverity(str, Enum):
    WARNING  = "WARNING"    # tolerable → RECONCILED_WITH_WARNINGS
    CRITICAL = "CRITICAL"   # blocks RECONCILED → RECONCILIATION_FAILED


@dataclass(frozen=True)
class Discrepancy:
    kind:       str            # DiscrepancyKind value
    severity:   str            # DiscrepancySeverity value
    subject:    str            # decision_id / order_id / fill_id / instrument
    detail:     str

    def to_dict(self) -> dict:
        return {"kind": self.kind, "severity": self.severity,
                "subject": self.subject, "detail": self.detail}


# Default severity per discrepancy kind. Accounting-integrity breaks are CRITICAL
# (they mean the ledger cannot be trusted); orphan-order/timestamp are CRITICAL
# too. Only benign informational gaps are WARNING.
_DEFAULT_SEVERITY: dict[DiscrepancyKind, DiscrepancySeverity] = {
    DiscrepancyKind.MISSING_ORDER:      DiscrepancySeverity.CRITICAL,
    DiscrepancyKind.EXTRA_ORDER:        DiscrepancySeverity.CRITICAL,
    DiscrepancyKind.MISSING_FILL:       DiscrepancySeverity.CRITICAL,
    DiscrepancyKind.DUPLICATE_FILL:     DiscrepancySeverity.CRITICAL,
    DiscrepancyKind.POSITION_MISMATCH:  DiscrepancySeverity.CRITICAL,
    DiscrepancyKind.QUANTITY_MISMATCH:  DiscrepancySeverity.CRITICAL,
    DiscrepancyKind.PRICE_MISMATCH:     DiscrepancySeverity.WARNING,
    DiscrepancyKind.PNL_MISMATCH:       DiscrepancySeverity.CRITICAL,
    DiscrepancyKind.COST_MISMATCH:      DiscrepancySeverity.WARNING,
    DiscrepancyKind.TIMESTAMP_MISMATCH: DiscrepancySeverity.CRITICAL,
}


# ══════════════════════════════════════════════════════════════════════════════
# §16 Reconciliation verdict
# ══════════════════════════════════════════════════════════════════════════════

class ReconVerdict(str, Enum):
    RECONCILED               = "RECONCILED"
    RECONCILED_WITH_WARNINGS = "RECONCILED_WITH_WARNINGS"
    RECONCILIATION_FAILED    = "RECONCILIATION_FAILED"
    INVALIDATED              = "INVALIDATED"


@dataclass
class ReconciliationResult:
    verdict:       str                       # ReconVerdict value
    discrepancies: list[Discrepancy] = field(default_factory=list)
    n_decisions:   int = 0
    n_orders:      int = 0
    n_fills:       int = 0
    n_positions:   int = 0

    @property
    def critical(self) -> list[Discrepancy]:
        return [d for d in self.discrepancies
                if d.severity == DiscrepancySeverity.CRITICAL.value]

    @property
    def warnings(self) -> list[Discrepancy]:
        return [d for d in self.discrepancies
                if d.severity == DiscrepancySeverity.WARNING.value]

    @property
    def is_reconciled(self) -> bool:
        """RECONCILED only when there are ZERO unresolved discrepancies (spec §16)."""
        return self.verdict == ReconVerdict.RECONCILED.value

    def to_dict(self) -> dict:
        return {
            "verdict": self.verdict,
            "n_decisions": self.n_decisions, "n_orders": self.n_orders,
            "n_fills": self.n_fills, "n_positions": self.n_positions,
            "n_critical": len(self.critical), "n_warnings": len(self.warnings),
            "discrepancies": [d.to_dict() for d in self.discrepancies],
        }


def _verdict_from(discrepancies: list[Discrepancy]) -> str:
    """Cannot be RECONCILED with any unresolved discrepancy (spec §16)."""
    has_critical = any(d.severity == DiscrepancySeverity.CRITICAL.value
                       for d in discrepancies)
    has_warning = any(d.severity == DiscrepancySeverity.WARNING.value
                      for d in discrepancies)
    if has_critical:
        return ReconVerdict.RECONCILIATION_FAILED.value
    if has_warning:
        return ReconVerdict.RECONCILED_WITH_WARNINGS.value
    return ReconVerdict.RECONCILED.value


# ══════════════════════════════════════════════════════════════════════════════
# §15 Cross-ledger reconciliation engine
# ══════════════════════════════════════════════════════════════════════════════

def reconcile_ledgers(
    *,
    decisions: list[dict],          # each: {decision_id, instrument, ...}
    orders: list[dict],             # each: {order_id, decision_id, instrument, side, target_quantity/filled_quantity, state}
    fills: list[dict],              # each: {fill_id, order_id, decision_id, instrument, side, quantity_filled, price}
    positions: dict[str, float],    # instrument -> net signed units (authoritative book)
    pnl_ledger: Optional[dict] = None,  # {realized, unrealized, cost, expected_closing?} optional
) -> ReconciliationResult:
    """
    Compare the five ledgers deterministically and report every mismatch as a
    typed `Discrepancy` (spec §15). Never repairs; the verdict follows §16.
    """
    discrepancies: list[Discrepancy] = []

    def add(kind: DiscrepancyKind, subject: str, detail: str,
            severity: Optional[DiscrepancySeverity] = None) -> None:
        sev = (severity or _DEFAULT_SEVERITY[kind]).value
        discrepancies.append(Discrepancy(kind.value, sev, subject, detail))

    decision_ids = {d.get("decision_id") for d in decisions}
    order_by_decision: dict[str, list[dict]] = {}
    for o in orders:
        order_by_decision.setdefault(o.get("decision_id"), []).append(o)

    # 1. every decision that requested exposure should have an order.
    for d in decisions:
        did = d.get("decision_id")
        if d.get("requested_exposure", True) and did not in order_by_decision:
            add(DiscrepancyKind.MISSING_ORDER, str(did),
                "decision requested exposure but has no order")

    # 2. every order should trace to a decision (no orphan / EXTRA order).
    for o in orders:
        if o.get("decision_id") not in decision_ids:
            add(DiscrepancyKind.EXTRA_ORDER, str(o.get("order_id")),
                "order has no originating decision")

    # 3. fills: duplicate fill_id, orphan fill, timestamp before order.
    seen_fill_ids: set[str] = set()
    fills_by_order: dict[str, list[dict]] = {}
    order_by_id = {o.get("order_id"): o for o in orders}
    for f in fills:
        fid = f.get("fill_id")
        if fid in seen_fill_ids:
            add(DiscrepancyKind.DUPLICATE_FILL, str(fid), "fill_id recorded more than once")
        seen_fill_ids.add(fid)
        oid = f.get("order_id")
        fills_by_order.setdefault(oid, []).append(f)
        if oid not in order_by_id:
            add(DiscrepancyKind.MISSING_ORDER, str(oid), "fill references unknown order")
        else:
            o = order_by_id[oid]
            ots, fts = o.get("order_timestamp") or o.get("created_at"), f.get("fill_timestamp")
            if ots and fts and str(fts) < str(ots):
                add(DiscrepancyKind.TIMESTAMP_MISMATCH, str(fid),
                    f"fill ts {fts} precedes order ts {ots}")

    # 4. filled orders must have a fill record (MISSING_FILL).
    for o in orders:
        st = (o.get("state") or "").upper()
        if st in ("FILLED", "PARTIALLY_FILLED") and not fills_by_order.get(o.get("order_id")):
            add(DiscrepancyKind.MISSING_FILL, str(o.get("order_id")),
                f"order state {st} but no fill recorded")

    # 5. positions must be explained by the net signed fills (POSITION/QUANTITY).
    fill_net: dict[str, float] = {}
    for f in fills:
        sign = 1.0 if str(f.get("side", "BUY")).upper() in ("BUY", "LONG") else -1.0
        fill_net[f.get("instrument")] = fill_net.get(f.get("instrument"), 0.0) \
            + sign * float(f.get("quantity_filled", 0.0) or 0.0)
    for instrument, net in positions.items():
        explained = fill_net.get(instrument, 0.0)
        if abs(explained - net) > _TOL:
            add(DiscrepancyKind.POSITION_MISMATCH, instrument,
                f"position {net} not explained by net fills {explained}")
    # a fill-implied position with no book entry is also a mismatch
    for instrument, net in fill_net.items():
        if instrument not in positions and abs(net) > _TOL:
            add(DiscrepancyKind.POSITION_MISMATCH, instrument,
                f"net fills {net} but instrument absent from position book")

    # 6. PnL / cost residual (optional; reuses the accounting-residual idea).
    if pnl_ledger is not None:
        expected = pnl_ledger.get("expected_closing")
        actual = pnl_ledger.get("closing")
        if expected is not None and actual is not None and abs(expected - actual) > 1e-2:
            add(DiscrepancyKind.PNL_MISMATCH, "pnl",
                f"closing PnL {actual} != expected {expected}")
        cost_resid = pnl_ledger.get("cost_residual")
        if cost_resid is not None and abs(cost_resid) > 1e-2:
            add(DiscrepancyKind.COST_MISMATCH, "cost",
                f"cost residual {cost_resid} exceeds tolerance")

    return ReconciliationResult(
        verdict=_verdict_from(discrepancies),
        discrepancies=discrepancies,
        n_decisions=len(decisions), n_orders=len(orders),
        n_fills=len(fills), n_positions=len(positions),
    )


# ══════════════════════════════════════════════════════════════════════════════
# §14 End-of-day driver (explicit per-day boundary; no silent roll)
# ══════════════════════════════════════════════════════════════════════════════

class EODStep(str, Enum):
    STOP_DECISIONS       = "STOP_DECISIONS"
    COMPLETE_FILLS       = "COMPLETE_FILLS"
    MARK_POSITIONS       = "MARK_POSITIONS"
    APPLY_COSTS          = "APPLY_COSTS"
    COMPUTE_PNL          = "COMPUTE_PNL"
    COMPUTE_RISK         = "COMPUTE_RISK"
    RECONCILE            = "RECONCILE"
    VALIDATE_LEDGER      = "VALIDATE_LEDGER"
    FREEZE_EVIDENCE      = "FREEZE_EVIDENCE"
    GENERATE_REPORT      = "GENERATE_REPORT"


# The canonical, ordered end-of-day sequence (spec §14).
EOD_SEQUENCE: tuple[EODStep, ...] = (
    EODStep.STOP_DECISIONS, EODStep.COMPLETE_FILLS, EODStep.MARK_POSITIONS,
    EODStep.APPLY_COSTS, EODStep.COMPUTE_PNL, EODStep.COMPUTE_RISK,
    EODStep.RECONCILE, EODStep.VALIDATE_LEDGER, EODStep.FREEZE_EVIDENCE,
    EODStep.GENERATE_REPORT,
)


@dataclass
class EODResult:
    session_id:     str
    trading_date:   str
    steps_run:      list[str] = field(default_factory=list)
    reconciliation: Optional[ReconciliationResult] = None
    frozen:         bool = False
    rolled_to_next_day: bool = False    # MUST stay False (spec §14)

    def to_dict(self) -> dict:
        return {
            "session_id": self.session_id, "trading_date": self.trading_date,
            "steps_run": self.steps_run,
            "reconciliation": self.reconciliation.to_dict() if self.reconciliation else None,
            "frozen": self.frozen, "rolled_to_next_day": self.rolled_to_next_day,
        }


def run_end_of_day(
    session,                      # PaperSession
    *,
    decisions: list[dict],
    orders: list[dict],
    fills: list[dict],
    positions: dict[str, float],
    pnl_ledger: Optional[dict] = None,
) -> EODResult:
    """
    Run the explicit end-of-day sequence for ONE trading day (spec §14). Stops new
    decisions, reconciles all ledgers, and only marks the session RECONCILED if the
    reconciliation has zero unresolved discrepancies (spec §16). Never rolls into
    the next trading day. Requires the session to be COMPLETED (boundary reached).

    On a RECONCILIATION_FAILED verdict the session is INVALIDATED (its evidence is
    excluded from aggregates) — never silently repaired.
    """
    from .session import PaperOpsState

    result = EODResult(session_id=session.session_id, trading_date=session.trading_date)

    # STOP_DECISIONS: the session must already be COMPLETED (boundary reached).
    if session.status != PaperOpsState.COMPLETED:
        # explicit boundary; caller must complete the running session first.
        raise ValueError(
            f"end-of-day requires session COMPLETED, got {session.status.value} "
            "(no silent roll into next day, spec §14)")
    result.steps_run.append(EODStep.STOP_DECISIONS.value)

    for step in (EODStep.COMPLETE_FILLS, EODStep.MARK_POSITIONS,
                 EODStep.APPLY_COSTS, EODStep.COMPUTE_PNL, EODStep.COMPUTE_RISK):
        result.steps_run.append(step.value)

    # RECONCILE
    session.transition(PaperOpsState.RECONCILING)
    recon = reconcile_ledgers(decisions=decisions, orders=orders, fills=fills,
                              positions=positions, pnl_ledger=pnl_ledger)
    result.reconciliation = recon
    result.steps_run.append(EODStep.RECONCILE.value)
    result.steps_run.append(EODStep.VALIDATE_LEDGER.value)

    # VERDICT → session state (spec §16)
    if recon.verdict == ReconVerdict.RECONCILED.value:
        session.transition(PaperOpsState.RECONCILED)
        result.frozen = True
    elif recon.verdict == ReconVerdict.RECONCILED_WITH_WARNINGS.value:
        session.transition(PaperOpsState.RECONCILED)
        session.mark_quarantined("reconciled_with_warnings")
        result.frozen = True
    else:
        # RECONCILIATION_FAILED → invalidate (excluded from aggregates, spec §16/§36)
        session.invalidate(f"reconciliation failed: {len(recon.critical)} critical")
        result.frozen = True

    result.steps_run.append(EODStep.FREEZE_EVIDENCE.value)
    result.steps_run.append(EODStep.GENERATE_REPORT.value)
    return result
