# Phase 3K — Incremental Alpha Report

**Generated:** 2026-09-06  
**Branch:** `refactor/improve-ml-service`  
**Verdict:** NO_INCREMENTAL_ALPHA — INSUFFICIENT_EVIDENCE (no real dataset)

---

## 1. Central Question (spec §30)

Does a deep model contain information NOT already captured by the classical
champion? Measured via incremental IC, prediction/error correlation, residual
modeling, and ensemble diversification.

---

## 2. Incremental IC (spec §30)

`incremental_alpha_report` removes the champion's linear component from the
challenger's predictions and computes the residual's rank IC vs realized
returns. A positive incremental IC means the challenger's UNIQUE component still
predicts returns.

Synthetic verification:
- Redundant challenger (pred corr ≈ 1.0): flagged `near_identical`, negative
  incremental IC → REDUNDANT.
- Complementary challenger (pred corr ≈ −0.05): incremental IC ≈ 0.52 → flagged
  COMPLEMENTARY.

---

## 3. Residual Model (spec §31)

`compute_residual_target` = realized − champion_prediction; a deep model can be
trained to predict this residual. `evaluate_residual_model` reports whether
(champion + residual_pred) improves OOS rank IC over the champion alone.

Synthetic verification: combined IC 0.907 > champion IC 0.733 → residual model
improves. This is reported SEPARATELY from direct replacement (spec §31).

---

## 4. Ensemble (spec §32, §57)

`EnsembleWeighter` fits non-negative simplex weights to maximise VALIDATION rank
IC (never OOS, spec §33). A model with low correlation to the champion but no
standalone superiority can still improve the ensemble — a valid COMPLEMENTARY
outcome (spec §57). The model does not need to become champion to be useful.

Synthetic verification: ensemble weights [0.6, 0.4] fit on val; OOS ensemble IC
0.915 > champion 0.749.

---

## 5. Disagreement / Abstention (spec §34)

`disagreement_report` measures rank and prediction disagreement between models.
High disagreement feeds the Phase 3F abstention system to ABSTAIN rather than
force an action.

---

## 6. Current Result

**NO_INCREMENTAL_ALPHA / INSUFFICIENT_EVIDENCE.** No real dataset is loaded, so
no deep model has demonstrated production incremental alpha. All incremental,
residual, and ensemble machinery is verified on deterministic synthetic data.

Per the brief, `NO_INCREMENTAL_ALPHA` is a successful research conclusion — the
system honestly reports that advanced models have not (yet, on real data) shown
value beyond the classical stack.
