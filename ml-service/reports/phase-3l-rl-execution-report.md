# Phase 3L — RL Execution Report

**Generated:** 2026-09-06  
**Branch:** `refactor/improve-ml-service`  
**Verdict:** NO_INCREMENTAL_EXECUTION_ALPHA — INSUFFICIENT_EVIDENCE (no real dataset; OPE unreliable on synthetic)

---

## 1. Research Question

Can reinforcement learning improve execution quality, trade management, and
risk-adjusted net outcomes beyond deterministic AlphaForge baselines under a
realistic, causal, cost-aware simulator — WITHOUT degrading risk, capacity,
stability, or execution safety?

RL operates DOWNSTREAM of the existing alpha/ranker/meta/EV/portfolio stack
(spec §1, §3). It never learns alpha from scratch; it optimises WHEN/HOW/HOW-MUCH
to execute and how to manage an open position.

---

## 2. What Was Built (`src/rl/`)

Framework-agnostic, deterministic, pure-NumPy RL research layer (torch/SB3/
gymnasium unavailable in this environment; see
`reports/phase-3l-current-rl-audit.md` §3.1). Every RL agent enters Phase 3J as a
CHALLENGER and is never auto-promoted.

| Module | Purpose |
|--------|---------|
| `schemas.py` | versioned contracts (env/reward/simulator), provenance, reward ledger, experiment record |
| `registry.py` | RL experiment registry + immutable trajectory registry + Phase 3J challenger wiring |
| `environment.py` | causal, deterministic, replayable, versioned execution environment |
| `actions.py` | action space + deterministic safety layer + action masking |
| `reward.py` | net-of-cost reward via Phase 3G cost model |
| `simulator_bridge.py` | reuse of the Phase 3G `BacktestEngine` (no second simulator) |
| `baselines.py` | TWAP / VWAP / participation / passive / aggressive + ORACLE_ONLY |
| `offline.py` | trajectory generation, OOD protection, behavior cloning |
| `agent.py` | pure-NumPy tabular / linear Fitted-Q; walk-forward; multi-seed |
| `ope.py` | off-policy evaluation (IS/WIS/DR/FQE) with uncertainty |
| `evaluation.py` | execution/risk/capacity metrics, robustness, failure modes |
| `classification.py` | RL model-value classification + action audit + fallback |

---

## 3. Environment

Causal (observation at `t` uses only data ≤ `t`; only `next_state`/`reward` use
the following bar), deterministic under a fixed seed, replayable, and versioned
(`EnvironmentVersion`). Two tracks: EXECUTION_OPTIMIZATION and TRADE_MANAGEMENT
(not combined). Termination on target-filled / deadline / market-close /
end-of-data. A deterministic `state_hash` reproduces what the agent saw.

---

## 4. Reward

Net-of-cost via Phase 3G: `gross_pnl − transaction_cost − slippage − impact`
minus configurable risk/turnover/inventory penalties. Reward is NEVER raw price
change (spec §17). Reward weights are versioned hyperparameters, never tuned on
OOS (spec §37). Every episode's `RewardComponents` ledger reconciles.

---

## 5. Agent & Training

Pure-NumPy deterministic offline Fitted-Q (tabular or linear), a DQN-equivalent
for the small discrete action space. Trained OFFLINE on fixed trajectories.
Walk-forward train/val/OOS with embargo. HPO on train/val only
(`touched_oos=False`). Multi-seed robustness reports mean/median/std/worst/best.

---

## 6. RL Results (synthetic verification only)

No real Indian equity/F&O execution dataset is loaded, so there are **no
production RL results**. On deterministic synthetic trajectories the framework
runs end-to-end, but off-policy evaluation returns
**OPE_INSUFFICIENT_EVIDENCE** (effective sample size ≈ 1, importance weights
concentrated) — the honest signal that the learned greedy policy cannot be
credibly valued from the available behavior data.

The deterministic baselines (TWAP / VWAP / participation / passive / aggressive)
run through the identical Phase 3G simulator and produce well-defined net-of-cost
outcomes; RL has NOT demonstrated a credible improvement over them.

---

## 7. Verdict

**NO_INCREMENTAL_EXECUTION_ALPHA / INSUFFICIENT_EVIDENCE.** Per spec §80 and §91
this is a successful research conclusion: RL has not shown credible incremental
execution value, and the evidence (no real data + unreliable OPE) does not
support any promotion. The framework, safety layer, and governance are complete
and verified; they simply refuse to manufacture an RL execution edge.

---

## 8. Tests

Phase 3L: 38 passed / 0 failed. Full Phase-3 suite (3A–3L): 858 passed / 0
failed / 19 skipped. Static audit CLEAN.
