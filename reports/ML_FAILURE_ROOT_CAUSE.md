# ML FAILURE ROOT-CAUSE (Phase 11/12)

**Date:** 2026-09-09. Based on the fresh retrain run (`INDIA_ML_TRAINING_REPORT.md`)
on real daily-derived tensors with walk-forward + purged CV + acceptance gates. No
gate was bypassed; no model was forced into production.

## Per-model diagnosis

| Model | Target | Samples | OOS metric | Baseline | Gate | Root cause | Verdict |
|---|---|---|---|---|---|---|---|
| Regime Classifier | multiclass regime | 826 × 28 | acc **0.474** | majority-class ≈ 0.45–0.50 | acc ≥ 0.52 | Barely above majority baseline; severe overfit (train 0.99 vs val 0.29–1.0); one fold = 100% of return (path-dependent) | **DISABLE** (no edge over baseline) |
| Stock Ranker | fwd risk-adj return rank | 25 104 × 64 | Spearman IC **0.0041** (p 0.54) | IC 0 | IC > 0.02 | IC statistically indistinguishable from zero; in-fold IC 0.70 but ~0 OOS → memorisation, not signal | **DISABLE** (no OOS ranking edge) |
| Strategy Selector | best-strategy class | 39 682 × 17 | — | — | acc > baseline+0.03 | **Dependency-blocked**: catboost import fails on numpy 2.2.6 ABI mismatch | **BLOCKED** (env), cannot evaluate |
| Risk Predictor | stop/target/drawdown | 38 962 × 18 | crashed | AUC 0.5 | AUC > 0.55 | A chronological 63-bar validation fold landed single-class (rows grouped by symbol) → `roc_auc` undefined; global balance is fine (58.5% / 57.1%) | **BLOCKED** (fold construction) |
| Price Forecaster | price/regime | — | — | — | — | Deep-learning deps (darts/TFT) not installed; no tensor | **NOT RUN** |
| IV Classifier | IV regime | — | — | — | — | Sequence deps (PatchTST/tsai) not installed; option-chain history sparse | **NOT RUN** |
| Meta Decision | ensemble P(profit) | — | — | base rate | — | Needs persisted OOS outcomes; store was in-memory (now durable, but no data yet) | **NOT TRAINABLE** yet |

## Does each model contain predictive information?

- **Regime / Ranker:** on the evidence available, **no demonstrable OOS edge over the
  relevant baseline**. Correct action per the prompt: **DISABLE**, not deploy.
- **Strategy / Risk:** **cannot be evaluated** until the environment (catboost/numpy)
  and the single-class-fold guard are fixed. Until then: not eligible.
- **Forecaster / IV / Meta:** **not evaluable** without their deps / a persisted OOS
  outcome store.

## Baseline comparison (Phase 12)

Every model must beat its baseline to deploy. **None does** (regime ≈ majority class;
ranker IC ≈ 0). Therefore **0/7 are live-eligible**, and under the model-state gate
(`model-state-gate.ts`) none can drive a live A+ — the correct behaviour is ABSTAIN.

## Conclusion

The 0/7 result is **not a gate misconfiguration** — it is the honest signal that these
models have no proven edge on the data available. Forcing them into production would
violate the absolute rules. They remain **DISABLED / SHADOW**. Re-evaluation requires:
(1) fix catboost/numpy + risk fold guard, (2) install or scope-out forecaster/IV deps,
(3) accumulate a persisted OOS outcome sample (now unblocked by the durable store), then
re-run walk-forward and re-check baselines.
