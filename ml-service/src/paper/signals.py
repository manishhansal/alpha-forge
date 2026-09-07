"""
Phase 3N — Canonical signal aggregation + deduplication + conflict classification
(spec §18–§21).

AlphaForge produces signals from many families across two codebases. This module
does NOT re-implement any of them and does NOT introduce a new voting scheme. It:

  §18  defines ONE canonical `CanonicalSignal` contract that every family's output
       can be adapted into (adapters, not rewrites);
  §19  enumerates the discovered signal families (`SignalFamily`) so coverage is
       explicit and auditable;
  §20  deduplicates correlated evidence via `evidence_group` so four correlated
       momentum reads do not count as four independent pieces of evidence;
  §21  classifies conflicts (STRONG/WEAK/REGIME/TIMEFRAME/DATA/MODEL) and maps the
       aggregate to a proposed action state (TAKE/SKIP/ABSTAIN/INSUFFICIENT_EVIDENCE)
       whose FINAL resolution is owned by the existing `decision.DecisionPipeline`
       (this module produces the aggregate + conflict record it consumes).

Discovered signal families (searched, not assumed — spec §19)
-------------------------------------------------------------
  ml-service/src:
    ranking/ranker.py            StockRanker + Momentum/Composite/Ridge/ElasticNet/
                                 LightGBM/XGBoost baselines  → CROSS_SECTIONAL_RANK
    models/stock_ranker.py       StockRanker (LightGBM)       → CROSS_SECTIONAL_RANK
    models/strategy_selector.py  CatBoost strategy selector   → STRATEGY_SELECTION
    models/market_regime.py      XGBoost regime classifier    → MARKET_REGIME
    iv_regime_classifier.py      IVClassifier                 → IV_REGIME
    price_forecaster.py          PriceForecaster              → PRICE_FORECAST
    gex.py / greeks.py           gamma exposure / Greeks      → DERIVATIVES_GEX / GREEKS
    meta/ (ensemble, meta_ranker, meta_model)  MetaDecisionEngine → META_LABEL
    rl/                          RL execution challenger      → RL_EXECUTION
    stability/                   SignalHealth                 → (health, not a signal)
  Next.js src/features/ai-signals + src/services/india/scanner:
    confluence factors: OI build-up, PCR, IV, VWAP, volume thrust, delivery,
    market-structure/FVG/order-block/liquidity, news sentiment → mapped to the
    corresponding families below via adapters at the API boundary (Task 9).

Determinism: pure stdlib + numpy. Import-clean (no talib/torch/sklearn at load).
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field, asdict
from enum import Enum
from typing import Optional

# ══════════════════════════════════════════════════════════════════════════════
# §19 Signal families (discovered by repo search)
# ══════════════════════════════════════════════════════════════════════════════

class SignalFamily(str, Enum):
    CROSS_SECTIONAL_RANK = "CROSS_SECTIONAL_RANK"   # ranking/ + models/stock_ranker
    STRATEGY_SELECTION   = "STRATEGY_SELECTION"     # models/strategy_selector
    MARKET_REGIME        = "MARKET_REGIME"          # models/market_regime
    IV_REGIME            = "IV_REGIME"              # iv_regime_classifier
    PRICE_FORECAST       = "PRICE_FORECAST"         # price_forecaster
    DERIVATIVES_GEX      = "DERIVATIVES_GEX"        # gex
    GREEKS               = "GREEKS"                 # greeks
    OI_STRUCTURE         = "OI_STRUCTURE"           # OI build-up / PCR (india-builder)
    MOMENTUM             = "MOMENTUM"               # momentum/trend confluence
    MEAN_REVERSION       = "MEAN_REVERSION"
    BREAKOUT             = "BREAKOUT"
    MARKET_STRUCTURE     = "MARKET_STRUCTURE"       # FVG / order-block / liquidity
    VWAP                 = "VWAP"
    VOLUME               = "VOLUME"                 # volume thrust / delivery
    NEWS_SENTIMENT       = "NEWS_SENTIMENT"
    META_LABEL           = "META_LABEL"             # meta/ MetaDecisionEngine
    RL_EXECUTION         = "RL_EXECUTION"           # rl/ challenger (execution, not alpha)
    UNKNOWN              = "UNKNOWN"


class Direction(str, Enum):
    LONG    = "LONG"
    SHORT   = "SHORT"
    NEUTRAL = "NEUTRAL"


class EvidenceLevel(str, Enum):
    """Evidence quality (mirrors prediction_provenance semantics)."""
    TRAINED_MODEL         = "trained_model"
    HEURISTIC             = "heuristic"
    INSUFFICIENT_EVIDENCE = "insufficient_evidence"
    UNAVAILABLE           = "unavailable"


class SignalStatus(str, Enum):
    ACTIVE                = "ACTIVE"
    STALE                 = "STALE"
    DATA_UNAVAILABLE      = "DATA_UNAVAILABLE"
    MODEL_UNAVAILABLE     = "MODEL_UNAVAILABLE"
    INSUFFICIENT_EVIDENCE = "INSUFFICIENT_EVIDENCE"


# ══════════════════════════════════════════════════════════════════════════════
# §18 Canonical signal contract
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class CanonicalSignal:
    """
    ONE canonical signal record (spec §18). Every family's output is ADAPTED into
    this — never conflating the distinct quantities (spec 3M invariant):
    alpha_score ≠ probability ≠ expected_return ≠ expected_value.
    """
    signal_id:        str
    signal_family:    str                 # SignalFamily value
    instrument:       str
    timestamp:        str                 # ISO-8601 UTC (information time)
    direction:        str = Direction.NEUTRAL.value
    strength:         Optional[float] = None   # family-native magnitude, [-1,1] or [0,1]
    confidence:       Optional[float] = None   # [0,1]
    alpha_score:      Optional[float] = None
    expected_return:  Optional[float] = None
    probability:      Optional[float] = None   # calibrated probability if available
    expected_value:   Optional[float] = None
    timeframe:        str = ""
    regime:           Optional[str] = None
    source_model:     str = ""
    source_strategy:  str = ""
    evidence_level:   str = EvidenceLevel.UNAVAILABLE.value
    status:           str = SignalStatus.ACTIVE.value
    # correlated-evidence grouping (spec §20). Signals sharing an evidence_group
    # are treated as ONE piece of evidence, not N.
    evidence_group:   str = ""
    provenance:       dict = field(default_factory=dict)

    def __post_init__(self):
        if not self.evidence_group:
            # default group = family+direction+timeframe (correlated by construction)
            self.evidence_group = f"{self.signal_family}:{self.direction}:{self.timeframe}"

    @property
    def usable(self) -> bool:
        """Usable evidence unless data/model unavailable or insufficient."""
        return self.status not in (
            SignalStatus.DATA_UNAVAILABLE.value,
            SignalStatus.MODEL_UNAVAILABLE.value,
            SignalStatus.INSUFFICIENT_EVIDENCE.value,
        ) and self.evidence_level not in (
            EvidenceLevel.UNAVAILABLE.value, EvidenceLevel.INSUFFICIENT_EVIDENCE.value,
        )

    @property
    def signed_strength(self) -> Optional[float]:
        """Strength signed by direction; None if strength unavailable."""
        if self.strength is None:
            return None
        s = abs(self.strength)
        if self.direction == Direction.LONG.value:
            return s
        if self.direction == Direction.SHORT.value:
            return -s
        return 0.0

    def to_dict(self) -> dict:
        d = asdict(self)
        d["usable"] = self.usable
        return d

    @classmethod
    def from_dict(cls, d: dict) -> "CanonicalSignal":
        known = {f for f in cls.__dataclass_fields__}  # type: ignore[attr-defined]
        return cls(**{k: v for k, v in d.items() if k in known})

    @staticmethod
    def new_id(family: str, instrument: str, timestamp: str) -> str:
        raw = f"{family}|{instrument}|{timestamp}"
        return "sig-" + hashlib.sha256(raw.encode()).hexdigest()[:16]


# ══════════════════════════════════════════════════════════════════════════════
# §21 Conflict classification
# ══════════════════════════════════════════════════════════════════════════════

class ConflictType(str, Enum):
    NONE              = "NONE"
    STRONG_CONFLICT   = "STRONG_CONFLICT"    # strong long vs strong short
    WEAK_CONFLICT     = "WEAK_CONFLICT"      # mild disagreement
    REGIME_CONFLICT   = "REGIME_CONFLICT"    # signals disagree on regime
    TIMEFRAME_CONFLICT = "TIMEFRAME_CONFLICT" # different timeframes disagree
    DATA_CONFLICT     = "DATA_CONFLICT"      # data-availability disagreement
    MODEL_CONFLICT    = "MODEL_CONFLICT"     # model-provenance disagreement


class ProposedAction(str, Enum):
    """Proposed action state — FINAL resolution owned by DecisionPipeline."""
    TAKE                  = "TAKE"
    SKIP                  = "SKIP"
    ABSTAIN               = "ABSTAIN"
    INSUFFICIENT_EVIDENCE = "INSUFFICIENT_EVIDENCE"


@dataclass(frozen=True)
class AggregationPolicy:
    """Config-driven aggregation thresholds (spec §20, §21) — no hard-coded literals."""
    version: str = "3n-signal-aggregation-v1"
    min_usable_groups: int = 1          # below this → INSUFFICIENT_EVIDENCE
    strong_threshold: float = 0.5       # |net signed strength| for a "strong" side
    strong_conflict_threshold: float = 0.5  # both sides strong → STRONG_CONFLICT
    take_threshold: float = 0.35        # |net| above which the aggregate proposes TAKE


@dataclass
class SignalAggregate:
    """
    Aggregated view of many signals for one instrument (spec §18, §20, §21).
    Deduplicated by evidence_group; conflict-classified; proposes an action state.
    """
    instrument:        str
    timestamp:         str
    n_signals:         int
    n_usable_groups:   int
    long_groups:       int
    short_groups:      int
    neutral_groups:    int
    net_signed_strength: Optional[float]
    conflict:          str                    # ConflictType value
    proposed_action:   str                    # ProposedAction value
    dominant_direction: str                   # Direction value
    families:          list[str] = field(default_factory=list)
    evidence_groups:   list[str] = field(default_factory=list)
    reasons:           list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


def aggregate_signals(signals: list[CanonicalSignal],
                      policy: Optional[AggregationPolicy] = None) -> SignalAggregate:
    """
    Aggregate signals for ONE instrument at ONE timestamp (spec §18–§21).

    Deduplication (§20): signals sharing an `evidence_group` collapse to a single
    group verdict (the strongest-confidence member), so correlated reads (RSI +
    MACD + EMA momentum) count once, not N times.

    Conflict (§21): classified from the surviving group directions. The proposed
    action is a conservative mapping the DecisionPipeline then owns:
      * no usable groups → INSUFFICIENT_EVIDENCE
      * strong two-sided disagreement → STRONG_CONFLICT → ABSTAIN
      * mixed but weak → WEAK_CONFLICT → SKIP
      * aligned + above take_threshold → TAKE
      * aligned but weak → SKIP
    This module NEVER emits a live order and NEVER overrides the DecisionPipeline.
    """
    pol = policy or AggregationPolicy()
    inst = signals[0].instrument if signals else ""
    ts = signals[0].timestamp if signals else ""

    usable = [s for s in signals if s.usable]

    # §20 dedup: collapse each evidence_group to its highest-confidence member
    groups: dict[str, CanonicalSignal] = {}
    for s in usable:
        cur = groups.get(s.evidence_group)
        if cur is None or (s.confidence or 0) > (cur.confidence or 0):
            groups[s.evidence_group] = s
    group_signals = list(groups.values())

    long_g = [s for s in group_signals if s.direction == Direction.LONG.value]
    short_g = [s for s in group_signals if s.direction == Direction.SHORT.value]
    neutral_g = [s for s in group_signals if s.direction == Direction.NEUTRAL.value]

    reasons: list[str] = []

    # net signed strength across surviving groups (None if none carry strength)
    signed = [s.signed_strength for s in group_signals if s.signed_strength is not None]
    net = (sum(signed) / len(signed)) if signed else None

    # strength of each side (mean of |signed| on that side)
    def _side_strength(side: list[CanonicalSignal]) -> float:
        vals = [abs(s.signed_strength) for s in side if s.signed_strength is not None]
        return (sum(vals) / len(vals)) if vals else 0.0
    long_s, short_s = _side_strength(long_g), _side_strength(short_g)

    # ── INSUFFICIENT_EVIDENCE: not enough usable, deduplicated evidence ──
    if len(group_signals) < pol.min_usable_groups:
        reasons.append(f"only {len(group_signals)} usable evidence group(s)")
        return SignalAggregate(
            instrument=inst, timestamp=ts, n_signals=len(signals),
            n_usable_groups=len(group_signals), long_groups=len(long_g),
            short_groups=len(short_g), neutral_groups=len(neutral_g),
            net_signed_strength=net, conflict=ConflictType.NONE.value,
            proposed_action=ProposedAction.INSUFFICIENT_EVIDENCE.value,
            dominant_direction=Direction.NEUTRAL.value,
            families=sorted({s.signal_family for s in signals}),
            evidence_groups=sorted(groups.keys()), reasons=reasons)

    # ── conflict classification (§21) ──
    conflict = ConflictType.NONE.value
    regimes = {s.regime for s in group_signals if s.regime}
    timeframes = {s.timeframe for s in group_signals if s.timeframe}

    if long_g and short_g:
        if long_s >= pol.strong_conflict_threshold and short_s >= pol.strong_conflict_threshold:
            conflict = ConflictType.STRONG_CONFLICT.value
            reasons.append(f"strong two-sided: long={long_s:.2f} short={short_s:.2f}")
        else:
            conflict = ConflictType.WEAK_CONFLICT.value
            reasons.append(f"weak two-sided: long={long_s:.2f} short={short_s:.2f}")
        if len(regimes) > 1:
            conflict = ConflictType.REGIME_CONFLICT.value
            reasons.append(f"regime disagreement: {sorted(regimes)}")
        elif len(timeframes) > 1:
            # only downgrade to timeframe conflict if not already strong
            if conflict == ConflictType.WEAK_CONFLICT.value:
                conflict = ConflictType.TIMEFRAME_CONFLICT.value
                reasons.append(f"timeframe disagreement: {sorted(timeframes)}")

    # model-provenance disagreement: some trained, some heuristic, taking sides
    levels = {s.evidence_level for s in group_signals}
    if (EvidenceLevel.TRAINED_MODEL.value in levels
            and EvidenceLevel.HEURISTIC.value in levels and (long_g and short_g)):
        conflict = ConflictType.MODEL_CONFLICT.value
        reasons.append("trained vs heuristic disagreement")

    # ── proposed action (conservative; DecisionPipeline owns the final call) ──
    dominant = Direction.NEUTRAL.value
    if net is not None:
        dominant = (Direction.LONG.value if net > 0
                    else Direction.SHORT.value if net < 0 else Direction.NEUTRAL.value)

    if conflict == ConflictType.STRONG_CONFLICT.value or conflict == ConflictType.REGIME_CONFLICT.value:
        action = ProposedAction.ABSTAIN.value
    elif conflict in (ConflictType.WEAK_CONFLICT.value, ConflictType.TIMEFRAME_CONFLICT.value,
                      ConflictType.MODEL_CONFLICT.value):
        action = ProposedAction.SKIP.value
    elif net is not None and abs(net) >= pol.take_threshold:
        action = ProposedAction.TAKE.value
        reasons.append(f"aligned net={net:.2f} >= take_threshold {pol.take_threshold}")
    else:
        action = ProposedAction.SKIP.value
        reasons.append(f"aligned but weak (net={net if net is None else round(net,2)})")

    return SignalAggregate(
        instrument=inst, timestamp=ts, n_signals=len(signals),
        n_usable_groups=len(group_signals), long_groups=len(long_g),
        short_groups=len(short_g), neutral_groups=len(neutral_g),
        net_signed_strength=net, conflict=conflict, proposed_action=action,
        dominant_direction=dominant,
        families=sorted({s.signal_family for s in signals}),
        evidence_groups=sorted(groups.keys()), reasons=reasons)
