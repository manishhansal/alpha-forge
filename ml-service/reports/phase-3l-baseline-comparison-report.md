# Phase 3L — Baseline Comparison Report

**Generated:** 2026-09-06  
**Branch:** `refactor/improve-ml-service`  
**Verdict:** deterministic baselines PRESERVED; RL shows NO credible improvement (INSUFFICIENT_EVIDENCE)

---

## 1. Fair-Comparison Apparatus (spec §41, §85)

RL and every deterministic baseline run through the SAME:

- market data (identical PIT bars)
- execution simulator (Phase 3G `BacktestEngine` via `SimulatorBridge`)
- cost model (`compute_trade_cost`, `india-fno-2023`)
- slippage / liquidity assumptions
- evaluation period

This is enforced by `SimulatorBridge`, which converts any policy's decisions
into `OOSDecisionRecord`s and reads realized net-of-cost economics from the same
ledger. `ExecutionSimulatorVersion` pins the exact simulator; changing the config
changes the version.

---

## 2. Deterministic Baselines (spec §25)

| Baseline | Behaviour |
|----------|-----------|
| NEXT_OPEN | execute the full target at the next bar |
| TWAP | equal, steady slices across the deadline |
| VWAP_PROXY | slice by causal (past) volume ratio vs trailing average |
| FIXED_PARTICIPATION | constant participation-rate action |
| PASSIVE | minimal participation |
| AGGRESSIVE | maximal participation |

All are pure functions of PIT information (`uses_future = False`), so no baseline
peeks at the future.

## 3. ORACLE_ONLY Upper Bound (spec §26, §64)

`oracle_best_execution` computes the theoretical best fill within the deadline
using FUTURE information. It is tagged `ORACLE_ONLY`, `uses_future = True`, and
carries an explicit WARNING. It is used ONLY to quantify available headroom and
is NEVER used for training or production.

---

## 4. Comparison Result

On synthetic trajectories the baselines produce distinct, well-defined
net-of-cost outcomes through the shared simulator. RL's learned greedy policy
could not be credibly valued against them: off-policy evaluation returned
**OPE_INSUFFICIENT_EVIDENCE** (ESS ≈ 1). Therefore RL is NOT shown to beat the
deterministic baselines.

**No real-dataset comparison exists** — there is no production claim that RL
beats or loses to any baseline.

---

## 5. Baseline Integrity (spec §85)

Verified by test: RL and the baselines share the exact same simulator/cost/
slippage/liquidity via `SimulatorBridge`; a zero-cost reward is provably higher
than the net-of-cost reward, confirming cost is genuinely charged and cannot be
quietly dropped to flatter RL.

---

## 6. Verdict

Deterministic baselines preserved and remain the reference. RL shows no credible
incremental improvement. **INSUFFICIENT_EVIDENCE** — a governed real dataset is
required for any production comparison.
