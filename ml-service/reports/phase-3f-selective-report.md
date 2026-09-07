# Phase 3F — Selective Prediction & Abstention Report

**Phase:** 3F
**Date:** 2026-09-06
**OOS evidence status:** INSUFFICIENT_EVIDENCE

---

## Decision State Machine

```
NO_CANDIDATE → CANDIDATE → META_EVALUATED → CALIBRATED → EV_EVALUATED → TAKE/SKIP/ABSTAIN
```

Never jump directly from rank → TAKE. Every state transition requires explicit evidence.

### Five canonical decision states

| State | Meaning |
|-------|---------|
| `TAKE` | Calibrated probability above threshold AND positive EV AND valid calibration |
| `SKIP` | Probability below threshold OR negative EV |
| `ABSTAIN` | Calibration unavailable/stale/mismatched; high uncertainty; insufficient data |
| `INSUFFICIENT_EVIDENCE` | No trained meta model or OOS validation |
| `UNAVAILABLE` | Meta engine not operational |

### Every decision carries reasons

```python
{
  "decision": "TAKE",
  "decision_reasons": [
    "CALIBRATED_PROBABILITY_ABOVE_THRESHOLD",
    "POSITIVE_NET_EV"
  ]
}
```

or:

```python
{
  "decision": "ABSTAIN",
  "decision_reasons": [
    "CALIBRATION_STALE",
    "HIGH_UNCERTAINTY"
  ]
}
```

---

## Expected Value Engine

EV formula (asymmetric payoffs):

```
EV = P(success) × E[win] + (1 - P(success)) × E[loss] - E[cost]
```

Rules:
- `E[win] ≠ |E[loss]|` by design — never assumes symmetric payoffs
- Cost model: `DATA_UNAVAILABLE` by default (NSE STT, brokerage, slippage not loaded)
- When cost unavailable: EV computed without cost, status = `COST_DATA_UNAVAILABLE`
- EV threshold is configurable (`EVConfig.min_ev_for_take`), never hardcoded as `> 0`

### EV leakage protection

`PayoffDistribution.fit_end_time` must be `< prediction_time`. `assert_no_future_leakage()` raises `RuntimeError` if violated. Tested by `TestEVLeakage::test_ev_calculator_detects_leakage`.

---

## Abstention Reasons (11 explicit codes)

- `CALIBRATION_INSUFFICIENT_DATA` — too few samples to fit a reliable calibrator
- `CALIBRATION_STALE` — calibrator older than `max_age_days`
- `CALIBRATION_MISMATCH` — model_id/version incompatible with calibrator
- `CALIBRATION_UNAVAILABLE` — no calibrator fitted at all
- `HIGH_MODEL_DISAGREEMENT` — ensemble models disagree substantially
- `HIGH_UNCERTAINTY` — mean calibrated confidence below threshold
- `LOW_CROSS_SECTION_SIZE` — universe too small for reliable CS ranking
- `FEATURE_MISSINGNESS` — required features absent
- `DISTRIBUTION_SHIFT` — detected covariate shift
- `STALE_MODEL` — primary model or meta model too old
- `STALE_DATA` — source data too old

---

## OOS Selective Prediction Evidence

**Status: INSUFFICIENT_EVIDENCE** — requires real data.

| Metric | Value |
|--------|-------|
| Coverage | INSUFFICIENT_EVIDENCE |
| Abstention rate | INSUFFICIENT_EVIDENCE |
| Success rate (all) | INSUFFICIENT_EVIDENCE |
| Success rate (non-abstained) | INSUFFICIENT_EVIDENCE |
| EV (all) | INSUFFICIENT_EVIDENCE |
| EV (non-abstained) | INSUFFICIENT_EVIDENCE |
| Risk/coverage curve | INSUFFICIENT_EVIDENCE |

---

## Probability Bucket Infrastructure

`compute_probability_bucket_analysis()` is implemented and produces all 10 buckets:

```
[0.0–0.1], [0.1–0.2], ..., [0.9–1.0]
```

Each bucket reports: `n_observations`, `actual_success_rate`, `mean_net_return`, `median_net_return`, `mean_mfe`, `mean_mae`.

All buckets are reported — no cherry-picking.

---

## Threshold Analysis Infrastructure

```python
thresholds_to_evaluate = [0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80]
```

Selection rule: threshold must be selected inside training/validation. Final OOS remains untouched. OOS data must NEVER influence threshold selection.
