"""
Phase 3H — Portfolio Intelligence Layer.

Transforms individual Phase 3F meta-decision outputs into a coherent,
cost-aware, risk-managed target portfolio.

Pipeline
--------
    list[MetaDecisionOutput]  (Phase 3F TAKE decisions)
            ↓
    EligibilityFilter         (stale data, uncalibrated prob, F&O ban, ...)
            ↓
    RiskModel                 (historical covariance, Ledoit-Wolf shrinkage,
                               PSD validation, CovarianceQuality)
            ↓
    ConstraintSet             (sector, industry, single-name, gross/net,
                               beta, factor, turnover, liquidity)
            ↓
    SizingEngine              (EV-aware, fractional Kelly, vol targeting,
                               risk budgeting, component risk)
            ↓
    PortfolioOptimizer        (MIN_VARIANCE / MAX_SHARPE / MAX_DIVERSIFICATION
                               / CVaR / RISK_BUDGETING / EV_RISK / HRP)
            ↓
    PortfolioTarget           (target weights, deterministic provenance hash)
            ↓
    Rebalancer                (turnover, cost-adjusted trade orders)
            ↓
    Analytics                 (attribution, concentration, stability,
                               benchmark-relative metrics)
            ↓
    RiskOverlay               (drawdown / vol spike / regime response)

Design invariants
-----------------
1. No uncontrolled randomness — np.random.* and random.* are forbidden.
2. UNAVAILABLE / INSUFFICIENT_EVIDENCE are first-class outcomes.
3. rank_score ≠ probability ≠ expected_return ≠ portfolio_weight.
4. Covariance must be derived from historical returns; synthetic
   correlation is NEVER used on the production research path.
5. All outputs carry a versioned provenance hash for reproducibility.
"""

from .schemas import (
    # Enums
    PortfolioObjective,
    OptimizationStatus,
    EligibilityStatus,
    CovarianceMethod,
    CovarianceStatus,
    SizingMethod,
    RiskOverlayAction,
    RebalancePolicy,
    PortfolioMode,
    ConstraintRelaxationPolicy,
    # Dataclasses
    PortfolioCandidate,
    CovarianceResult,
    ConstraintSet,
    PortfolioTarget,
    PortfolioState,
    TargetOrder,
    PortfolioResult,
    PortfolioProvenance,
    ComponentRisk,
    ExposureSummary,
)

__all__ = [
    # Enums
    "PortfolioObjective",
    "OptimizationStatus",
    "EligibilityStatus",
    "CovarianceMethod",
    "CovarianceStatus",
    "SizingMethod",
    "RiskOverlayAction",
    "RebalancePolicy",
    "PortfolioMode",
    "ConstraintRelaxationPolicy",
    # Dataclasses
    "PortfolioCandidate",
    "CovarianceResult",
    "ConstraintSet",
    "PortfolioTarget",
    "PortfolioState",
    "TargetOrder",
    "PortfolioResult",
    "PortfolioProvenance",
    "ComponentRisk",
    "ExposureSummary",
]
