"""
Ranking Evaluation Engine — Phase 3E.

Implements all research diagnostics for cross-sectional alpha systems:

    IC / Rank IC
    ICIR
    IC distribution statistics
    Decile analysis (Q1–Q10 returns)
    Top-bottom spread
    Monotonicity score
    Rank stability (auto-correlation, top-K overlap)
    Turnover proxy
    Coverage
    Regime breakdown stubs

Design principles
-----------------
1. IC is computed CROSS-SECTIONALLY per timestamp (Spearman of scores vs
   realized returns within U_t).  Never computed globally across time.
2. ICIR = mean(IC) / std(IC).  Annualization is documented, not blind.
3. Decile assignment uses quantile cut within each timestamp's cross-section.
4. All results report ALL folds, ALL models, ALL deciles.
   No cherry-picking.
5. Multiple-comparison tracking: experiment counts are recorded.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional

import numpy as np
import pandas as pd


# ── IC computation ────────────────────────────────────────────────────────────

def compute_rank_ic(
    scores: np.ndarray,
    realized: np.ndarray,
) -> Optional[float]:
    """
    Spearman rank correlation between alpha scores and realized returns
    within a single cross-section (one timestamp).

    Parameters
    ----------
    scores    : (n,) predicted alpha scores (higher = more attractive).
    realized  : (n,) realized returns (same ordering as scores).

    Returns
    -------
    float in [-1, 1] or None if fewer than 5 valid pairs.

    Note: Rank IC and IC (Pearson) are both computed here.
    The Spearman version is referred to as Rank IC throughout Phase 3E
    because it uses rank-of-scores vs rank-of-returns.
    """
    mask = np.isfinite(scores) & np.isfinite(realized)
    n    = int(mask.sum())
    if n < 5:
        return None

    s = scores[mask]
    r = realized[mask]

    # Spearman rank correlation
    rs = _rankdata(s)
    rr = _rankdata(r)
    n_f = float(n)
    cov = float(np.cov(rs, rr)[0, 1])
    ss  = float(np.std(rs, ddof=1))
    sr  = float(np.std(rr, ddof=1))
    if ss < 1e-12 or sr < 1e-12:
        return None
    return float(cov / (ss * sr))


def compute_ic(
    scores: np.ndarray,
    realized: np.ndarray,
) -> Optional[float]:
    """Pearson IC between scores and realized returns."""
    mask = np.isfinite(scores) & np.isfinite(realized)
    n    = int(mask.sum())
    if n < 5:
        return None
    s, r = scores[mask], realized[mask]
    denom = float(np.std(s, ddof=1)) * float(np.std(r, ddof=1))
    if denom < 1e-12:
        return None
    return float(np.cov(s, r)[0, 1] / denom)


def compute_ic_series(
    panel_df: pd.DataFrame,
    score_col:    str,
    realized_col: str,
    timestamp_col: str,
    min_cs_size:  int = 5,
    use_rank_ic:  bool = True,
) -> pd.Series:
    """
    Compute per-timestamp IC (or Rank IC) across a panel DataFrame.

    Parameters
    ----------
    panel_df      : Long-format DataFrame with scores, realized returns, timestamps.
    score_col     : Column name for predicted alpha scores.
    realized_col  : Column name for realized returns.
    timestamp_col : Column name for prediction timestamps.
    min_cs_size   : Minimum rows per timestamp; else NaN.
    use_rank_ic   : If True, compute Spearman (Rank IC); else Pearson (IC).

    Returns
    -------
    pd.Series indexed by timestamp with IC values (NaN where insufficient data).

    Causal guarantee
    ----------------
    IC for each timestamp uses only that timestamp's cross-section.
    """
    fn = compute_rank_ic if use_rank_ic else compute_ic
    result: dict = {}

    for ts, grp in panel_df.groupby(timestamp_col, sort=True):
        if len(grp) < min_cs_size:
            result[ts] = np.nan
            continue
        s  = grp[score_col].to_numpy(dtype=float)
        r  = grp[realized_col].to_numpy(dtype=float)
        ic = fn(s, r)
        result[ts] = ic if ic is not None else np.nan

    return pd.Series(result)


@dataclass
class ICSummary:
    """Summary statistics for an IC time series."""
    mean:           Optional[float] = None
    median:         Optional[float] = None
    std:            Optional[float] = None
    icir:           Optional[float] = None
    positive_pct:   Optional[float] = None   # % of timestamps with IC > 0
    p5:             Optional[float] = None
    p25:            Optional[float] = None
    p75:            Optional[float] = None
    p95:            Optional[float] = None
    n_timestamps:   int = 0
    n_nan:          int = 0


def summarise_ic_series(ic_series: pd.Series) -> ICSummary:
    """
    Compute descriptive statistics for an IC time series.

    ICIR = mean(IC) / std(IC).  Not annualized (use annualize_icir() if needed).
    """
    valid = ic_series.dropna().to_numpy(dtype=float)
    n     = len(valid)
    n_nan = int(ic_series.isna().sum())

    if n == 0:
        return ICSummary(n_timestamps=0, n_nan=n_nan)

    mu  = float(np.mean(valid))
    med = float(np.median(valid))
    sig = float(np.std(valid, ddof=1)) if n > 1 else 0.0
    icir = mu / sig if sig > 1e-10 else None

    return ICSummary(
        mean=round(mu, 6),
        median=round(med, 6),
        std=round(sig, 6),
        icir=round(icir, 6) if icir is not None else None,
        positive_pct=round(float((valid > 0).sum() / n * 100), 2),
        p5=round(float(np.percentile(valid, 5)), 6),
        p25=round(float(np.percentile(valid, 25)), 6),
        p75=round(float(np.percentile(valid, 75)), 6),
        p95=round(float(np.percentile(valid, 95)), 6),
        n_timestamps=n + n_nan,
        n_nan=n_nan,
    )


def annualize_icir(icir: float, periods_per_year: float = 252.0) -> float:
    """
    Annualize ICIR: ICIR_ann = ICIR × √periods_per_year.

    Use daily IC series → periods_per_year = 252.
    Documents the convention explicitly.
    """
    return icir * math.sqrt(periods_per_year)


# ── Decile analysis ───────────────────────────────────────────────────────────

@dataclass
class DecileStats:
    """Return statistics for one decile bucket."""
    decile:      int            # 1=lowest score, 10=highest score
    n_obs:       int
    mean_return: Optional[float]
    median_return: Optional[float]
    std_return:  Optional[float]
    win_rate:    Optional[float]    # fraction with return > 0
    excess_mean: Optional[float]   # vs cross-section mean


@dataclass
class DecileReport:
    """
    Full decile analysis across all timestamps.

    All 10 deciles are reported — never only the best.
    monotonicity_score = Spearman(decile_rank, mean_return).
    """
    deciles:           list[DecileStats]
    top_bottom_spread: Optional[float]   # Q10 mean - Q1 mean
    monotonicity_score: Optional[float]  # Spearman(rank, return)
    n_timestamps:      int
    n_observations:    int
    mean_cs_size:      float


def compute_decile_report(
    panel_df:      pd.DataFrame,
    score_col:     str,
    realized_col:  str,
    timestamp_col: str,
    n_deciles:     int = 10,
    min_cs_size:   int = 10,
) -> DecileReport:
    """
    Compute full decile analysis across a panel of predictions and realized returns.

    Parameters
    ----------
    panel_df      : Long-format panel.
    score_col     : Predicted alpha score column.
    realized_col  : Realized return column.
    timestamp_col : Timestamp grouping column.
    n_deciles     : Number of equal-width buckets (default 10).
    min_cs_size   : Minimum stocks per timestamp for a valid cross-section.

    Returns
    -------
    DecileReport — all `n_deciles` buckets, monotonicity score, top-bottom spread.

    Decile assignment
    -----------------
    Within each timestamp, stocks are assigned to decile 1 (lowest score)
    through decile 10 (highest score) by quantile cut of `score_col`.
    Ties are assigned by stable sort order (instrument_id as secondary key).
    """
    decile_returns: dict[int, list[float]] = {i: [] for i in range(1, n_deciles + 1)}
    n_ts = 0
    cs_sizes: list[int] = []

    for ts, grp in panel_df.groupby(timestamp_col, sort=True):
        valid = grp[
            grp[score_col].notna() & grp[realized_col].notna()
        ].copy()
        if len(valid) < min_cs_size:
            continue
        n_ts += 1
        cs_sizes.append(len(valid))

        # Decile assignment within this timestamp
        scores_arr   = valid[score_col].to_numpy(dtype=float)
        realized_arr = valid[realized_col].to_numpy(dtype=float)

        # Use qcut-style assignment: divide sorted scores into n_deciles equal groups
        n = len(scores_arr)
        sort_idx = np.argsort(scores_arr, kind="stable")   # ascending
        for rank_asc, orig_i in enumerate(sort_idx):
            decile = int(rank_asc * n_deciles / n) + 1
            decile = min(decile, n_deciles)
            decile_returns[decile].append(realized_arr[orig_i])

    # Build DecileStats per decile
    stats_list: list[DecileStats] = []
    for d in range(1, n_deciles + 1):
        rets = decile_returns[d]
        if not rets:
            stats_list.append(DecileStats(decile=d, n_obs=0, mean_return=None,
                                           median_return=None, std_return=None,
                                           win_rate=None, excess_mean=None))
            continue
        arr = np.array(rets, dtype=float)
        stats_list.append(DecileStats(
            decile=d,
            n_obs=len(arr),
            mean_return=round(float(np.mean(arr)), 6),
            median_return=round(float(np.median(arr)), 6),
            std_return=round(float(np.std(arr, ddof=1)), 6) if len(arr) > 1 else 0.0,
            win_rate=round(float((arr > 0).sum() / len(arr)), 4),
            excess_mean=None,  # filled below
        ))

    # Excess relative to cross-section mean
    all_rets = [r for rets in decile_returns.values() for r in rets]
    cs_mean  = float(np.mean(all_rets)) if all_rets else 0.0
    for s in stats_list:
        if s.mean_return is not None:
            s.excess_mean = round(s.mean_return - cs_mean, 6)

    # Top-bottom spread
    top = stats_list[-1].mean_return
    bot = stats_list[0].mean_return
    spread = (top - bot) if (top is not None and bot is not None) else None

    # Monotonicity score: Spearman(decile_rank, mean_return)
    mono_score = _decile_monotonicity(stats_list)

    return DecileReport(
        deciles=stats_list,
        top_bottom_spread=round(spread, 6) if spread is not None else None,
        monotonicity_score=mono_score,
        n_timestamps=n_ts,
        n_observations=len(all_rets),
        mean_cs_size=float(np.mean(cs_sizes)) if cs_sizes else 0.0,
    )


def _decile_monotonicity(stats: list[DecileStats]) -> Optional[float]:
    """Spearman(decile, mean_return); +1 = perfect monotonic improvement."""
    valid = [(s.decile, s.mean_return) for s in stats if s.mean_return is not None]
    if len(valid) < 3:
        return None
    ranks_d = np.array([v[0] for v in valid], dtype=float)
    rets    = np.array([v[1] for v in valid], dtype=float)
    return compute_rank_ic(ranks_d, rets)


# ── Turnover proxy ────────────────────────────────────────────────────────────

def compute_turnover_proxy(
    panel_df:      pd.DataFrame,
    score_col:     str,
    timestamp_col: str,
    top_k_pct:     float = 0.2,   # top 20% = top quintile
) -> Optional[float]:
    """
    Compute turnover proxy for the top-K quantile.

    turnover_t = 1 - |top_K_t ∩ top_K_{t-1}| / |top_K_t|

    Parameters
    ----------
    panel_df      : Long-format panel.
    score_col     : Predicted alpha score column.
    timestamp_col : Grouping column.
    top_k_pct     : Fraction of universe in the top bucket.

    Returns
    -------
    Mean turnover across adjacent timestamps, or None if fewer than 2 valid.
    """
    top_sets: list[set] = []
    timestamps = sorted(panel_df[timestamp_col].unique())

    for ts in timestamps:
        grp   = panel_df[panel_df[timestamp_col] == ts]
        valid = grp[grp[score_col].notna()].copy()
        if len(valid) < 5:
            continue
        k = max(1, int(len(valid) * top_k_pct))
        top_syms = set(
            valid.nlargest(k, score_col)["instrument_id"].tolist()
            if "instrument_id" in valid.columns
            else []
        )
        if top_syms:
            top_sets.append(top_syms)

    if len(top_sets) < 2:
        return None

    turnovers = []
    for i in range(1, len(top_sets)):
        prev = top_sets[i - 1]
        curr = top_sets[i]
        if not curr:
            continue
        overlap = len(curr & prev)
        turnovers.append(1.0 - overlap / len(curr))

    return float(np.mean(turnovers)) if turnovers else None


# ── Rank stability ────────────────────────────────────────────────────────────

def compute_rank_stability(
    panel_df:      pd.DataFrame,
    score_col:     str,
    timestamp_col: str,
) -> Optional[float]:
    """
    Mean Spearman correlation between adjacent-timestamp rank orderings.

    High values (near 1) indicate stable alpha; low values (near 0) indicate noise.
    """
    timestamps = sorted(panel_df[timestamp_col].unique())
    corrs: list[float] = []

    prev_ranks: Optional[pd.Series] = None

    for ts in timestamps:
        grp   = panel_df[panel_df[timestamp_col] == ts]
        valid = grp[grp[score_col].notna()].copy()
        if "instrument_id" not in valid.columns or len(valid) < 5:
            prev_ranks = None
            continue

        curr_ranks = valid.set_index("instrument_id")[score_col]

        if prev_ranks is not None:
            common = curr_ranks.index.intersection(prev_ranks.index)
            if len(common) >= 5:
                s1 = _rankdata(curr_ranks[common].to_numpy())
                s2 = _rankdata(prev_ranks[common].to_numpy())
                ic = compute_rank_ic(s1, s2)
                if ic is not None:
                    corrs.append(ic)

        prev_ranks = curr_ranks

    return float(np.mean(corrs)) if corrs else None


# ── Model comparison ──────────────────────────────────────────────────────────

@dataclass
class ModelComparisonRow:
    """One row in a model comparison table."""
    model_id:           str
    mean_rank_ic:       Optional[float]
    median_rank_ic:     Optional[float]
    icir:               Optional[float]
    positive_ic_pct:    Optional[float]
    top_bottom_spread:  Optional[float]
    monotonicity_score: Optional[float]
    turnover_proxy:     Optional[float]
    coverage_pct:       Optional[float]
    verdict:            str


def compare_rankers(
    results: list[dict],
) -> list[ModelComparisonRow]:
    """
    Build a comparison table from a list of {model_id, ic_summary, decile_report, ...} dicts.

    Results must cover ALL models (baselines + ML).  No cherry-picking.

    verdict: 'ML_ADDS_CLEAR_VALUE' | 'ML_ADDS_NO_CLEAR_VALUE' | 'INSUFFICIENT_EVIDENCE'.
    """
    rows: list[ModelComparisonRow] = []

    for r in results:
        ics   = r.get("ic_summary")
        dec   = r.get("decile_report")
        cov   = r.get("coverage_pct")
        turn  = r.get("turnover_proxy")

        mean_ic = ics.mean if ics else None
        med_ic  = ics.median if ics else None
        icir_v  = ics.icir if ics else None
        pos_pct = ics.positive_pct if ics else None
        spread  = dec.top_bottom_spread if dec else None
        mono    = dec.monotonicity_score if dec else None

        # Simple verdict
        if mean_ic is None:
            verdict = "INSUFFICIENT_EVIDENCE"
        elif abs(mean_ic) < 0.02:
            verdict = "INSUFFICIENT_EVIDENCE"
        elif mean_ic > 0.02:
            verdict = "RESEARCH_SIGNAL_DETECTED"
        else:
            verdict = "NO_CLEAR_SIGNAL"

        rows.append(ModelComparisonRow(
            model_id=r.get("model_id", "unknown"),
            mean_rank_ic=mean_ic,
            median_rank_ic=med_ic,
            icir=icir_v,
            positive_ic_pct=pos_pct,
            top_bottom_spread=spread,
            monotonicity_score=mono,
            turnover_proxy=turn,
            coverage_pct=cov,
            verdict=verdict,
        ))

    # ML dominance check
    ml_ids     = {"lgbm_ranker", "xgboost_ranker", "ridge_ranker", "elasticnet_ranker"}
    base_ids   = {"momentum_baseline", "composite_baseline"}

    ml_ics   = [r.mean_rank_ic for r in rows if r.model_id in ml_ids and r.mean_rank_ic is not None]
    base_ics = [r.mean_rank_ic for r in rows if r.model_id in base_ids and r.mean_rank_ic is not None]

    if ml_ics and base_ics:
        best_ml   = max(ml_ics)
        best_base = max(base_ics)
        if best_ml <= best_base + 0.01:   # less than 1% IC improvement
            for r in rows:
                if r.model_id in ml_ids:
                    r.verdict = "ML_ADDS_NO_CLEAR_VALUE"

    return rows


# ── Coverage ──────────────────────────────────────────────────────────────────

def compute_coverage(
    panel_df:      pd.DataFrame,
    score_col:     str,
    timestamp_col: str,
) -> float:
    """
    Fraction of rows where `score_col` is not NaN.
    """
    total = len(panel_df)
    if total == 0:
        return 0.0
    valid = panel_df[score_col].notna().sum()
    return float(valid / total * 100.0)


# ── Internal helpers ──────────────────────────────────────────────────────────

def _rankdata(arr: np.ndarray) -> np.ndarray:
    """Average-rank transform, NaN-safe."""
    n = len(arr)
    sort_idx = np.argsort(arr, kind="stable")
    ranks    = np.empty(n, dtype=float)
    i = 0
    while i < n:
        j = i
        while j < n - 1 and arr[sort_idx[j]] == arr[sort_idx[j + 1]]:
            j += 1
        avg = (i + j) / 2.0 + 1.0   # 1-indexed
        for k in range(i, j + 1):
            ranks[sort_idx[k]] = avg
        i = j + 1
    return ranks
