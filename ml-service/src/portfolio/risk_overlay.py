"""
Phase 3H — Portfolio Risk Overlay.

Monitors portfolio-level risk metrics and triggers configurable
protective actions when thresholds are breached.

Design rules
------------
1. All thresholds are configuration-driven — never hardcoded.
2. The overlay acts on PORTFOLIO-LEVEL signals (drawdown, vol spike,
   correlation spike, CVaR increase, regime change).
3. Actions are ordered: NO_ACTION < REDUCE_RISK < HALT_NEW_POSITIONS < EXIT.
4. Regime data must come from the current bar — no lookahead.
5. No uncontrolled randomness.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional

import numpy as np

from .schemas import (
    PortfolioState, PortfolioTarget, RiskOverlayAction,
)


# ── Overlay configuration ─────────────────────────────────────────────────────

@dataclass
class OverlayThresholds:
    """
    Configurable risk overlay thresholds.
    All values are configurable — none are hardcoded in logic.
    Setting any threshold to None disables that check.
    """
    # Drawdown
    drawdown_reduce_risk:       Optional[float] = 0.05   # 5% drawdown → REDUCE_RISK
    drawdown_halt:              Optional[float] = 0.10   # 10% → HALT_NEW_POSITIONS
    drawdown_exit:              Optional[float] = 0.20   # 20% → EXIT

    # Realised volatility (daily, annualised)
    vol_spike_reduce_risk:      Optional[float] = 0.30   # 30% ann vol → REDUCE_RISK
    vol_spike_halt:             Optional[float] = 0.50   # 50% → HALT
    vol_spike_exit:             Optional[float] = None   # disabled by default

    # CVaR (95%, daily)
    cvar_reduce_risk:           Optional[float] = 0.02   # 2% daily CVaR → REDUCE_RISK
    cvar_halt:                  Optional[float] = 0.04   # 4% → HALT

    # Model confidence deterioration (0–1; lower = worse)
    min_model_confidence:       Optional[float] = None   # None = disabled

    # Regime-based responses
    halt_on_regimes:            tuple = ()               # e.g. ("crash", "bear_extreme")
    reduce_on_regimes:          tuple = ("high_volatility", "risk_off")

    # Reduction factor (applied to weights when REDUCE_RISK)
    risk_reduction_factor:      float = 0.50             # scale weights by this

    version:                    str = "overlay-v1"


# ── Overlay trigger result ────────────────────────────────────────────────────

@dataclass
class OverlayResult:
    """
    Result of the risk overlay evaluation.
    """
    action:             RiskOverlayAction
    reason:             str
    triggered_checks:   list[str] = field(default_factory=list)
    current_drawdown:   Optional[float] = None
    current_vol:        Optional[float] = None
    current_cvar:       Optional[float] = None
    current_regime:     Optional[str] = None
    risk_scale:         float = 1.0   # weight scaling factor (1.0 = no change)
    notes:              str = ""


# ── Risk overlay ──────────────────────────────────────────────────────────────

class RiskOverlay:
    """
    Portfolio-level risk overlay.

    Usage
    -----
    ::
        overlay = RiskOverlay(thresholds)
        result = overlay.evaluate(
            portfolio_state=current_state,
            recent_returns=np.array([...]),   # last N daily returns
            current_regime="high_volatility",
            model_confidence=0.65,
        )
        if result.action == RiskOverlayAction.HALT_NEW_POSITIONS:
            # Do not open new trades this period
    """

    def __init__(self, thresholds: Optional[OverlayThresholds] = None) -> None:
        self.thresholds = thresholds or OverlayThresholds()

    def evaluate(
        self,
        portfolio_state: Optional[PortfolioState],
        recent_returns: Optional[np.ndarray],
        current_regime: Optional[str] = None,
        model_confidence: Optional[float] = None,
    ) -> OverlayResult:
        """
        Evaluate all risk checks and return the appropriate action.

        Actions are ordered; the most severe triggered action is returned.
        """
        t = self.thresholds
        triggered = []

        # ── Compute current metrics ───────────────────────────────────────────
        current_drawdown = None
        current_vol      = None
        current_cvar     = None

        if portfolio_state is not None:
            current_drawdown = portfolio_state.current_drawdown

        if recent_returns is not None and len(recent_returns) >= 10:
            ret = np.array(recent_returns)
            current_vol  = float(np.std(ret, ddof=1) * np.sqrt(252.0))
            k = max(1, int(0.05 * len(ret)))
            current_cvar = float(-np.mean(np.sort(ret)[:k]))

        # ── Determine worst action ────────────────────────────────────────────
        worst_action = RiskOverlayAction.NO_ACTION
        risk_scale   = 1.0

        def _escalate(action: RiskOverlayAction, label: str) -> None:
            nonlocal worst_action, risk_scale
            triggered.append(label)
            order = [
                RiskOverlayAction.NO_ACTION,
                RiskOverlayAction.REDUCE_RISK,
                RiskOverlayAction.HALT_NEW_POSITIONS,
                RiskOverlayAction.EXIT,
                RiskOverlayAction.ABSTAIN,
            ]
            if order.index(action) > order.index(worst_action):
                worst_action = action
                if action == RiskOverlayAction.REDUCE_RISK:
                    risk_scale = t.risk_reduction_factor

        # ── Drawdown checks ───────────────────────────────────────────────────
        if current_drawdown is not None:
            dd = abs(current_drawdown)
            if t.drawdown_exit is not None and dd >= t.drawdown_exit:
                _escalate(RiskOverlayAction.EXIT,
                          f"drawdown={dd:.2%} ≥ exit threshold={t.drawdown_exit:.2%}")
            elif t.drawdown_halt is not None and dd >= t.drawdown_halt:
                _escalate(RiskOverlayAction.HALT_NEW_POSITIONS,
                          f"drawdown={dd:.2%} ≥ halt threshold={t.drawdown_halt:.2%}")
            elif t.drawdown_reduce_risk is not None and dd >= t.drawdown_reduce_risk:
                _escalate(RiskOverlayAction.REDUCE_RISK,
                          f"drawdown={dd:.2%} ≥ reduce threshold={t.drawdown_reduce_risk:.2%}")

        # ── Volatility spike checks ───────────────────────────────────────────
        if current_vol is not None:
            if t.vol_spike_exit is not None and current_vol >= t.vol_spike_exit:
                _escalate(RiskOverlayAction.EXIT,
                          f"vol={current_vol:.2%} ≥ exit threshold={t.vol_spike_exit:.2%}")
            elif t.vol_spike_halt is not None and current_vol >= t.vol_spike_halt:
                _escalate(RiskOverlayAction.HALT_NEW_POSITIONS,
                          f"vol={current_vol:.2%} ≥ halt threshold={t.vol_spike_halt:.2%}")
            elif t.vol_spike_reduce_risk is not None and current_vol >= t.vol_spike_reduce_risk:
                _escalate(RiskOverlayAction.REDUCE_RISK,
                          f"vol={current_vol:.2%} ≥ reduce threshold={t.vol_spike_reduce_risk:.2%}")

        # ── CVaR checks ───────────────────────────────────────────────────────
        if current_cvar is not None:
            if t.cvar_halt is not None and current_cvar >= t.cvar_halt:
                _escalate(RiskOverlayAction.HALT_NEW_POSITIONS,
                          f"CVaR(95%)={current_cvar:.2%} ≥ halt threshold={t.cvar_halt:.2%}")
            elif t.cvar_reduce_risk is not None and current_cvar >= t.cvar_reduce_risk:
                _escalate(RiskOverlayAction.REDUCE_RISK,
                          f"CVaR(95%)={current_cvar:.2%} ≥ reduce threshold={t.cvar_reduce_risk:.2%}")

        # ── Regime checks ─────────────────────────────────────────────────────
        if current_regime is not None:
            if current_regime in t.halt_on_regimes:
                _escalate(RiskOverlayAction.HALT_NEW_POSITIONS,
                          f"Regime={current_regime!r} in halt list.")
            elif current_regime in t.reduce_on_regimes:
                _escalate(RiskOverlayAction.REDUCE_RISK,
                          f"Regime={current_regime!r} in reduce list.")

        # ── Model confidence check ────────────────────────────────────────────
        if model_confidence is not None and t.min_model_confidence is not None:
            if model_confidence < t.min_model_confidence:
                _escalate(RiskOverlayAction.REDUCE_RISK,
                          f"Model confidence {model_confidence:.3f} < "
                          f"threshold {t.min_model_confidence:.3f}")

        reason = (
            "; ".join(triggered) if triggered
            else "All risk checks passed."
        )

        return OverlayResult(
            action=worst_action,
            reason=reason,
            triggered_checks=triggered,
            current_drawdown=current_drawdown,
            current_vol=current_vol,
            current_cvar=current_cvar,
            current_regime=current_regime,
            risk_scale=risk_scale,
        )

    def apply_risk_scaling(
        self,
        target: PortfolioTarget,
        overlay_result: OverlayResult,
    ) -> PortfolioTarget:
        """
        Scale down portfolio weights by overlay_result.risk_scale.

        Returns a new PortfolioTarget with scaled weights.
        Does not modify the original target.
        """
        if overlay_result.risk_scale >= 1.0 - 1e-8:
            return target  # no scaling needed

        scale = overlay_result.risk_scale
        scaled_weights = {k: v * scale for k, v in target.weights.items()}

        from .schemas import OptimizationStatus
        return PortfolioTarget(
            formation_time=target.formation_time,
            instruments=target.instruments,
            weights=scaled_weights,
            objective=target.objective,
            objective_version=target.objective_version,
            status=OptimizationStatus.FEASIBLE_FALLBACK,
            fallback_reason=(
                f"Risk overlay scaled weights by {scale:.2f}: "
                f"{overlay_result.reason}"
            ),
            fallback_method=target.objective,
            total_capital_inr=target.total_capital_inr,
            risk_model_version=target.risk_model_version,
            covariance_method=target.covariance_method,
            covariance_status=target.covariance_status,
            constraint_set_version=target.constraint_set_version,
            notes=target.notes + f" | OVERLAY_SCALED by {scale:.2f}",
        )
