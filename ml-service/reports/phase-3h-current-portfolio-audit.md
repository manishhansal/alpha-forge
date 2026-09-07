# Phase 3H — Current Portfolio Infrastructure Audit

**Date:** 2026-09-06  
**Branch:** `refactor/improve-ml-service`  
**Auditor:** Automated (pre-implementation audit)

---

## 1. Scope

All portfolio-related code in `ml-service/` was inspected before any Phase 3H changes.

Files audited:
- `src/models/portfolio_optimizer.py`
- `src/schemas.py` (PortfolioAsset, PortfolioRequest, PortfolioResponse)
- `src/server.py` (both portfolio endpoints)
- `src/meta/ev_engine.py` (EV computation and simplified CostModel)
- `src/meta/schemas.py` (MetaDecisionOutput, CalibratedProbability, ExpectedValue)
- `src/execution/schemas.py` (CostBreakdown, TradeRecord, ExecutionLedger)
- `src/execution/cost_model.py` (PIT versioned cost schedules)
- `src/execution/backtest_engine.py` (OOSDecisionRecord, BacktestResult)
- `src/execution/position_accounting.py` (PortfolioState, Position)
- `src/ranking/schemas.py` (CrossSectionalAlphaSignal)
- `src/data/instrument_master.py` (InstrumentMasterStore)
- `src/data/fno_eligibility.py` (FnOStateStore)
- `src/data/corporate_actions.py` (CorporateActionStore)
- `tests/test_portfolio_optimizer.py`
- `pyproject.toml`

---

## 2. Finding: `src/portfolio/` Does Not Exist

No `src/portfolio/` package exists. The portfolio intelligence layer is entirely absent.

What exists for portfolio construction is:
- `src/models/portfolio_optimizer.py` — a single-file optimizer with serious defects
- `src/schemas.py` — legacy API schemas (Pydantic)
- `src/server.py` — two API endpoints consuming the above
- `src/execution/position_accounting.py::PortfolioState` — backtest accounting ledger, NOT a portfolio construction module

**Phase 3H creates `src/portfolio/` from scratch.**

---

## 3. `src/models/portfolio_optimizer.py` — Full Defect Register

### 3.1 UNSAFE: `np.random.uniform` in Production Code

**Location:** `_build_correlation_matrix()`, line ~334

```python
# Cross-sector stocks — UNSAFE:
base_corr = 0.25 + np.random.uniform(-0.05, 0.05)
```

No seed. No version. Every call to `optimize()` produces different portfolio weights from
identical inputs. This violates the determinism requirement for quantitative research.

**Classification: UNSAFE — must be removed from the production path.**

### 3.2 UNSAFE: Silent Equal-Weight Fallback

**Location:** `_normalize()`, last clause

```python
if total <= 0:
    return np.ones(len(weights)) / len(weights)
```

Returns equal weights silently when the optimization degenerates. No log, no flag, no
status field. The caller receives a result that looks like an optimized portfolio but is
actually a fallback.

**Classification: UNSAFE — must be replaced with an explicit `FEASIBLE_FALLBACK` state.**

### 3.3 UNSAFE: Silent Method Fallback in Server

**Location:** `server.py`, `/predict/portfolio-v2` handler

```python
else:
    # Fallback to HRP for unsupported methods (max_diversification, factor)
    result = portfolio_optimizer.hrp_allocation(returns_df)
    method = "hrp"
```

`max_diversification` and `factor` methods silently return HRP weights labeled as `"hrp"`.
The response `method` field is overwritten. The caller cannot detect the fallback.

**Classification: UNSAFE — must return an explicit error or `FEASIBLE_FALLBACK`.**

### 3.4 APPROXIMATE: `rank_score` Misused as Expected Return Proxy

**Location:** `_scale_by_rank()`, `PortfolioAsset.rank_score`

`rank_score` is the 0–100 outperformance score from `StockRanker` — a cross-sectional
relative-attractiveness rank signal, NOT a probability and NOT an expected return.
Using it as a multiplicative weight scaling factor treats it as if it were proportional
to expected return, which is the semantic violation identified in Phase 3H spec §4 and §8.

The power exponent `1.5` and floor `0.5` are completely arbitrary and undocumented.

**Classification: APPROXIMATE — semantically wrong; must be replaced with EV-derived sizing.**

### 3.5 APPROXIMATE: `risk_score` as Variance Proxy

**Location:** `_hrp_allocate()`, `_estimate_portfolio_risk()`, `_scale_by_risk()`

