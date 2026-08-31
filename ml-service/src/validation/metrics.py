"""
Financial Machine Learning Evaluation Metrics.

A model with high classification accuracy but poor trading performance must
NOT be automatically accepted.  This module computes both:

  1. Classification metrics (accuracy, precision, recall, F1, ROC-AUC)
  2. Trading metrics (Sharpe, Sortino, max drawdown, profit factor,
     expectancy, turnover)

And implements a ModelAcceptanceGate that enforces the dual-pass requirement:
  - Out-of-sample performance must be positive
  - Drawdown must be within threshold
  - Performance must be stable across multiple windows
  - No single time period may dominate returns

Usage:
    evaluator = FinancialMetricsEvaluator()

    # From raw predictions + prices
    result = evaluator.evaluate(
        y_true=y_test, y_pred=y_pred, y_prob=y_prob,
        returns=strategy_returns,  # daily strategy returns series
    )

    # Accept/reject decision
    gate = ModelAcceptanceGate()
    decision = gate.evaluate(result, fold_results=all_fold_results)
    print(decision.accepted, decision.reasons)
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field, asdict
from datetime import datetime
from pathlib import Path
from typing import Sequence

import numpy as np
import pandas as pd
import structlog
from sklearn.metrics import (
    accuracy_score,
    f1_score,
    precision_score,
    recall_score,
    roc_auc_score,
)

logger = structlog.get_logger(__name__)

# ─── Risk-free rate (annualized, for Indian market context) ───────────────────
RISK_FREE_RATE_ANNUAL = 0.065   # 6.5% Indian RBI repo rate (approximate)
TRADING_DAYS_PER_YEAR = 252


# ─── Classification metrics ───────────────────────────────────────────────────


@dataclass
class ClassificationMetrics:
    """Standard classification performance metrics."""

    accuracy: float
    precision: float
    recall: float
    f1: float
    roc_auc: float | None        # None for multi-class without probabilities
    n_samples: int
    n_classes: int
    class_distribution: dict[str, int] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return asdict(self)

    def is_valid(self) -> bool:
        return self.accuracy > 0 and self.n_samples > 0


# ─── Trading metrics ──────────────────────────────────────────────────────────


@dataclass
class TradingMetrics:
    """
    Trading performance metrics computed from a returns series.

    All metrics assume daily returns unless noted.
    """

    # Risk-adjusted returns
    sharpe_ratio: float                  # annualized Sharpe
    sortino_ratio: float                 # annualized Sortino (downside vol only)
    calmar_ratio: float                  # annualized return / max drawdown

    # Drawdown
    max_drawdown: float                  # worst peak-to-trough drawdown (0..1)
    avg_drawdown: float                  # average drawdown across all drawdown periods
    max_drawdown_duration_bars: int      # longest drawdown duration in bars

    # Return statistics
    total_return: float                  # cumulative return over the evaluation period
    annualized_return: float             # CAGR
    annualized_volatility: float         # annualized std of daily returns

    # Trade statistics
    profit_factor: float                 # gross profit / gross loss (> 1 is good)
    expectancy: float                    # expected return per trade (mean of returns)
    win_rate: float                      # fraction of positive-return days/trades
    avg_win: float                       # average return on winning days/trades
    avg_loss: float                      # average return on losing days/trades
    payoff_ratio: float                  # avg_win / abs(avg_loss)

    # Activity
    turnover: float                      # average daily position change (0..1 per bar)

    # Period coverage
    n_bars: int                          # number of bars evaluated
    start_date: str | None = None
    end_date: str | None = None

    def to_dict(self) -> dict:
        return asdict(self)

    def is_profitable(self) -> bool:
        return self.total_return > 0 and self.sharpe_ratio > 0

    def passes_risk_thresholds(
        self,
        max_drawdown_limit: float = 0.25,
        min_sharpe: float = 0.5,
    ) -> bool:
        return (
            self.max_drawdown <= max_drawdown_limit
            and self.sharpe_ratio >= min_sharpe
        )


# ─── Per-fold result ──────────────────────────────────────────────────────────


@dataclass
class FoldResult:
    """
    Evaluation result for a single validation fold.

    Stores both classification and trading metrics so the acceptance gate
    can assess performance stability across folds.
    """

    fold_index: int
    classification: ClassificationMetrics
    trading: TradingMetrics
    n_train: int
    n_test: int
    test_start: str | None = None
    test_end: str | None = None
    fold_weight: float = 1.0     # relative weight of this fold (e.g. by n_test)

    def to_dict(self) -> dict:
        return {
            "fold_index": self.fold_index,
            "n_train": self.n_train,
            "n_test": self.n_test,
            "test_start": self.test_start,
            "test_end": self.test_end,
            "fold_weight": self.fold_weight,
            "classification": self.classification.to_dict(),
            "trading": self.trading.to_dict(),
        }


# ─── Stability analysis ───────────────────────────────────────────────────────


@dataclass
class StabilityAnalysis:
    """
    Cross-fold stability analysis for a validation run.

    A model that performs well on average but has high variance or is
    dominated by a single fold is not production-ready.
    """

    # Sharpe ratio distribution across folds
    mean_sharpe: float
    std_sharpe: float
    min_sharpe: float          # worst fold
    max_sharpe: float          # best fold
    sharpe_decay: float        # (first_half_mean - second_half_mean) / first_half_mean

    # Accuracy distribution
    mean_accuracy: float
    std_accuracy: float
    min_accuracy: float
    max_accuracy: float

    # Max drawdown distribution
    mean_max_drawdown: float
    std_max_drawdown: float
    worst_max_drawdown: float

    # Dominance: does a single fold drive total returns?
    # max fold return contribution / total return
    max_fold_return_contribution: float
    is_dominated_by_single_period: bool   # True if > 60% of returns from one fold

    # Overall stability score (0..1, higher = more stable)
    stability_score: float

    def to_dict(self) -> dict:
        return asdict(self)


# ─── Validation run result ────────────────────────────────────────────────────


@dataclass
class ValidationResult:
    """
    Complete result of a validation run across all folds.

    This is the object that is persisted (never overwritten) to create
    an immutable audit trail of model evaluation history.
    """

    # Provenance
    model_version: str
    dataset_version: str
    feature_version: str
    validation_method: str       # "walk_forward", "purged_kfold", "cpcv"
    evaluated_at: str            # ISO timestamp

    # Fold-level results
    fold_results: list[FoldResult]

    # Aggregate metrics (weighted average across folds)
    aggregate_classification: ClassificationMetrics
    aggregate_trading: TradingMetrics

    # Stability analysis
    stability: StabilityAnalysis

    # Acceptance decision
    accepted: bool
    acceptance_reasons: list[str]    # reasons for rejection (empty if accepted)

    def to_dict(self) -> dict:
        return {
            "modelVersion": self.model_version,
            "datasetVersion": self.dataset_version,
            "featureVersion": self.feature_version,
            "validationMethod": self.validation_method,
            "evaluatedAt": self.evaluated_at,
            "accepted": self.accepted,
            "acceptanceReasons": self.acceptance_reasons,
            "nFolds": len(self.fold_results),
            "aggregateClassification": self.aggregate_classification.to_dict(),
            "aggregateTrading": self.aggregate_trading.to_dict(),
            "stability": self.stability.to_dict(),
            "foldResults": [f.to_dict() for f in self.fold_results],
        }


# ─── Core metrics computation ─────────────────────────────────────────────────


class FinancialMetricsEvaluator:
    """
    Computes classification and trading metrics from model predictions.

    Classification metrics require y_true and y_pred (and optionally y_prob).
    Trading metrics require a returns Series (daily P&L as a fraction).

    When a strategy returns series is not directly available, a proxy
    is computed from (y_pred * forward_returns) — each bar's return is
    scaled by the predicted signal direction.
    """

    def __init__(
        self,
        risk_free_rate: float = RISK_FREE_RATE_ANNUAL,
        trading_days: int = TRADING_DAYS_PER_YEAR,
    ) -> None:
        self.risk_free_rate = risk_free_rate
        self.trading_days = trading_days
        self._rfr_daily = (1 + risk_free_rate) ** (1 / trading_days) - 1

    def classification_metrics(
        self,
        y_true: np.ndarray,
        y_pred: np.ndarray,
        y_prob: np.ndarray | None = None,
    ) -> ClassificationMetrics:
        """
        Compute classification performance metrics.

        Args:
            y_true:  Ground truth labels.
            y_pred:  Predicted labels.
            y_prob:  Class probabilities for ROC-AUC computation.
                     Shape (n_samples,) for binary or (n_samples, n_classes)
                     for multi-class.

        Returns:
            ClassificationMetrics dataclass.
        """
        n_samples = len(y_true)
        classes = np.unique(np.concatenate([y_true, y_pred]))
        n_classes = len(classes)
        avg = "binary" if n_classes == 2 else "macro"

        acc = float(accuracy_score(y_true, y_pred))
        prec = float(precision_score(y_true, y_pred, average=avg, zero_division=0))
        rec = float(recall_score(y_true, y_pred, average=avg, zero_division=0))
        f1 = float(f1_score(y_true, y_pred, average=avg, zero_division=0))

        roc_auc: float | None = None
        if y_prob is not None:
            try:
                if n_classes == 2:
                    prob = y_prob if y_prob.ndim == 1 else y_prob[:, 1]
                    roc_auc = float(roc_auc_score(y_true, prob))
                else:
                    roc_auc = float(roc_auc_score(
                        y_true, y_prob, multi_class="ovr", average="macro"
                    ))
            except Exception:
                roc_auc = None

        class_dist = {str(c): int(np.sum(y_true == c)) for c in classes}

        return ClassificationMetrics(
            accuracy=acc,
            precision=prec,
            recall=rec,
            f1=f1,
            roc_auc=roc_auc,
            n_samples=n_samples,
            n_classes=n_classes,
            class_distribution=class_dist,
        )

    def trading_metrics(
        self,
        returns: pd.Series | np.ndarray,
        signals: np.ndarray | None = None,
    ) -> TradingMetrics:
        """
        Compute trading performance metrics from a returns series.

        Args:
            returns: Daily (or per-bar) strategy return series.
                     Positive = profit, negative = loss.
                     If signals are also provided, returns are assumed to be
                     raw market returns and are scaled by the signal.
            signals: Optional signal array (+1 long, -1 short, 0 flat).
                     When provided, strategy_returns = signals * returns.

        Returns:
            TradingMetrics dataclass.
        """
        if isinstance(returns, pd.Series):
            ret_series = returns.dropna()
            start_date = str(ret_series.index[0]) if len(ret_series) > 0 else None
            end_date = str(ret_series.index[-1]) if len(ret_series) > 0 else None
            r = ret_series.values.astype(float)
        else:
            r = np.array(returns, dtype=float)
            r = r[~np.isnan(r)]
            start_date = None
            end_date = None

        if signals is not None:
            s = np.array(signals, dtype=float)
            # Align lengths
            min_len = min(len(r), len(s))
            r = r[:min_len] * s[:min_len]

        n_bars = len(r)
        if n_bars == 0:
            return self._empty_trading_metrics()

        # ── Annualized return & volatility ────────────────────────────────
        total_return = float(np.prod(1 + r) - 1)
        annual_factor = self.trading_days / n_bars
        annualized_return = float((1 + total_return) ** annual_factor - 1)
        annualized_vol = float(np.std(r, ddof=1) * np.sqrt(self.trading_days))

        # ── Sharpe ratio ─────────────────────────────────────────────────
        excess = r - self._rfr_daily
        if np.std(excess, ddof=1) > 1e-10:
            sharpe = float(np.mean(excess) / np.std(excess, ddof=1) * np.sqrt(self.trading_days))
        else:
            sharpe = 0.0

        # ── Sortino ratio ─────────────────────────────────────────────────
        downside = r[r < self._rfr_daily]
        if len(downside) > 1:
            downside_std = float(np.std(downside, ddof=1) * np.sqrt(self.trading_days))
            sortino = annualized_return / downside_std if downside_std > 1e-10 else 0.0
        else:
            sortino = sharpe  # no downside deviation — use Sharpe as proxy

        # ── Maximum drawdown ─────────────────────────────────────────────
        cum_returns = np.cumprod(1 + r)
        running_max = np.maximum.accumulate(cum_returns)
        drawdowns = (cum_returns - running_max) / running_max
        max_dd = float(np.min(drawdowns))   # most negative value (already negative)
        max_dd = abs(max_dd)                 # report as positive magnitude

        # Average drawdown: mean of all drawdown values during drawdown periods
        dd_periods = drawdowns[drawdowns < 0]
        avg_dd = float(np.mean(np.abs(dd_periods))) if len(dd_periods) > 0 else 0.0

        # Drawdown duration: longest continuous period below previous peak
        in_dd = drawdowns < 0
        max_dd_dur = 0
        cur_dur = 0
        for flag in in_dd:
            cur_dur = cur_dur + 1 if flag else 0
            max_dd_dur = max(max_dd_dur, cur_dur)

        # ── Calmar ratio ──────────────────────────────────────────────────
        calmar = annualized_return / max_dd if max_dd > 1e-10 else 0.0

        # ── Trade statistics ─────────────────────────────────────────────
        wins = r[r > 0]
        losses = r[r < 0]
        gross_profit = float(np.sum(wins)) if len(wins) > 0 else 0.0
        gross_loss = float(np.abs(np.sum(losses))) if len(losses) > 0 else 0.0
        profit_factor = gross_profit / gross_loss if gross_loss > 1e-10 else (float("inf") if gross_profit > 0 else 1.0)
        win_rate = float(len(wins) / n_bars) if n_bars > 0 else 0.0
        avg_win = float(np.mean(wins)) if len(wins) > 0 else 0.0
        avg_loss = float(np.mean(np.abs(losses))) if len(losses) > 0 else 0.0
        payoff = avg_win / avg_loss if avg_loss > 1e-10 else float("inf")
        expectancy = float(np.mean(r))

        # ── Turnover ──────────────────────────────────────────────────────
        # If signals provided, turnover = fraction of bars where signal changes
        if signals is not None:
            s_arr = np.array(signals, dtype=float)[:n_bars]
            changes = np.sum(np.diff(s_arr) != 0)
            turnover = float(changes / max(n_bars - 1, 1))
        else:
            # Proxy: fraction of bars with non-zero return (rough estimate)
            turnover = float(np.mean(np.abs(r) > 1e-10))

        return TradingMetrics(
            sharpe_ratio=round(sharpe, 4),
            sortino_ratio=round(sortino, 4),
            calmar_ratio=round(calmar, 4),
            max_drawdown=round(max_dd, 6),
            avg_drawdown=round(avg_dd, 6),
            max_drawdown_duration_bars=int(max_dd_dur),
            total_return=round(total_return, 6),
            annualized_return=round(annualized_return, 6),
            annualized_volatility=round(annualized_vol, 6),
            profit_factor=round(profit_factor, 4),
            expectancy=round(expectancy, 8),
            win_rate=round(win_rate, 4),
            avg_win=round(avg_win, 8),
            avg_loss=round(avg_loss, 8),
            payoff_ratio=round(payoff, 4),
            turnover=round(turnover, 4),
            n_bars=n_bars,
            start_date=start_date,
            end_date=end_date,
        )

    def _empty_trading_metrics(self) -> TradingMetrics:
        return TradingMetrics(
            sharpe_ratio=0.0, sortino_ratio=0.0, calmar_ratio=0.0,
            max_drawdown=0.0, avg_drawdown=0.0, max_drawdown_duration_bars=0,
            total_return=0.0, annualized_return=0.0, annualized_volatility=0.0,
            profit_factor=1.0, expectancy=0.0, win_rate=0.0,
            avg_win=0.0, avg_loss=0.0, payoff_ratio=1.0,
            turnover=0.0, n_bars=0,
        )

    def evaluate_fold(
        self,
        fold_index: int,
        y_true: np.ndarray,
        y_pred: np.ndarray,
        returns: pd.Series | np.ndarray,
        y_prob: np.ndarray | None = None,
        signals: np.ndarray | None = None,
        n_train: int = 0,
        test_start: str | None = None,
        test_end: str | None = None,
    ) -> FoldResult:
        """
        Evaluate a single fold and return a FoldResult.

        Args:
            fold_index: Fold number.
            y_true:     Ground truth labels for the test fold.
            y_pred:     Predicted labels for the test fold.
            returns:    Per-bar strategy returns for the test fold.
            y_prob:     Predicted class probabilities (for ROC-AUC).
            signals:    Signal directions (+1/-1/0) for turnover computation.
            n_train:    Size of training set.
            test_start: ISO string of test period start.
            test_end:   ISO string of test period end.

        Returns:
            FoldResult with both classification and trading metrics.
        """
        clf = self.classification_metrics(y_true, y_pred, y_prob)
        trd = self.trading_metrics(returns, signals)

        return FoldResult(
            fold_index=fold_index,
            classification=clf,
            trading=trd,
            n_train=n_train,
            n_test=len(y_true),
            test_start=test_start,
            test_end=test_end,
            fold_weight=float(len(y_true)),
        )


# ─── Stability analysis ───────────────────────────────────────────────────────


def compute_stability(fold_results: list[FoldResult]) -> StabilityAnalysis:
    """
    Compute cross-fold stability metrics.

    Args:
        fold_results: List of FoldResult objects from all validation folds.

    Returns:
        StabilityAnalysis dataclass with distribution statistics.
    """
    if not fold_results:
        return StabilityAnalysis(
            mean_sharpe=0.0, std_sharpe=0.0, min_sharpe=0.0, max_sharpe=0.0,
            sharpe_decay=0.0, mean_accuracy=0.0, std_accuracy=0.0,
            min_accuracy=0.0, max_accuracy=0.0, mean_max_drawdown=0.0,
            std_max_drawdown=0.0, worst_max_drawdown=0.0,
            max_fold_return_contribution=1.0,
            is_dominated_by_single_period=True,
            stability_score=0.0,
        )

    sharpes = np.array([f.trading.sharpe_ratio for f in fold_results])
    accuracies = np.array([f.classification.accuracy for f in fold_results])
    drawdowns = np.array([f.trading.max_drawdown for f in fold_results])
    total_rets = np.array([f.trading.total_return for f in fold_results])

    # Sharpe decay: compare first half vs second half of folds
    n = len(fold_results)
    mid = n // 2
    if mid > 0 and n - mid > 0:
        first_half_sharpe = float(np.mean(sharpes[:mid]))
        second_half_sharpe = float(np.mean(sharpes[mid:]))
        if abs(first_half_sharpe) > 1e-10:
            sharpe_decay = (first_half_sharpe - second_half_sharpe) / abs(first_half_sharpe)
        else:
            sharpe_decay = 0.0
    else:
        sharpe_decay = 0.0

    # Dominance: does any single fold account for > 60% of total return?
    total_abs_return = float(np.sum(np.abs(total_rets)))
    if total_abs_return > 1e-10:
        max_contribution = float(np.max(np.abs(total_rets)) / total_abs_return)
    else:
        max_contribution = 1.0 / max(n, 1)
    dominated = max_contribution > 0.6

    # Stability score: 0..1, computed from CV of Sharpe and accuracy
    # Lower CV (coefficient of variation) = higher stability
    sharpe_cv = (np.std(sharpes) / (abs(np.mean(sharpes)) + 1e-10))
    acc_cv = (np.std(accuracies) / (np.mean(accuracies) + 1e-10))
    # Penalize dominance
    dominance_penalty = max_contribution - (1.0 / n)
    raw_score = 1.0 - min(1.0, (sharpe_cv + acc_cv) / 2 + dominance_penalty)
    stability_score = float(max(0.0, raw_score))

    return StabilityAnalysis(
        mean_sharpe=float(np.mean(sharpes)),
        std_sharpe=float(np.std(sharpes, ddof=1) if n > 1 else 0.0),
        min_sharpe=float(np.min(sharpes)),
        max_sharpe=float(np.max(sharpes)),
        sharpe_decay=float(sharpe_decay),
        mean_accuracy=float(np.mean(accuracies)),
        std_accuracy=float(np.std(accuracies, ddof=1) if n > 1 else 0.0),
        min_accuracy=float(np.min(accuracies)),
        max_accuracy=float(np.max(accuracies)),
        mean_max_drawdown=float(np.mean(drawdowns)),
        std_max_drawdown=float(np.std(drawdowns, ddof=1) if n > 1 else 0.0),
        worst_max_drawdown=float(np.max(drawdowns)),
        max_fold_return_contribution=max_contribution,
        is_dominated_by_single_period=dominated,
        stability_score=stability_score,
    )


def aggregate_fold_results(
    fold_results: list[FoldResult],
    evaluator: FinancialMetricsEvaluator | None = None,
) -> tuple[ClassificationMetrics, TradingMetrics]:
    """
    Compute weighted-average aggregate metrics across all folds.

    Args:
        fold_results: List of FoldResult objects.
        evaluator:    Optional evaluator for re-computing aggregate returns.

    Returns:
        (ClassificationMetrics, TradingMetrics) aggregates.
    """
    if not fold_results:
        ev = evaluator or FinancialMetricsEvaluator()
        return (
            ClassificationMetrics(0.0, 0.0, 0.0, 0.0, None, 0, 2),
            ev._empty_trading_metrics(),
        )

    weights = np.array([f.fold_weight for f in fold_results])
    weights = weights / weights.sum()

    # Weighted classification
    clf_agg = ClassificationMetrics(
        accuracy=float(np.average([f.classification.accuracy for f in fold_results], weights=weights)),
        precision=float(np.average([f.classification.precision for f in fold_results], weights=weights)),
        recall=float(np.average([f.classification.recall for f in fold_results], weights=weights)),
        f1=float(np.average([f.classification.f1 for f in fold_results], weights=weights)),
        roc_auc=float(np.average(
            [f.classification.roc_auc for f in fold_results if f.classification.roc_auc is not None],
            weights=weights[:sum(1 for f in fold_results if f.classification.roc_auc is not None)],
        )) if any(f.classification.roc_auc is not None for f in fold_results) else None,
        n_samples=sum(f.n_test for f in fold_results),
        n_classes=max(f.classification.n_classes for f in fold_results),
    )

    # Weighted trading
    trd_agg = TradingMetrics(
        sharpe_ratio=float(np.average([f.trading.sharpe_ratio for f in fold_results], weights=weights)),
        sortino_ratio=float(np.average([f.trading.sortino_ratio for f in fold_results], weights=weights)),
        calmar_ratio=float(np.average([f.trading.calmar_ratio for f in fold_results], weights=weights)),
        max_drawdown=float(np.max([f.trading.max_drawdown for f in fold_results])),  # worst case
        avg_drawdown=float(np.average([f.trading.avg_drawdown for f in fold_results], weights=weights)),
        max_drawdown_duration_bars=int(np.max([f.trading.max_drawdown_duration_bars for f in fold_results])),
        total_return=float(np.average([f.trading.total_return for f in fold_results], weights=weights)),
        annualized_return=float(np.average([f.trading.annualized_return for f in fold_results], weights=weights)),
        annualized_volatility=float(np.average([f.trading.annualized_volatility for f in fold_results], weights=weights)),
        profit_factor=float(np.average([f.trading.profit_factor for f in fold_results], weights=weights)),
        expectancy=float(np.average([f.trading.expectancy for f in fold_results], weights=weights)),
        win_rate=float(np.average([f.trading.win_rate for f in fold_results], weights=weights)),
        avg_win=float(np.average([f.trading.avg_win for f in fold_results], weights=weights)),
        avg_loss=float(np.average([f.trading.avg_loss for f in fold_results], weights=weights)),
        payoff_ratio=float(np.average([f.trading.payoff_ratio for f in fold_results], weights=weights)),
        turnover=float(np.average([f.trading.turnover for f in fold_results], weights=weights)),
        n_bars=sum(f.trading.n_bars for f in fold_results),
    )

    return clf_agg, trd_agg


# ─── Model Acceptance Gate ────────────────────────────────────────────────────


@dataclass
class AcceptanceThresholds:
    """
    Thresholds for the model acceptance gate.

    A model must pass ALL thresholds to be accepted.  Defaults are calibrated
    for Indian equity F&O trading strategies.
    """

    # Classification floor
    min_accuracy: float = 0.52                  # must beat a random classifier
    min_f1: float = 0.45

    # Trading performance
    min_sharpe: float = 0.5                     # annualized
    min_total_return: float = 0.0               # out-of-sample must be positive
    max_drawdown: float = 0.25                  # 25% max drawdown
    min_profit_factor: float = 1.05             # gross profit > gross loss

    # Stability
    max_sharpe_std: float = 1.5                 # not too volatile across folds
    max_accuracy_std: float = 0.15
    max_fold_dominance: float = 0.60            # no single fold > 60% of total return
    min_stability_score: float = 0.3

    # Minimum data requirements
    min_test_bars: int = 30                     # at least 30 bars in test set


@dataclass
class AcceptanceDecision:
    """
    Model acceptance / rejection decision with detailed reasoning.
    """

    accepted: bool
    score: float                     # 0..1 overall acceptance score
    reasons: list[str]               # rejection reasons (empty if accepted)
    warnings: list[str]              # non-blocking concerns
    thresholds_checked: dict[str, dict]   # {metric: {value, threshold, passed}}

    def to_dict(self) -> dict:
        return asdict(self)


class ModelAcceptanceGate:
    """
    Evaluates whether a model should be promoted to production.

    A model is accepted only when ALL of the following hold:
      1. Out-of-sample classification performance exceeds the floor
      2. Trading performance is positive (Sharpe > threshold, return > 0)
      3. Maximum drawdown is within the configured limit
      4. Performance is stable across multiple validation windows
      5. No single time period dominates returns

    Usage:
        gate = ModelAcceptanceGate()
        decision = gate.evaluate(fold_results, stability, aggregate_trading)
        if not decision.accepted:
            print("Rejected:", decision.reasons)
    """

    def __init__(self, thresholds: AcceptanceThresholds | None = None) -> None:
        self.thresholds = thresholds or AcceptanceThresholds()

    def evaluate(
        self,
        fold_results: list[FoldResult],
        stability: StabilityAnalysis,
        aggregate_clf: ClassificationMetrics,
        aggregate_trd: TradingMetrics,
    ) -> AcceptanceDecision:
        """
        Run all acceptance checks and return a decision.

        Args:
            fold_results:    Per-fold evaluation results.
            stability:       Cross-fold stability analysis.
            aggregate_clf:   Weighted-average classification metrics.
            aggregate_trd:   Weighted-average trading metrics.

        Returns:
            AcceptanceDecision with accepted flag and rejection reasons.
        """
        th = self.thresholds
        reasons: list[str] = []
        warnings: list[str] = []
        checks: dict[str, dict] = {}

        def check(name: str, value: float, threshold: float, direction: str = "min") -> bool:
            """direction='min': value must be >= threshold. 'max': value must be <= threshold."""
            if direction == "min":
                passed = value >= threshold
            else:
                passed = value <= threshold
            checks[name] = {"value": round(value, 6), "threshold": threshold, "passed": passed}
            return passed

        # ── 1. Minimum data ───────────────────────────────────────────────
        if aggregate_trd.n_bars < th.min_test_bars:
            reasons.append(
                f"Insufficient test data: {aggregate_trd.n_bars} bars < {th.min_test_bars} required"
            )

        # ── 2. Classification performance ─────────────────────────────────
        if not check("accuracy", aggregate_clf.accuracy, th.min_accuracy):
            reasons.append(
                f"Accuracy {aggregate_clf.accuracy:.4f} below threshold {th.min_accuracy}"
            )
        if not check("f1_score", aggregate_clf.f1, th.min_f1):
            reasons.append(
                f"F1 score {aggregate_clf.f1:.4f} below threshold {th.min_f1}"
            )

        # ── 3. Trading performance ────────────────────────────────────────
        if not check("sharpe_ratio", aggregate_trd.sharpe_ratio, th.min_sharpe):
            reasons.append(
                f"Sharpe ratio {aggregate_trd.sharpe_ratio:.4f} below threshold {th.min_sharpe}"
            )
        if not check("total_return", aggregate_trd.total_return, th.min_total_return):
            reasons.append(
                f"Out-of-sample return {aggregate_trd.total_return:.4f} is not positive"
            )
        if not check("max_drawdown", aggregate_trd.max_drawdown, th.max_drawdown, direction="max"):
            reasons.append(
                f"Max drawdown {aggregate_trd.max_drawdown:.4f} exceeds limit {th.max_drawdown}"
            )
        if not check("profit_factor", aggregate_trd.profit_factor, th.min_profit_factor):
            reasons.append(
                f"Profit factor {aggregate_trd.profit_factor:.4f} below threshold {th.min_profit_factor}"
            )

        # ── 4. Stability ──────────────────────────────────────────────────
        if not check("sharpe_std", stability.std_sharpe, th.max_sharpe_std, direction="max"):
            reasons.append(
                f"Sharpe std {stability.std_sharpe:.4f} too high (max {th.max_sharpe_std}) — unstable"
            )
        if not check("accuracy_std", stability.std_accuracy, th.max_accuracy_std, direction="max"):
            warnings.append(
                f"Accuracy std {stability.std_accuracy:.4f} is high — review fold consistency"
            )
        if not check("stability_score", stability.stability_score, th.min_stability_score):
            reasons.append(
                f"Stability score {stability.stability_score:.4f} below threshold {th.min_stability_score}"
            )

        # ── 5. Dominance check ────────────────────────────────────────────
        if not check(
            "fold_dominance",
            stability.max_fold_return_contribution,
            th.max_fold_dominance,
            direction="max",
        ):
            reasons.append(
                f"Single fold contributes {stability.max_fold_return_contribution:.1%} of total return "
                f"(limit {th.max_fold_dominance:.1%}) — results may be path-dependent"
            )

        # ── 6. Soft warnings (non-blocking) ──────────────────────────────
        if stability.sharpe_decay > 0.3:
            warnings.append(
                f"Sharpe decay {stability.sharpe_decay:.2f} suggests performance degradation over time"
            )
        if aggregate_trd.max_drawdown_duration_bars > 60:
            warnings.append(
                f"Max drawdown duration {aggregate_trd.max_drawdown_duration_bars} bars is long"
            )

        accepted = len(reasons) == 0

        # Compute overall score: weighted pass rate on all checks
        n_checks = len(checks)
        n_passed = sum(1 for c in checks.values() if c["passed"])
        score = float(n_passed / n_checks) if n_checks > 0 else 0.0

        if accepted:
            logger.info(
                "model_accepted",
                score=score,
                sharpe=aggregate_trd.sharpe_ratio,
                accuracy=aggregate_clf.accuracy,
                max_dd=aggregate_trd.max_drawdown,
                stability=stability.stability_score,
            )
        else:
            logger.warning(
                "model_rejected",
                score=score,
                n_reasons=len(reasons),
                reasons=reasons,
            )

        return AcceptanceDecision(
            accepted=accepted,
            score=score,
            reasons=reasons,
            warnings=warnings,
            thresholds_checked=checks,
        )


# ─── Result persistence ───────────────────────────────────────────────────────


def save_validation_result(
    result: ValidationResult,
    output_dir: Path,
) -> Path:
    """
    Persist a ValidationResult to a JSON file.

    Historical results are NEVER overwritten — each run produces a new
    timestamped file.  This creates an immutable audit trail of all model
    evaluations.

    File naming: {model_version}_{evaluated_at}.json
    E.g.: regime-xgb-v1_20260831T142000Z.json

    Args:
        result:     The ValidationResult to save.
        output_dir: Directory to write the result file.

    Returns:
        Path of the written file.
    """
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # Build a safe filename from model version and timestamp
    safe_model_ver = result.model_version.replace("/", "-").replace(" ", "_")
    safe_ts = result.evaluated_at.replace(":", "").replace("-", "").replace("+", "")
    filename = f"{safe_model_ver}_{safe_ts}.json"
    output_path = output_dir / filename

    # Never overwrite — append a counter if the file already exists
    counter = 0
    while output_path.exists():
        counter += 1
        output_path = output_dir / f"{safe_model_ver}_{safe_ts}_{counter}.json"

    output_path.write_text(json.dumps(result.to_dict(), indent=2))
    logger.info(
        "validation_result_saved",
        path=str(output_path),
        model=result.model_version,
        accepted=result.accepted,
        n_folds=len(result.fold_results),
    )
    return output_path


def load_validation_history(
    output_dir: Path,
    model_version: str | None = None,
) -> list[ValidationResult]:
    """
    Load all historical validation results from a directory.

    Args:
        output_dir:    Directory containing saved validation result JSON files.
        model_version: Optional filter — only load results for this model version.

    Returns:
        List of ValidationResult dicts (raw JSON, not deserialized dataclasses).
        Sorted by evaluation timestamp, oldest first.
    """
    output_dir = Path(output_dir)
    if not output_dir.exists():
        return []

    results = []
    for path in sorted(output_dir.glob("*.json")):
        try:
            data = json.loads(path.read_text())
            if model_version and data.get("modelVersion") != model_version:
                continue
            results.append(data)
        except Exception as exc:
            logger.warning("validation_result_load_failed", path=str(path), error=str(exc))

    logger.info("validation_history_loaded", n_results=len(results), dir=str(output_dir))
    return results  # type: ignore[return-value]
