# ALPHAFORGE ML VALIDATION

**Models, calibration, OOS, leakage, champion/challenger.** Read-only. 2026-09-09,
git `1c2941b`. Cross-references `INDIA_ML_TRAINING_REPORT.md` (fresh retrain run).

---

## 1. DATASET CONSTRUCTION & LEAKAGE CONTROLS (Phase 12 + 14)

The Python `ml-service` training stack is genuinely rigorous:

| Control | Implementation | Verdict |
|---|---|---|
| Chronological split (no shuffle) | `WalkForwardValidator` | ✅ |
| Purged K-fold | `validation/purged_kfold.py` | ✅ |
| Embargo (= label horizon) | `EmbargoApplier` (5 bars) | ✅ |
| HPO on inner folds only; test never touched | `_hpo_temporal` inner-fold-only | ✅ |
| Acceptance gate blocks saving unfit models | `ModelAcceptanceGate` | ✅ (verified — it rejected everything) |
| Policy-based labels | `labels/triple_barrier.py` | ✅ |
| Dataset hashing | SHA-256 captured (regime `482f56f4…`, ranking `1979dcf3…`, risk `ab027e93…`, strategy `9c68405b…`) | ✅ |
| Dataset versioning sidecar | **missing** (`dataset_meta.json` absent → defaults `af-v3.0-fv4`) | ⚠️ |

**Labels (Phase 12):** `generate_triple_barrier_labels` uses a **sequential
first-touch scan** (not `.any()`), `CONSERVATIVE_SL` on intrabar ambiguity
(both-touched → STOP), excludes `INTRABAR_AMBIGUOUS` and `DATA_INSUFFICIENT` from
training (never relabels incomplete as time-exit), and is expiry-aware. This maps
cleanly to TARGET_FIRST / STOP_FIRST / TIME_EXIT_* / AMBIGUOUS. **No label leakage
found.**

**Leakage audit (Phase 14):**
- Look-ahead in labeling: **none** (trailing ATR, forward scan bounded by horizon).
- Train/test contamination: **none** (purge + embargo enforced by assertions).
- Favorable stop/target ordering: **none** (conservative-SL).
- Normalization/scaler leakage: not separately verified per fold — 🟡 flagged for
  review (features are pre-computed in the tensor; per-fold scaler fitting not
  independently confirmed).
- Data snooping / multiple-testing: the acceptance gate flags single-fold path
  dependence (it fired on the regime model) — a genuine guard. ✅

---

## 2. FRESH RETRAIN RESULTS (Phase 12) — 0/7 MODELS PASS

Real walk-forward retrain on real daily-derived tensors (to scratch dir; production
artifacts untouched). Full detail in `INDIA_ML_TRAINING_REPORT.md`.

| Model | Algo | OOS result | Gate | Status |
|---|---|---|---|---|
| Market Regime Classifier | XGBoost | **acc 0.474** (<0.52), Sharpe −0.83, PF 0.90, 1 fold=100% return | ❌ | 🔴 INSUFFICIENT EVIDENCE |
| Stock Ranker | LightGBM | **Spearman IC 0.0041** (p 0.54, <0.02) | ❌ | 🔴 INSUFFICIENT EVIDENCE |
| Strategy Selector | CatBoost | — | ⛔ | BLOCKED (numpy 2.2.6 / catboost ABI) |
| Risk Predictor | XGBoost ×3 | crashed: single-class validation fold → `roc_auc` undefined | ⛔ | TRAINING FAILED |
| Price Regime Forecaster | (darts/TFT) | deps not installed; no tensor | — | NOT RUN |
| IV Regime Classifier | (PatchTST/tsai) | deps not installed; no tensor | — | NOT RUN |
| Meta Decision Model | TS ensemble | needs persisted OOS outcomes (in-memory only) | — | NOT TRAINABLE |

**Interpretation:** the two models that fully evaluated OOS have **no out-of-sample
edge** (regime barely above random for its class count; ranker IC statistically
zero at p=0.54). Strong in-fold fit (regime train ~0.99; ranker train IC 0.70) with
near-zero OOS is a textbook **overfit** signature — which the acceptance gate
correctly caught. The gate working is a positive finding; the models being unfit is a
negative one.

---

## 3. CALIBRATION (Phase 4 + 17)

- **Machinery ✅:** `ml-meta-training.trainMetaModel` implements hierarchical
  calibrators (isotonic/Platt/raw) selected by OOS log-loss, per-model ROC-AUC/
  log-loss contribution, PSI drift, regime performance, correlation de-weighting, and
  OOS-learned base weights. `computeCalibrationMetrics` produces Brier/ECE/slope/
  intercept. All unit-tested.
- **Runtime 🔴:** the resolver returns `defaultMetaArtifact()` — **untrained**, every
  calibrator `method:"raw"`, `globalPrior:0.5`, `addsValue:false`. By design it
  cannot masquerade as calibrated (it self-reports low quality), but it means the
  deployed probability is **not calibrated**.
- **Empirical calibration test (Phase 17): NOT MEASURABLE.** No predicted-probability/
  realized-outcome pairs are persisted (0/321 in the ledger). Brier/ECE/reliability
  cannot be computed on real data. → "Does 70% mean ~70%?" **INSUFFICIENT EVIDENCE.**

**Separation of confidence / probability / quality / EV:** ✅ these are distinct typed
fields in `ml-meta-decision` and are not interchanged.

---

## 4. CHAMPION / CHALLENGER (Phase 12)

`evaluateChampionChallenger` is a real statistical gate: expectancy is the required
metric with a two-sample **z ≥ 1.96**, Brier must not regress, drawdown-regression
guard, ≥100 OOS sample floor; decision ∈ PROMOTE/HOLD/REJECT. The composite spirit
(expectancy-first, calibration + PF + DD + regime robustness + stability guards)
matches the intended 40/20/15/10/10/5 weighting.

**But it cannot run for real:** the outcome store is in-memory, so no champion/
challenger comparison ever executes on accumulated production data; and in this
retrain **no challenger passed its own acceptance gate**, so none is even eligible.
Deployed champion artifacts (`ml-service/artifacts/*`, Aug-19) are **raw booster dumps
with no embedded provenance/metrics**, and **no `model_registry.json` exists** — so
there is no champion baseline to compare against. **Champion/challenger: implemented,
not operational, not validated.**

---

## 5. MODEL METADATA / VERSIONING (Phase 12 + 23)

`ModelRecord` supports every required field (version, training/validation/OOS periods,
feature/label/dataset versions, hyperparameters, validation+calibration metrics, git
commit, acceptance status) and `prediction_provenance.py` can stamp a model version on
predictions. **Gap:** deployed artifacts weren't registered (no provenance in the
files, no registry JSON), and no dataset-meta sidecar pins the window. **🟡
IMPLEMENTED BUT NOT (fully) OPERATIONALIZED.**

---

## 6. ML VERDICT

Infrastructure grade: **A−** (rigorous, leakage-aware, honest gates). Model-evidence
grade: **F** — **0/7 models demonstrate OOS edge**, calibration is unproven on real
data, and the runtime meta-model is untrained. The ML stack is **safe** (it fails
closed to a prior-abstaining default) but **not yet predictive on evidence**.
