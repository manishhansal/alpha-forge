"""
Performance Monitor — AlphaForge ML Monitoring.

Tracks live model performance once trade outcomes become available and
monitors strategy decay using rolling windows.

Metrics tracked
---------------
Model-level (prediction quality)
  Brier score          : mean squared error on calibrated probabilities
  Calibration error    : ECE (expected calibration error)
  Accuracy             : fraction of correct directional predictions
  Log-loss             : cross-entropy on predicted probabilities

Strategy-level (trading performance)
  Trading expectancy   : E[P&L per trade] = win_rate × avg_win − loss_rate × avg_loss
  Rolling Sharpe ratio : annualised Sharpe over a rolling window
  Rolling win rate     : fraction of profitable trades in a rolling window
  Rolling drawdown     : maximum drawdown in a rolling window

Design
------
- ``TradeOutcome`` is the atomic data unit: one resolved trade with its
  predicted probability, actual result, and P&L.
- ``PerformanceMonitor`` maintains a rolling deque per model/strategy and
  computes metrics on demand or when the window is full.
- All metrics are pure functions of the stored outcomes — no database needed.
- Integrates with ``ModelRegistry`` and ``AlertSystem`` to escalate
  performance-based state changes.

Thresholds (configurable)
  brier_warn       : 0.25  (PSI analogy — minor degradation)
  brier_critical   : 0.35
  accuracy_warn    : 0.50  (below coin-flip)
  accuracy_critical: 0.45
  sharpe_warn      : 0.50  (rolling annualised Sharpe)
  sharpe_critical  : 0.0   (negative Sharpe → losses)
  win_rate_warn    : 0.40
  win_rate_critical: 0.33
"""

from __future__ import annotations

import math
import threading
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

import numpy as np
import structlog

logger = structlog.get_logger()


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

@dataclass
class PerformanceThresholds:
    """Configurable thresholds for performance degradation detection."""

    brier_warn:        float = 0.25
    brier_critical:    float = 0.35
    accuracy_warn:     float = 0.50
    accuracy_critical: float = 0.45
    sharpe_warn:       float = 0.50
    sharpe_critical:   float = 0.0
    win_rate_warn:     float = 0.40
    win_rate_critical: float = 0.33
    expectancy_warn:   float = 0.0     # ≤ 0 means net losing
    expectancy_critical: float = -0.005  # -0.5 % per trade


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------

@dataclass
class TradeOutcome:
    """
    One resolved trade — the atomic unit for performance tracking.

    Parameters
    ----------
    model_name          : which model produced this signal
    strategy            : TradingStrategy value (e.g. "momentum")
    symbol              : trading symbol
    predicted_prob      : calibrated probability the trade would succeed ∈ [0, 1]
    actual_outcome      : 1.0 if trade was profitable, 0.0 otherwise
    pnl_pct             : actual P&L as % of capital (negative = loss)
    confidence          : model confidence at decision time
    action              : "BUY" | "SELL" | "WAIT" | "NO_TRADE"
    timestamp           : ISO-8601 UTC when the outcome was resolved
    """

    model_name:     str
    strategy:       str
    symbol:         str
    predicted_prob: float
    actual_outcome: float          # 1.0 = profit, 0.0 = loss
    pnl_pct:        float          # e.g. +0.012 = +1.2%
    confidence:     float = 0.5
    action:         str   = "BUY"
    timestamp:      str   = field(default_factory=lambda: _now())

    def to_dict(self) -> dict[str, Any]:
        return {
            "modelName":     self.model_name,
            "strategy":      self.strategy,
            "symbol":        self.symbol,
            "predictedProb": round(self.predicted_prob, 4),
            "actualOutcome": self.actual_outcome,
            "pnlPct":        round(self.pnl_pct, 5),
            "confidence":    round(self.confidence, 4),
            "action":        self.action,
            "timestamp":     self.timestamp,
        }


