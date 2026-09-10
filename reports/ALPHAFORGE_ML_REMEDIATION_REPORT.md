# ALPHAFORGE ML REMEDIATION REPORT

**Date:** 2026-09-09. See `ML_FAILURE_ROOT_CAUSE.md` for per-model detail.

## Outcome: 0/7 models beat baseline → all DISABLED / non-live-eligible

| Model | Verdict | Reason |
|---|---|---|
| Regime Classifier | DISABLE | OOS acc 0.474 ≈ majority baseline; overfit; path-dependent |
| Stock Ranker | DISABLE | OOS IC 0.0041 (p 0.54) — indistinguishable from zero |
| Strategy Selector | BLOCKED | catboost/numpy 2.2.6 ABI mismatch |
| Risk Predictor | BLOCKED | single-class validation fold → `roc_auc` undefined |
| Price Forecaster | NOT RUN | deep-learning deps absent |
| IV Classifier | NOT RUN | sequence deps absent; OC history sparse |
| Meta Decision | NOT TRAINABLE | needs persisted OOS outcomes (now durable, no data yet) |

## Enforcement

The **model-state gate** (`model-state-gate.ts`) is now the runtime enforcement point:
an UNTRAINED / uniform-prior artifact classifies as UNTRAINED and is **not
live-eligible** — the canonical decision authority converts it to WAIT, never TRADE.
`shadow-intelligence.deriveMetaModelState` zeroes model contribution and widens
uncertainty when the model is not live-eligible, so **no untrained model can lend live
conviction and no probability is fabricated**.

## Champion / challenger

`evaluateChampionChallenger` (statistical: expectancy z≥1.96, Brier + drawdown guards,
≥100 OOS) is implemented but has **no eligible challenger** (0/7 pass) and no champion
baseline metrics, so no promotion occurs. Correct outcome: keep DISABLED.

## Verdict

Models evaluated: 7 · passing: **0** · disabled/blocked: 7 · champion: none ·
challenger: none · calibration: unproven. The ML layer is **safe** (fails closed to
abstention) but has **no demonstrated edge**. Re-evaluation requires the env fixes + a
persisted OOS sample, then a fresh walk-forward. Not deployed — correctly.
