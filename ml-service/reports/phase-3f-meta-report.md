# Phase 3F — Meta-Labeling & Ranker Report

**Phase:** 3F
**Date:** 2026-09-06
**OOS evidence status:** INSUFFICIENT_EVIDENCE

---

## Meta-Label Framework

### The three policies

| Policy | Label=1 when | Version |
|--------|-------------|---------|
| A — Positive net outcome | `net_return > threshold` (default 0.0%) | `meta_policy_a-v1` |
| B — Triple-barrier success | `first_touch == TAKE_PROFIT` | `meta_policy_b-v1` |
| C — Risk-adjusted success | `net_return > min_required AND mae > max_mae` | `meta_policy_c-v1` |

Each policy is configurable and versioned. Changing any parameter requires a new `policy_version`.

### Stacking leakage enforcement

`build_meta_labels(require_oos=True)` raises `RuntimeError` before labeling if any event has `is_oos_primary_prediction=False`. This is programmatic enforcement of the OOS discipline rule — documentation alone is insufficient.

### Outcome feature guard

`validate_no_outcome_features(feature_names)` raises `ValueError` if any feature name contains: `gross_return`, `net_return`, `mfe`, `mae`, `first_touch`, `_outcome_`, `forward_return`, or `exit_price`. Call this before assembling the meta-model feature matrix.

---

## Meta Ranker Models

| Model | Provenance | Score semantics | Status |
|-------|-----------|----------------|--------|
| `alpha_threshold_baseline` | `BASELINE_THRESHOLD` | Monotone transform of alpha_score ÷ 100 | Implemented |
| `linear_meta_ranker` | `BASELINE_LINEAR` | Logistic regression raw P(success) | Implemented (requires sklearn) |
| `lgbm_meta_ranker` | `TRAINED_MODEL` | LightGBM binary classifier raw P(success) | Implemented (requires lightgbm) |
| `xgboost_meta_ranker` | `TRAINED_MODEL` | XGBoost binary classifier raw P(success) | Implemented (requires xgboost) |

All models output `RawProbabilityScore` — NOT calibrated probabilities. Output must pass through `CalibratorArtifact` before use in decisions.

### ML dominance rule

`compare_meta_models()` marks LightGBM/XGBoost as `ML_ADDS_NO_CLEAR_VALUE` if their AUC is ≤ baseline + 0.01. This is tested and enforced.

---

## OOS Meta-Model Evidence

**Status: INSUFFICIENT_EVIDENCE** — requires real NSE/BSE data.

| Metric | All models |
|--------|------------|
| ROC-AUC | INSUFFICIENT_EVIDENCE |
| PR-AUC | INSUFFICIENT_EVIDENCE |
| Brier | INSUFFICIENT_EVIDENCE |
| Positive rate | INSUFFICIENT_EVIDENCE |
| Coverage at P>0.6 | INSUFFICIENT_EVIDENCE |

---

## Research Conclusion

**INSUFFICIENT_EVIDENCE**

The meta-labeling and ranker infrastructure is architecturally complete. All leakage guards, stacking leakage enforcement, and semantic type contracts are verified by 71 tests. OOS performance evidence requires real data and will be evaluated in Phase 3G.
