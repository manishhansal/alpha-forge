# Champion / Challenger Methodology

This document describes the methodology behind AlphaForge's champion/challenger
evaluation and evidence-gated promotion, as implemented in Phase 3J.

---

## 1. Principle

A model earns the right to trade capital by out-evidencing the incumbent
champion on a fair, frozen comparison — not by having a higher backtest number.
The default state is skepticism: absent sufficient evidence, no model is
champion (NO_PROMOTION).

---

## 2. Scoped Champions

There is no universal "best model". Champions are scoped by
`asset_class / market / horizon / strategy_family / regime`. A model that wins
`equity/5D` says nothing about `futures/1D`. Comparisons only ever happen within
a scope, and only between compatible models (same feature/label/execution/
portfolio contract).

---

## 3. Fair Comparison

The comparator requires a `FrozenEvalSnapshot` — a fixed evaluation dataset
identified by hash, observation count, date range, and universe hash. Both the
champion and the challenger are scored on the SAME snapshot with the SAME
execution model, cost model, portfolio constraints, and evaluation horizon.

Prediction correlation is surfaced: challengers whose predictions correlate with
the champion above 0.99 are flagged as near-identical, because a near-identical
model rarely justifies the switching risk.

---

## 4. Evidence Before Promotion

A challenger progresses through SHADOW (predictions only, zero influence on the
champion portfolio) and PAPER (simulated execution via Phase 3G) before it is
even eligible. Configurable soak periods (`min_shadow_days`,
`min_shadow_observations`, `min_paper_days`, `min_paper_trades`) prevent
promotion on a lucky short window.

Evidence is graded A–D. Promotion requires at least LEVEL_B and a clean
(uncontaminated) final OOS. Proxy-only evidence (LEVEL_C) and contaminated
evidence (LEVEL_D) cannot promote.

---

## 5. The Promotion Bar

A challenger must clear six gates, each returning PASS / FAIL /
INSUFFICIENT_EVIDENCE:

1. DATA — integrity, sample size, evidence level, no final-OOS contamination
2. PREDICTIVE — Rank IC improvement above the configured minimum
3. CALIBRATION — Brier must not degrade beyond tolerance
4. EXECUTION — positive net return, turnover/costs not materially worse
5. RISK — drawdown not materially worse
6. STABILITY — no significant IC decay, no high/critical feature drift

Marginal improvements do not justify promotion: a positive-but-tiny IC gain that
does not clear `min_ic_improvement` yields DO_NOT_PROMOTE.

---

## 6. Selection Bias

Every tested challenger — promoted or rejected — is counted per scope
(`number_tested / number_rejected / number_promoted`). Failed challengers are
never hidden. This makes multiple-testing pressure visible and discourages
fishing for a passing configuration.

---

## 7. Human in the Loop

By default a PROMOTE decision requires explicit human confirmation
(`high_impact_requires_human`). The orchestrator records the decision and
defers; a human confirms via `confirm_promotion()`. The system never silently
swaps the model that trades capital.

---

## 8. Why NO_PROMOTION Is a Good Answer

Phase 3J currently reports NO_PROMOTION / INSUFFICIENT_EVIDENCE because no real
Indian equity/F&O dataset is loaded. This is by design. A trading system with no
champion is strictly safer than one that promotes a model it cannot defend with
evidence. The framework is ready; it simply refuses to invent a champion.
