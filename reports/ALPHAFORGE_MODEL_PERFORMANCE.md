# ALPHAFORGE MODEL PERFORMANCE

**Date:** 2026-09-09. Cross-refs `INDIA_ML_TRAINING_REPORT.md` (fresh retrain).

## Retrain result (real daily tensors, walk-forward + purged CV + acceptance gate)

| Model | OOS result | Gate | State (model-state gate) |
|---|---|---|---|
| Market Regime Classifier | acc 0.474 (<0.52), Sharpe −0.83, PF 0.90 | ❌ | UNTRAINED/SHADOW — not live-eligible |
| Stock Ranker | Spearman IC 0.0041 (p 0.54, <0.02) | ❌ | SHADOW — no OOS edge |
| Strategy Selector | — | ⛔ BLOCKED (catboost/numpy ABI) | UNTRAINED |
| Risk Predictor | crashed (single-class validation fold) | ⛔ | UNTRAINED |
| Price Regime Forecaster | deps not installed; no tensor | — | UNTRAINED (NOT RUN) |
| IV Regime Classifier | deps not installed; no tensor | — | UNTRAINED (NOT RUN) |
| Meta Decision Model | needs persisted OOS outcomes (in-memory only) | — | UNTRAINED (runtime default) |

**0 / 7 models are VALIDATED.** Under the new model-state gate
(`model-state-gate.ts`), none is live-eligible, so none may drive a live A+ — the
correct behaviour is ABSTAIN.

## Champion / challenger

`evaluateChampionChallenger` is a real statistical gate (expectancy z≥1.96, Brier
guard, DD guard, ≥100 OOS). It cannot promote anything: no challenger passed its own
acceptance gate, and the deployed champion artifacts carry no recorded OOS metrics
(no `model_registry.json`). Champion/challenger is **implemented, not operational**.

## SHAP / permutation importance / feature stability / redundancy

The Python stack supports these (`shap 0.46`, permutation importance, PIT +
structural-leakage checks). A published SHAP summary is deferred: SHAP on a **rejected**
(no-edge) model would explain noise. SHAP should be generated only for a model that
first clears its acceptance gate.

## Verdict

Model predictive edge on real OOS data: **NONE demonstrated (0/7)**. Correct posture:
all models **DISABLED / non-live-eligible**. This is not a failure to fake — it is the
honest result, and DISABLED is preferable to a fake model.
