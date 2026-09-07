"""
Phase 3N — Evidence & performance metrics (spec §35–§39, §45, §48, §57, §60).

Computes paper-trading metrics HONESTLY:
  * every metric carries sample_size / effective_sample_size / observation window /
    confidence interval / status; below the configured minimum it is
    INSUFFICIENT_EVIDENCE, never a fabricated point estimate (spec §35, §48);
  * uncertainty via bootstrap and block-bootstrap (serial dependence) — no
    assumption that every trade is independent (spec §37);
  * conditional breakdowns by regime/sector/instrument/liquidity/… (spec §36);
  * multiple-testing control (Benjamini-Hochberg / Bonferroni) so a best subgroup
    picked after the fact is not sold as unbiased evidence (spec §38);
  * official-vs-diagnostic-vs-degraded-vs-untrusted separation — ONLY
    OFFICIAL_EVIDENCE from REAL_MARKET_DATA can influence readiness (spec §45, §57).

Determinism: pure stdlib + numpy with a FIXED seed for bootstrap. No global
np.random.*. Import-clean.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field, asdict
from enum import Enum
from typing import Optional

import numpy as np


# ══════════════════════════════════════════════════════════════════════════════
# Evidence policy + status
# ══════════════════════════════════════════════════════════════════════════════

class MetricStatus(str, Enum):
    OK                    = "OK"
    INSUFFICIENT_EVIDENCE = "INSUFFICIENT_EVIDENCE"
    UNAVAILABLE           = "UNAVAILABLE"


@dataclass(frozen=True)
class EvidencePolicy:
    """
    Config-driven evidence policy (spec §48). Thresholds are NOT invented per
    call-site; they live here and are reported alongside every metric.
    """
    version: str = "3n-evidence-policy-v1"
    min_observations: int = 30          # below this: INSUFFICIENT_EVIDENCE
    min_effective_observations: float = 10.0
    bootstrap_resamples: int = 1000
    block_size: int = 5                 # block-bootstrap block length
    ci_level: float = 0.95
    seed: int = 12345                   # fixed → deterministic CIs


@dataclass
class Metric:
    """One metric value with full uncertainty + provenance (spec §35, §48)."""
    name:           str
    value:          Optional[float]
    sample_size:    int
    effective_sample_size: Optional[float]
    ci_low:         Optional[float]
    ci_high:        Optional[float]
    status:         str
    observation_window: str = ""
    data_tag:       str = "SYNTHETIC_DATA"
    notes:          str = ""

    def to_dict(self) -> dict:
        return asdict(self)


# ══════════════════════════════════════════════════════════════════════════════
# Uncertainty (spec §37)
# ══════════════════════════════════════════════════════════════════════════════

def _effective_sample_size(x: np.ndarray) -> float:
    """
    Effective sample size accounting for lag-1 autocorrelation:
    n_eff = n * (1 - rho) / (1 + rho), clamped to [1, n]. Serial dependence
    shrinks the effective n (spec §37).
    """
    n = len(x)
    if n < 3:
        return float(n)
    x0, x1 = x[:-1], x[1:]
    sd0, sd1 = x0.std(), x1.std()
    if sd0 == 0 or sd1 == 0:
        return float(n)
    rho = float(np.corrcoef(x0, x1)[0, 1])
    if math.isnan(rho):
        return float(n)
    rho = max(-0.999, min(0.999, rho))
    n_eff = n * (1.0 - rho) / (1.0 + rho)
    return float(max(1.0, min(float(n), n_eff)))


def bootstrap_ci(x: np.ndarray, stat_fn, policy: EvidencePolicy,
                 block: bool = False) -> tuple[Optional[float], Optional[float]]:
    """
    Bootstrap CI for a statistic. `block=True` uses a moving-block bootstrap to
    preserve serial dependence (spec §37). Deterministic via fixed seed.
    """
    n = len(x)
    if n < 2:
        return None, None
    rng = np.random.RandomState(policy.seed)
    stats = np.empty(policy.bootstrap_resamples)
    bs = max(1, policy.block_size)
    for i in range(policy.bootstrap_resamples):
        if block and n > bs:
            n_blocks = int(math.ceil(n / bs))
            starts = rng.randint(0, n - bs + 1, size=n_blocks)
            idx = np.concatenate([np.arange(s, s + bs) for s in starts])[:n]
            sample = x[idx]
        else:
            sample = x[rng.randint(0, n, size=n)]
        stats[i] = stat_fn(sample)
    alpha = (1.0 - policy.ci_level) / 2.0
    lo = float(np.nanpercentile(stats, 100 * alpha))
    hi = float(np.nanpercentile(stats, 100 * (1 - alpha)))
    return lo, hi


def _metric_from_series(name: str, x: np.ndarray, stat_fn, policy: EvidencePolicy,
                        window: str = "", data_tag: str = "SYNTHETIC_DATA",
                        block: bool = True) -> Metric:
    n = len(x)
    if n == 0:
        return Metric(name, None, 0, None, None, None, MetricStatus.UNAVAILABLE.value,
                      window, data_tag, "no observations")
    n_eff = _effective_sample_size(x)
    if n < policy.min_observations or n_eff < policy.min_effective_observations:
        return Metric(name, None, n, n_eff, None, None,
                      MetricStatus.INSUFFICIENT_EVIDENCE.value, window, data_tag,
                      f"n={n} (n_eff={n_eff:.1f}) below policy min "
                      f"{policy.min_observations}/{policy.min_effective_observations}")
    value = float(stat_fn(x))
    lo, hi = bootstrap_ci(x, stat_fn, policy, block=block)
    return Metric(name, value, n, n_eff, lo, hi, MetricStatus.OK.value, window, data_tag)


# ══════════════════════════════════════════════════════════════════════════════
# Metric statistics
# ══════════════════════════════════════════════════════════════════════════════

def _sharpe(r: np.ndarray) -> float:
    sd = r.std(ddof=1) if len(r) > 1 else 0.0
    return float(r.mean() / sd * math.sqrt(252)) if sd > 0 else 0.0

def _sortino(r: np.ndarray) -> float:
    downside = r[r < 0]
    dd = downside.std(ddof=1) if len(downside) > 1 else 0.0
    return float(r.mean() / dd * math.sqrt(252)) if dd > 0 else 0.0

def _max_drawdown(r: np.ndarray) -> float:
    equity = np.cumsum(r)
    peak = np.maximum.accumulate(equity)
    dd = equity - peak
    return float(dd.min()) if len(dd) else 0.0

def _var(r: np.ndarray, q: float = 0.05) -> float:
    return float(np.percentile(r, 100 * q)) if len(r) else 0.0

def _cvar(r: np.ndarray, q: float = 0.05) -> float:
    if not len(r):
        return 0.0
    var = np.percentile(r, 100 * q)
    tail = r[r <= var]
    return float(tail.mean()) if len(tail) else float(var)

def _win_rate(pnl: np.ndarray) -> float:
    return float((pnl > 0).mean()) if len(pnl) else 0.0

def _profit_factor(pnl: np.ndarray) -> float:
    gains = pnl[pnl > 0].sum()
    losses = -pnl[pnl < 0].sum()
    return float(gains / losses) if losses > 0 else float("inf") if gains > 0 else 0.0

def _expectancy(pnl: np.ndarray) -> float:
    return float(pnl.mean()) if len(pnl) else 0.0

def _brier(pairs: np.ndarray) -> float:
    # pairs: column 0 = predicted prob, column 1 = outcome {0,1}
    return float(np.mean((pairs[:, 0] - pairs[:, 1]) ** 2)) if len(pairs) else 0.0


# ══════════════════════════════════════════════════════════════════════════════
# Metric suite
# ══════════════════════════════════════════════════════════════════════════════

def compute_return_metrics(returns: list[float], policy: Optional[EvidencePolicy] = None,
                           window: str = "", data_tag: str = "SYNTHETIC_DATA") -> dict:
    """Returns + risk metrics, each with n / n_eff / CI / status (spec §35)."""
    pol = policy or EvidencePolicy()
    r = np.asarray([x for x in returns if x is not None], dtype=float)
    return {
        "sharpe":      _metric_from_series("sharpe", r, _sharpe, pol, window, data_tag).to_dict(),
        "sortino":     _metric_from_series("sortino", r, _sortino, pol, window, data_tag).to_dict(),
        "max_drawdown": _metric_from_series("max_drawdown", r, _max_drawdown, pol, window, data_tag).to_dict(),
        "var_95":      _metric_from_series("var_95", r, _var, pol, window, data_tag).to_dict(),
        "cvar_95":     _metric_from_series("cvar_95", r, _cvar, pol, window, data_tag).to_dict(),
        "mean_return": _metric_from_series("mean_return", r, lambda a: float(a.mean()), pol, window, data_tag).to_dict(),
    }


def compute_trading_metrics(trade_pnls: list[float], policy: Optional[EvidencePolicy] = None,
                            window: str = "", data_tag: str = "SYNTHETIC_DATA") -> dict:
    """Trading metrics (win rate, profit factor, expectancy) (spec §35)."""
    pol = policy or EvidencePolicy()
    p = np.asarray([x for x in trade_pnls if x is not None], dtype=float)
    return {
        "win_rate":      _metric_from_series("win_rate", p, _win_rate, pol, window, data_tag).to_dict(),
        "profit_factor": _metric_from_series("profit_factor", p, _profit_factor, pol, window, data_tag).to_dict(),
        "expectancy":    _metric_from_series("expectancy", p, _expectancy, pol, window, data_tag).to_dict(),
    }


def compute_decision_quality(prob_outcome_pairs: list[tuple], policy: Optional[EvidencePolicy] = None,
                             window: str = "", data_tag: str = "SYNTHETIC_DATA") -> dict:
    """Calibration/Brier decision-quality metrics (spec §35)."""
    pol = policy or EvidencePolicy()
    pairs = np.asarray([(p, o) for p, o in prob_outcome_pairs
                        if p is not None and o is not None], dtype=float)
    if len(pairs) == 0:
        return {"brier": Metric("brier", None, 0, None, None, None,
                                MetricStatus.UNAVAILABLE.value, window, data_tag).to_dict()}
    return {"brier": _metric_from_series("brier", pairs, _brier, pol, window, data_tag, block=False).to_dict()}


# ══════════════════════════════════════════════════════════════════════════════
# Conditional breakdowns (spec §36) + multiple-testing (spec §38)
# ══════════════════════════════════════════════════════════════════════════════

def conditional_breakdown(records: list[dict], by: str, value_key: str,
                          stat_fn=_expectancy, policy: Optional[EvidencePolicy] = None,
                          data_tag: str = "SYNTHETIC_DATA") -> dict:
    """
    Break a metric down by a dimension (regime/sector/instrument/liquidity/mcap/
    direction/strategy/family/timeframe/confidence/EV/prob bucket) — spec §36.
    Each group reports its own n / CI / status (INSUFFICIENT_EVIDENCE for thin
    groups), so a thin bucket cannot masquerade as evidence.
    """
    pol = policy or EvidencePolicy()
    groups: dict[str, list[float]] = {}
    for rec in records:
        key = str(rec.get(by, ""))
        v = rec.get(value_key)
        if v is not None:
            groups.setdefault(key, []).append(float(v))
    out = {}
    for key, vals in sorted(groups.items()):
        out[key] = _metric_from_series(f"{by}={key}", np.asarray(vals, dtype=float),
                                       stat_fn, pol, data_tag=data_tag, block=False).to_dict()
    return out


def benjamini_hochberg(pvalues: list[float], fdr: float = 0.05) -> list[bool]:
    """
    Benjamini-Hochberg FDR control (spec §38). Returns a boolean per input p-value:
    True = reject null at the given FDR after correction. Guards against selecting
    the best subgroup post-hoc.
    """
    m = len(pvalues)
    if m == 0:
        return []
    order = sorted(range(m), key=lambda i: pvalues[i])
    reject = [False] * m
    max_k = -1
    for rank, i in enumerate(order, start=1):
        if pvalues[i] <= (rank / m) * fdr:
            max_k = rank
    if max_k > 0:
        for rank, i in enumerate(order, start=1):
            if rank <= max_k:
                reject[i] = True
    return reject


def bonferroni(pvalues: list[float], alpha: float = 0.05) -> list[bool]:
    """Bonferroni family-wise correction (spec §38)."""
    m = len(pvalues)
    return [p <= alpha / m for p in pvalues] if m else []


# ══════════════════════════════════════════════════════════════════════════════
# Official-evidence gating (spec §45, §57)
# ══════════════════════════════════════════════════════════════════════════════

def filter_official_evidence(records: list[dict]) -> tuple[list[dict], dict]:
    """
    Split records into OFFICIAL vs excluded (spec §45, §57). A record counts as
    OFFICIAL evidence ONLY if it is REAL_MARKET_DATA AND evidence_status ==
    OFFICIAL_EVIDENCE AND provenance is complete (provenance_complete truthy).
    Everything else (synthetic/replay/diagnostic/degraded/untrusted/incomplete
    provenance) is excluded from official performance evidence — this is what
    stops a convenient synthetic run from becoming a performance claim.
    """
    official, excluded = [], {"synthetic_or_replay": 0, "not_official": 0,
                              "incomplete_provenance": 0}
    for rec in records:
        if rec.get("data_tag") != "REAL_MARKET_DATA":
            excluded["synthetic_or_replay"] += 1
            continue
        if rec.get("evidence_status") != "OFFICIAL_EVIDENCE":
            excluded["not_official"] += 1
            continue
        if not rec.get("provenance_complete", False):
            excluded["incomplete_provenance"] += 1
            continue
        official.append(rec)
    return official, excluded
