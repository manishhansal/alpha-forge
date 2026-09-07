# Phase 3K — Current Deep-Learning Audit

**Generated:** 2026-09-06  
**Branch:** `refactor/improve-ml-service`  
**Auditor scope:** `src/`, `tests/`, `reports/`, `docs/`, `configs/`, `scripts/`

---

## 1. Purpose

Determine what deep-learning / advanced-ML infrastructure already exists before
writing any Phase 3K code, and confirm what must be reused from Phases 3A–3J
rather than duplicated.

---

## 2. Existing Deep-Learning Code — CONFIRMED ABSENT

A grep for `import torch`, `tensorflow`, `keras`, `nn.Module`, `MLPClassifier`,
`MLPRegressor`, `Sequential(` inside `ml-service/src/` returns **zero** matches
for any purpose-built neural predictor.

| Item | Status |
|------|--------|
| MLP / feed-forward NN predictor | ABSENT (greenfield) |
| Temporal CNN / LSTM / GRU / Transformer | ABSENT (greenfield) |
| Sequence builder | ABSENT (greenfield) |
| DL experiment registry | ABSENT (greenfield) |
| `src/models/rl_executor.py` | EXISTS — RL via `stable-baselines3` (out of Phase 3K scope; not modified) |

Phase 3K sequence/deep models are therefore new, but MUST plug into the existing
feature/label/ranking/validation conventions and Phase 3J governance.

---

## 3. Environment Findings (decisive)

| Component | Result |
|-----------|--------|
| Python | **3.14.6** (very new) |
| numpy | 2.5.1 (available) |
| scipy | 1.18.1 (available) |
| pandas | 3.0.3 (available) |
| **torch** | **NOT importable** in the active interpreter (`ModuleNotFoundError`) |
| **tensorflow** | **No wheel** for Python 3.14 (`pip` finds no distribution) |
| sklearn / joblib | **BROKEN** — missing transitive `cloudpickle` (pre-existing, Phases 3I/3J) |
| Accelerator | CPU only (macOS arm64); no GPU/CUDA |

`pip install --dry-run torch` resolves `torch 2.14.0` (a cp314 arm64 wheel
exists), but torch is **not installed** in the interpreter that runs the test
suite, TensorFlow has **no** Python-3.14 distribution at all, and the phase
brief forbids adding heavyweight production dependencies casually (§11 "no
massive transformer / foundation model"; the classical stack remains baseline).

### 3.1 Framework Decision

Phase 3K is implemented **framework-agnostic on a pure-NumPy neural backend**,
with an **optional** thin torch adapter that is used only if torch is importable.

Rationale:
- **Determinism** — pure NumPy forward/backward with explicit seeding gives
  reproducible results across runs and machines, satisfying §24/§62/§63. GPU
  torch cannot guarantee bitwise reproducibility (§63 explicitly allows
  documenting this limitation).
- **Environment robustness** — the test suite runs under Python 3.14 where
  torch is not installed and TF is unavailable. A pure-NumPy core means the DL
  framework, PIT-safety, causality, leakage, and negative-control tests all run
  and pass in CI without a heavyweight dependency.
- **Scope fit** — the brief's models (compact MLP, 1D causal CNN, small
  LSTM/GRU, transformer-lite) are small enough to implement and train
  correctly in NumPy for the research question ("is there *incremental* alpha?").
  This is research infrastructure, not a production inference server.
- **No new hard dependency** — consistent with the 3I/3J decision to avoid new
  deps (`filelock`, `cloudpickle` etc.).

The torch adapter path is stubbed behind a capability check so the same
experiment API can later run on torch where a compatible environment exists.

---

## 4. Reusable Infrastructure (do NOT duplicate)

