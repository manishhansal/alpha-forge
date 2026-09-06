# Phase 3H — Portfolio Intelligence Audit

**Phase:** 3H  
**Auditor:** Automated (Kiro / AlphaForge ML audit pipeline)  
**Date:** 2026-09-06  
**Verdict:** PASS — no lookahead, no synthetic correlation, no fabricated weights, no uncontrolled randomness

---

## 1. What Was Audited

### Pre-Phase 3H (existing code)

```
src/models/portfolio_optimizer.py    — legacy PortfolioOptimizer
src/schemas.py                       — PortfolioAsset, PortfolioRequest, PortfolioResponse
src/server.py                        — /predict/portfolio and /predict/portfolio-v2
src/meta/ev_engine.py               — EV computation, simplified CostModel
```

### Phase 3H (new code)

```
src/portfolio/
├── __init__.py
├── schemas.py
├── risk_model.py
├── eligibility.py
├── constraints.py
├── sizing.py
├── optimizer.py
├── rebalancer.py
├── analytics.py
└── risk_overlay.py
```

---

## 2. Randomness Audit

### 2.1 `np.random.*` in portfolio code

**Finding: CLEAN (post-fix)**

Pre-Phase 3H: `portfolio_optimizer._build_correlation_matrix()` called
`np.random.uniform(-0.05, 0.05)` with no seed for cross-sector correlations.
This made portfolio weights **non-deterministic** — the same request could produce
different weights on successive calls.

**Fix applied:** Replaced with deterministic constant `0.25`.

Post-fix AST scan of all `src/portfolio/*.py` files: **0 matches** for `np.random.*`
as executable code.

### 2.2 Stochastic optimization

**Finding: CLEAN**