`risk_score` is a 0–10 scalar from `RiskPredictor` (a model that predicts
`prob_stop_hit`, `prob_target_hit`, and `expected_drawdown`). It is not a realized
volatility estimate and cannot serve as a covariance matrix diagonal.

Using `risk_score / 10` as standard deviation produces a covariance matrix with no
historical validity.

**Classification: APPROXIMATE — must use realized return volatility when available.**

### 3.6 APPROXIMATE: In-Sample Risk Metrics

**Location:** `_compute_risk_metrics()`

The same `returns` DataFrame used to fit the optimizer is used to compute
`volatility`, `cvar`, `sharpe`, and `max_dd`. These are in-sample estimates.

**Classification: RESEARCH-GRADE — clearly documented limitation; acceptable for Phase 3H
with explicit labeling.**

### 3.7 DUPLICATED: `ev_engine.CostModel` vs `execution.cost_model`

`ev_engine.CostModel` is a simple dataclass with approximate cost components.
`execution.cost_model.IndiaFnOCostSchedule` is the canonical, versioned, PIT-correct
implementation. Both compute round-trip cost percentages but use different schemas.

**Classification: DUPLICATED — Phase 3H should use `execution.cost_model` as the
canonical source; `ev_engine.CostModel` is acceptable as a research-layer shorthand
but must not be the portfolio layer's cost reference.**

### 3.8 DEAD CODE: `risk_budget_pct`

`PortfolioRequest.risk_budget_pct` is declared in the API schema but never read by
`optimize()`. The portfolio risk budget is completely unimplemented in the legacy API.

**Classification: DEAD CODE — must be removed or implemented.**

### 3.9 VALID: New Riskfolio-Lib Methods

`hrp_allocation()` and `cvar_allocation()` use correct Riskfolio-Lib 6.x APIs:
- `rp.HCPortfolio` for HRP (correct; `model="HRP"`)
- `rp.Portfolio` with `method_cov="ledoit"` for CVaR

**Problem:** `riskfolio-lib` is NOT in `pyproject.toml`. It is only installed locally.
The production service would fail to import it.

**Classification: VALID algorithmically, but dependency not declared — Phase 3H must
decide: (a) add riskfolio-lib to requirements, or (b) implement HRP/CVaR natively.**

Decision: Phase 3H implements HRP and CVaR natively using `numpy`/`scipy`/`sklearn-covariance`
to avoid the undeclared dependency and the Python 3.14 incompatibility of `sklearn`'s
`joblib` dependency chain. `pypfopt==1.5.5` is already declared and will be used where
its internal scipy solver works.

---

## 4. Available Dependencies (Confirmed)

| Package | Available | Used for |
|---------|-----------|---------|
| `numpy==1.26.4` (declared); `2.5.1` installed | ✅ | Matrix operations |
| `scipy==1.14.1` (declared); installed without full sklearn chain | ✅ | `optimize.minimize`, `cluster.hierarchy`, `spatial.distance` |
| `pypfopt==1.5.5` (declared) | ⚠️ Declared but not usable without scipy deps | Fallback if scipy optimizer sufficient |
| `scikit-learn==1.5.2` (declared) | ❌ joblib chain broken on Python 3.14 | Use pure numpy Ledoit-Wolf instead |
| `riskfolio-lib` | ❌ Not declared | Implement HRP/CVaR natively |
| `cvxpy` | ❌ Not installed | Use `scipy.optimize.minimize` with SLSQP |

**Implementation strategy:** Pure `numpy` + `scipy.optimize` for all convex optimization.
This is sufficient for MIN_VARIANCE, MAX_SHARPE, MAX_DIVERSIFICATION, CVaR (historical
simulation), and RISK_BUDGETING via SLSQP. HRP via scipy hierarchical clustering.

---

## 5. Upstream Pipeline (What Already Works)

The pipeline upstream of portfolio construction is complete and correct:

```
StockRanker → CrossSectionalAlphaSignal (alpha_score, rank, percentile)
    ↓
MetaModel → RawProbabilityScore
    ↓
CalibratorArtifact → CalibratedProbability (value, status=CALIBRATED)
    ↓
EVCalculator → ExpectedValue (value, status=VALID, cost-adjusted)
    ↓
MetaDecisionOutput (decision=TAKE, primary_alpha_score, calibrated_probability,
                    expected_value, uncertainty, all provenance)
```

Phase 3H consumes `MetaDecisionOutput` objects filtered to `decision == Decision.TAKE`.

---

## 6. Semantic Contract Violations to Fix

