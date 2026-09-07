"""
Phase 3O — Analysis layer (spec §18–§25): benchmarks, alpha attribution,
ablation, RL comparison, cost/turnover/capacity.

Design rules honoured here (from the phase brief):
  • NET after real Indian costs is the only economic result reported as primary;
    gross is shown only as a decomposition input, never as "the return" (§17, §23).
  • Ablation NEVER removes a safety component; "no confirmed incremental value"
    (NO_CONFIRMED_INCREMENTAL_VALUE) is an acceptable, honest verdict (§21).
  • RL comparison reports execution-quality deltas (implementation shortfall,
    slippage, fill, completion, cost, risk, inventory, deadline) — NOT gross PnL,
    and always paired vs a baseline with uncertainty (§22, §68).
  • Capacity is INSUFFICIENT_EVIDENCE unless real liquidity/ADV is supplied (§25) —
    we never invent capacity numbers.
  • Everything is deterministic and reuses Phase 3G cost model + Phase 3N
    paper.evidence metrics. No new predictive model is introduced.

Import-clean: numpy + stdlib + already-import-clean src.paper.evidence / src.execution.
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from datetime import date
from enum import Enum
from typing import Optional

import numpy as np


# ══════════════════════════════════════════════════════════════════════════════
# §18 Deterministic return baselines
# ══════════════════════════════════════════════════════════════════════════════

class BaselineType(str, Enum):
    BUY_HOLD        = "BUY_HOLD"
    INDEX           = "INDEX"
    NAIVE_MOMENTUM  = "NAIVE_MOMENTUM"
    NAIVE_TREND     = "NAIVE_TREND"
    NO_SKILL        = "NO_SKILL"       # zero-alpha / random-sign reference


def _pct_changes(prices: list[float]) -> np.ndarray:
    p = np.asarray([x for x in prices if x is not None], dtype=float)
    if len(p) < 2:
        return np.asarray([], dtype=float)
    return np.diff(p) / p[:-1]


def baseline_returns(baseline: BaselineType, prices: list[float],
                     seed: int = 12345) -> list[float]:
    """
    Deterministic per-period returns for a benchmark. All baselines are
    reproducible given the same prices + seed. No lookahead: momentum/trend
    signals use only the prior period.
    """
    r = _pct_changes(prices)
    if r.size == 0:
        return []

    if baseline in (BaselineType.BUY_HOLD, BaselineType.INDEX):
        return [float(x) for x in r]

    if baseline == BaselineType.NAIVE_MOMENTUM:
        # take next return with sign of the previous realised return (lagged)
        sign = np.sign(r[:-1])
        return [0.0] + [float(s * nxt) for s, nxt in zip(sign, r[1:])]

    if baseline == BaselineType.NAIVE_TREND:
        # position = sign of trailing 2-period sum (lagged), applied to next return
        out = [0.0, 0.0]
        for i in range(2, len(r)):
            pos = np.sign(r[i - 2] + r[i - 1])
            out.append(float(pos * r[i]))
        return out

    if baseline == BaselineType.NO_SKILL:
        rng = np.random.RandomState(seed)
        sign = rng.choice([-1.0, 1.0], size=r.size)
        return [float(s * x) for s, x in zip(sign, r)]

    return [float(x) for x in r]


class ExecutionBaseline(str, Enum):
    TWAP                 = "TWAP"
    VWAP_PROXY           = "VWAP_PROXY"
    PASSIVE              = "PASSIVE"
    AGGRESSIVE           = "AGGRESSIVE"
    FIXED_PARTICIPATION  = "FIXED_PARTICIPATION"


def execution_shortfall(baseline: ExecutionBaseline, arrival_price: float,
                        fills: list[dict]) -> Optional[float]:
    """
    Implementation shortfall of a fill schedule vs its arrival price, in bps.
    fills: [{"qty": float, "price": float}]. Returns None if not measurable
    (no fills / bad arrival) — never fabricated. Positive = adverse (cost).
    """
    if not fills or arrival_price is None or arrival_price <= 0:
        return None
    tot_qty = sum(abs(f.get("qty", 0.0)) for f in fills)
    if tot_qty <= 0:
        return None
    vwap = sum(abs(f.get("qty", 0.0)) * f.get("price", 0.0) for f in fills) / tot_qty
    return float((vwap - arrival_price) / arrival_price * 1e4)


# ══════════════════════════════════════════════════════════════════════════════
# §20 Alpha attribution — incremental value per stage
# ══════════════════════════════════════════════════════════════════════════════

class AttributionStatus(str, Enum):
    MEASURED             = "MEASURED"
    INSUFFICIENT_EVIDENCE = "INSUFFICIENT_EVIDENCE"


# canonical pipeline stages (raw signal → ranking → meta → portfolio → execution)
ATTRIBUTION_STAGES = ("raw_signal", "ranking", "meta", "portfolio", "execution")


@dataclass
class StageAttribution:
    stage:       str
    net_metric:  Optional[float] = None      # net-of-cost metric AT this stage
    incremental: Optional[float] = None      # delta vs previous stage
    n:           int = 0
    status:      str = AttributionStatus.INSUFFICIENT_EVIDENCE.value

    def to_dict(self) -> dict:
        return asdict(self)


def alpha_attribution(stage_net_metrics: dict, min_n: int = 30) -> dict:
    """
    Decompose net performance across the pipeline. `stage_net_metrics` maps a
    stage name → {"value": net_metric_or_None, "n": int}. Incremental value is
    (stage − previous stage) ONLY when both stages have enough observations;
    otherwise the stage is INSUFFICIENT_EVIDENCE (never a fabricated delta).
    """
    out: list[dict] = []
    prev_val: Optional[float] = None
    prev_ok = False
    for stage in ATTRIBUTION_STAGES:
        entry = stage_net_metrics.get(stage) or {}
        val = entry.get("value")
        n = int(entry.get("n", 0))
        sa = StageAttribution(stage=stage, net_metric=val, n=n)
        if val is not None and n >= min_n:
            sa.status = AttributionStatus.MEASURED.value
            if prev_ok and prev_val is not None:
                sa.incremental = float(val - prev_val)
            prev_val, prev_ok = val, True
        else:
            prev_ok = False
        out.append(sa.to_dict())
    return {"stages": out, "min_n": min_n}


# ══════════════════════════════════════════════════════════════════════════════
# §21 Ablation — never remove safety
# ══════════════════════════════════════════════════════════════════════════════

class AblationComponent(str, Enum):
    RANKER      = "RANKER"
    META        = "META"
    CALIBRATION = "CALIBRATION"
    PORTFOLIO   = "PORTFOLIO"
    RL          = "RL"


# Safety components can NEVER be ablated (spec §21). Guard against misuse.
SAFETY_COMPONENTS: frozenset[str] = frozenset({
    "RISK", "RISK_LIMITS", "KILL_SWITCH", "PROVENANCE", "DATA_QUALITY",
    "NO_LOOKAHEAD", "RECONCILIATION",
})


class AblationVerdict(str, Enum):
    CONFIRMED_INCREMENTAL_VALUE    = "CONFIRMED_INCREMENTAL_VALUE"
    NO_CONFIRMED_INCREMENTAL_VALUE = "NO_CONFIRMED_INCREMENTAL_VALUE"
    INSUFFICIENT_EVIDENCE          = "INSUFFICIENT_EVIDENCE"


class SafetyAblationError(ValueError):
    """Raised if a caller tries to ablate a safety component."""


def ablation_verdict(full_net: Optional[float], ablated_net: Optional[float],
                     ci_low: Optional[float] = None, ci_high: Optional[float] = None,
                     n: int = 0, min_n: int = 30) -> str:
    """
    Compare full system vs a variant with one NON-SAFETY component removed.
    A component only earns CONFIRMED_INCREMENTAL_VALUE if the paired delta
    (full − ablated) is positive AND its CI excludes zero. Without enough data
    → INSUFFICIENT_EVIDENCE. A real "adds nothing" → NO_CONFIRMED_INCREMENTAL_VALUE
    (a valid, honest result — not a defect).
    """
    if full_net is None or ablated_net is None or n < min_n:
        return AblationVerdict.INSUFFICIENT_EVIDENCE.value
    delta = full_net - ablated_net
    if ci_low is not None and ci_high is not None:
        if ci_low > 0.0:
            return AblationVerdict.CONFIRMED_INCREMENTAL_VALUE.value
        return AblationVerdict.NO_CONFIRMED_INCREMENTAL_VALUE.value
    # no CI available → cannot confirm significance
    return (AblationVerdict.NO_CONFIRMED_INCREMENTAL_VALUE.value
            if delta <= 0 else AblationVerdict.INSUFFICIENT_EVIDENCE.value)


def assert_ablatable(component: str) -> None:
    if component.upper() in SAFETY_COMPONENTS:
        raise SafetyAblationError(
            f"Refusing to ablate safety component {component!r} (spec §21).")


# ══════════════════════════════════════════════════════════════════════════════
# §22 RL comparison — execution quality only, paired, never gross PnL
# ══════════════════════════════════════════════════════════════════════════════

RL_EXECUTION_DIMENSIONS = (
    "implementation_shortfall_bps", "slippage_bps", "fill_rate",
    "completion_rate", "cost_bps", "risk", "inventory", "deadline_adherence",
)


@dataclass
class RLComparison:
    dimension:   str
    baseline:    Optional[float] = None
    rl:          Optional[float] = None
    delta:       Optional[float] = None       # rl − baseline (paired)
    ci_low:      Optional[float] = None
    ci_high:     Optional[float] = None
    n:           int = 0
    status:      str = "INSUFFICIENT_EVIDENCE"

    def to_dict(self) -> dict:
        return asdict(self)


def rl_execution_comparison(paired: dict, min_n: int = 30) -> dict:
    """
    Compare RL execution policy vs a deterministic baseline on execution-quality
    dimensions ONLY (spec §22). `paired` maps dimension →
    {"baseline": v, "rl": v, "ci_low": v, "ci_high": v, "n": int}. Every reported
    delta is paired and carries n + CI; thin dimensions stay INSUFFICIENT_EVIDENCE.
    NO gross-PnL claim is produced here.
    """
    out: list[dict] = []
    for dim in RL_EXECUTION_DIMENSIONS:
        e = paired.get(dim) or {}
        b, rl = e.get("baseline"), e.get("rl")
        n = int(e.get("n", 0))
        c = RLComparison(dimension=dim, baseline=b, rl=rl, n=n,
                         ci_low=e.get("ci_low"), ci_high=e.get("ci_high"))
        if b is not None and rl is not None and n >= min_n:
            c.delta = float(rl - b)
            c.status = "MEASURED"
        out.append(c.to_dict())
    return {"dimensions": out, "min_n": min_n,
            "note": "execution-quality only; gross PnL is NOT a valid RL metric here"}


# ══════════════════════════════════════════════════════════════════════════════
# §23 Cost attribution — gross → net (real Indian costs)
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class CostAttribution:
    gross_pnl:       float = 0.0
    brokerage:       float = 0.0
    stt:             float = 0.0            # securities transaction tax
    exchange_charge: float = 0.0
    gst:             float = 0.0
    sebi_charge:     float = 0.0
    stamp_duty:      float = 0.0
    slippage:        float = 0.0
    market_impact:   float = 0.0
    turnover_drag:   float = 0.0
    net_pnl:         float = 0.0

    @property
    def total_costs(self) -> float:
        return (self.brokerage + self.stt + self.exchange_charge + self.gst
                + self.sebi_charge + self.stamp_duty + self.slippage
                + self.market_impact + self.turnover_drag)

    def reconciles(self, tol: float = 0.01) -> bool:
        return abs((self.gross_pnl - self.total_costs) - self.net_pnl) <= tol

    def to_dict(self) -> dict:
        d = asdict(self)
        d["total_costs"] = self.total_costs
        d["reconciles"] = self.reconciles()
        return d


def cost_attribution(gross_pnl: float, cost_components: dict,
                     slippage: float = 0.0, market_impact: float = 0.0,
                     turnover_drag: float = 0.0) -> CostAttribution:
    """
    Build a gross→net decomposition. `cost_components` is a Phase-3G
    CostBreakdown.to_dict() (brokerage/stt/exchange_charge/gst/sebi_charge/
    stamp_duty). Net is COMPUTED = gross − all costs (never asserted). The
    caller reports NET as the economic result; gross alone is never the headline.
    """
    ca = CostAttribution(
        gross_pnl=float(gross_pnl),
        brokerage=float(cost_components.get("brokerage", 0.0)),
        stt=float(cost_components.get("stt", 0.0)),
        exchange_charge=float(cost_components.get("exchange_charge", 0.0)),
        gst=float(cost_components.get("gst", 0.0)),
        sebi_charge=float(cost_components.get("sebi_charge", 0.0)),
        stamp_duty=float(cost_components.get("stamp_duty", 0.0)),
        slippage=float(slippage),
        market_impact=float(market_impact),
        turnover_drag=float(turnover_drag),
    )
    ca.net_pnl = ca.gross_pnl - ca.total_costs
    return ca


# ══════════════════════════════════════════════════════════════════════════════
# §24 Turnover
# ══════════════════════════════════════════════════════════════════════════════

def turnover_analysis(traded_notional: list[float], avg_capital: float) -> dict:
    """
    Turnover ratio = Σ|traded notional| / average deployed capital. Returns
    UNAVAILABLE if capital is not positive (never divide by a guessed base).
    """
    total = float(np.sum(np.abs(np.asarray(traded_notional, dtype=float)))) if traded_notional else 0.0
    if avg_capital is None or avg_capital <= 0:
        return {"total_traded_notional": total, "avg_capital": avg_capital,
                "turnover_ratio": None, "status": "UNAVAILABLE"}
    return {"total_traded_notional": total, "avg_capital": float(avg_capital),
            "turnover_ratio": total / float(avg_capital), "status": "OK",
            "n_trades": len(traded_notional)}


# ══════════════════════════════════════════════════════════════════════════════
# §25 Capacity — never invented
# ══════════════════════════════════════════════════════════════════════════════

class CapacityStatus(str, Enum):
    OK                   = "OK"
    CAPACITY_INSUFFICIENT_EVIDENCE = "CAPACITY_INSUFFICIENT_EVIDENCE"


def capacity_analysis(adv_by_instrument: Optional[dict] = None,
                      participation_by_instrument: Optional[dict] = None,
                      max_participation: float = 0.10) -> dict:
    """
    Capacity requires REAL average-daily-volume (ADV) and observed participation.
    If either is missing/empty → CAPACITY_INSUFFICIENT_EVIDENCE (spec §25). We do
    NOT invent an ADV or a capacity ceiling. When present, flag any instrument
    whose participation exceeds `max_participation` as capacity-constrained.
    """
    if not adv_by_instrument or not participation_by_instrument:
        return {"status": CapacityStatus.CAPACITY_INSUFFICIENT_EVIDENCE.value,
                "reason": "no real ADV / participation data supplied",
                "constrained": [], "max_participation": max_participation}
    constrained = [
        inst for inst, part in participation_by_instrument.items()
        if part is not None and part > max_participation
    ]
    return {"status": CapacityStatus.OK.value,
            "max_participation": max_participation,
            "constrained": sorted(constrained),
            "n_instruments": len(adv_by_instrument)}