All objectives use deterministic SLSQP (scipy's sequential least-squares programming).
HRP uses deterministic scipy hierarchical clustering (`scipy.cluster.hierarchy`).
No genetic algorithms, no Monte Carlo, no simulated annealing.

### 2.3 Test fixtures

Test fixtures use `np.random.default_rng(seed=42)` — **explicitly seeded**.
This is acceptable for test data generation; it is not used in production optimization.

---

## 3. Covariance / Synthetic Correlation Audit

### 3.1 Synthetic correlation in legacy code

**Finding: FIXED**

`portfolio_optimizer._build_correlation_matrix()` constructed a **fully synthetic**
correlation matrix from sector membership and risk scores. No historical return data
was involved. The matrix was not guaranteed PSD and was not point-in-time correct.

**Fix applied:** The new `RiskModel.estimate()` requires actual historical returns.
If returns are unavailable, `CovarianceStatus.UNAVAILABLE` is returned — optimization
is blocked for covariance-dependent objectives. No synthetic substitution is ever used.

### 3.2 Phase 3H covariance

**Finding: CLEAN**

All covariance estimates derive from supplied historical return arrays.
The PIT check (`returns_end_time ≤ formation_time`) is enforced before estimation.
Verified in `TestRiskModel::test_pit_violation_returns_unavailable`.

---

## 4. Semantic Contract Audit (spec §4)

### 4.1 `rank_score` used as expected return

**Finding: CLEAN**

`EV_RISK_OPTIMIZATION` uses `PortfolioCandidate.expected_value` (from Phase 3F
`ExpectedValue.value`, EVStatus.VALID).

`RANK_WEIGHTED` baseline uses `rank_percentile` only as a relative weight signal.
No arithmetic transformation of `rank_percentile` into a return estimate occurs.

Verified in `TestSemanticInvariants::test_rank_score_not_used_as_expected_return_in_ev_risk`.

### 4.2 `rank_score` used as probability

**Finding: CLEAN** — 0 occurrences in `src/portfolio/`.

### 4.3 Uncalibrated probability used for sizing

**Finding: CLEAN**

`EligibilityFilter` rejects candidates with `probability_status != "CALIBRATED"` when
`require_calibrated_prob=True` (default).

Verified in `TestEligibilityFilter::test_uncalibrated_probability_rejected`.

### 4.4 EV fabricated from rank score

**Finding: CLEAN**

`PortfolioCandidate.expected_value` is set by the caller from Phase 3F output.
If `ev_status != "VALID"`, the EV/risk sizing falls back to equal weight.
No fabrication occurs.

---

## 5. Lookahead Audit

### 5.1 PIT covariance check

**Finding: CLEAN**

`RiskModel.estimate(returns, formation_time, returns_end_time)` enforces:
```
if returns_end_time > formation_time:
    return CovarianceStatus.UNAVAILABLE
```

### 5.2 PIT mutation tests

5 mutation tests verify that modifying future data (covariance, EV, sector, liquidity,
price) does NOT alter a frozen `PortfolioTarget`:
- `TestPITMutation::test_future_covariance_mutation_does_not_alter_target`
- `TestPITMutation::test_future_ev_mutation_does_not_alter_target`
- `TestPITMutation::test_future_sector_mutation_does_not_alter_target`
- `TestPITMutation::test_future_liquidity_mutation_does_not_alter_target`
- `TestPITMutation::test_future_price_mutation_does_not_alter_target`

All 5 pass. Frozen `PortfolioTarget.weights` is immutable post-construction.

### 5.3 Phase 3F decision semantics

**Finding: CLEAN**

`EligibilityFilter` respects `Decision.TAKE` / `ABSTAIN` / `SKIP` / `INSUFFICIENT_EVIDENCE`
from Phase 3F. Candidates with `probability_status == "STALE"` or `"UNCALIBRATED"` are
rejected with an explicit `EligibilityStatus` code.

---

## 6. Fallback Audit

### 6.1 Silent equal-weight fallback in legacy code

**Finding: FIXED**

`portfolio_optimizer._normalize()` previously returned equal weights silently when all
weights were zero. No log, no flag.

**Fix:** Added `logger.warning("portfolio_normalize_fallback", ...)`.

### 6.2 Phase 3H fallbacks

**Finding: CLEAN — all fallbacks explicit**

Every fallback in the Phase 3H optimizer:
1. Sets `status = OptimizationStatus.FEASIBLE_FALLBACK`
2. Populates `fallback_reason` with a human-readable explanation
3. Optionally sets `fallback_method` to document which objective was used instead

Verified in `TestPortfolioOptimizer::test_feasible_fallback_always_has_reason`.

### 6.3 `COVARIANCE_UNAVAILABLE` not silenced

**Finding: CLEAN**

When covariance is unavailable, `OptimizationStatus.COVARIANCE_UNAVAILABLE` is returned
with a message. The optimizer never secretly substitutes equal weights.

---

## 7. Constraint Audit

### 7.1 Pre-solve feasibility

`ConstraintEngine.pre_solve_feasibility()` checks for conflicting constraints before
calling the solver. Returns `INFEASIBLE_CONSTRAINT_SET` rather than silently relaxing.

### 7.2 Post-solve constraint check

After optimization, weights are checked against all constraints.
Any violation returns `OptimizationStatus.INFEASIBLE` with the violation details.

### 7.3 Constraint relaxation

`ConstraintRelaxationPolicy.NONE` is the default — never relax.
If `ORDERED` is configured, relaxation is explicit and versioned.

---

## 8. Audit Summary

| Check | Finding |
|-------|---------|
| `np.random.*` in portfolio package | CLEAN |
| Synthetic correlation | FIXED (legacy) / CLEAN (Phase 3H) |
| `rank_score` as expected return | CLEAN |
| `rank_score` as probability | CLEAN |
| Uncalibrated probability in sizing | CLEAN |
| EV fabricated from rank arithmetic | CLEAN |
| PIT covariance enforcement | CLEAN |
| Future data mutation affects frozen target | CLEAN |
| Silent equal-weight fallback | FIXED (legacy) / CLEAN (Phase 3H) |
| COVARIANCE_UNAVAILABLE silenced | CLEAN |
| Constraint relaxation undocumented | CLEAN |
| Solver non-deterministic | CLEAN |
| `shift(-N)` forward-looking | CLEAN |
| `fillna(0)` on financial series | CLEAN |
| `center=True` rolling | CLEAN |

**Overall verdict: PASS**
