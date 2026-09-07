"""
Phase 3R — Evidence, analytics & multi-session aggregation (spec §24-§37).

This is an EVIDENCE / ANALYTICS layer. It NEVER optimises anything from paper
results (no threshold tuning, no signal re-weighting, no auto retrain / recalibrate
/ promote — spec §25, §26, §33, §56). It composes the existing statistical engine
(`paper.evidence`: bootstrap CIs, INSUFFICIENT_EVIDENCE gating), the existing
decision journal (`paper3o.journals`), the existing evidence tiers +
multi-session store (`paper3o.evidence_store`), and the 3Q signal-family +
double-counting audit (`data_reliability.signal_matrix`).

Only VALID + RECONCILED (OFFICIAL) sessions may enter aggregate results (spec §37).
Statistical significance is never claimed below the policy's minimum sample
(spec §28).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Optional


# ══════════════════════════════════════════════════════════════════════════════
# §26 Abstention analysis (frequency/conditions only — never threshold tuning)
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class AbstentionSummary:
    """
    Frequency of each decision outcome (spec §26). Documents WHY the system did not
    trade. It explicitly does NOT propose new thresholds — optimising abstention
    from the same evidence is forbidden (spec §26, §56).
    """
    counts:      dict = field(default_factory=dict)   # outcome -> count
    total:       int = 0
    optimization_performed: bool = False              # invariant: MUST stay False

    @property
    def take_rate(self) -> Optional[float]:
        if self.total == 0:
            return None
        return self.counts.get("TAKE", 0) / self.total

    def rate(self, outcome: str) -> Optional[float]:
        if self.total == 0:
            return None
        return self.counts.get(outcome, 0) / self.total

    def to_dict(self) -> dict:
        return {"counts": dict(self.counts), "total": self.total,
                "take_rate": self.take_rate,
                "optimization_performed": self.optimization_performed}


def summarize_abstention(outcomes: list[str]) -> AbstentionSummary:
    """
    Count TAKE/SKIP/ABSTAIN/INSUFFICIENT_EVIDENCE/BLOCKED/UNAVAILABLE etc. from the
    decision journal (spec §26). Pure frequency — no optimisation.
    """
    counts: dict[str, int] = {}
    for o in outcomes:
        counts[o] = counts.get(o, 0) + 1
    return AbstentionSummary(counts=counts, total=len(outcomes))


# ══════════════════════════════════════════════════════════════════════════════
# §27-§28 Paper performance + statistical uncertainty (reuse paper.evidence)
# ══════════════════════════════════════════════════════════════════════════════

def paper_performance(
    daily_returns: list[float],
    trade_pnls: list[float],
    prob_outcome_pairs: Optional[list[tuple]] = None,
    policy=None,
    window: str = "",
    data_tag: str = "SYNTHETIC_DATA",
) -> dict:
    """
    Full performance block with per-metric uncertainty + INSUFFICIENT_EVIDENCE
    gating, delegated ENTIRELY to the reused `paper.evidence` engine (spec §27-§28).
    Every metric carries n / n_eff / CI / status; below the policy minimum the
    status is INSUFFICIENT_EVIDENCE — significance is never claimed on a tiny
    sample (spec §28).
    """
    from src.paper.evidence import (
        compute_return_metrics, compute_trading_metrics, compute_decision_quality,
        EvidencePolicy,
    )
    pol = policy or EvidencePolicy()
    out = {
        "returns": compute_return_metrics(daily_returns, pol, window, data_tag),
        "trading": compute_trading_metrics(trade_pnls, pol, window, data_tag),
        "policy": {"min_observations": pol.min_observations,
                   "ci_level": pol.ci_level, "version": pol.version},
        "n_daily": len([x for x in daily_returns if x is not None]),
        "n_trades": len([x for x in trade_pnls if x is not None]),
    }
    if prob_outcome_pairs is not None:
        out["decision_quality"] = compute_decision_quality(
            prob_outcome_pairs, pol, window, data_tag)
    out["insufficient_sample"] = out["n_trades"] < pol.min_observations
    return out


# ══════════════════════════════════════════════════════════════════════════════
# §29 Benchmarks
# ══════════════════════════════════════════════════════════════════════════════

class Benchmark(str, Enum):
    NIFTY_BUY_HOLD  = "NIFTY_BUY_HOLD"
    SECTOR          = "SECTOR"
    CASH            = "CASH"
    SIMPLE_TREND    = "SIMPLE_TREND"
    SIMPLE_MOMENTUM = "SIMPLE_MOMENTUM"
    TWAP            = "TWAP"            # execution benchmark
    VWAP_PROXY      = "VWAP_PROXY"      # execution benchmark


def benchmark_relative(strategy_return: float, benchmark_return: float) -> float:
    """Excess return over a benchmark (spec §29). Pure arithmetic; no tuning."""
    return strategy_return - benchmark_return


# ══════════════════════════════════════════════════════════════════════════════
# §30 Alpha attribution (documentary decomposition)
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class AlphaAttribution:
    """
    Documentary decomposition of paper return into components (spec §30). This is a
    reporting breakdown only — it does not re-weight or optimise anything.
    """
    total_return:    float
    market_beta:     float = 0.0
    sector_exposure: float = 0.0
    factor_exposure: float = 0.0
    stock_selection: float = 0.0
    timing:          float = 0.0
    execution:       float = 0.0
    costs:           float = 0.0

    @property
    def residual(self) -> float:
        explained = (self.market_beta + self.sector_exposure + self.factor_exposure
                     + self.stock_selection + self.timing + self.execution + self.costs)
        return self.total_return - explained

    def to_dict(self) -> dict:
        return {"total_return": self.total_return, "market_beta": self.market_beta,
                "sector_exposure": self.sector_exposure, "factor_exposure": self.factor_exposure,
                "stock_selection": self.stock_selection, "timing": self.timing,
                "execution": self.execution, "costs": self.costs, "residual": self.residual}


# ══════════════════════════════════════════════════════════════════════════════
# §31 Regime analysis (report per regime; never cherry-pick)
# ══════════════════════════════════════════════════════════════════════════════

class MarketRegime(str, Enum):
    BULL          = "BULL"
    BEAR          = "BEAR"
    SIDEWAYS      = "SIDEWAYS"
    HIGH_VOL      = "HIGH_VOL"
    LOW_VOL       = "LOW_VOL"
    TRENDING      = "TRENDING"
    MEAN_REVERTING = "MEAN_REVERTING"


def performance_by_regime(regime_returns: dict[str, list[float]], policy=None) -> dict:
    """
    Compute the performance block for EVERY regime present (spec §31). Reporting
    all regimes (not just favourable ones) is the anti-cherry-pick guarantee.
    """
    return {regime: paper_performance(rets, rets, policy=policy)
            for regime, rets in regime_returns.items()}


# ══════════════════════════════════════════════════════════════════════════════
# §32 Signal-family analysis (no double-counting — reuse the 3Q audit)
# ══════════════════════════════════════════════════════════════════════════════

def signal_family_activity(family_decision_map: dict[str, int]) -> dict:
    """
    Report per-family decision activity, and surface the documented overlaps from
    the 3Q double-counting audit so contributions are not naively summed
    (spec §32). Never removes a family or re-weights (spec §35 of 3Q).
    """
    from src.data_reliability import audit_notes, SignalFamily
    valid = {f.value for f in SignalFamily}
    activity = {k: v for k, v in family_decision_map.items() if k in valid}
    overlaps = [n.to_dict() for n in audit_notes()]
    return {"activity": activity, "documented_overlaps": overlaps,
            "double_counting_warning": len(overlaps) > 0}


# ══════════════════════════════════════════════════════════════════════════════
# §33 Model drift — evidence only (NO auto retrain/recalibrate/promote)
# ══════════════════════════════════════════════════════════════════════════════

class DriftSignal(str, Enum):
    PREDICTION_DISTRIBUTION = "PREDICTION_DISTRIBUTION"
    PROBABILITY_DISTRIBUTION = "PROBABILITY_DISTRIBUTION"
    CALIBRATION             = "CALIBRATION"
    FEATURE_DRIFT           = "FEATURE_DRIFT"
    MISSING_FEATURES        = "MISSING_FEATURES"
    REGIME_DRIFT            = "REGIME_DRIFT"
    MODEL_LATENCY           = "MODEL_LATENCY"
    PREDICTION_FAILURE      = "PREDICTION_FAILURE"


@dataclass
class DriftEvidence:
    """
    A drift observation (spec §33). It is EVIDENCE ONLY: it never triggers a
    retrain, recalibration, or promotion — those actions are forbidden here.
    """
    signal:   str            # DriftSignal value
    magnitude: float
    detail:   str = ""
    auto_action_taken: bool = False    # invariant: MUST stay False (spec §33, §56)

    def to_dict(self) -> dict:
        return {"signal": self.signal, "magnitude": self.magnitude,
                "detail": self.detail, "auto_action_taken": self.auto_action_taken}


# ══════════════════════════════════════════════════════════════════════════════
# §36 Session invalidation reasons
# ══════════════════════════════════════════════════════════════════════════════

class InvalidationReason(str, Enum):
    FUTURE_INFORMATION      = "FUTURE_INFORMATION"
    CORRUPT_SNAPSHOT        = "CORRUPT_SNAPSHOT"
    INVALID_TIMESTAMP       = "INVALID_TIMESTAMP"
    MODEL_IDENTITY_CHANGED  = "MODEL_IDENTITY_CHANGED"
    CONFIG_CHANGED          = "CONFIG_CHANGED"
    LEDGER_CORRUPTION       = "LEDGER_CORRUPTION"
    RECONCILIATION_FAILED   = "RECONCILIATION_FAILED"
    DUPLICATE_CORRUPTION    = "DUPLICATE_CORRUPTION"
    LIVE_INTERACTION        = "LIVE_INTERACTION"
    INCOMPLETE_PROVENANCE   = "INCOMPLETE_PROVENANCE"


INVALIDATION_REASONS: tuple[str, ...] = tuple(r.value for r in InvalidationReason)


# ══════════════════════════════════════════════════════════════════════════════
# §35 Evidence tiers (reuse paper3o.evidence_store; never over-claim)
# ══════════════════════════════════════════════════════════════════════════════

def can_claim_tier(tier: str, n_official_sessions: int, n_regimes: int) -> bool:
    """
    Guard against over-claiming an evidence tier (spec §35). E3+ (statistically
    meaningful) requires a real body of official sessions across >= 2 regimes;
    E4/E5 additionally require independent validation which paper alone cannot
    supply. Returns True only if the requested tier is defensible.
    """
    from src.paper3o.evidence_store import EvidenceTier
    t = EvidenceTier(tier)
    if t in (EvidenceTier.E0, EvidenceTier.E1, EvidenceTier.E2):
        return True   # synthetic / few-session tiers are always claimable
    if t == EvidenceTier.E3:
        return n_official_sessions >= 20 and n_regimes >= 2
    # E4/E5 need independent + reproducible validation → never from paper alone
    return False


# ══════════════════════════════════════════════════════════════════════════════
# §37 Multi-session aggregation (OFFICIAL sessions only)
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class MultiSessionAggregate:
    """
    Aggregate over ONLY valid + reconciled (OFFICIAL) sessions (spec §37).
    Invalidated / quarantined / pending sessions are excluded — never cherry-picked
    in or out beyond that objective rule.
    """
    n_official:        int
    n_excluded:        int
    cumulative_net_pnl: float
    equity_curve:      list = field(default_factory=list)   # cumulative net pnl per session
    daily_net_pnls:    list = field(default_factory=list)
    max_drawdown:      float = 0.0

    def to_dict(self) -> dict:
        return {"n_official": self.n_official, "n_excluded": self.n_excluded,
                "cumulative_net_pnl": self.cumulative_net_pnl,
                "equity_curve": self.equity_curve, "daily_net_pnls": self.daily_net_pnls,
                "max_drawdown": self.max_drawdown}


def aggregate_sessions(sessions: list) -> MultiSessionAggregate:
    """
    Build the cumulative equity curve + drawdown from OFFICIAL sessions only
    (spec §37). `sessions` is a list of objects/dicts each exposing `is_official`
    (or evidence_status == 'OFFICIAL') and a `net_pnl`. Non-official sessions are
    counted as excluded and contribute nothing.
    """
    equity: list[float] = []
    daily: list[float] = []
    cum = 0.0
    peak = 0.0
    max_dd = 0.0
    n_official = 0
    n_excluded = 0

    for s in sessions:
        official = _is_official(s)
        if not official:
            n_excluded += 1
            continue
        pnl = _net_pnl(s)
        n_official += 1
        daily.append(pnl)
        cum += pnl
        equity.append(cum)
        peak = max(peak, cum)
        max_dd = max(max_dd, peak - cum)

    return MultiSessionAggregate(
        n_official=n_official, n_excluded=n_excluded, cumulative_net_pnl=cum,
        equity_curve=equity, daily_net_pnls=daily, max_drawdown=max_dd)


def _is_official(s) -> bool:
    if hasattr(s, "is_official"):
        return bool(s.is_official)
    if isinstance(s, dict):
        return (s.get("is_official") is True
                or s.get("evidence_status") == "OFFICIAL")
    return False


def _net_pnl(s) -> float:
    if isinstance(s, dict):
        return float(s.get("net_pnl", 0.0) or 0.0)
    return float(getattr(s, "net_pnl", 0.0) or 0.0)
