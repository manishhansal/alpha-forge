# Deep-Learning Methodology (Phase 3K)

How AlphaForge decides whether an advanced model earns a place beside the
classical stack.

---

## 1. Principle

The classical stack is the baseline. A deep model must EMPIRICALLY prove
credible, stable, incremental out-of-sample value. Absent that proof the honest
answer is `NO_INCREMENTAL_ALPHA` — a successful research conclusion, not a
failure.

---

## 2. Research Hierarchy (spec §75)

Evidence is ranked, and higher tiers dominate lower ones:

1. data integrity
2. OOS validity
3. predictive quality (IC / ICIR)
4. calibration
5. expected value
6. execution-adjusted economics
7. portfolio performance
8. stability
9. regime robustness
10. capacity
11. complexity

A model cannot compensate for invalid data with superior performance. A
contaminated final OOS collapses the classification to INSUFFICIENT_EVIDENCE
regardless of headline numbers.

---

## 3. Fair Comparison

Every deep model is scored against classical baselines on the SAME walk-forward
folds, features, labels, universe, PIT scaler, and IC metric. A fresh model per
fold prevents state leakage. Comparisons never use random train/test splits.

---

## 4. Leakage Discipline

- **Sequences** end at the prediction time and are left-padded only — never with
  future observations.
- **Normalization** is fit on the training window and applied to validation/OOS;
  no full-dataset `fit_transform`.
- **HPO, seed, checkpoint, ensemble weight** selection uses validation only. The
  final OOS block is untouched until the model is fully fixed.
- **Runtime probes** (label permutation, negative control, future perturbation,
  contamination check) must all pass before evidence is trusted.

---

## 5. Seed Management (spec §24–§26)

Every seed is recorded. Promising models are run under multiple seeds and the
mean/median/std/worst/best are reported. A seed is fixed beforehand or chosen by
validation — never by final OOS.

---

## 6. Incremental Value, Not Replacement

The question is whether the deep model adds information the champion lacks:
incremental IC, prediction/error correlation, residual modeling, and ensemble
diversification. A model that is not standalone-superior but improves the
ensemble is COMPLEMENTARY and useful — it does not need to become champion.

---

## 7. Model-Value Classification

Each model is classified — with documented multi-criteria reasons, not a single
number — as SUPERIOR, COMPLEMENTARY, REDUNDANT, UNSTABLE, WORSE, or
INSUFFICIENT_EVIDENCE.

---

## 8. Governance

A deep model reaches production only through Phase 3J: registered as a
challenger, driven through SHADOW → PAPER, and evaluated by the six-gate
promotion gate. It is never auto-promoted and never auto-replaces the champion.

---

## 9. Complexity Trade-off

The final recommendation weighs incremental alpha against incremental complexity
(dependencies, hardware, latency, memory, operational risk) using structured
evidence, not a subjective score. A tiny improvement that needs GPU
infrastructure and doubles latency may not justify replacement.

---

## 10. Current Conclusion

No real Indian equity/F&O dataset is loaded, so the honest verdict is
**NO_INCREMENTAL_ALPHA / INSUFFICIENT_EVIDENCE**. The methodology and all
apparatus are in place; they simply refuse to manufacture an alpha claim without
governed real data.
