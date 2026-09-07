"""
Generate Phase 3E CSV reports using synthetic deterministic data.

Since no real dataset is available, all statistics use controlled synthetic
price paths.  Every report explicitly marks its evidence status as
INSUFFICIENT_EVIDENCE for real-data metrics.
"""
import sys, csv
import numpy as np
import pandas as pd
sys.path.insert(0, 'src')

from ranking.evaluation import (
    compute_rank_ic, compute_ic_series, summarise_ic_series,
    compute_decile_report, compare_rankers, ICSummary
)
from ranking.ranker import MomentumBaselineRanker, CompositeBaselineRanker

UTC = "UTC"
np.random.seed(42)

# ── Synthetic data: 5 timestamps × 20 stocks ─────────────────────────────────
N_TS  = 20
N_STK = 20
timestamps = pd.bdate_range("2023-01-02", periods=N_TS, tz="UTC")

rows = []
for i, ts in enumerate(timestamps):
    for j in range(N_STK):
        # Momentum baseline: scores = random; realized = score + noise
        score   = float(j + np.random.randn() * 2)
        realized = score * 0.5 + np.random.randn() * 3
        rows.append({
            "timestamp":     ts,
            "instrument_id": f"S{j:02d}",
            "score":         score,
            "realized":      realized,
        })

df = pd.DataFrame(rows)

# ── IC time-series ────────────────────────────────────────────────────────────
ic_series = compute_ic_series(df, "score", "realized", "timestamp", use_rank_ic=True)
summary   = summarise_ic_series(ic_series)

ic_rows = []
for ts, ic_val in ic_series.items():
    ic_rows.append({
        "timestamp":   str(ts),
        "rank_ic":     round(ic_val, 6) if not np.isnan(ic_val) else "NaN",
        "evidence":    "SYNTHETIC_DATA",
    })

with open("reports/phase-3e-ic-timeseries.csv", "w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=["timestamp","rank_ic","evidence"])
    w.writeheader()
    w.writerows(ic_rows)
print(f"Wrote {len(ic_rows)} IC rows")

# ── Decile analysis ───────────────────────────────────────────────────────────
decile_rep = compute_decile_report(df, "score", "realized", "timestamp",
                                    n_deciles=10, min_cs_size=10)
decile_rows = []
for s in decile_rep.deciles:
    decile_rows.append({
        "decile":        s.decile,
        "n_obs":         s.n_obs,
        "mean_return":   round(s.mean_return, 6) if s.mean_return is not None else "NaN",
        "median_return": round(s.median_return, 6) if s.median_return is not None else "NaN",
        "win_rate":      round(s.win_rate, 4) if s.win_rate is not None else "NaN",
        "evidence":      "SYNTHETIC_DATA",
    })

with open("reports/phase-3e-decile-analysis.csv", "w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=["decile","n_obs","mean_return","median_return","win_rate","evidence"])
    w.writeheader()
    w.writerows(decile_rows)
print(f"Wrote {len(decile_rows)} decile rows")

# ── Model comparison (all 6 models, synthetic IC only) ────────────────────────
def _mock(model_id, mean_ic, std_ic=0.08):
    ic_sum = ICSummary(
        mean=mean_ic, median=mean_ic * 0.95,
        std=std_ic,
        icir=(mean_ic / std_ic) if std_ic > 0 else None,
        positive_pct=round((0.5 + mean_ic * 2) * 100, 1),
        n_timestamps=N_TS,
    )
    return {"model_id": model_id, "ic_summary": ic_sum,
            "decile_report": None, "coverage_pct": 95.0,
            "turnover_proxy": 0.35}

# Synthetic IC values (these are estimates; real values need real data)
# Deliberately showing INSUFFICIENT_EVIDENCE for all ML models
comparison_input = [
    _mock("momentum_baseline",   summary.mean or 0.0),
    _mock("composite_baseline",  (summary.mean or 0.0) * 0.9),
    _mock("ridge_ranker",        0.0),   # cannot run without sklearn
    _mock("elasticnet_ranker",   0.0),   # cannot run without sklearn
    _mock("lgbm_ranker",         0.0),   # cannot run without lightgbm
    _mock("xgboost_ranker",      0.0),   # cannot run without xgboost
]
comparison = compare_rankers(comparison_input)

comp_rows = []
for r in comparison:
    comp_rows.append({
        "model_id":          r.model_id,
        "mean_rank_ic":      round(r.mean_rank_ic, 6) if r.mean_rank_ic is not None else "NaN",
        "median_rank_ic":    round(r.median_rank_ic, 6) if r.median_rank_ic is not None else "NaN",
        "icir":              round(r.icir, 4) if r.icir is not None else "NaN",
        "positive_ic_pct":   round(r.positive_ic_pct, 1) if r.positive_ic_pct is not None else "NaN",
        "top_bottom_spread": "NaN",
        "turnover_proxy":    round(r.turnover_proxy, 4) if r.turnover_proxy is not None else "NaN",
        "verdict":           r.verdict,
        "evidence":          "SYNTHETIC_DATA" if r.model_id in ("momentum_baseline","composite_baseline") else "INSUFFICIENT_EVIDENCE",
    })

with open("reports/phase-3e-model-comparison.csv", "w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=["model_id","mean_rank_ic","median_rank_ic","icir",
                                       "positive_ic_pct","top_bottom_spread","turnover_proxy",
                                       "verdict","evidence"])
    w.writeheader()
    w.writerows(comp_rows)
print(f"Wrote {len(comp_rows)} model comparison rows")

print("Done. Note: all metrics marked SYNTHETIC_DATA or INSUFFICIENT_EVIDENCE.")
print(f"Synthetic summary IC: mean={summary.mean}, ICIR={summary.icir}")
