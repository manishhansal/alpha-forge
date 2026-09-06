# Phase 3H — Portfolio Intelligence Report

**Generated:** 2026-09-06  
**Branch:** `refactor/improve-ml-service`  
**Status:** PASS

---

## 1. Scope

Phase 3H introduces the complete portfolio intelligence layer for AlphaForge,
sitting downstream of Phase 3F (meta-labeling, probability calibration, EV computation)
and Phase 3G (execution simulation, cost model) and upstream of any live deployment.

---

## 2. Components Built

| Module | Purpose |
|--------|---------|
| `src/portfolio/schemas.py` | All canonical types: `PortfolioCandidate`, `PortfolioTarget`, `PortfolioState`, `TargetOrder`, `PortfolioResult`, `PortfolioProvenance`, `ComponentRisk`, `ExposureSummary`; 10 enums |
| `src/portfolio/risk_model.py` | Historical, EWMA, Ledoit-Wolf (analytical), OAS covariance; PSD repair with eigenvalue floor; PIT enforcement; condition number check; missingness validation |
| `src/portfolio/eligibility.py` | Deterministic eligibility filter with 10 rejection reasons; Phase 3F Decision semantics preserved |
| `src/portfolio/constraints.py` | Sector, industry, single-name, gross/net exposure, beta, factor, turnover, liquidity constraints; pre-solve feasibility check; scipy-compatible constraint builder |
| `src/portfolio/sizing.py` | EV/risk sizing, fractional Kelly (¼ Kelly default), inverse-vol, risk-budgeting (iterative), vol targeting; clip applied post-normalization |
| `src/portfolio/optimizer.py` | 6 objectives (MIN_VARIANCE, MAX_SHARPE, MAX_DIVERSIFICATION, CVaR, RISK_BUDGETING, EV_RISK) + HRP + 3 baselines; all via scipy SLSQP or analytical; explicit failure states |
| `src/portfolio/rebalancer.py` | Turnover calculation, target vs executed separation, TargetOrder execution contract |
| `src/portfolio/analytics.py` | Performance metrics, benchmark-relative, concentration (HHI, effective N), stability (grid perturbation), regime analysis, attribution |
| `src/portfolio/risk_overlay.py` | Drawdown/vol/CVaR/regime/model-confidence overlay; configurable thresholds; risk scaling |

Also fixed: `src/models/portfolio_optimizer.py` — removed `np.random.uniform`, added logging to silent fallback.

---

## 3. Test Results

### 3.1 Phase 3H suite

| Metric | Value |
|--------|-------|
| Tests collected | 115 |
| Passed | 115 |
| Failed | 0 |
| Skipped | 0 |

### 3.2 Full regression suite (Phases 3A–3H)

| Metric | Value |
|--------|-------|
| Total passed | 513 |
| Total failed | 0 |
| Skipped (pre-existing) | 11 |

---

## 4. Test Classes

| Class | Tests | Focus |
|-------|-------|-------|
| `TestDeterminism` | 5 | Identical input → identical output; no `np.random.*` in executable code; provenance hash stability |
| `TestRiskModel` | 11 | Covariance symmetry, PSD, LW shrinkage ∈ [0,1], OAS ∈ [0,1], EWMA, component risk sum, PIT violation, INSUFFICIENT_SAMPLE |
| `TestConstraints` | 10 | All constraint types; violations detected; pre-solve feasibility; scipy constraint building |
| `TestLongShort` | 4 | Long-only weights ≥ 0; gross/net reconciliation; long/short weight subsets; mode enforcement |
| `TestEVSizing` | 10 | Positive/zero/negative/unavailable EV; higher EV → higher weight; Kelly unavailability; fractional Kelly ceiling; vol targeting; risk budgeting equal contribution |
| `TestPortfolioOptimizer` | 17 | All 9 objectives; MIN_VARIANCE < equal-weight variance; CVaR ≤ EW CVaR; HRP non-negative; explicit failure states; component risk non-empty |
| `TestFnOHandling` | 6 | Lot sizing; zero lots for sub-lot capital; expiry rejection; F&O ban; options Greeks in candidate; portfolio delta |
| `TestRebalancing` | 7 | No rebalance when unchanged; turnover; buy orders; close sells; target vs executed separation; daily policy; order fields |
| `TestPITMutation` | 5 | Future covariance/EV/sector/liquidity/price mutations do NOT alter frozen target |
| `TestEligibilityFilter` | 7 | All rejection reasons; batch filter; rejection summary |
| `TestRiskOverlay` | 9 | No trigger; drawdown reduce/halt/exit; vol spike; regime triggers; ordered escalation; risk scaling; configurable thresholds |
| `TestAnalytics` | 7 | HHI ∈ (0,1]; effective N; INSUFFICIENT_EVIDENCE < 20 obs; Sharpe/max_dd/CVaR computed; benchmark-relative with/without data; regime segmentation |
| `TestSemanticInvariants` | 4 | EV_RISK uses `expected_value` not `alpha_score`; EQUAL_WEIGHT ignores EV; EV ≠ alpha; prob status required |
| `TestBaselineComparison` | 8 | All baselines exist; all produce valid targets; weights sum to 1.0 |
| `TestBackwardCompatibility` | 3 | Legacy `optimize()` API works; prior phase imports unaffected; no `np.random.uniform` in executable code |

