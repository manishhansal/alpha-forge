"""
Phase 3O — Decision / order / position journals (spec §13, §14, §15, §16, §17).

Append-only, immutable journals for one paper session. They record what actually
happened — never a fabricated fill or a synthesized economic event.

  §13 DecisionSnapshot — every accepted OR rejected decision, with full context.
  §14 abstention is FIRST-CLASS: TAKE / SKIP / ABSTAIN / INSUFFICIENT_EVIDENCE /
      BLOCKED / UNAVAILABLE are distinct outcomes; "no trade" is never treated as
      a model failure and is measured separately.
  §15 PaperOrderJournalEntry — every paper order, no fake fills.
  §16 PositionJournalEntry — deterministic position accounting (+ F&O fields).
  §17 gross vs cost vs slippage vs net are kept separate.

Persistence via `lifecycle._storage.append_jsonl` (append-only). Import-clean.
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Optional

UTC = timezone.utc


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


# ══════════════════════════════════════════════════════════════════════════════
# §14 Decision outcome (abstention first-class)
# ══════════════════════════════════════════════════════════════════════════════

class DecisionOutcome(str, Enum):
    TAKE                  = "TAKE"
    SKIP                  = "SKIP"
    ABSTAIN               = "ABSTAIN"
    INSUFFICIENT_EVIDENCE = "INSUFFICIENT_EVIDENCE"
    BLOCKED               = "BLOCKED"
    UNAVAILABLE           = "UNAVAILABLE"


# Outcomes that are deliberate non-trades — NOT failures (spec §14).
_DELIBERATE_NON_TRADE: frozenset[DecisionOutcome] = frozenset({
    DecisionOutcome.SKIP, DecisionOutcome.ABSTAIN, DecisionOutcome.INSUFFICIENT_EVIDENCE,
})


def is_deliberate_non_trade(outcome: str) -> bool:
    try:
        return DecisionOutcome(outcome) in _DELIBERATE_NON_TRADE
    except ValueError:
        return False


# ══════════════════════════════════════════════════════════════════════════════
# §13 Decision snapshot
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class DecisionSnapshot:
    """One decision (accepted or rejected) with full §13 context."""
    decision_id:      str
    timestamp:        str                    # information/decision time (ISO UTC)
    instrument:       str
    timeframe:        str = ""
    regime:           Optional[str] = None
    # scores — kept semantically distinct (spec 3M invariant)
    alpha_score:      Optional[float] = None
    rank:             Optional[int] = None
    probability:      Optional[float] = None
    expected_win:     Optional[float] = None
    expected_loss:    Optional[float] = None
    expected_cost:    Optional[float] = None
    expected_value:   Optional[float] = None
    # strategy / direction
    strategy:         Optional[str] = None
    direction:        Optional[str] = None
    # downstream
    portfolio_target: Optional[float] = None
    risk_state:       Optional[str] = None
    execution_plan:   Optional[str] = None
    rl_action:        Optional[str] = None
    rl_override:      bool = False
    # outcome + provenance
    outcome:          str = DecisionOutcome.SKIP.value
    decision_state:   str = ""
    provenance_id:    str = ""
    provenance_complete: bool = False
    created_at:       str = ""

    def __post_init__(self):
        if not self.created_at:
            self.created_at = _now_iso()

    @property
    def is_trade(self) -> bool:
        return self.outcome == DecisionOutcome.TAKE.value

    @property
    def is_deliberate_non_trade(self) -> bool:
        return is_deliberate_non_trade(self.outcome)

    def to_dict(self) -> dict:
        d = asdict(self)
        d["is_trade"] = self.is_trade
        d["is_deliberate_non_trade"] = self.is_deliberate_non_trade
        return d


# ══════════════════════════════════════════════════════════════════════════════
# §15 Paper order journal entry
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class PaperOrderJournalEntry:
    """One paper order (spec §15). No fake fills — unfilled fields stay None."""
    paper_order_id:   str
    decision_id:      str
    instrument:       str
    side:             str
    quantity:         float
    intended_price:   Optional[float] = None
    execution_price:  Optional[float] = None
    order_type:       str = "MARKET"
    created_at:       str = ""
    submitted_at:     Optional[str] = None
    filled_at:        Optional[str] = None
    fill_status:      str = "CREATED"        # CREATED/SUBMITTED/PARTIAL/FILLED/REJECTED/UNAVAILABLE
    quantity_filled:  float = 0.0
    slippage:         Optional[float] = None
    fees:             Optional[float] = None
    taxes:            Optional[float] = None
    total_cost:       Optional[float] = None
    execution_policy: str = ""
    rl_action:        str = ""
    portfolio_before: Optional[dict] = None
    portfolio_after:  Optional[dict] = None

    def __post_init__(self):
        if not self.created_at:
            self.created_at = _now_iso()

    def to_dict(self) -> dict:
        return asdict(self)


# ══════════════════════════════════════════════════════════════════════════════
# §16 Position journal entry (deterministic accounting + F&O)
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class PositionJournalEntry:
    """A position snapshot (spec §16). Deterministic — computed, never guessed."""
    instrument:        str
    timestamp:         str
    quantity:          float = 0.0
    average_price:     Optional[float] = None
    realized_pnl:      float = 0.0
    unrealized_pnl:    float = 0.0
    gross_exposure:    float = 0.0
    net_exposure:      float = 0.0
    margin:            float = 0.0
    available_capital: Optional[float] = None
    fees:              float = 0.0
    slippage:          float = 0.0
    turnover:          float = 0.0
    # F&O (None for cash equity)
    lot_size:          Optional[int] = None
    expiry:            Optional[str] = None
    strike:            Optional[float] = None
    option_type:       Optional[str] = None
    contract_value:    Optional[float] = None

    def to_dict(self) -> dict:
        return asdict(self)


# ══════════════════════════════════════════════════════════════════════════════
# Append-only journals
# ══════════════════════════════════════════════════════════════════════════════

class _JournalBase:
    """Append-only JSONL journal backed by lifecycle._storage."""
    filename = "journal.jsonl"

    def __init__(self, root: str | Path, session_id: str):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.session_id = session_id
        self.path = self.root / f"{session_id}_{self.filename}"

    def _append(self, rec: dict) -> None:
        from src.lifecycle._storage import append_jsonl
        append_jsonl(self.path, rec)

    def all(self) -> list[dict]:
        from src.lifecycle._storage import read_jsonl
        return read_jsonl(self.path)


class DecisionJournal(_JournalBase):
    filename = "decisions.jsonl"

    def record(self, snap: DecisionSnapshot) -> None:
        self._append(snap.to_dict())

    def outcome_counts(self) -> dict:
        """Count decisions by outcome — abstention measured separately (§14)."""
        counts: dict = {o.value: 0 for o in DecisionOutcome}
        for rec in self.all():
            o = rec.get("outcome")
            if o in counts:
                counts[o] += 1
        return counts


class OrderJournal(_JournalBase):
    filename = "orders.jsonl"

    def record(self, entry: PaperOrderJournalEntry) -> None:
        self._append(entry.to_dict())


class PositionJournal(_JournalBase):
    filename = "positions.jsonl"

    def record(self, entry: PositionJournalEntry) -> None:
        self._append(entry.to_dict())