@dataclass
class PerformanceSnapshot:
    """
    Point-in-time performance metrics for one model.

    Computed from the rolling window of resolved ``TradeOutcome`` objects.
    """

    model_name:        str
    timestamp:         str
    n_samples:         int
    brier_score:       float
    calibration_error: float
    accuracy:          float
    log_loss:          float
    trading_expectancy:float
    win_rate:          float
    avg_win_pct:       float
    avg_loss_pct:      float
    degraded:          bool     = False
    details:           str      = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "modelName":         self.model_name,
            "timestamp":         self.timestamp,
            "nSamples":          self.n_samples,
            "brierScore":        round(self.brier_score, 5),
            "calibrationError":  round(self.calibration_error, 5),
            "accuracy":          round(self.accuracy, 4),
            "logLoss":           round(self.log_loss, 5),
            "tradingExpectancy": round(self.trading_expectancy, 5),
            "winRate":           round(self.win_rate, 4),
            "avgWinPct":         round(self.avg_win_pct, 5),
            "avgLossPct":        round(self.avg_loss_pct, 5),
            "degraded":          self.degraded,
            "details":           self.details,
        }


@dataclass
class StrategyDecayMetrics:
    """
    Rolling strategy performance metrics for decay detection.

    Computed over a rolling window of ``TradeOutcome`` objects
    filtered to a specific strategy.
    """

    strategy:           str
    model_name:         str
    timestamp:          str
    n_trades:           int
    rolling_sharpe:     float
    rolling_win_rate:   float
    rolling_expectancy: float
    rolling_drawdown:   float   # maximum drawdown fraction, e.g. -0.05 = -5%
    is_decaying:        bool    = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "strategy":          self.strategy,
            "modelName":         self.model_name,
            "timestamp":         self.timestamp,
            "nTrades":           self.n_trades,
            "rollingSharpe":     round(self.rolling_sharpe, 4),
            "rollingWinRate":    round(self.rolling_win_rate, 4),
            "rollingExpectancy": round(self.rolling_expectancy, 5),
            "rollingDrawdown":   round(self.rolling_drawdown, 5),
            "isDecaying":        self.is_decaying,
        }


# ---------------------------------------------------------------------------
# Pure metric functions
# ---------------------------------------------------------------------------

def _brier_score(probs: np.ndarray, labels: np.ndarray) -> float:
    return float(np.mean((probs - labels) ** 2))


def _log_loss(probs: np.ndarray, labels: np.ndarray, eps: float = 1e-7) -> float:
    probs  = np.clip(probs, eps, 1 - eps)
    return float(-np.mean(labels * np.log(probs) + (1 - labels) * np.log(1 - probs)))


def _ece(
    probs: np.ndarray,
    labels: np.ndarray,
    n_bins: int = 10,
) -> float:
    """Expected Calibration Error."""
    ece = 0.0
    n   = len(probs)
    bin_edges = np.linspace(0, 1, n_bins + 1)
    for lo, hi in zip(bin_edges[:-1], bin_edges[1:]):
        mask = (probs >= lo) & (probs < hi)
        if mask.sum() == 0:
            continue
        ece += (mask.sum() / n) * abs(probs[mask].mean() - labels[mask].mean())
    return float(ece)


def _accuracy(probs: np.ndarray, labels: np.ndarray, threshold: float = 0.5) -> float:
    preds = (probs >= threshold).astype(float)
    return float(np.mean(preds == labels))


def _trading_expectancy(pnls: np.ndarray) -> tuple[float, float, float, float]:
    """
    Returns (expectancy, win_rate, avg_win, avg_loss).

    expectancy = win_rate × avg_win + loss_rate × avg_loss
    """
    if len(pnls) == 0:
        return 0.0, 0.0, 0.0, 0.0

    wins  = pnls[pnls > 0]
    losses = pnls[pnls <= 0]

    win_rate  = len(wins) / len(pnls)
    loss_rate = 1.0 - win_rate
    avg_win   = float(np.mean(wins))   if len(wins)   > 0 else 0.0
    avg_loss  = float(np.mean(losses)) if len(losses) > 0 else 0.0

    expectancy = win_rate * avg_win + loss_rate * avg_loss
    return expectancy, win_rate, avg_win, avg_loss


def _sharpe_ratio(pnls: np.ndarray, periods_per_year: int = 252) -> float:
    """Annualised Sharpe ratio from a series of per-trade P&L percentages."""
    if len(pnls) < 2:
        return 0.0
    mean = float(np.mean(pnls))
    std  = float(np.std(pnls, ddof=1))
    if std == 0:
        # Constant returns: infinite Sharpe — return signed large value capped at ±1e6
        if mean > 0:
            return 1e6
        elif mean < 0:
            return -1e6
        return 0.0
    return float((mean / std) * math.sqrt(periods_per_year))