---

## 5. Critical Bugs Fixed

| ID | Severity | File | Description | Fix |
|----|----------|------|-------------|-----|
| BUG-3H-01 | CRITICAL | `portfolio_optimizer.py` | `np.random.uniform` with no seed — non-deterministic portfolio weights | Replaced with deterministic constant `0.25` |
| BUG-3H-02 | HIGH | `portfolio_optimizer.py` | Silent equal-weight fallback — no log, no flag | Added `logger.warning` with explicit reason |
| BUG-3H-03 | MEDIUM | `sizing.py` | Weight clip applied before normalization — flattened EV proportionality | Moved clip to post-normalization step |
| BUG-3H-04 | MEDIUM | `constraints.py` | Long-only constraint was `sum(w) ≤ 1` (inequality) — allowed degenerate zero-weight solutions | Changed to `sum(w) = 1` equality |
| BUG-3H-05 | LOW | `schemas.py` | `PortfolioCandidate.alpha_score`/`rank_percentile` were required positional args | Made `Optional` with `None` default |

---

## 6. Static Audit Results — ALL CLEAN

| Pattern | Result | Evidence |
|---------|--------|----------|
| `np.random.*` in executable portfolio code | CLEAN | AST-based scan: 0 matches |
| `random.*` in portfolio code | CLEAN | 0 matches |
| `rank_score` used as expected return | CLEAN | `EV_RISK` uses `expected_value` field exclusively |
| `rank_score` used as probability | CLEAN | 0 matches |
| Synthetic correlation matrix | CLEAN | All covariance from historical returns; `UNAVAILABLE` if absent |
| `shift(-N)` forward-looking | CLEAN | 0 matches in `src/portfolio/` |
| `fillna(0)` on financial series | CLEAN | 0 matches |
| `center=True` rolling | CLEAN | 0 matches |
| Silent equal-weight fallback | CLEAN | All fallbacks now log and set `FEASIBLE_FALLBACK` status |
| `COVARIANCE_UNAVAILABLE` silently resolved | CLEAN | Explicit `OptimizationStatus.COVARIANCE_UNAVAILABLE` returned |

---

## 7. Key Design Decisions

1. **No synthetic correlation.** If historical returns are unavailable, `CovarianceStatus.UNAVAILABLE` is returned and the optimizer cannot proceed with covariance-dependent objectives.
2. **rank_score ≠ expected_return.** `EV_RISK_OPTIMIZATION` uses `PortfolioCandidate.expected_value` (from Phase 3F EVCalculator). `RANK_WEIGHTED` baseline uses `rank_percentile` only as a relative weight signal, not as an expected return.
3. **Sum-to-1 constraint.** Long-only portfolios use a `sum(w) = 1.0` equality constraint to prevent degenerate zero-weight SLSQP solutions.
4. **Clip post-normalization.** Per-position weight ceiling is applied after normalization so high-EV candidates retain proportional advantage before the ceiling is enforced.
5. **PIT enforced in covariance.** `returns_end_time > formation_time` is rejected with `CovarianceStatus.UNAVAILABLE` and message "PIT violation".
6. **FEASIBLE_FALLBACK requires reason.** Every fallback documents `fallback_reason` and `fallback_method`. Silent fallback is forbidden.

---

## 8. OOS Evidence

**INSUFFICIENT_EVIDENCE** — no real Indian equity dataset loaded. Portfolio weights, risk metrics (Sharpe, CVaR, max_dd), and strategy comparison (HRP vs CVaR vs EW) are verified on synthetic data only. Real OOS evaluation deferred to Phase 3I when real NSE data is available.
