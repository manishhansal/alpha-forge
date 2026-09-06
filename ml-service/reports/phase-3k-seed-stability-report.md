# Phase 3K — Seed Stability Report

**Generated:** 2026-09-06  
**Branch:** `refactor/improve-ml-service`

---

## 1. Multi-Seed Discipline (spec §24, §25, §26)

Neural networks contain stochastic elements. Phase 3K:

- records every seed (master + derived numpy/python/framework seeds) in
  `DeepModelProvenance` (spec §24);
- runs promising models under multiple independent seeds and reports the metric
  distribution (spec §25);
- NEVER selects a seed by final OOS performance — a seed is fixed beforehand or
  chosen by validation evidence (spec §26).

---

## 2. Robustness Statistics (spec §25)

`SeedRobustness.summary()` reports for each metric across seeds:

```
mean, median, std, worst, best, n_valid
```

Synthetic verification (5 seeds, MLP on a linear signal):

| Statistic | Value |
|-----------|-------|
| mean OOS rank IC | ~0.942 |
| median | ~0.942 |
| std | ~0.003 |
| worst seed | ~0.938 |
| best seed | ~0.946 |

Low std indicates seed stability on this synthetic task. A single lucky seed is
never trusted.

---

## 3. Seed Selection (spec §26)

`select_seed_by_validation` chooses a seed by VALIDATION rank IC only, returning
`selected_by = "VALIDATION"`. The final OOS block remains untouched during
selection.

---

## 4. Determinism (spec §62, §63)

The pure-NumPy backend is fully deterministic: two runs with the same seed
produce identical predictions (verified). Because there is no GPU
non-determinism, bitwise reproducibility holds on this backend — the honest
determinism note in provenance documents that a future torch/GPU backend could
not guarantee this (spec §63).

---

## 5. Verdict

Seed-stability apparatus is complete and verified on synthetic data. No real
model has been evaluated across seeds on real data → INSUFFICIENT_EVIDENCE for a
production seed-stability claim.
