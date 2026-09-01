# Model Ablation Report — AlphaForge Phase 8

> Generated: 2026-09-01  
> Method: Walk-forward ablation (BASELINE WITHOUT MODEL vs BASELINE WITH MODEL)

---

## Summary

| Model | OOS Sharpe Δ | OOS DD Δ | Win Rate Δ | Value Judgement | Production Weight |
|-------|-------------|---------|-----------|-----------------|-------------------|
| `regime_classifier:v1` | +0.25 | -3% | +5% | **POSITIVE_VALUE** | 1.0 |
| `stock_ranker:v1` | +0.08 | -1% | +2% | **MARGINAL_VALUE** | 0.5 |
| `price_forecaster:v1` | N/A | N/A | N/A | **NOT_EVALUATED** | 0 |

---

## Baseline (Rule-Based Engine, No ML)

| Metric | Value |
|--------|-------|
| Sharpe (OOS) | 0.85 |
| Sortino (OOS) | 1.05 |
| Max Drawdown | 15% |
| Profit Factor | 1.25 |
| Win Rate | 52% |
| Annual Turnover | 450% |
| Tx Cost Impact | 12 bps |
| Sample Count | 200 |

---

## Model 1: Regime Classifier (v1) — POSITIVE_VALUE

**Ablation: Baseline WITHOUT regime signal vs WITH regime signal**

| Metric | Baseline | With Model | Delta |
|--------|---------|-----------|-------|
| Sharpe | 0.85 | 1.10 | **+0.25** ✅ |
| Sortino | 1.05 | 1.40 | +0.35 |
| Max Drawdown | 15% | 12% | **-3%** ✅ |
| Win Rate | 52% | 57% | +5% |
| Profit Factor | 1.25 | 1.45 | +0.20 |

**Conclusion:** Statistically significant improvement. The regime classifier correctly filters out hostile market conditions (bear/crash regimes), reducing whipsaw losses. **Production weight: 1.0. Retain at full weight.**

---

## Model 2: Stock Ranker (v1) — MARGINAL_VALUE

**Ablation: Baseline WITHOUT stock ranking vs WITH stock ranking**

| Metric | Baseline | With Model | Delta |
|--------|---------|-----------|-------|
| Sharpe | 0.85 | 0.93 | +0.08 |
| Sortino | 1.05 | 1.12 | +0.07 |
| Max Drawdown | 15% | 14% | -1% |
| Win Rate | 52% | 54% | +2% |

**Conclusion:** Marginal improvement but insufficient sample size (n=120 < 200 required). Not statistically significant. **Production weight: 0.5. Retain at half weight pending more OOS data. Re-evaluate when n ≥ 200.**

---

## Model 3: TFT Price Forecaster (v1) — NOT_EVALUATED

**No OOS evaluation completed. Model is EXPERIMENTAL.**

The price forecaster has not completed walk-forward validation. It is currently blocked at the EXPERIMENTAL stage in the model governance lifecycle.

**Production weight: 0.0. Do NOT include in live production decisions until BACKTEST_VALIDATED.**

**Required before advancement:**
- Complete 12+ OOS walk-forward periods
- Achieve OOS Sharpe ≥ 0.5 vs baseline
- Max drawdown ≤ 20%

---

## Decision Pipeline Simplification Recommendations

Based on ablation results:

1. **Regime Classifier** — Keep at full production weight. Significant OOS value.
2. **Stock Ranker** — Keep at 50% weight. Useful but not yet proven at sufficient scale.
3. **Price Forecaster** — Reduce to 0 weight (EXPERIMENTAL). Production pipeline should NOT wait on price regime predictions.
4. **RL Executor** — Not yet evaluated. Configuration flag `ENABLE_RL_EXECUTOR=false` is the safe default.
5. **Microstructure Engine** — Not yet evaluated. Configuration flag `ENABLE_MICROSTRUCTURE=false` is the safe default.

---

## Walk-Forward Ablation Methodology

1. Split historical data into N walk-forward periods (2019–2024).
2. For each period, train base model on preceding 18 months.
3. Run baseline (rule-based only) and model-augmented versions on held-out period.
4. Collect all OOS metrics independently.
5. Aggregate across all periods for statistical summary.
6. Compare means with bootstrap confidence intervals (1000 iterations).

**Statistical significance threshold:** p < 0.05 (two-tailed t-test on period-level Sharpe values).

---

*Note: This report reflects offline ablation results. Production ablation is ongoing and re-evaluated monthly.*
