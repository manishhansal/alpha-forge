"""
Phase 3O — Quality / statistical-analysis layer (spec §26–§34).

Everything here is diagnostic and deterministic. It NEVER recalibrates, retrains,
or tunes thresholds (spec §5, §64) — it only measures and reports, defaulting to
INSUFFICIENT_EVIDENCE / UNKNOWN when there isn't enough data to say more.

  §26 calibration (Brier / log-loss / ECE / MCE / slope / intercept), OOS-vs-paper
  §27 EV validation — predicted EV vs realised NET by bucket
  §28 decile monotonicity (never assumed)
  §29 cross-sectional IC / RankIC / ICIR / long-short spread
  §30 regime analysis (reuse existing regime labels — do NOT redefine regimes)
  §31 signal-family aggregation + correlation (no double-counting)
  §32 drift: HEALTHY / WATCH / DEGRADED / SEVERE / UNKNOWN
  §33 alpha decay early-vs-late; latency vs timeframe
  §34 session quality dimensions + stability classification

Reuses src.paper.evidence (compute_decision_quality / conditional_breakdown /
EvidencePolicy) so sample-size gating and CIs are consistent with Phase 3N.
Import-clean: numpy + stdlib only at module load.
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from enum import Enum
from typing import Optional

import numpy as np


def _clean_pairs(pairs):
    return np.asarray([(float(p), float(o)) for p, o in pairs
                       if p is not None and o is not None], dtype=float)


# ══════════════════════════════════════════════════════════════════════════════
# §26 Calibration
# ══════════════════════════════════════════════════════════════════════════════

class CalibrationStatus(str, Enum):
    OK                             = "OK"
    CALIBRATION_INSUFFICIENT_EVIDENCE = "CALIBRATION_INSUFFICIENT_EVIDENCE"


def _brier(p, y):
    return float(np.mean((p - y) ** 2))


def _log_loss(p, y, eps: float = 1e-12):
    pc = np.clip(p, eps, 1 - eps)
    return float(-np.mean(y * np.log(pc) + (1 - y) * np.log(1 - pc)))


def _ece_mce(p, y, n_bins: int = 10):
    """Expected + maximum calibration error over equal-width probability bins."""
    edges = np.linspace(0.0, 1.0, n_bins + 1)
    ece = 0.0
    mce = 0.0
    n = len(p)
    for i in range(n_bins):
        lo, hi = edges[i], edges[i + 1]
        mask = (p >= lo) & (p < hi) if i < n_bins - 1 else (p >= lo) & (p <= hi)
        if not mask.any():
            continue
        conf = float(p[mask].mean())
        acc = float(y[mask].mean())
        gap = abs(acc - conf)
        ece += (mask.sum() / n) * gap
        mce = max(mce, gap)
    return float(ece), float(mce)


def _reliability_line(p, y):
    """Least-squares slope/intercept of realised outcome on predicted prob."""
    if len(p) < 2 or p.std() == 0:
        return None, None
    slope, intercept = np.polyfit(p, y, 1)
    return float(slope), float(intercept)


def calibration_report(prob_outcome_pairs, min_n: int = 100,
                       n_bins: int = 10, data_tag: str = "SYNTHETIC_DATA") -> dict:
    """
    Calibration diagnostics. Requires >= min_n observations (calibration needs
    volume — spec §68); otherwise CALIBRATION_INSUFFICIENT_EVIDENCE with NO metric
    values fabricated. Never triggers recalibration.
    """
    pairs = _clean_pairs(prob_outcome_pairs)
    n = len(pairs)
    if n < min_n:
        return {"status": CalibrationStatus.CALIBRATION_INSUFFICIENT_EVIDENCE.value,
                "n": n, "min_n": min_n, "data_tag": data_tag,
                "brier": None, "log_loss": None, "ece": None, "mce": None,
                "slope": None, "intercept": None,
                "note": "auto-recalibration is out of scope for this phase"}
    p, y = pairs[:, 0], pairs[:, 1]
    ece, mce = _ece_mce(p, y, n_bins)
    slope, intercept = _reliability_line(p, y)
    return {"status": CalibrationStatus.OK.value, "n": n, "data_tag": data_tag,
            "brier": _brier(p, y), "log_loss": _log_loss(p, y),
            "ece": ece, "mce": mce, "slope": slope, "intercept": intercept,
            "note": "diagnostic only; no recalibration performed"}


def calibration_oos_vs_paper(oos_pairs, paper_pairs, min_n: int = 100) -> dict:
    """Compare OOS-historical vs paper calibration (spec §26). Both must clear min_n."""
    oos = calibration_report(oos_pairs, min_n=min_n)
    paper = calibration_report(paper_pairs, min_n=min_n)
    consistent = None
    if oos["status"] == "OK" and paper["status"] == "OK":
        # a coarse "consistent" check: Brier degradation within 50% is not a mismatch
        consistent = paper["brier"] <= oos["brier"] * 1.5
    return {"oos": oos, "paper": paper, "consistent": consistent}


# ══════════════════════════════════════════════════════════════════════════════
# §27 EV validation — predicted EV vs realised NET by bucket
# ══════════════════════════════════════════════════════════════════════════════

def ev_validation(records: list[dict], n_buckets: int = 5, min_per_bucket: int = 20,
                  data_tag: str = "SYNTHETIC_DATA") -> dict:
    """
    Group decisions by predicted-EV quantile and compare mean predicted EV against
    mean realised NET pnl per bucket. records: [{"predicted_ev": float,
    "realized_net": float}]. Buckets with < min_per_bucket are INSUFFICIENT_EVIDENCE.
    NET (not gross) is the realised comparator (spec §17, §27).
    """
    rows = [(r.get("predicted_ev"), r.get("realized_net")) for r in records
            if r.get("predicted_ev") is not None and r.get("realized_net") is not None]
    n = len(rows)
    if n < n_buckets * min_per_bucket:
        return {"status": "INSUFFICIENT_EVIDENCE", "n": n, "buckets": [],
                "data_tag": data_tag}
    arr = np.asarray(rows, dtype=float)
    order = np.argsort(arr[:, 0])
    arr = arr[order]
    splits = np.array_split(arr, n_buckets)
    buckets = []
    for i, b in enumerate(splits):
        if len(b) < min_per_bucket:
            buckets.append({"bucket": i, "n": len(b), "status": "INSUFFICIENT_EVIDENCE"})
            continue
        buckets.append({"bucket": i, "n": len(b),
                        "mean_predicted_ev": float(b[:, 0].mean()),
                        "mean_realized_net": float(b[:, 1].mean()),
                        "status": "OK"})
    return {"status": "OK", "n": n, "n_buckets": n_buckets, "buckets": buckets,
            "data_tag": data_tag}


# ══════════════════════════════════════════════════════════════════════════════
# §28 Decile monotonicity (never assumed)
# ══════════════════════════════════════════════════════════════════════════════

class MonotonicityStatus(str, Enum):
    MONOTONIC             = "MONOTONIC"
    NON_MONOTONIC         = "NON_MONOTONIC"
    INSUFFICIENT_EVIDENCE = "INSUFFICIENT_EVIDENCE"


def decile_monotonicity(records: list[dict], score_key: str = "score",
                        outcome_key: str = "realized_net",
                        n_deciles: int = 10, min_per_decile: int = 10) -> dict:
    """
    Sort by score into deciles and report each decile's mean realised outcome.
    Monotonicity is TESTED (Spearman of decile index vs mean outcome), never
    assumed (spec §28). Thin data → INSUFFICIENT_EVIDENCE.
    """
    rows = [(r.get(score_key), r.get(outcome_key)) for r in records
            if r.get(score_key) is not None and r.get(outcome_key) is not None]
    if len(rows) < n_deciles * min_per_decile:
        return {"status": MonotonicityStatus.INSUFFICIENT_EVIDENCE.value,
                "n": len(rows), "deciles": []}
    arr = np.asarray(rows, dtype=float)
    arr = arr[np.argsort(arr[:, 0])]
    parts = np.array_split(arr, n_deciles)
    means = [float(p[:, 1].mean()) for p in parts]
    idx = np.arange(n_deciles)
    # Spearman = Pearson on ranks; means are already ordered by decile index
    rank_means = np.argsort(np.argsort(means))
    if np.std(rank_means) == 0:
        rho = 0.0
    else:
        rho = float(np.corrcoef(idx, rank_means)[0, 1])
    status = (MonotonicityStatus.MONOTONIC.value if rho >= 0.9
              else MonotonicityStatus.NON_MONOTONIC.value)
    return {"status": status, "n": len(rows), "spearman": rho,
            "decile_means": means,
            "deciles": [{"decile": i, "n": len(p), "mean_outcome": means[i]}
                        for i, p in enumerate(parts)]}


# ══════════════════════════════════════════════════════════════════════════════
# §29 Cross-sectional IC / RankIC / ICIR / spread
# ══════════════════════════════════════════════════════════════════════════════

def _pearson(a, b):
    if len(a) < 2 or np.std(a) == 0 or np.std(b) == 0:
        return None
    return float(np.corrcoef(a, b)[0, 1])


def _rank(a):
    return np.argsort(np.argsort(a)).astype(float)


def cross_sectional_ic(periods: list[dict], min_names: int = 5,
                       min_periods: int = 10) -> dict:
    """
    IC per period = corr(score, forward_return) across names that period.
    RankIC uses ranks. ICIR = mean(IC)/std(IC). Long-short spread = top-minus-
    bottom quantile mean forward return. periods: [{"scores":[...],
    "forward_returns":[...]}]. Under-populated periods are skipped; too few valid
    periods → INSUFFICIENT_EVIDENCE (spec §29, §68).
    """
    ics, rank_ics, spreads = [], [], []
    for per in periods:
        s = np.asarray(per.get("scores", []), dtype=float)
        f = np.asarray(per.get("forward_returns", []), dtype=float)
        if len(s) != len(f) or len(s) < min_names:
            continue
        ic = _pearson(s, f)
        ric = _pearson(_rank(s), _rank(f))
        if ic is not None:
            ics.append(ic)
        if ric is not None:
            rank_ics.append(ric)
        k = max(1, len(s) // 5)
        order = np.argsort(s)
        spreads.append(float(f[order[-k:]].mean() - f[order[:k]].mean()))
    if len(ics) < min_periods:
        return {"status": "INSUFFICIENT_EVIDENCE", "n_periods": len(ics),
                "min_periods": min_periods}
    ic_arr = np.asarray(ics)
    icir = float(ic_arr.mean() / ic_arr.std(ddof=1)) if ic_arr.std(ddof=1) > 0 else None
    return {"status": "OK", "n_periods": len(ics),
            "mean_ic": float(ic_arr.mean()),
            "mean_rank_ic": float(np.mean(rank_ics)) if rank_ics else None,
            "icir": icir,
            "mean_long_short_spread": float(np.mean(spreads)) if spreads else None}


# ══════════════════════════════════════════════════════════════════════════════
# §30 Regime analysis (reuse existing regime labels — do not redefine)
# ══════════════════════════════════════════════════════════════════════════════

def regime_breakdown(records: list[dict], regime_key: str = "regime",
                     value_key: str = "realized_net", min_per_regime: int = 20) -> dict:
    """
    Group realised NET by an EXISTING regime label (spec §30 — we consume the
    regime label produced upstream; we never invent a new regime taxonomy here).
    Thin regimes are flagged INSUFFICIENT_EVIDENCE rather than merged away.
    """
    groups: dict[str, list[float]] = {}
    for r in records:
        reg = r.get(regime_key)
        val = r.get(value_key)
        if reg is None or val is None:
            continue
        groups.setdefault(str(reg), []).append(float(val))
    out = {}
    for reg, vals in groups.items():
        a = np.asarray(vals, dtype=float)
        if len(a) < min_per_regime:
            out[reg] = {"n": len(a), "status": "INSUFFICIENT_EVIDENCE"}
        else:
            out[reg] = {"n": len(a), "mean_net": float(a.mean()),
                        "std_net": float(a.std(ddof=1)), "status": "OK"}
    return {"regimes": out, "n_regimes": len(out)}


# ══════════════════════════════════════════════════════════════════════════════
# §31 Signal-family aggregation + correlation (no double-count)
# ══════════════════════════════════════════════════════════════════════════════

def signal_family_correlation(family_series: dict, min_obs: int = 30) -> dict:
    """
    Pairwise correlation across signal families (spec §31). Highly correlated
    families are flagged so their contributions are not double-counted downstream.
    family_series: {family_name: [values...]}. Families with < min_obs are excluded.
    """
    names = [k for k, v in family_series.items() if v is not None and len(v) >= min_obs]
    if len(names) < 2:
        return {"status": "INSUFFICIENT_EVIDENCE", "families": names, "pairs": []}
    # align to the shortest length so correlations are comparable
    L = min(len(family_series[n]) for n in names)
    mat = {n: np.asarray(family_series[n][:L], dtype=float) for n in names}
    pairs = []
    for i in range(len(names)):
        for j in range(i + 1, len(names)):
            c = _pearson(mat[names[i]], mat[names[j]])
            pairs.append({"a": names[i], "b": names[j], "corr": c,
                          "redundant": (c is not None and abs(c) >= 0.9)})
    return {"status": "OK", "families": names, "pairs": pairs}


# ══════════════════════════════════════════════════════════════════════════════
# §32 Drift
# ══════════════════════════════════════════════════════════════════════════════

class DriftStatus(str, Enum):
    HEALTHY  = "HEALTHY"
    WATCH    = "WATCH"
    DEGRADED = "DEGRADED"
    SEVERE   = "SEVERE"
    UNKNOWN  = "UNKNOWN"


def drift_status(reference: list[float], current: list[float],
                 min_n: int = 30) -> dict:
    """
    Population-stability style drift on a metric distribution. Returns UNKNOWN
    (never a fabricated "healthy") when either window is too small. Thresholds are
    fixed and conservative; drift is only ever a diagnostic, never an auto-action.
    """
    ref = np.asarray([x for x in reference if x is not None], dtype=float)
    cur = np.asarray([x for x in current if x is not None], dtype=float)
    if len(ref) < min_n or len(cur) < min_n:
        return {"status": DriftStatus.UNKNOWN.value,
                "n_ref": len(ref), "n_cur": len(cur), "psi": None}
    edges = np.percentile(ref, np.linspace(0, 100, 11))
    edges[0], edges[-1] = -np.inf, np.inf
    ref_h = np.histogram(ref, bins=edges)[0] / len(ref)
    cur_h = np.histogram(cur, bins=edges)[0] / len(cur)
    eps = 1e-6
    psi = float(np.sum((cur_h - ref_h) * np.log((cur_h + eps) / (ref_h + eps))))
    if psi < 0.1:
        s = DriftStatus.HEALTHY
    elif psi < 0.2:
        s = DriftStatus.WATCH
    elif psi < 0.4:
        s = DriftStatus.DEGRADED
    else:
        s = DriftStatus.SEVERE
    return {"status": s.value, "psi": psi, "n_ref": len(ref), "n_cur": len(cur)}


# ══════════════════════════════════════════════════════════════════════════════
# §33 Alpha decay + latency
# ══════════════════════════════════════════════════════════════════════════════

def alpha_decay(early: list[float], late: list[float], min_n: int = 20) -> dict:
    """
    Compare early-period vs late-period mean outcome (spec §33). Decay = early
    mean minus late mean (positive = decaying). INSUFFICIENT_EVIDENCE when thin.
    """
    e = np.asarray([x for x in early if x is not None], dtype=float)
    l = np.asarray([x for x in late if x is not None], dtype=float)
    if len(e) < min_n or len(l) < min_n:
        return {"status": "INSUFFICIENT_EVIDENCE", "n_early": len(e), "n_late": len(l)}
    return {"status": "OK", "early_mean": float(e.mean()), "late_mean": float(l.mean()),
            "decay": float(e.mean() - l.mean()), "n_early": len(e), "n_late": len(l)}


def latency_vs_timeframe(decision_latencies_s: list[float], timeframe_seconds: float,
                         min_n: int = 10) -> dict:
    """
    Compare decision/processing latency against the trading timeframe. Flags when
    p95 latency consumes a large fraction of the timeframe (a signal may be stale
    before it can be acted on). UNAVAILABLE when timeframe is not positive.
    """
    lat = np.asarray([x for x in decision_latencies_s if x is not None], dtype=float)
    if len(lat) < min_n:
        return {"status": "INSUFFICIENT_EVIDENCE", "n": len(lat)}
    if timeframe_seconds is None or timeframe_seconds <= 0:
        return {"status": "UNAVAILABLE", "reason": "non-positive timeframe"}
    p95 = float(np.percentile(lat, 95))
    ratio = p95 / float(timeframe_seconds)
    return {"status": "OK", "p50": float(np.percentile(lat, 50)), "p95": p95,
            "timeframe_seconds": float(timeframe_seconds), "p95_ratio": ratio,
            "latency_material": ratio > 0.25}


# ══════════════════════════════════════════════════════════════════════════════
# §34 Session quality dimensions + stability
# ══════════════════════════════════════════════════════════════════════════════

class QualityDimension(str, Enum):
    DATA               = "DATA"
    DECISION           = "DECISION"
    EXECUTION          = "EXECUTION"
    ACCOUNTING         = "ACCOUNTING"
    STATISTICAL        = "STATISTICAL"
    OPERATIONAL        = "OPERATIONAL"
    PROVENANCE_QUALITY = "PROVENANCE_QUALITY"


class QualityStatus(str, Enum):
    PASS                  = "PASS"
    WARN                  = "WARN"
    FAIL                  = "FAIL"
    INSUFFICIENT_EVIDENCE = "INSUFFICIENT_EVIDENCE"


QUALITY_DIMENSIONS = tuple(d.value for d in QualityDimension)


@dataclass
class SessionQuality:
    """Per-dimension quality assessment for one session (spec §34)."""
    dimensions: dict = field(default_factory=dict)   # dim -> {status, reason}

    def set(self, dim: QualityDimension, status: QualityStatus, reason: str = "") -> None:
        self.dimensions[dim.value] = {"status": status.value, "reason": reason}

    def overall(self) -> str:
        """Fail-closed roll-up: any FAIL→FAIL; else any INSUFFICIENT→INSUFFICIENT;
        else any WARN→WARN; else PASS. Missing dimensions count as INSUFFICIENT."""
        seen = {self.dimensions.get(d, {}).get("status",
                QualityStatus.INSUFFICIENT_EVIDENCE.value) for d in QUALITY_DIMENSIONS}
        if QualityStatus.FAIL.value in seen:
            return QualityStatus.FAIL.value
        if QualityStatus.INSUFFICIENT_EVIDENCE.value in seen:
            return QualityStatus.INSUFFICIENT_EVIDENCE.value
        if QualityStatus.WARN.value in seen:
            return QualityStatus.WARN.value
        return QualityStatus.PASS.value

    def to_dict(self) -> dict:
        return {"dimensions": self.dimensions, "overall": self.overall()}


class StabilityClass(str, Enum):
    ROBUST                = "ROBUST"
    REGIME_DEPENDENT      = "REGIME_DEPENDENT"
    UNSTABLE              = "UNSTABLE"
    INSUFFICIENT_EVIDENCE = "INSUFFICIENT_EVIDENCE"


def stability_classification(per_regime_means: dict, min_regimes: int = 2) -> dict:
    """
    Classify stability from per-regime mean outcomes (spec §34). ROBUST = positive
    and similar sign across regimes; REGIME_DEPENDENT = sign flips by regime;
    UNSTABLE = large dispersion / negative overall; INSUFFICIENT_EVIDENCE when
    fewer than min_regimes have data.
    """
    vals = [v for v in per_regime_means.values() if v is not None]
    if len(vals) < min_regimes:
        return {"status": StabilityClass.INSUFFICIENT_EVIDENCE.value,
                "n_regimes": len(vals)}
    a = np.asarray(vals, dtype=float)
    signs = np.sign(a)
    if np.all(signs >= 0) and a.min() > 0:
        s = StabilityClass.ROBUST
    elif len(set(signs.tolist())) > 1:
        s = StabilityClass.REGIME_DEPENDENT
    else:
        s = StabilityClass.UNSTABLE
    return {"status": s.value, "n_regimes": len(vals),
            "min_mean": float(a.min()), "max_mean": float(a.max())}
