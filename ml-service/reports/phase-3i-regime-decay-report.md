# Phase 3I — Regime Decay Report

**Generated:** 2026-09-06  
**Branch:** `refactor/improve-ml-service`  
**OOS evidence:** INSUFFICIENT_EVIDENCE

---

## 1. Scope

Documents regime-conditional stability analysis in `src/stability/regime_decay.py`.
Evaluates whether alpha works only in certain market regimes and how it behaves
across regime transitions.

---

## 2. Regime Taxonomy

Uses the 6 regimes from `models.market_regime`:

`STRONG_BULL / BULL / SIDEWAYS / VOLATILE / BEAR / CRASH`

Regime labels at signal timestamp T must be point-in-time correct (computed from
data ≤ T). Realized returns are used only for evaluation.

---

## 3. Regime-Conditional IC

For every regime the report computes:

| Metric | Notes |
|--------|-------|
| mean IC / mean Rank IC | Spearman of scores vs realized within regime |
| ICIR | mean IC / std IC across timestamps in the regime |
| positive IC % | fraction of timestamps with IC > 0 |
| mean EV | conditional expected value |
| observation count | REQUIRED — no statistics from tiny samples |
| unique dates | REQUIRED (spec §57) |
| evidence level | STRONG / MODERATE / WEAK / INSUFFICIENT |

Regimes with fewer than 10 observations return `INSUFFICIENT_EVIDENCE` — never
a fabricated 0.0.

---

## 4. Regime Transition Analysis

Adjacent-timestamp regime changes (e.g. BULL → BEAR) are analysed:

| Field | Meaning |
|-------|---------|
| ic_before | mean IC in the 5 timestamps before transition |
| ic_after | mean IC in the 5 timestamps after transition |
| ic_change | ic_after − ic_before |
| status | SURVIVES / WEAKENS / REVERSES / INSUFFICIENT_EVIDENCE |

- SURVIVES: ic_after ≥ 90% of ic_before
- WEAKENS: ic_after ≥ 0 but below 90% of ic_before
- REVERSES: ic_after < 0

---

## 5. Sector-Conditional Stability

Where `sector_col` is provided, per-sector IC is computed. The `dominant_sector`
field identifies whether the overall alpha is concentrated in a single sector
(a fragility signal per spec §27).

---

## 6. Framework Verification (Synthetic Data)

| Scenario | Expected | Result |
|----------|----------|--------|
| BULL-predictive, BEAR-noise panel | BULL IC > BEAR IC | PASS |
| Regime segmentation | BULL and BEAR both present | PASS |
| BULL → BEAR transition | ≥ 1 transition detected | PASS |
| 3-observation CRASH regime | INSUFFICIENT_EVIDENCE | PASS |
| Sector IC computed | ≥ 1 sector | PASS |

---

## 7. OOS Evidence

**INSUFFICIENT_EVIDENCE** — no real regime-labeled prediction panel loaded.
Regime-conditional IC requires a real dataset with regime labels aligned to
predictions and realized outcomes.

---

## 8. Limitations

- Regime labels must be supplied by the caller (PIT-correct). This module does
  not re-run the regime classifier.
- Transition windows are fixed at ±5 timestamps (configurable in future).
- Sector-conditional stats require sufficient per-sector sample sizes; small
  sectors return None rather than a fabricated value.
