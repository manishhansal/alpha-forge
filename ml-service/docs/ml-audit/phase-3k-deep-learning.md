# Phase 3K — Deep Learning (Audit Reference)

Audit-grade reference for the advanced-ML / deep-learning research layer
(`ml-service/src/deep/`). Describes the system as built.

---

## 1. Purpose & Non-Goals

**Purpose:** determine whether advanced models provide credible, stable,
INCREMENTAL out-of-sample information beyond the classical AlphaForge stack.

**Non-goals:** replacing classical models with neural nets; deep learning is not
assumed superior. Phase 3K does NOT auto-promote a deep model, does NOT
auto-replace the champion, does NOT retrain production models, and contains NO
reinforcement learning and NO live execution.

---

## 2. Framework Decision

Implemented framework-agnostic on a **pure-NumPy** neural backend for
determinism and dependency-light reproducibility. In the current environment
(Python 3.14) torch is not importable in the interpreter and TensorFlow has no
wheel; the NumPy backend runs everywhere and is bitwise reproducible. See
`reports/phase-3k-current-deep-learning-audit.md` §3.1.

---

## 3. Package Layout

```
src/deep/
├── schemas.py            experiment/provenance/complexity/value enums & dataclasses
├── experiment_registry.py DL experiment registry + Phase 3J challenger wiring
├── sequence_builder.py   PIT-safe sequence construction
├── normalization.py      PIT-safe scalers + cross-sectional transforms
├── nn_backend.py         deterministic NumPy neural primitives
├── models.py             MLP ranker
├── temporal_models.py    causal CNN, LSTM/GRU, transformer-lite
├── classical_baselines.py linear/ridge/elastic-net
├── comparison.py         fair walk-forward comparison
├── training.py           HPO/seed/checkpoint discipline, multi-seed
├── incremental_alpha.py  incremental IC, residual, ensemble, disagreement
├── integration.py        3F calibration, complexity, latency, 3I decay
├── leakage_tests.py      causality/permutation/negative-control/contamination
└── classification.py     model-value classification
```

---

## 4. Reuse (no duplication)

Phase 3A walk-forward, 3B PIT dataset, 3C labels, 3D features, 3E IC/ranking &
`BaseRanker`, 3F calibration/EV/abstention, 3G execution, 3H portfolio, 3I decay,
3J lifecycle/registry/challenger. Every deep model is a `BaseRanker` and a Phase
3J challenger.

---

## 5. Leakage Controls

- Sequences: window ends at prediction time; left-pad only; future perturbation
  cannot change the prediction.
- Normalization: scaler fit on train window only; no `fit_transform` on the full
  dataset.
- HPO/seed/checkpoint: validation only; final OOS untouched during search.
- Runtime probes: causality, future-scaler, future-label, label-permutation,
  negative-control, permutation-importance, final-OOS-contamination.

---

## 6. Governance

Deep models enter Phase 3J as challengers. Contaminated evidence
(`FINAL_OOS_CONTAMINATED`) blocks challenger registration. No auto-promotion.

---

## 7. Current State

No real dataset loaded → verdict **NO_INCREMENTAL_ALPHA / INSUFFICIENT_EVIDENCE**.
Framework verified on deterministic synthetic data.

---

## 8. Verification

Phase 3K: 55 tests passed. Full suite (3A–3K): 820 passed / 0 failed. Static
audit CLEAN (no executable `np.random.*`, no `latest.pkl`, no `fit_transform`, no
random splits, no OOS-based selection).
