"""
Phase 3H — Portfolio Intelligence Schemas.

Canonical types for the portfolio construction layer.

Semantic contract (spec §4)
---------------------------
These quantities are DIFFERENT and must never be confused:

    rank_score          — relative attractiveness signal (0-100 or z-score)
    probability         — calibrated P(success) from meta model
    expected_return     — estimated conditional return %
    expected_value      — probability-weighted net payoff after costs
    risk                — volatility / CVaR / variance
    portfolio_weight    — capital allocation fraction
    position_size       — lots × lot_size × price = notional INR

Invariants
----------
1. PortfolioCandidate.expected_value must come from ExpectedValue.is_valid() == True
   or be None — never fabricated from rank_score arithmetic.
2. Weights in PortfolioTarget sum to ≤ 1.0 (long-only) or satisfy
   |sum(long_weights)| + |sum(short_weights)| = gross_exposure.
3. No uncontrolled randomness in any constructor or method.
4. PortfolioProvenance.provenance_hash is SHA-256 of all material inputs.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Optional

UTC = timezone.utc


# ══════════════════════════════════════════════════════════════════════════════
# Enumerations
# ══════════════════════════════════════════════════════════════════════════════

class PortfolioObjective(str, Enum):
    """Portfolio optimisation objective."""
    MIN_VARIANCE        = "MIN_VARIANCE"
    MAX_SHARPE          = "MAX_SHARPE"
    MAX_DIVERSIFICATION = "MAX_DIVERSIFICATION"
    CVaR_MINIMIZATION   = "CVaR_MINIMIZATION"
    RISK_BUDGETING      = "RISK_BUDGETING"
    EV_RISK_OPTIMIZATION = "EV_RISK_OPTIMIZATION"   # maximise EV / risk
    HRP                 = "HRP"                     # Hierarchical Risk Parity
    EQUAL_WEIGHT        = "EQUAL_WEIGHT"             # baseline
    INVERSE_VOL         = "INVERSE_VOL"              # baseline
    RANK_WEIGHTED       = "RANK_WEIGHTED"            # baseline (top-N rank equal weight)


class OptimizationStatus(str, Enum):
    """Result state of one optimization run."""
    OPTIMIZED                = "OPTIMIZED"
    FEASIBLE_FALLBACK        = "FEASIBLE_FALLBACK"   # fallback used; reason documented
    INFEASIBLE               = "INFEASIBLE"          # constraints are jointly infeasible
    INFEASIBLE_CONSTRAINT_SET = "INFEASIBLE_CONSTRAINT_SET"  # pre-solve feasibility check failed
    INSUFFICIENT_EVIDENCE    = "INSUFFICIENT_EVIDENCE"
    RISK_DATA_UNAVAILABLE    = "RISK_DATA_UNAVAILABLE"
    LIQUIDITY_DATA_UNAVAILABLE = "LIQUIDITY_DATA_UNAVAILABLE"
    COVARIANCE_UNAVAILABLE   = "COVARIANCE_UNAVAILABLE"
    NO_ELIGIBLE_CANDIDATES   = "NO_ELIGIBLE_CANDIDATES"
    SOLVER_ERROR             = "SOLVER_ERROR"


class EligibilityStatus(str, Enum):
    """Candidate eligibility at portfolio formation time."""
    ELIGIBLE                 = "ELIGIBLE"
    STALE_DATA               = "STALE_DATA"
    STALE_MODEL              = "STALE_MODEL"
    UNCALIBRATED_PROBABILITY = "UNCALIBRATED_PROBABILITY"
    INSUFFICIENT_EVIDENCE    = "INSUFFICIENT_EVIDENCE"
    EXECUTION_UNAVAILABLE    = "EXECUTION_UNAVAILABLE"
    INSUFFICIENT_LIQUIDITY   = "INSUFFICIENT_LIQUIDITY"
    INVALID_INSTRUMENT       = "INVALID_INSTRUMENT"
    EXPIRED_CONTRACT         = "EXPIRED_CONTRACT"
    FNO_BANNED               = "FNO_BANNED"
    MISSING_RISK_DATA        = "MISSING_RISK_DATA"
    MISSING_FACTOR_DATA      = "MISSING_FACTOR_DATA"
    DECISION_NOT_TAKE        = "DECISION_NOT_TAKE"   # decision != TAKE
    NEGATIVE_EV              = "NEGATIVE_EV"         # EV valid but ≤ 0 threshold
    ABSTAINED                = "ABSTAINED"            # decision == ABSTAIN


class CovarianceMethod(str, Enum):
    """How the covariance matrix was estimated."""
    HISTORICAL          = "HISTORICAL"         # sample covariance from returns
    EWMA                = "EWMA"               # exponentially weighted
    LEDOIT_WOLF         = "LEDOIT_WOLF"        # shrinkage: Ledoit-Wolf
    OAS                 = "OAS"                # Oracle Approximating Shrinkage
    CONSTANT_CORR       = "CONSTANT_CORR"      # constant-correlation shrinkage
    UNAVAILABLE         = "UNAVAILABLE"        # no returns available


class CovarianceStatus(str, Enum):
    """Quality status of the estimated covariance matrix."""
    VALID               = "VALID"
    PSD_REPAIRED        = "PSD_REPAIRED"       # eigenvalue floor applied; documented
    ILL_CONDITIONED     = "ILL_CONDITIONED"    # high condition number; use with caution
    INSUFFICIENT_SAMPLE = "INSUFFICIENT_SAMPLE"
    UNAVAILABLE         = "UNAVAILABLE"
    MISSINGNESS         = "MISSINGNESS"        # too many missing return observations


class SizingMethod(str, Enum):
    """How position sizes were derived."""
    EV_RISK_RATIO       = "EV_RISK_RATIO"      # positive_ev / volatility
    FRACTIONAL_KELLY    = "FRACTIONAL_KELLY"
    EQUAL_WEIGHT        = "EQUAL_WEIGHT"
    INVERSE_VOL         = "INVERSE_VOL"
    RISK_BUDGET         = "RISK_BUDGET"
    OPTIMIZER_WEIGHT    = "OPTIMIZER_WEIGHT"   # direct from optimizer
    KELLY_UNAVAILABLE   = "KELLY_UNAVAILABLE"  # prob/payoff not reliable
    UNAVAILABLE         = "UNAVAILABLE"


class RiskOverlayAction(str, Enum):
    """Portfolio-level risk overlay response."""
    NO_ACTION           = "NO_ACTION"
    REDUCE_RISK         = "REDUCE_RISK"        # scale down weights
    HALT_NEW_POSITIONS  = "HALT_NEW_POSITIONS" # no new entries; allow exits
    EXIT                = "EXIT"               # close all positions
    ABSTAIN             = "ABSTAIN"            # do not form portfolio this period


class RebalancePolicy(str, Enum):
    DAILY               = "DAILY"
    WEEKLY              = "WEEKLY"
    EVENT_DRIVEN        = "EVENT_DRIVEN"       # rebalance when signal changes
    SIGNAL_DRIVEN       = "SIGNAL_DRIVEN"      # rebalance when new TAKE decisions arrive


class PortfolioMode(str, Enum):
    LONG_ONLY           = "LONG_ONLY"
    LONG_SHORT          = "LONG_SHORT"


class ConstraintRelaxationPolicy(str, Enum):
    NONE                = "NONE"               # never relax; return INFEASIBLE
    ORDERED             = "ORDERED"            # relax in documented order
    REPORT_ONLY         = "REPORT_ONLY"        # solve unconstrained; flag violations


# ══════════════════════════════════════════════════════════════════════════════
# Portfolio candidate (input to the portfolio layer)
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class PortfolioCandidate:
    """
    A single candidate for portfolio construction.

    Populated from MetaDecisionOutput + execution metadata.

    Semantic invariants
    -------------------
    - alpha_score is NOT a probability and NOT an expected return.
    - calibrated_probability is None unless status == CALIBRATED.
    - expected_value is None unless EVStatus.is_valid().
    - expected_return is a separate quantity from expected_value.
    - price and adv_inr must come from market data — not fabricated.

    Never set expected_value from rank arithmetic.
    """
    # Identity
    instrument_id:      str
    underlying:         str
    formation_time:     datetime          # portfolio formation timestamp (PIT)

    # Ranking signal (from Phase 3E)
    alpha_score:        Optional[float] = None  # higher = more attractive
    rank_percentile:    Optional[float] = None  # 0–100; 100 = highest alpha
    alpha_score_semantics: str = "UNKNOWN"  # from AlphaScoreSemantics

    # Side
    side:               str = "LONG"      # "LONG" | "SHORT"

    # Meta-model outputs (from Phase 3F) — must not be fabricated
    calibrated_probability: Optional[float] = None   # None if not CALIBRATED
    probability_status: str = "UNAVAILABLE"          # ProbabilityStatus value
    expected_return:    Optional[float] = None        # E[return | signal], %
    expected_value:     Optional[float] = None        # net EV after costs, %
    ev_status:          str = "UNAVAILABLE"           # EVStatus value
    uncertainty:        Optional[float] = None        # 0–1; from meta model

    # Instrument metadata (from InstrumentMasterStore)
    instrument_type:    str = "FUT_IDX"  # InstrumentType value
    product_type:       str = "NRML"     # ProductType value
    lot_size:           int = 1
    expiry_date:        Optional[datetime] = None
    strike:             Optional[float] = None
    option_type:        Optional[str] = None    # "CE" | "PE"

    # Market data (from price feed)
    price:              Optional[float] = None   # close at formation_time
    adv_inr:            Optional[float] = None   # average daily value INR
    volatility_daily:   Optional[float] = None   # daily σ as fraction (e.g. 0.012)
    atr:                Optional[float] = None   # ATR in price units

    # Classification
    sector:             Optional[str] = None
    industry:           Optional[str] = None

    # Factor exposures (assets × factors matrix row)
    # Keys: "market", "size", "value", "momentum", "quality", "volatility", "liquidity"
    factor_exposures:   dict[str, float] = field(default_factory=dict)

    # Beta to benchmark
    beta:               Optional[float] = None   # β to NIFTY 50

    # Options Greeks (only for OPT_* instruments)
    delta:              Optional[float] = None
    gamma:              Optional[float] = None
    vega:               Optional[float] = None
    theta:              Optional[float] = None

    # Eligibility result (set by EligibilityFilter)
    eligibility_status: EligibilityStatus = EligibilityStatus.ELIGIBLE
    eligibility_reason: str = ""

    # Provenance
    model_id:           str = ""
    meta_model_id:      str = ""
    calibrator_id:      str = ""
    feature_set_id:     str = ""
    label_version:      str = "lv2"
    dataset_id:         str = ""
    data_snapshot_id:   str = ""

    @property
    def is_eligible(self) -> bool:
        return self.eligibility_status == EligibilityStatus.ELIGIBLE

    @property
    def notional_per_lot(self) -> Optional[float]:
        """Notional value of one lot at current price."""
        if self.price is None:
            return None
        return self.price * self.lot_size

    @property
    def is_fno(self) -> bool:
        return self.instrument_type in (
            "FUT_IDX", "FUT_STK",
            "OPT_IDX_CE", "OPT_IDX_PE",
            "OPT_STK_CE", "OPT_STK_PE",
        )

    @property
    def is_option(self) -> bool:
        return self.instrument_type.startswith("OPT_")


# ══════════════════════════════════════════════════════════════════════════════
# Covariance result
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class CovarianceResult:
    """
    Output of the risk model covariance estimation.

    If status != VALID and != PSD_REPAIRED, the covariance matrix
    must not be used for optimization — return COVARIANCE_UNAVAILABLE.
    """
    instruments:        list[str]          # ordered list of instrument IDs
    cov_matrix:         Optional[object]   # numpy ndarray (n × n) or None
    corr_matrix:        Optional[object]   # numpy ndarray (n × n) or None
    volatilities:       Optional[object]   # numpy ndarray (n,) daily σ or None

    method:             CovarianceMethod
    status:             CovarianceStatus
    n_observations:     int                # effective number of return observations
    sample_start:       Optional[datetime]
    sample_end:         Optional[datetime]

    # Shrinkage diagnostics
    shrinkage_coeff:    Optional[float] = None   # Ledoit-Wolf λ
    shrinkage_method:   str = "none"

    # PSD repair diagnostics (populated if status == PSD_REPAIRED)
    psd_repair_applied: bool = False
    min_pre_eigenvalue: Optional[float] = None   # smallest eigenvalue before repair
    min_post_eigenvalue: Optional[float] = None  # smallest eigenvalue after repair
    projection_method:  str = ""

    # Quality checks
    condition_number:   Optional[float] = None
    missingness_pct:    Optional[float] = None   # fraction of missing return obs
    notes:              str = ""

    @property
    def is_usable(self) -> bool:
        return self.status in (CovarianceStatus.VALID, CovarianceStatus.PSD_REPAIRED)


# ══════════════════════════════════════════════════════════════════════════════
# Constraint set
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class ConstraintSet:
    """
    Portfolio construction constraints.
    All limits are CONFIGURABLE — never hardcoded.
    None means unconstrained.
    """
    # Single-name limits
    max_position_weight:    Optional[float] = 0.15    # ≤ 15% per position
    min_position_weight:    Optional[float] = 0.0
    max_gross_position:     Optional[float] = None    # absolute INR limit

    # Sector limits
    max_sector_weight:      Optional[float] = 0.40
    min_sector_weight:      Optional[float] = None

    # Industry limits
    max_industry_weight:    Optional[float] = 0.25

    # Gross / net exposure
    max_gross_exposure:     Optional[float] = 1.0     # sum(abs(w)) ≤ 1.0
    max_net_exposure:       Optional[float] = 1.0     # sum(w)
    min_net_exposure:       Optional[float] = 0.0

    # Beta constraints
    max_portfolio_beta:     Optional[float] = None
    min_portfolio_beta:     Optional[float] = None

    # Factor constraints  {factor_name: (min, max)}
    factor_limits:          dict[str, tuple[Optional[float], Optional[float]]] = field(
        default_factory=dict
    )

    # Turnover limits
    max_daily_turnover:     Optional[float] = None    # fraction of portfolio value
    max_rebalance_turnover: Optional[float] = 0.50   # ≤ 50% change per rebalance

    # Liquidity limits
    max_order_pct_adv:      Optional[float] = 0.10   # ≤ 10% of ADV per order
    max_position_pct_adv:   Optional[float] = 0.20   # ≤ 20% of ADV per position

    # Position count
    max_positions:          int = 20
    min_positions:          int = 1

    # Portfolio mode
    mode:                   PortfolioMode = PortfolioMode.LONG_ONLY

    # Relaxation
    relaxation_policy:      ConstraintRelaxationPolicy = ConstraintRelaxationPolicy.NONE

    # Version (for provenance)
    version:                str = "constraints-v1"


# ══════════════════════════════════════════════════════════════════════════════
# Component risk
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class ComponentRisk:
    """
    Per-position risk decomposition.

    sum(component_risk) ≈ portfolio_risk  (within tolerance)
    """
    instrument_id:      str
    weight:             float
    marginal_risk:      float   # ∂σ_p / ∂w_i
    component_risk:     float   # w_i × marginal_risk
    risk_contribution_pct: float  # component_risk / portfolio_risk × 100


# ══════════════════════════════════════════════════════════════════════════════
# Exposure summary
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class ExposureSummary:
    """
    Portfolio exposure diagnostics produced by the analytics layer.
    All fields are Optional — unavailable data is explicit.
    """
    gross_exposure:     float = 0.0
    net_exposure:       float = 0.0
    long_exposure:      float = 0.0
    short_exposure:     float = 0.0
    cash_pct:           float = 1.0

    # Risk
    portfolio_volatility_daily: Optional[float] = None
    portfolio_volatility_annual: Optional[float] = None
    portfolio_cvar_95:  Optional[float] = None
    portfolio_beta:     Optional[float] = None
    long_beta:          Optional[float] = None
    short_beta:         Optional[float] = None

    # Sector exposures  {sector: weight}
    sector_weights:     dict[str, float] = field(default_factory=dict)
    industry_weights:   dict[str, float] = field(default_factory=dict)

    # Factor exposures  {factor: exposure}
    factor_exposures:   dict[str, float] = field(default_factory=dict)

    # Concentration
    hhi:                Optional[float] = None
    effective_n:        Optional[float] = None
    top_1_weight:       Optional[float] = None
    top_5_weight:       Optional[float] = None
    top_10_weight:      Optional[float] = None

    # Options Greeks (portfolio-level; None if no options)
    portfolio_delta:    Optional[float] = None
    portfolio_gamma:    Optional[float] = None
    portfolio_vega:     Optional[float] = None
    portfolio_theta:    Optional[float] = None

    # Benchmark-relative (None if benchmark unavailable)
    active_beta:        Optional[float] = None
    tracking_error_ann: Optional[float] = None


# ══════════════════════════════════════════════════════════════════════════════
# Portfolio target
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class PortfolioTarget:
    """
    Target portfolio produced by the optimizer.

    This is SEPARATE from the executed portfolio.
    Phase 3G execution machinery determines what can actually be filled.

    weights         : {instrument_id: target_weight}
                      positive = long, negative = short
    sizing_method   : how position sizes were derived
    objective       : optimization objective used
    status          : optimization result state
    fallback_reason : if status == FEASIBLE_FALLBACK, why
    """
    formation_time:     datetime
    instruments:        list[str]
    weights:            dict[str, float]           # instrument_id → target weight

    # Objective and status
    objective:          PortfolioObjective
    objective_version:  str
    status:             OptimizationStatus
    fallback_reason:    str = ""
    fallback_method:    Optional[PortfolioObjective] = None

    # Sizing
    sizing_method:      SizingMethod = SizingMethod.OPTIMIZER_WEIGHT
    sizing_version:     str = "sizing-v1"

    # Capital
    total_capital_inr:  float = 1_000_000.0

    # Risk model used
    risk_model_version: str = ""
    covariance_method:  CovarianceMethod = CovarianceMethod.UNAVAILABLE
    covariance_status:  CovarianceStatus = CovarianceStatus.UNAVAILABLE

    # Constraint set used
    constraint_set_version: str = ""

    # Exposure summary
    exposure:           Optional[ExposureSummary] = None

    # Component risk
    component_risks:    list[ComponentRisk] = field(default_factory=list)

    # Provenance
    provenance_hash:    str = ""
    notes:              str = ""

    @property
    def gross_exposure(self) -> float:
        return sum(abs(w) for w in self.weights.values())

    @property
    def net_exposure(self) -> float:
        return sum(self.weights.values())

    @property
    def long_weights(self) -> dict[str, float]:
        return {k: v for k, v in self.weights.items() if v > 0}

    @property
    def short_weights(self) -> dict[str, float]:
        return {k: v for k, v in self.weights.items() if v < 0}

    @property
    def n_positions(self) -> int:
        return sum(1 for w in self.weights.values() if abs(w) > 1e-6)

    def is_valid(self) -> bool:
        return self.status in (
            OptimizationStatus.OPTIMIZED,
            OptimizationStatus.FEASIBLE_FALLBACK,
        )


# ══════════════════════════════════════════════════════════════════════════════
# Portfolio state (live / executed)
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class PortfolioState:
    """
    Current (executed) portfolio state.

    Separate from PortfolioTarget — target weights may differ from
    what was actually executed by the Phase 3G fill engine.

    positions: {instrument_id: (current_weight, current_lots, avg_entry_price)}
    """
    timestamp:          datetime
    capital_inr:        float

    positions:          dict[str, dict] = field(default_factory=dict)
    # Each position dict: {weight, lots, avg_entry_price, side, sector, industry}

    cash_inr:           float = 0.0
    unrealized_pnl_inr: float = 0.0
    total_value_inr:    float = 0.0

    # Drawdown tracking
    peak_value_inr:     Optional[float] = None
    current_drawdown:   float = 0.0        # fraction from peak
    max_drawdown:       float = 0.0

    @property
    def current_weights(self) -> dict[str, float]:
        return {k: v["weight"] for k, v in self.positions.items()}

    @property
    def gross_exposure(self) -> float:
        return sum(abs(v["weight"]) for v in self.positions.values())


# ══════════════════════════════════════════════════════════════════════════════
# Target order (portfolio → execution contract)
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class TargetOrder:
    """
    Trade order generated by the rebalancer.

    Implements spec §44: explicit contract between portfolio target
    and Phase 3G execution simulator.
    """
    instrument_id:      str
    side:               str               # "BUY" | "SELL"
    trade_side:         str               # "LONG" | "SHORT"

    target_weight:      float             # target portfolio weight
    current_weight:     float             # current portfolio weight
    weight_delta:       float             # target - current

    quantity_lots:      int               # lots to trade
    lot_size:           int

    estimated_notional_inr: float
    estimated_cost_inr:     float = 0.0
    liquidity_requirement_pct_adv: Optional[float] = None

    reason:             str = ""
    portfolio_version:  str = ""

    @property
    def is_buy(self) -> bool:
        return self.side == "BUY"

    @property
    def is_sell(self) -> bool:
        return self.side == "SELL"


# ══════════════════════════════════════════════════════════════════════════════
# Portfolio result (full output record)
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class PortfolioResult:
    """
    Complete output of one portfolio construction cycle.

    Records both target and executed state plus all diagnostics.
    """
    formation_time:     datetime

    target:             PortfolioTarget
    orders:             list[TargetOrder] = field(default_factory=list)

    # Prior state (before rebalance)
    prior_state:        Optional[PortfolioState] = None

    # Rebalance metrics
    estimated_turnover: float = 0.0        # fraction of portfolio value
    estimated_cost_inr: float = 0.0
    n_buys:             int = 0
    n_sells:            int = 0

    # Eligible vs rejected candidates
    n_candidates_in:    int = 0
    n_eligible:         int = 0
    n_rejected:         int = 0
    rejection_reasons:  dict[str, int] = field(default_factory=dict)  # reason → count

    # Exposure
    exposure:           Optional[ExposureSummary] = None

    # Risk overlay
    risk_overlay_action: RiskOverlayAction = RiskOverlayAction.NO_ACTION
    risk_overlay_reason: str = ""

    notes:              str = ""

    @property
    def is_actionable(self) -> bool:
        """True if the target portfolio is valid and no halt/exit overlay."""
        return (
            self.target.is_valid()
            and self.risk_overlay_action not in (
                RiskOverlayAction.HALT_NEW_POSITIONS,
                RiskOverlayAction.EXIT,
                RiskOverlayAction.ABSTAIN,
            )
        )


# ══════════════════════════════════════════════════════════════════════════════
# Portfolio provenance
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class PortfolioProvenance:
    """
    Complete reproducibility record for a portfolio construction run.

    Same provenance → identical PortfolioTarget (spec §60).
    """
    portfolio_id:       str
    formation_time:     datetime

    # Input snapshots
    candidate_snapshot_id:  str
    data_snapshot_id:       str

    # Model versions
    primary_model_id:       str
    meta_model_id:          str
    calibrator_id:          str
    feature_set_id:         str
    label_version:          str
    dataset_id:             str

    # Portfolio layer versions
    portfolio_model_version:    str = "portfolio-v1"
    risk_model_version:         str = "risk-model-v1"
    covariance_model_version:   str = "covariance-model-v1"
    constraint_set_version:     str = "constraints-v1"
    sizing_version:             str = "sizing-v1"
    rebalance_policy_version:   str = "rebalance-v1"
    benchmark_version:          str = "NIFTY50-v1"

    # Execution layer versions (from Phase 3G)
    execution_model_version:    str = "backtest-engine-v1"
    cost_model_version:         str = "india-fno-2023"

    git_commit:         str = ""
    notes:              str = ""

    @property
    def provenance_hash(self) -> str:
        """Deterministic 16-char SHA-256 hash of all material provenance fields."""
        key = {
            "formation_time":   self.formation_time.isoformat(),
            "candidate_snap":   self.candidate_snapshot_id,
            "data_snap":        self.data_snapshot_id,
            "primary_model":    self.primary_model_id,
            "meta_model":       self.meta_model_id,
            "calibrator":       self.calibrator_id,
            "feature_set":      self.feature_set_id,
            "label_version":    self.label_version,
            "portfolio_model":  self.portfolio_model_version,
            "risk_model":       self.risk_model_version,
            "covariance_model": self.covariance_model_version,
            "constraint_set":   self.constraint_set_version,
            "sizing":           self.sizing_version,
            "rebalance":        self.rebalance_policy_version,
            "benchmark":        self.benchmark_version,
            "exec_model":       self.execution_model_version,
            "cost_model":       self.cost_model_version,
        }
        raw = json.dumps(key, sort_keys=True)
        return hashlib.sha256(raw.encode()).hexdigest()[:16]
