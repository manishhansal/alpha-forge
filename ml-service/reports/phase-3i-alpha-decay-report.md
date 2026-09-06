# Phase 3I — Alpha Decay Report

**Generated:** 2026-09-06  
**Branch:** `refactor/improve-ml-service`  
**Status:** PASS (framework); OOS evidence = INSUFFICIENT_EVIDENCE

---

## 1. Scope

Phase 3I builds the alpha decay, stability, and concept-drift analysis layer
(`src/stability/`). This report documents the IC decay framework and its
capabilities. Because no real Indian equity dataset is loaded in the service,
all numeric OOS decay results are **INSUFFICIENT_EVIDENCE** — the framework is
verified on synthetic data only.

---

## 2. Components Built

| Module | Purpose |
|--------|---------|
| `src/stability/schemas.py` | All canonical types: `AlphaDecayObservation`, `ICDecayResult`, `SignalHealth`, `SignalHealthRecord`, `ConceptDriftRecord`, `StabilityMatrix`, `DataCoverageReport`; 10 enums |
| `src/stability/ic_decay.py` | Pearson/Rank IC decay, rolling ICIR, IC trend slope (linregress), lag-1 autocorrelation, half-life (AR(1)), CUSUM change-point, forward-horizon decay |
| `src/stability/quantile_analysis.py` | Quantile/decile temporal stability, monotonicity decay, top-bottom spread (gross + net of cost) |
| `src/stability/feature_stability.py` | PSI, KS, Wasserstein, missingness drift per feature |
| `src/stability/prediction_drift.py` | Alpha score / probability / EV distribution drift + CUSUM |
| `src/stability/calibration_drift.py` | Brier/ECE/slope drift across temporal folds |
| `src/stability/regime_decay.py` | Regime-conditional IC/EV; regime transitions; sector IC |
| `src/stability/portfolio_decay.py` | Rolling portfolio metrics; concentration/turnover/cost-edge decay |
| `src/stability/signal_health.py` | SignalHealth classification; stability matrix; concept-drift records |

---

## 3. IC Decay Methodology

### 3.1 IC computation

IC is computed **cross-sectionally per timestamp** (reusing
`ranking.evaluation.compute_ic` / `compute_rank_ic`). Temporal decay analysis
layers on top of the per-timestamp IC series.

### 3.2 Decay diagnostics

| Diagnostic | Method | Interpretation |
|-----------|--------|----------------|
| IC trend slope | `scipy.stats.linregress` on IC series | Negative slope = decaying |
| Trend significance | linregress p-value | p < 0.05 = statistically significant |
| Temporal split | Early / Middle / Recent thirds | Compare recent vs early IC |
| Lag-1 autocorrelation | `scipy.stats.pearsonr(IC[:-1], IC[1:])` | High = persistent signal |
| Half-life | AR(1) fit: `-log(2)/log(β)` | Estimable only when 0 < β < 1 |
| Change-point | CUSUM on IC series | Detects level shift |

### 3.3 Decay status classification

- `SIGNIFICANT_DECAY` — trend slope < −0.001 AND p < 0.05, OR recent IC < 50% of early IC
- `FAILED` — early IC > 0 but recent IC < 0
- `MILD_DECAY` — recent IC < 75% of early IC
- `STABLE` — recent IC ≥ 75% of early IC, mean |IC| > 0.02
- `INSUFFICIENT_EVIDENCE` — fewer than 10 IC observations

### 3.4 Half-life status

- `HALF_LIFE_ESTIMABLE` — AR(1) β ∈ (0, 1), n ≥ 20
- `HALF_LIFE_INSUFFICIENT_EVIDENCE` — non-stationary (β ≥ 1), anti-persistent (β ≤ 0), or n < 20

Half-life is **never fabricated**.

---

## 4. Framework Verification (Synthetic Data)

| Test scenario | Expected | Result |
|--------------|----------|--------|
| Declining IC (0.10 → −0.03) | SIGNIFICANT_DECAY, negative slope | PASS |
| Persistent AR(1) β=0.7 | HALF_LIFE_ESTIMABLE | PASS |
| Anti-persistent (alternating) | HALF_LIFE_INSUFFICIENT_EVIDENCE | PASS |
| Level shift at index 30 | CUSUM DETECTED near 30 | PASS |
| Flat series | CUSUM NOT_DETECTED | PASS |
| 2-observation series | INSUFFICIENT_EVIDENCE (not 0.0) | PASS |

---

## 5. Rolling IC Windows

Configurable window sizes (default `[20, 60, 120]`) — no hardcoded values in
analysis code. Each window reports mean IC, mean Rank IC, ICIR, positive IC %,
and an evidence level (STRONG ≥ 100, MODERATE ≥ 30, WEAK ≥ 10, else INSUFFICIENT).

---

## 6. Forward-Horizon Decay

Evaluates the same signal at multiple forward horizons (e.g. 1D/3D/5D/10D/20D).
Different horizons are analysed separately — a 1-day alpha and a 20-day alpha
never share a decay analysis. PIT is guaranteed by construction: realized returns
at horizon H come from T+H while the signal was generated at T.

---

## 7. OOS Evidence

**INSUFFICIENT_EVIDENCE** — no real Indian equity/F&O dataset is loaded in the
ML service. IC decay curves, half-life values, and regime-conditional IC require
real cross-sectional prediction/outcome panels to produce meaningful numbers.

The framework is architecturally complete and verified on synthetic data.
Real decay analysis is deferred until a production dataset with genuine
prediction-outcome history is available.

---

## 8. Important Findings

1. The framework distinguishes **signal strength** (mean IC) from **signal
   persistence** (autocorrelation) from **signal decay** (trend slope) — three
   separate quantities.
2. `INSUFFICIENT_EVIDENCE` is returned rather than 0.0 for small samples
   throughout — no missing evidence is masked as a zero value.
3. No automatic model replacement occurs (spec §66) — the module produces
   evidence and recommendations only.

---

## 9. Limitations

| Limitation | Impact |
|------------|--------|
| No real prediction/outcome dataset | All OOS decay numbers = INSUFFICIENT_EVIDENCE |
| Half-life uses AR(1) only | Alternative decay models not fitted |
| Change-point uses CUSUM only | PELT/BOCPD (ruptures) not installed |
| statsmodels not declared | ACF via scipy.stats.pearsonr instead |
