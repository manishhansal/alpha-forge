# Phase 3K — Deep-Learning Report

**Generated:** 2026-09-06  
**Branch:** `refactor/improve-ml-service`  
**Verdict:** NO_INCREMENTAL_ALPHA — INSUFFICIENT_EVIDENCE (no real dataset loaded)

---

## 1. Research Question

Do advanced models (MLP, temporal CNN, LSTM/GRU, transformer-lite) provide
statistically credible, economically meaningful, stable, **incremental** OOS
information beyond the existing classical AlphaForge stack? The classical stack
remains the baseline; a deep model must PROVE incremental value.

---

## 2. What Was Built

Framework-agnostic, deterministic, pure-NumPy deep-learning research package
`src/deep/` (see `phase-3k-current-deep-learning-audit.md` §3.1 for the framework
decision). Every deep model implements the Phase 3E `BaseRanker` interface and
enters Phase 3J as a CHALLENGER — never auto-promoted.

| Module | Purpose |
|--------|---------|
| `schemas.py` | experiment / provenance / complexity / value enums & dataclasses |
| `experiment_registry.py` | persistent DL experiment registry + Phase 3J challenger wiring |
| `sequence_builder.py` | PIT-safe versioned sequence construction (no future padding) |
| `normalization.py` | PIT-safe scalers (train-fit only) + cross-sectional transforms |
| `nn_backend.py` | deterministic NumPy neural primitives (Dense, Dropout, Adam, seeds) |
| `models.py` | compact MLP ranker |
| `temporal_models.py` | causal CNN, LSTM/GRU, transformer-lite (causal mask) |
| `classical_baselines.py` | linear / ridge / elastic-net baselines |
| `comparison.py` | fair walk-forward comparison harness |
| `training.py` | HPO / seed / checkpoint discipline + multi-seed robustness |
| `incremental_alpha.py` | incremental IC, residual model, ensemble, disagreement |
| `integration.py` | 3F calibration, complexity, latency, 3I decay adapters |
| `leakage_tests.py` | causality / permutation / negative-control / contamination probes |
| `classification.py` | model-value classification |

---

## 3. Architectures Implemented

| Architecture | Family | Parameters (example) | Causality |
|--------------|--------|----------------------|-----------|
| MLP | MLP | 257 (16×8) | n/a (cross-sectional) |
| Temporal CNN | TEMPORAL_CNN | 113 | causal left-pad conv, last position only |
| LSTM | LSTM | 425 | left→right recurrence, final hidden |
| GRU | GRU | 321 | left→right recurrence, final hidden |
| Transformer-lite | TRANSFORMER_LITE | 169 | strict causal attention mask |

All models are compact by design (spec §5, §11 — no massive transformer). No
foundation model / LLM / large pretrained transformer was introduced.

---

## 4. Deep-Learning Results (synthetic verification only)

No real Indian equity/F&O dataset is loaded, so there are **no production
OOS results**. On deterministic synthetic signals the framework demonstrates:

| Model | Synthetic OOS rank IC (illustrative) |
|-------|--------------------------------------|
| Ridge / Linear (baseline) | ~0.975 (linear signal) |
| MLP | ~0.954 (linear signal) |
| Temporal CNN | ~0.61 (temporal signal) |
| LSTM | ~0.80 (temporal signal) |
| GRU | ~0.76 (temporal signal) |
| Transformer-lite | ~0.32 (temporal signal) |

These are synthetic sanity checks, NOT alpha claims. On a linear signal the
classical baseline correctly beats the MLP — the framework does not assume
DL > classical.

---

## 5. Discipline Enforced

- **PIT sequences**: window ends at prediction time; left-pad only; a future
  perturbation cannot change the prediction (verified).
- **PIT normalization**: scalers fit on the train window only, applied to
  val/OOS; no `fit_transform` on the full dataset.
- **Walk-forward only**: uses the Phase 3A `WalkForwardValidator` with embargo;
  no random splits.
- **HPO / seed / checkpoint**: selection uses validation only; the final OOS is
  never touched during search (verified `search_touched_oos=False`).
- **Multi-seed robustness**: mean/median/std/worst/best reported over seeds.
- **Calibration**: raw sigmoid is never treated as a calibrated probability;
  routed through Phase 3F (or a pure-NumPy isotonic fallback in this env).
- **Governance**: every deep model registers as a Phase 3J challenger; contaminated
  evidence blocks challenger registration; no auto-promotion.

---

## 6. Verdict

**NO_INCREMENTAL_ALPHA / INSUFFICIENT_EVIDENCE.** No deep model has demonstrated
credible incremental OOS alpha over the classical champion, because no real
dataset was evaluated. The framework is complete and verified on synthetic data;
it awaits a governed real dataset before any incremental-alpha claim can be made.

---

## 7. Tests

Phase 3K: 55 passed / 0 failed. Full Phase-3 suite (3A–3K): 820 passed / 0
failed / 19 skipped. Static audit CLEAN.