def _max_drawdown(pnls: np.ndarray) -> float:
    """Maximum drawdown from a cumulative P&L series."""
    if len(pnls) == 0:
        return 0.0
    cumulative = np.cumsum(pnls)
    running_max = np.maximum.accumulate(cumulative)
    drawdowns = cumulative - running_max
    return float(np.min(drawdowns))


# ---------------------------------------------------------------------------
# PerformanceMonitor
# ---------------------------------------------------------------------------

class PerformanceMonitor:
    """
    Tracks live trading outcomes and computes model + strategy health metrics.

    Parameters
    ----------
    alert_system    : AlertSystem for forwarding performance alerts
    model_registry  : ModelRegistry for state updates
    thresholds      : PerformanceThresholds (uses defaults if None)
    window_size     : rolling window size for metric computation
    min_samples     : minimum outcomes required before evaluating metrics
    """

    def __init__(
        self,
        alert_system: Any | None = None,
        model_registry: Any | None = None,
        thresholds: PerformanceThresholds | None = None,
        window_size: int = 100,
        min_samples: int = 20,
    ) -> None:
        self._alert_system   = alert_system
        self._model_registry = model_registry
        self._thresholds     = thresholds or PerformanceThresholds()
        self._window_size    = window_size
        self._min_samples    = min_samples

        # {model_name: deque[TradeOutcome]}
        self._outcomes: dict[str, deque] = {}
        # {(model_name, strategy): deque[TradeOutcome]}
        self._strategy_outcomes: dict[tuple[str, str], deque] = {}
        # {model_name: PerformanceSnapshot}
        self._last_snapshots: dict[str, PerformanceSnapshot] = {}
        # {(model_name, strategy): StrategyDecayMetrics}
        self._last_decay: dict[tuple[str, str], StrategyDecayMetrics] = {}

        self._lock = threading.Lock()

    # ------------------------------------------------------------------
    # Outcome ingestion
    # ------------------------------------------------------------------

    def record_outcome(self, outcome: TradeOutcome) -> PerformanceSnapshot | None:
        """
        Record one resolved trade outcome.

        When the buffer reaches ``window_size``, performance metrics are
        recomputed and a ``PerformanceSnapshot`` is returned.
        Otherwise returns ``None``.

        Also updates strategy-level decay metrics for this outcome's strategy.
        """
        with self._lock:
            # Per-model buffer
            if outcome.model_name not in self._outcomes:
                self._outcomes[outcome.model_name] = deque(maxlen=self._window_size)
            self._outcomes[outcome.model_name].append(outcome)

            # Per-(model, strategy) buffer
            sk = (outcome.model_name, outcome.strategy)
            if sk not in self._strategy_outcomes:
                self._strategy_outcomes[sk] = deque(maxlen=self._window_size)
            self._strategy_outcomes[sk].append(outcome)

            model_buf = list(self._outcomes[outcome.model_name])
            strat_buf = list(self._strategy_outcomes[sk])
            should_eval = len(model_buf) >= self._min_samples

        # Strategy decay — always recompute on each outcome
        if len(strat_buf) >= self._min_samples:
            self._compute_strategy_decay(
                outcome.model_name, outcome.strategy, strat_buf
            )

        if should_eval:
            return self._compute_snapshot(outcome.model_name, model_buf)
        return None

    def record_outcomes_batch(
        self,
        outcomes: list[TradeOutcome],
    ) -> PerformanceSnapshot | None:
        """Record multiple outcomes.  Returns the last computed snapshot."""
        snap = None
        for outcome in outcomes:
            s = self.record_outcome(outcome)
            if s is not None:
                snap = s
        return snap

    # ------------------------------------------------------------------
    # On-demand evaluation
    # ------------------------------------------------------------------

    def evaluate(self, model_name: str) -> PerformanceSnapshot | None:
        """
        Compute a performance snapshot immediately using whatever outcomes
        are buffered for *model_name*.

        Returns ``None`` if fewer than ``min_samples`` outcomes are stored.
        """
        with self._lock:
            buf = list(self._outcomes.get(model_name, []))

        if len(buf) < self._min_samples:
            logger.debug(
                "performance_eval_insufficient",
                model=model_name,
                n=len(buf),
                min=self._min_samples,
            )
            return None
        return self._compute_snapshot(model_name, buf)

    def evaluate_strategy(
        self,
        model_name: str,
        strategy: str,
    ) -> StrategyDecayMetrics | None:
        """Evaluate strategy decay immediately."""
        with self._lock:
            buf = list(self._strategy_outcomes.get((model_name, strategy), []))

        if len(buf) < self._min_samples:
            return None
        return self._compute_strategy_decay(model_name, strategy, buf)

    # ------------------------------------------------------------------
    # Query
    # ------------------------------------------------------------------

    def get_snapshot(self, model_name: str) -> PerformanceSnapshot | None:
        with self._lock:
            return self._last_snapshots.get(model_name)

    def get_all_snapshots(self) -> dict[str, PerformanceSnapshot]:
        with self._lock:
            return dict(self._last_snapshots)

    def get_strategy_decay(
        self,
        model_name: str,
        strategy: str,
    ) -> StrategyDecayMetrics | None:
        with self._lock:
            return self._last_decay.get((model_name, strategy))

    def get_all_strategy_decay(self) -> list[StrategyDecayMetrics]:
        with self._lock:
            return list(self._last_decay.values())

    def get_outcome_count(self, model_name: str) -> int:
        with self._lock:
            return len(self._outcomes.get(model_name, []))

    # ------------------------------------------------------------------
    # Internal: metric computation
    # ------------------------------------------------------------------

    def _compute_snapshot(
        self,
        model_name: str,
        outcomes: list[TradeOutcome],
    ) -> PerformanceSnapshot:
        probs  = np.array([o.predicted_prob for o in outcomes])
        labels = np.array([o.actual_outcome for o in outcomes])
        pnls   = np.array([o.pnl_pct        for o in outcomes])

        brier = _brier_score(probs, labels)
        ece   = _ece(probs, labels)
        acc   = _accuracy(probs, labels)
        ll    = _log_loss(probs, labels)
        exp, win_rate, avg_win, avg_loss = _trading_expectancy(pnls)

        # Determine if degraded
        t = self._thresholds
        degraded = (
            brier   >= t.brier_critical   or
            acc     <= t.accuracy_critical or
            win_rate <= t.win_rate_critical or
            exp      <= t.expectancy_critical
        )
        warning = not degraded and (
            brier   >= t.brier_warn   or
            acc     <= t.accuracy_warn or
            win_rate <= t.win_rate_warn or
            exp      <= t.expectancy_warn
        )

        detail_parts = []
        if degraded:
            if brier   >= t.brier_critical:   detail_parts.append(f"Brier={brier:.3f}")
            if acc     <= t.accuracy_critical: detail_parts.append(f"accuracy={acc:.3f}")
            if win_rate <= t.win_rate_critical:detail_parts.append(f"win_rate={win_rate:.3f}")
            if exp      <= t.expectancy_critical:detail_parts.append(f"expectancy={exp:.4f}")

        snap = PerformanceSnapshot(
            model_name=model_name,
            timestamp=_now(),
            n_samples=len(outcomes),
            brier_score=brier,
            calibration_error=ece,
            accuracy=acc,
            log_loss=ll,
            trading_expectancy=exp,
            win_rate=win_rate,
            avg_win_pct=avg_win,
            avg_loss_pct=avg_loss,
            degraded=degraded,
            details="; ".join(detail_parts),
        )

        with self._lock:
            self._last_snapshots[model_name] = snap

        logger.info(
            "performance_snapshot_computed",
            model=model_name,
            n=len(outcomes),
            brier=round(brier, 4),
            accuracy=round(acc, 4),
            win_rate=round(win_rate, 4),
            expectancy=round(exp, 5),
            degraded=degraded,
        )

        self._handle_snapshot(model_name, snap, warning)
        return snap

    def _compute_strategy_decay(
        self,
        model_name: str,
        strategy: str,
        outcomes: list[TradeOutcome],
    ) -> StrategyDecayMetrics:
        pnls = np.array([o.pnl_pct for o in outcomes])
        exp, win_rate, _, _ = _trading_expectancy(pnls)
        sharpe   = _sharpe_ratio(pnls)
        drawdown = _max_drawdown(pnls)

        t = self._thresholds
        is_decaying = (
            sharpe   <= t.sharpe_critical  or
            win_rate <= t.win_rate_critical or
            exp      <= t.expectancy_critical
        )

        metrics = StrategyDecayMetrics(
            strategy=strategy,
            model_name=model_name,
            timestamp=_now(),
            n_trades=len(outcomes),
            rolling_sharpe=sharpe,
            rolling_win_rate=win_rate,
            rolling_expectancy=exp,
            rolling_drawdown=drawdown,
            is_decaying=is_decaying,
        )

        with self._lock:
            self._last_decay[(model_name, strategy)] = metrics

        if is_decaying:
            logger.warning(
                "strategy_decay_detected",
                model=model_name,
                strategy=strategy,
                sharpe=round(sharpe, 3),
                win_rate=round(win_rate, 3),
                expectancy=round(exp, 5),
                drawdown=round(drawdown, 4),
            )
            if self._alert_system:
                from .alerts import AlertCategory, AlertSeverity
                self._alert_system.warn(
                    category=AlertCategory.STRATEGY_DECAY,
                    model_name=model_name,
                    title=f"Strategy decay: {strategy} ({model_name})",
                    message=(
                        f"Strategy '{strategy}' rolling metrics below threshold. "
                        f"Sharpe={sharpe:.3f}, WinRate={win_rate:.3f}, "
                        f"Expectancy={exp:.4f}, MaxDD={drawdown:.4f}"
                    ),
                    metadata={
                        "strategy":   strategy,
                        "sharpe":     round(sharpe, 3),
                        "win_rate":   round(win_rate, 3),
                        "expectancy": round(exp, 5),
                        "drawdown":   round(drawdown, 4),
                    },
                )

        return metrics

    def _handle_snapshot(
        self,
        model_name: str,
        snap: PerformanceSnapshot,
        warning: bool,
    ) -> None:
        """Forward snapshot to ModelRegistry and AlertSystem."""
        perf_meta = {
            "brier_score":       round(snap.brier_score, 4),
            "accuracy":          round(snap.accuracy, 4),
            "win_rate":          round(snap.win_rate, 4),
            "trading_expectancy":round(snap.trading_expectancy, 5),
        }

        if snap.degraded and self._model_registry:
            if self._model_registry.is_registered(model_name):
                reasons = [
                    f"Performance degraded: {snap.details}" if snap.details
                    else "Performance metrics below critical thresholds"
                ]
                self._model_registry.set_degraded(
                    model_name,
                    reasons=reasons,
                    performance_metrics=perf_meta,
                )

        elif warning and self._model_registry:
            if self._model_registry.is_registered(model_name):
                self._model_registry.set_warning(
                    model_name,
                    reasons=["Performance metrics below warning thresholds"],
                    performance_metrics=perf_meta,
                )

        if snap.degraded and self._alert_system:
            from .alerts import AlertCategory, AlertSeverity
            self._alert_system.critical(
                category=AlertCategory.PERFORMANCE,
                model_name=model_name,
                title=f"Performance degraded: {model_name}",
                message=(
                    f"Model performance is critically degraded. "
                    f"Brier={snap.brier_score:.4f}, Acc={snap.accuracy:.3f}, "
                    f"WinRate={snap.win_rate:.3f}, Expectancy={snap.trading_expectancy:.4f}"
                ),
                metadata=perf_meta,
            )
        elif warning and self._alert_system:
            from .alerts import AlertCategory
            self._alert_system.warn(
                category=AlertCategory.PERFORMANCE,
                model_name=model_name,
                title=f"Performance warning: {model_name}",
                message=(
                    f"Model performance is declining. "
                    f"Brier={snap.brier_score:.4f}, Acc={snap.accuracy:.3f}, "
                    f"WinRate={snap.win_rate:.3f}, Expectancy={snap.trading_expectancy:.4f}"
                ),
                metadata=perf_meta,
            )


# ---------------------------------------------------------------------------
# Utility
# ---------------------------------------------------------------------------

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()
