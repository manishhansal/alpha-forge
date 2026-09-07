"""
Phase 3S — Statistical inference & multiple-testing control (spec §29, §30, §35).

This module provides the statistical spine of the research factory:

  - Bootstrap confidence intervals (REUSES paper.evidence.bootstrap_ci — the
    deterministic, block-bootstrap implementation).
  - Multiple-testing corrections: Bonferroni, Holm, Benjamini-Hochberg (BH is
    REUSED from paper.evidence; Holm is added here), plus a family-wise summary
    that TRACKS the number of trials (spec §35).
  - Deflated Sharpe Ratio (DSR) — NEW (Bailey & López de Prado): deflates an
    observed Sharpe for the number of trials, skew, and kurtosis.
  - Probability of Backtest Overfitting (PBO) via CSCV — NEW: measures how often
    the in-sample-best configuration underperforms out-of-sample.
  - White's Reality Check — NEW (bootstrap): tests whether the BEST of many
    strategies beats a benchmark after accounting for the search.

Mandatory principle (spec §35): do NOT treat p<0.05 as sufficient after hundreds
of trials. The number of hypotheses/experiments/variants/configurations is
tracked and fed into the correction.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional

import numpy as np


# ── bootstrap CI (reuse) ─────────────────────────────────────────────────────

def bootstrap_ci_for(values, stat_fn=None, *, block: bool = True, policy=None):
    """
    Bootstrap CI wrapper reusing paper.evidence.bootstrap_ci (deterministic seed).
    Defaults to the mean statistic with a moving-block bootstrap.
    """
    from src.paper.evidence import bootstrap_ci, EvidencePolicy
    pol = policy or EvidencePolicy()
    x = np.asarray([v for v in values if v is not None], dtype=float)
    fn = stat_fn or (lambda a: float(np.mean(a)))
    return bootstrap_ci(x, fn, pol, block=block)


# ══════════════════════════════════════════════════════════════════════════════
# §35 Multiple-testing corrections
# ══════════════════════════════════════════════════════════════════════════════

class CorrectionMethod(str, Enum):
    BONFERRONI          = "BONFERRONI"
    HOLM                = "HOLM"
    BENJAMINI_HOCHBERG  = "BENJAMINI_HOCHBERG"


def holm_correction(pvalues: list[float], alpha: float = 0.05) -> list[bool]:
    """
    Holm-Bonferroni step-down family-wise correction (spec §35). Returns a boolean
    per input p-value: True = reject null after correction. More powerful than
    plain Bonferroni while still controlling FWER.
    """
    m = len(pvalues)
    if m == 0:
        return []
    order = sorted(range(m), key=lambda i: pvalues[i])
    reject = [False] * m
    for rank, i in enumerate(order):   # rank = 0..m-1
        threshold = alpha / (m - rank)
        if pvalues[i] <= threshold:
            reject[i] = True
        else:
            break   # step-down: once one fails, all larger p-values fail
    return reject


@dataclass
class MultipleTestingResult:
    """
    Family-wise multiple-testing outcome that TRACKS the number of trials
    (spec §35). `n_trials` is the TOTAL number tested (hypotheses × variants ×
    configurations), which may exceed len(pvalues) if only a subset is reported —
    the effective correction uses max(n_trials, len(pvalues)).
    """
    method:          CorrectionMethod
    n_trials:        int
    alpha:           float
    pvalues:         list[float]
    reject:          list[bool]
    n_significant:   int

    def to_dict(self) -> dict:
        return {
            "method":        self.method.value,
            "n_trials":      self.n_trials,
            "alpha":         self.alpha,
            "pvalues":       self.pvalues,
            "reject":        self.reject,
            "n_significant": self.n_significant,
        }


def correct_multiple_testing(
    pvalues: list[float],
    *,
    n_trials: Optional[int] = None,
    method: CorrectionMethod = CorrectionMethod.HOLM,
    alpha: float = 0.05,
) -> MultipleTestingResult:
    """
    Apply a multiple-testing correction that accounts for ALL trials (spec §35).
    If `n_trials` exceeds the number of reported p-values, the reported p-values
    are padded with 1.0 (non-significant) up to n_trials so the correction cannot
    be softened by hiding failed trials.
    """
    from src.paper.evidence import benjamini_hochberg, bonferroni

    reported = list(pvalues)
    total = max(n_trials or 0, len(reported))
    padded = reported + [1.0] * (total - len(reported))

    if method == CorrectionMethod.BONFERRONI:
        rej_all = bonferroni(padded, alpha=alpha)
    elif method == CorrectionMethod.HOLM:
        rej_all = holm_correction(padded, alpha=alpha)
    else:
        rej_all = benjamini_hochberg(padded, fdr=alpha)

    reject = rej_all[:len(reported)]
    return MultipleTestingResult(
        method=method, n_trials=total, alpha=alpha, pvalues=reported,
        reject=reject, n_significant=int(sum(reject)),
    )


# ══════════════════════════════════════════════════════════════════════════════
# Deflated Sharpe Ratio (NEW — Bailey & López de Prado)
# ══════════════════════════════════════════════════════════════════════════════

def _norm_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def _norm_ppf(p: float) -> float:
    """Inverse standard-normal CDF via a rational approximation (Acklam)."""
    if p <= 0.0:
        return -math.inf
    if p >= 1.0:
        return math.inf
    a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
         1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00]
    b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
         6.680131188771972e+01, -1.328068155288572e+01]
    c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
         -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00]
    d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
         3.754408661907416e+00]
    plow, phigh = 0.02425, 1 - 0.02425
    if p < plow:
        q = math.sqrt(-2 * math.log(p))
        return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / \
               ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1)
    if p > phigh:
        q = math.sqrt(-2 * math.log(1 - p))
        return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / \
                ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1)
    q = p - 0.5
    r = q * q
    return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q / \
           (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1)


@dataclass
class DeflatedSharpeResult:
    observed_sharpe:   float          # per-observation (non-annualized)
    deflated_psr:      float          # probabilistic Sharpe vs the deflated threshold
    expected_max_sharpe: float        # E[max Sharpe] under n_trials of pure noise
    n_trials:          int
    n_observations:    int
    is_significant:    bool           # deflated_psr > 0.95

    def to_dict(self) -> dict:
        return {
            "observed_sharpe":     self.observed_sharpe,
            "deflated_psr":        self.deflated_psr,
            "expected_max_sharpe": self.expected_max_sharpe,
            "n_trials":            self.n_trials,
            "n_observations":      self.n_observations,
            "is_significant":      self.is_significant,
        }


def deflated_sharpe_ratio(
    returns,
    *,
    n_trials: int,
    benchmark_sharpe: float = 0.0,
) -> DeflatedSharpeResult:
    """
    Deflated Sharpe Ratio (Bailey & López de Prado, spec §35). Deflates an observed
    Sharpe for the number of trials, sample length, skew and kurtosis.

    Steps:
      1. observed (per-obs) Sharpe SR.
      2. E[max SR] under n_trials i.i.d. N(0, 1/T) estimates (the selection bias):
         expected_max ≈ sqrt(Var(SR)) * ((1-γ)·Z⁻¹(1-1/N) + γ·Z⁻¹(1-1/(N·e)))
         with Var(SR) ≈ 1/T (null), γ = Euler-Mascheroni.
      3. Probabilistic Sharpe (PSR) of SR vs the deflated threshold using higher
         moments: DSR = Φ( (SR - SR*)·sqrt(T-1) / sqrt(1 - skew·SR + (kurt-1)/4·SR²) ).
    """
    r = np.asarray([v for v in returns if v is not None], dtype=float)
    T = len(r)
    if T < 3:
        return DeflatedSharpeResult(0.0, 0.0, 0.0, n_trials, T, False)
    mu = float(r.mean())
    sd = float(r.std(ddof=1))
    if sd <= 0:
        return DeflatedSharpeResult(0.0, 0.0, 0.0, n_trials, T, False)
    sr = mu / sd

    # higher moments of returns
    z = (r - mu) / sd
    skew = float(np.mean(z ** 3))
    kurt = float(np.mean(z ** 4))   # non-excess kurtosis (normal = 3)

    # E[max SR] under N pure-noise trials (variance of SR ~ 1/T under null)
    N = max(1, int(n_trials))
    var_sr = 1.0 / T
    gamma = 0.5772156649015329   # Euler-Mascheroni
    if N == 1:
        expected_max = benchmark_sharpe
    else:
        z1 = _norm_ppf(1.0 - 1.0 / N)
        z2 = _norm_ppf(1.0 - 1.0 / (N * math.e))
        expected_max = benchmark_sharpe + math.sqrt(var_sr) * ((1 - gamma) * z1 + gamma * z2)

    sr_star = expected_max
    denom = 1.0 - skew * sr + ((kurt - 1.0) / 4.0) * (sr ** 2)
    denom = max(denom, 1e-9)
    dsr_stat = (sr - sr_star) * math.sqrt(max(T - 1, 1)) / math.sqrt(denom)
    dsr = _norm_cdf(dsr_stat)

    return DeflatedSharpeResult(
        observed_sharpe=sr, deflated_psr=dsr, expected_max_sharpe=expected_max,
        n_trials=N, n_observations=T, is_significant=bool(dsr > 0.95),
    )


# ══════════════════════════════════════════════════════════════════════════════
# Probability of Backtest Overfitting (NEW — CSCV, Bailey et al.)
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class PBOResult:
    pbo:               float          # probability of backtest overfitting in [0,1]
    n_configs:         int
    n_splits:          int
    n_evaluated:       int
    overfit:           bool           # pbo > 0.5

    def to_dict(self) -> dict:
        return {"pbo": self.pbo, "n_configs": self.n_configs,
                "n_splits": self.n_splits, "n_evaluated": self.n_evaluated,
                "overfit": self.overfit}


def probability_backtest_overfitting(
    performance_matrix,
    *,
    n_splits: int = 8,
) -> PBOResult:
    """
    Probability of Backtest Overfitting via a simplified CSCV (spec §35).

    `performance_matrix` is (T_observations x N_configs): each column is one
    configuration's per-period performance. We split the rows into `n_splits`
    contiguous blocks, and over every way to choose half the blocks as IS and the
    complement as OOS, we find the IS-best config and record its OOS rank. PBO is
    the fraction of splits where the IS-best config lands in the bottom half OOS
    (logit(rank) <= 0). High PBO => in-sample winners are overfit.
    """
    from itertools import combinations

    M = np.asarray(performance_matrix, dtype=float)
    if M.ndim != 2 or M.shape[1] < 2:
        return PBOResult(0.0, M.shape[1] if M.ndim == 2 else 0, n_splits, 0, False)
    T, N = M.shape
    S = min(n_splits, T)
    if S < 2:
        return PBOResult(0.0, N, S, 0, False)
    # even number of blocks for symmetric IS/OOS partitions
    if S % 2 == 1:
        S -= 1
    block_idx = np.array_split(np.arange(T), S)

    logits: list[float] = []
    half = S // 2
    for is_blocks in combinations(range(S), half):
        is_set = set(is_blocks)
        is_rows = np.concatenate([block_idx[b] for b in range(S) if b in is_set])
        oos_rows = np.concatenate([block_idx[b] for b in range(S) if b not in is_set])
        is_perf = M[is_rows].mean(axis=0)
        oos_perf = M[oos_rows].mean(axis=0)
        best = int(np.argmax(is_perf))
        # OOS rank of the IS-best config (fractional rank in (0,1))
        oos_rank = (np.sum(oos_perf <= oos_perf[best])) / N
        oos_rank = min(max(oos_rank, 1e-6), 1 - 1e-6)
        logits.append(math.log(oos_rank / (1 - oos_rank)))

    n_eval = len(logits)
    pbo = float(np.mean([1.0 if lg <= 0 else 0.0 for lg in logits])) if n_eval else 0.0
    return PBOResult(pbo=pbo, n_configs=N, n_splits=S, n_evaluated=n_eval,
                     overfit=bool(pbo > 0.5))


# ══════════════════════════════════════════════════════════════════════════════
# White's Reality Check (NEW — bootstrap)
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class RealityCheckResult:
    best_statistic:    float
    p_value:           float
    n_strategies:      int
    n_bootstrap:       int
    reject_null:       bool           # p < alpha => best strategy genuinely beats benchmark

    def to_dict(self) -> dict:
        return {"best_statistic": self.best_statistic, "p_value": self.p_value,
                "n_strategies": self.n_strategies, "n_bootstrap": self.n_bootstrap,
                "reject_null": self.reject_null}


def whites_reality_check(
    excess_returns_matrix,
    *,
    n_bootstrap: int = 1000,
    alpha: float = 0.05,
    seed: int = 12345,
    block_size: int = 5,
) -> RealityCheckResult:
    """
    White's Reality Check (spec §35): tests whether the BEST of N strategies
    genuinely beats the benchmark after accounting for the multiplicity of the
    search. `excess_returns_matrix` is (T x N) of per-period returns in EXCESS of
    the benchmark. Uses a stationary moving-block bootstrap; deterministic seed.
    """
    X = np.asarray(excess_returns_matrix, dtype=float)
    if X.ndim != 2 or X.shape[0] < 2 or X.shape[1] < 1:
        return RealityCheckResult(0.0, 1.0, 0 if X.ndim < 2 else X.shape[1], n_bootstrap, False)
    T, N = X.shape
    mean_perf = X.mean(axis=0)
    V = math.sqrt(T) * float(np.max(mean_perf))     # observed best statistic

    rng = np.random.RandomState(seed)
    bs = max(1, block_size)
    centered = X - mean_perf                          # center under the null
    count_ge = 0
    for _ in range(n_bootstrap):
        n_blocks = int(math.ceil(T / bs))
        starts = rng.randint(0, max(1, T - bs + 1), size=n_blocks)
        idx = np.concatenate([np.arange(s, s + bs) for s in starts])[:T]
        resample = centered[idx]
        v_star = math.sqrt(T) * float(np.max(resample.mean(axis=0)))
        if v_star >= V:
            count_ge += 1
    p_value = (count_ge + 1) / (n_bootstrap + 1)
    return RealityCheckResult(
        best_statistic=V, p_value=p_value, n_strategies=N,
        n_bootstrap=n_bootstrap, reject_null=bool(p_value < alpha),
    )
