# Phase 3L — Reinforcement Learning (Audit Reference)

Audit-grade reference for the controlled RL execution / trade-management research
layer (`ml-service/src/rl/`).

---

## 1. Purpose & Non-Goals

**Purpose:** determine whether RL can improve execution quality, trade
management, and risk-adjusted net outcomes beyond deterministic baselines under a
realistic, causal, cost-aware simulator.

**Non-goals / hard rules:** RL does NOT replace alpha/ranker/meta/calibration/EV/
portfolio/execution/risk (spec §1). RL is DOWNSTREAM of the trading thesis and
never learns alpha from scratch (spec §3). No live broker, no real orders, no
auto-promotion, no auto-retraining, no autonomous live trading (spec §92).

## 2. Framework Decision

Pure-NumPy, deterministic backend. torch / stable-baselines3 / gymnasium are not
importable in this environment (Python 3.14); the small discrete action spaces
(WAIT/PASSIVE/NORMAL/AGGRESSIVE/FULL; HOLD/REDUCE_25/REDUCE_50/EXIT) suit tabular
/ linear Fitted-Q, which is fully reproducible. A gymnasium-compatible façade sits
behind a capability check. See `reports/phase-3l-current-rl-audit.md` §3.1.

## 3. Package Layout

```
src/rl/
├── schemas.py          versioned env/reward/simulator contracts, provenance, records
├── registry.py         RL experiment registry + immutable trajectory registry + 3J wiring
├── environment.py      causal, deterministic, replayable, versioned env
├── actions.py          action space + deterministic safety layer + masking
├── reward.py           net-of-cost reward via Phase 3G
├── simulator_bridge.py reuse of Phase 3G BacktestEngine (no second simulator)
├── baselines.py        TWAP/VWAP/participation/passive/aggressive + ORACLE_ONLY
├── offline.py          trajectory generation, OOD protection, behavior cloning
├── agent.py            pure-NumPy tabular/linear Fitted-Q, walk-forward, multi-seed
├── ope.py              off-policy evaluation (IS/WIS/DR/FQE) + uncertainty
├── evaluation.py       execution/risk/capacity metrics, robustness, failure modes
└── classification.py   RL value classification + action audit + fallback
```

## 4. Reuse (no duplication)

Phase 3G `BacktestEngine` / `compute_trade_cost` / slippage / calendar (the ONLY
execution simulator); Phase 3J `ModelRegistry` / `ChallengerRegistry` /
`ModelIdentity` / `ModelProvenance`; `lifecycle._storage` atomic writes. The
pre-existing `src/models/rl_executor.py` (SB3 PPO with its own synthetic
simulator and raw-price reward) is documented as an ANTI-PATTERN and is NOT
reused or modified.

## 5. Causality & Safety

Observation at `t` uses only data ≤ `t`; only `next_state`/`reward` use the next
bar. RL → deterministic safety layer → executable action; never RL → broker.
Action masking removes invalid actions. Deterministic `state_hash` + replay.

## 6. Governance

Every RL agent is a Phase 3J CHALLENGER; never auto-promoted. Contaminated final
holdout blocks challenger registration. OPE_INSUFFICIENT_EVIDENCE blocks any
credible valuation.

## 7. Current State

No real dataset → verdict **NO_INCREMENTAL_EXECUTION_ALPHA / INSUFFICIENT_
EVIDENCE**; OPE unreliable on synthetic. Framework verified end-to-end.

## 8. Verification

Phase 3L: 38 tests passed. Full suite (3A–3L): 858 passed / 0 failed. Static
audit CLEAN (no global `np.random.*`, no `train_test_split`, no `shift(-)`, no
`center=True`, no `latest.pkl`/`current_model`, no broker/live-order symbols).