| Violation | Location | Fix |
|-----------|----------|-----|
| `rank_score` used as expected return | `_scale_by_rank` | Use `MetaDecisionOutput.expected_value.value` |
| `risk_score` used as variance | `_hrp_allocate`, `_estimate_portfolio_risk` | Use realized return volatility |
| Random correlation matrix | `_build_correlation_matrix` | Use historical returns; COVARIANCE_UNAVAILABLE if data absent |
| Silent fallback to equal weights | `_normalize` | Return explicit `OptimizationStatus.FEASIBLE_FALLBACK` |
| `probability` not validated before use | No eligibility filter | Build `EligibilityFilter` using `Decision.TAKE` guard |
| No PIT check on covariance inputs | N/A | Enforce `returns_end_time <= portfolio_formation_time` |

---

## 7. Existing Tests for Portfolio (`tests/test_portfolio_optimizer.py`)

The test file requires `import riskfolio as rp` at module level — this causes all tests
to fail at collection time because `riskfolio-lib` is not installed.

**Coverage gaps (even ignoring the import failure):**
- No test for determinism (same input → same output)
- No test for the `np.random.uniform` non-determinism bug
- No test for silent equal-weight fallback
- No PIT mutation test
- No test for rank_score semantic misuse
- No test for long/short portfolios
- No test for EV-aware sizing
- No test for sector/industry/single-name constraints
- No test for F&O lot-size awareness

Phase 3H replaces `tests/test_portfolio_optimizer.py` with `tests/test_phase3h.py`
that covers all 63 acceptance criteria.

---

## 8. What Phase 3H Will Build

| Module | Path |
|--------|------|
| Schemas, enums, provenance | `src/portfolio/schemas.py` |
| Covariance, shrinkage, PSD validation | `src/portfolio/risk_model.py` |
| Candidate eligibility filter | `src/portfolio/eligibility.py` |
| Sector/industry/single-name/exposure constraints | `src/portfolio/constraints.py` |
| EV-aware sizing, Kelly, vol targeting, risk budgeting | `src/portfolio/sizing.py` |
| Optimizer (6 objectives + HRP + failure states) | `src/portfolio/optimizer.py` |
| Rebalancer, turnover, target→execution contract | `src/portfolio/rebalancer.py` |
| Attribution, concentration, stability, benchmark-relative | `src/portfolio/analytics.py` |
| Risk overlay (drawdown, vol spike, regime) | `src/portfolio/risk_overlay.py` |
| Package init | `src/portfolio/__init__.py` |

Legacy `src/models/portfolio_optimizer.py` is **modified** to:
1. Remove `np.random.uniform` from `_build_correlation_matrix`
2. Replace silent equal-weight fallback with explicit flag
3. Preserve public API (`optimize()`, `hrp_allocation()`, `cvar_allocation()`)

---

## 9. Data Gaps (INSUFFICIENT_EVIDENCE)

| Data | Status | Impact |
|------|--------|--------|
| Historical return series | NOT SUPPLIED via API | `COVARIANCE_UNAVAILABLE` unless caller provides returns |
| F&O ban dates | `DATA_UNAVAILABLE` in FnOStateStore | F&O ban eligibility = DATA_UNAVAILABLE |
| Corporate actions | `DATA_UNAVAILABLE` in CorporateActionStore | PIT price adjustment = DATA_UNAVAILABLE |
| Real tick-level spread | Not available | Slippage = PROXY |
| Factor loadings matrix | Not computed | Factor constraints = DATA_UNAVAILABLE |
| Benchmark returns (NIFTY) | Not in service | Benchmark-relative metrics = DATA_UNAVAILABLE |

All of these produce explicit `INSUFFICIENT_EVIDENCE` or `DATA_UNAVAILABLE` responses.
None are silently filled with invented data.

---

## 10. Audit Verdict

| Check | Result |
|-------|--------|
| `np.random.*` in portfolio construction | FOUND — 1 instance in `_build_correlation_matrix` |
| Silent fallbacks | FOUND — 2 instances (optimizer, server) |
| rank_score used as expected return | FOUND — `_scale_by_rank` |
| rank_score used as probability | NOT FOUND |
| Synthetic covariance without disclosure | FOUND — `_build_correlation_matrix` entire method |
| Forward-looking data in optimizer | NOT FOUND (no return series used at all) |
| No PIT check | FOUND — no formation-time validation anywhere |
| No EV-aware sizing | FOUND — EV field exists in MetaDecisionOutput but not wired to optimizer |
| No lot-size awareness | FOUND — optimizer works in weight space only |

**Overall pre-Phase-3H verdict: DEFICIENT — requires complete portfolio intelligence layer.**
