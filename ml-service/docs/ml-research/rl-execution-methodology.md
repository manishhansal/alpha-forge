# RL Execution Methodology (Phase 3L)

How AlphaForge evaluates whether reinforcement learning earns a role in
execution and trade management.

---

## 1. Principle

The existing deterministic system is the source of the trading thesis and the
execution baseline. RL operates strictly downstream and must EMPIRICALLY prove
credible, stable, net-of-cost improvement over deterministic baselines under a
realistic, causal simulator. Absent that proof, `NO_INCREMENTAL_EXECUTION_ALPHA`
is a successful research conclusion.

## 2. Environment

Event-driven, causal, deterministic, replayable, versioned. The observation at
time `t` contains only PIT information (position, remaining target, time
remaining, price/vol/spread proxies) — never future price, volume, spread,
volatility, regime, or outcome. Only `next_state` and `reward` may use the
following bar.

## 3. Reward

Net of cost via the Phase 3G cost model:
`gross_pnl − transaction_cost − slippage − impact`, minus configurable
drawdown/volatility/inventory/turnover/risk penalties. Never raw price change.
Reward weights are versioned hyperparameters and are never tuned on the final
OOS. Every episode's component ledger reconciles.

## 4. Simulator Parity

RL and every baseline execute through the SAME Phase 3G `BacktestEngine` with
identical cost, slippage, and liquidity. There is no RL-specific "easier"
simulator. `ExecutionSimulatorVersion` pins the exact configuration.

## 5. Baselines First

Deterministic baselines (NEXT_OPEN, TWAP, VWAP proxy, fixed participation,
passive, aggressive) set the bar RL must beat. An ORACLE_ONLY upper bound (uses
future data, clearly labelled, never for training/production) quantifies the
theoretical headroom.

## 6. Discipline

Walk-forward train/val/OOS with embargo; a final holdout used at most once. HPO,
seeds, and reward weights are selected on train/validation only. Multiple seeds
are reported (mean/median/std/worst/best).

## 7. Fair Value: OPE

Offline RL is evaluated with off-policy estimators (IS/WIS/DR/FQE) plus
uncertainty (ESS, weight concentration, coverage, bootstrap CI). If the estimate
is unreliable, `OPE_INSUFFICIENT_EVIDENCE` is returned and no value is claimed.

## 8. Robustness & Failure Modes

A promising policy is stress-tested under modest perturbations (worse slippage/
spread/impact, lower liquidity, latency). Collapse under modest perturbation →
`SIMULATOR_DEPENDENT`. Failure-mode detectors flag policy collapse, always-WAIT/
always-AGGRESSIVE, excessive turnover, inventory accumulation, and reward
hacking.

## 9. Classification & Governance

Each policy is classified SUPERIOR / COMPLEMENTARY / REDUNDANT / UNSTABLE /
WORSE / SIMULATOR_DEPENDENT / INSUFFICIENT_EVIDENCE with documented multi-criteria
reasons. RL reaches production only through Phase 3J (challenger → shadow → paper
→ promotion gate) and is never auto-promoted or connected to a live broker.

## 10. Current Conclusion

No real execution dataset is loaded and OPE is unreliable on synthetic data, so
the honest verdict is **NO_INCREMENTAL_EXECUTION_ALPHA / INSUFFICIENT_EVIDENCE**.
The methodology and all apparatus are in place; they refuse to manufacture an RL
execution edge.
