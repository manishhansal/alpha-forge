# AlphaForge — Signal Robustness Matrix

**Generated:** 2026-09-02  
**Engine Version:** opportunity-engine-v1

---

## Overview

Every strategy must pass the robustness matrix before promotion beyond RESEARCH status.
The matrix tests performance stability across 9 dimensions.

**Legend:**
- ✅ Pass: Strategy survives with acceptable degradation
- ⚠️ Partial: Strategy degrades but remains positive
- ❌ Fail: Strategy becomes unprofitable
- 🔶 Untested: Insufficient OOS data
- 📋 Framework: Test infrastructure in place, not yet run

---

## Robustness Tests Implemented

### Test 1: Regime Robustness

Does the strategy work across multiple market regimes?

| Strategy | Bull | Bear | Range | High Vol | Panic |
|----------|------|------|-------|----------|-------|
| RANGE_EXPANSION | 1.4× | 1.3× | 0.5× | 0.7× | 0.4× |
| VOLUME_BREAKOUT | 1.5× | 1.4× | 0.4× | 0.6× | 0.3× |
| OPENING_BREAKOUT | 1.5× | 1.4× | 0.6× | 0.8× | 0.5× |
| MOMENTUM | 1.6× | 1.5× | 0.3× | 0.5× | 0.4× |
| OI_BUILDUP | 1.4× | 1.4× | 0.8× | 0.7× | 0.5× |
| PCR_EXTREME | 0.5× | 0.5× | 1.5× | 1.3× | 0.6× |
| IV_SPIKE | 0.6× | 0.7× | 1.2× | 1.6× | 1.4× |
| INDIA_AI_SIGNALS | 1.3× | 1.2× | 0.8× | 0.7× | 0.4× |

*Values are edge multipliers from the Strategy×Regime matrix (1.0 = neutral)*

**Status:** Framework complete. Values are theoretical priors. OOS validation pending.

### Test 2: Cost Robustness

Does the strategy remain profitable under cost stress?

| Strategy | 1× Costs | 1.5× Costs | 2× Costs (FRAGILE gate) | 3× Costs |
|----------|----------|------------|------------------------|---------|
| All strategies | Framework ✅ | Framework ✅ | Framework ✅ | Framework ✅ |

**Implementation:** `computeFullEV()` in `expected-value-engine.ts` computes `evAtCostMultiplier1_5`, `evAtCostMultiplier2`, `evAtCostMultiplier3` for every opportunity. `costRobust` flag is set when profitable at 2× costs.

**COST_FRAGILE flag:** Any opportunity with `netEV < 0` at 2× costs receives this flag and the quality score is penalized.

### Test 3: Slippage Robustness

Does the strategy survive realistic slippage scenarios?

| Scenario | Additional Slippage | Tested |
|----------|--------------------|----|
| Baseline | 0bps | ✅ |
| +25% | ~1bps | ✅ |
| +50% | ~2bps | ✅ |
| +100% | ~3bps | ✅ |
| 100ms latency | ~0.1bps | ✅ |
| 500ms latency | ~0.5bps | ✅ |
| 2s latency | ~2bps | ✅ |
| 5s latency | ~5bps | ✅ |

**Implementation:** `testSlippageSensitivity()` in `expected-value-engine.ts`.

### Test 4: Sample Robustness

Are metrics reliable given the sample size?

| Metric | Min Sample for Reliability | Implementation |
|--------|--------------------------|----------------|
| Win rate (95% CI) | 30 | ✅ Wilson interval in `probability-calibration.ts` |
| Expectancy | 50 | ✅ Bayesian shrinkage |
| Sharpe ratio | 100 | 🔶 Framework in research platform |
| Regime performance | 20/regime | ✅ In `strategy-condition-profiler.ts` |
| Conditional profiles | 20/condition | ✅ In `strategy-condition-profiler.ts` |

### Test 5: Parameter Robustness

Does performance degrade sharply when parameters change by ±10–20%?

| Analysis | Status |
|----------|--------|
| Parameter neighborhood analysis | 🔶 Framework in `lib/research/parameters/` |
| OVERFIT_SUSPECTED flag | 🔶 Framework defined |
| Knife-edge peak detection | 🔶 Framework defined |

**Requires:** Backtesting grid search with varying parameter values. Not run in current paper-trading mode.

### Test 6: Walk-Forward Robustness

Does performance generalize from training to validation to test?

| Component | Status |
|-----------|--------|
| IS/OOS split governance | 🔶 Framework in `lib/research/splits/` |
| 15 leakage tests | 🔶 Framework implemented, not run |
| Purged K-Fold | 🔶 Framework defined |
| CPCV | 🔶 Framework defined |
| Embargo | 🔶 Framework defined |

**Status:** No strategy has been walk-forward validated. All are at RESEARCH status.

### Test 7: Signal Flip Test

Does inverting BUY↔SELL produce materially worse performance?

| Status | Notes |
|--------|-------|
| 📋 Framework not yet implemented | Required before PAPER promotion |

**Expected:** Inverted strategy should NOT exhibit similar performance to the original. If it does, the signal is likely random.

### Test 8: Feature Permutation Test

Does randomizing feature groups degrade performance?

| Status | Notes |
|--------|-------|
| 📋 Ablation framework in `lib/research/ablation/` | Individual component ablation defined |
| 🔶 Not run against live paper trade outcomes | Requires sufficient resolved trade data |

### Test 9: Entry Delay Test

Does performance degrade if entries are delayed?

| Delay | Expected Degradation | Status |
|-------|---------------------|--------|
| 0ms (ideal) | Baseline | ✅ Modeled |
| 100ms | Minimal | ✅ Modeled |
| 250ms | Small | ✅ Modeled |
| 500ms | Moderate | ✅ Modeled |
| 1000ms | Significant for ORB | ✅ Modeled |

---

## Required Pre-Promotion Gates

Before any strategy advances from RESEARCH → PAPER:

| Gate | Threshold | Source |
|------|-----------|--------|
| Min trade count | ≥ 30 OOS trades | `lib/research/promotion/` |
| OOS expectancy | > 0% | Required |
| Cost robustness | Profitable at 2× | COST_FRAGILE flag |
| Regime coverage | ≥ 3 distinct regimes | Validation sessions |
| Calibration (ECE) | < 0.25 | Brier-score gate |
| Paper evidence | ≥ 10 sessions | Validation sessions |
| Parameter stability | No knife-edge | Not OVERFIT_SUSPECTED |
| Walk-forward | Positive OOS | Not yet run |

**Current status of all strategies:** RESEARCH — no strategy has met all promotion gates.

---

## Champion / Challenger Status

| Strategy | Champion Config | Challenger | Status |
|----------|----------------|-----------|--------|
| INDIA_AI_SIGNALS | v2.0.0 (SHADOW) | None | CHAMPION_ONLY |
| All others | RESEARCH | None | CHAMPION_ONLY |

The Champion/Challenger framework is implemented in `strategy-condition-profiler.ts` and ready for use once strategies accumulate OOS data.