| Phase | Package | Reused for Phase 3K |
|-------|---------|---------------------|
| 3A | `src/validation/` | `WalkForwardValidator/Config/Fold`, `split_on_index(embargo_bars=)`, embargo/purge — ALL DL experiments use this; no random splits (§20) |
| 3B | `src/data/dataset_version.py` | `DatasetSnapshot`, version constants (`FEATURE_VERSION=fv4`, `LABEL_VERSION=lv2`), PIT engine — DL consumes same PIT foundation (§12) |
| 3C | `src/labels/` | `LabelConfig.hash` (= `label_config_hash`), `LABEL_REGISTRY`, event times — DL uses existing targets (§16) |
| 3D | `src/features/` | `FEATURE_REGISTRY`, `<FEATURE_SET>.feature_names` canonical column order — DL consumes same features (§12, §46 ablation) |
| 3E | `src/ranking/` | `BaseRanker` interface, `compute_ic/compute_rank_ic/compute_ic_series`, `compute_decile_report` — NN ranker is a drop-in `BaseRanker`; IC via existing funcs (§19, §30) |
| 3F | `src/meta/` | `compute_calibration_metrics`, `walk_forward_calibrate`, `CalibratorArtifact`, `ExpectedValueCalculator`, `AbstentionPolicy` — DL probs calibrated here (§35, §36, §34) |
| 3G | `src/execution/` | `BacktestEngine.run`, cost/slippage models — DL portfolios execute here (§37) |
| 3H | `src/portfolio/` | `RiskModel`, `PortfolioOptimizer`, `ConstraintSet`, `SizingEngine` — DL portfolios built here (§38) |
| 3I | `src/stability/` | `analyse_ic_decay`, drift/regime/feature-stability APIs — DL decay measured here (§39, §48–§51) |
| 3J | `src/lifecycle/` | `ModelRegistry`, `ModelIdentity`, `ModelProvenance`, `ChallengerRegistry`, `ModelEvidencePackage`, `PromotionGate` — every DL model enters as a CHALLENGER; no bypass (§27, §28, §29) |

---

## 5. Canonical Conventions Phase 3K Must Honour

- **Timestamps:** tz-aware UTC (`pd.bdate_range(..., tz="UTC")`); naive rejected.
- **OHLCV columns:** lowercase `[open, high, low, close, volume]`.
- **Feature matrix `X`:** `np.ndarray (n_samples, n_features)`, column order =
  `<FEATURE_SET>.feature_names` from `src.features.registry`.
- **Panel for IC:** long format keyed by `(timestamp, instrument_id)` with
  `score_col`, `realized_col`, `timestamp_col`.
- **Folds:** `split_on_index(df.index, embargo_bars=horizon_bars)`; sequences
  built strictly inside each fold; embargo ≥ label horizon.
- **Semantics (never conflate):** `ALPHA_SCORE ≠ probability ≠ expected_return ≠
  EV ≠ portfolio_weight` (`PredictionSemantics` enum).
- **No `np.random.*` in production `src/`** — DL seeding uses a dedicated,
  explicit deterministic RNG passed into constructors; static test enforces it.

---

## 6. Anti-Patterns to Avoid (from prior phases)

- No `latest.pkl` / `current_model` (Phase 3J forbidden references).
- No `fit_transform` on the full dataset before temporal split (§13).
- No future-observation padding in sequences (§7).
- No OOS-based selection of architecture / HPO / seed / checkpoint / ensemble
  weight / threshold (§21, §22, §26, §33, §69).
- No auto-promotion of a DL model (§29, §83).

---

## 7. Test Conventions

One `tests/test_phase3k.py`; imports `from src.<pkg> ...`; run from `ml-service/`.
Imports done inside test methods (lazy) so an optional dep only skips the tests
that need it — torch imports (if any) go inside tests and skip when absent.
Deterministic synthetic data only, explicit `np.random.seed` in tests.

---

## 8. Plan (14 tasks)

1. Audit (this doc). 2. `src/deep/` skeleton + experiment registry. 3. PIT
sequence builder. 4. PIT normalization. 5. MLP baseline (NumPy). 6. Temporal
models (causal CNN / LSTM / transformer-lite, NumPy). 7. Classical baselines +
fair walk-forward. 8. HPO/seed/checkpoint discipline. 9. Incremental alpha +
residual + ensemble + abstention. 10. 3F/3G/3H/3I integration + complexity +
latency. 11. Leakage / negative-control / causality tests. 12. Model value
classification + `tests/test_phase3k.py`. 13. Full suite + static audit.
14. Reports + docs + CHANGES + commit.

**Expected honest conclusion:** no real Indian equity/F&O dataset is loaded, so
the research verdict is **NO_INCREMENTAL_ALPHA / INSUFFICIENT_EVIDENCE**; the
framework is verified end-to-end on deterministic synthetic data.
