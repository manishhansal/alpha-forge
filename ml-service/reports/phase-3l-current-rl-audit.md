# Phase 3L — Current RL Audit

**Generated:** 2026-09-06  
**Branch:** `refactor/improve-ml-service`  
**Auditor scope:** `src/execution`, `src/portfolio`, `src/lifecycle`, `src/models`, `src/monitoring`, `tests`, `artifacts`, `reports`, `docs`, `configs`

---

## 1. Purpose

Determine what execution / RL infrastructure exists before writing Phase 3L, and
confirm what must be reused (Phase 3G simulator, Phase 3J governance) versus
built new.

---

## 2. Pre-existing RL Code — ANTI-PATTERN (do NOT reuse)

`src/models/rl_executor.py` exists (PPO via stable-baselines3) and `artifacts/rl_executor.zip`.
It **violates multiple Phase 3L rules** and MUST NOT be reused or extended by
this phase:

| Phase 3L rule | `rl_executor.py` violation |
|---------------|----------------------------|
| §5 "do NOT create a second execution simulator" | Has its OWN synthetic GBM simulator (`_generate_trajectory`) |
| §13 "use the existing Phase 3G simulator" | Never touches Phase 3G; no cost/slippage/fill/ledger |
| §17/§18 "reward net of cost" | `reward` is raw price change + hand-tuned bonuses; NO transaction cost |
| §11 "safety layer" | RL action → decision directly; no constraint layer |
| §12 "action masking" | No valid-action mask |
| §15 "no simulator cheating" | Simulator is synthetic, not the governed one |
| determinism | Uses `np.random.*` / `np.random.randint` (global RNG) |

It is imported by `server.py` for a rule-based fallback path; Phase 3L does NOT
modify it (out of scope, risk of breaking the running service). Phase 3L builds
a SEPARATE, governed RL layer in `src/rl/` that reuses Phase 3G and Phase 3J.

---

## 3. Environment Findings (framework)

Same as Phases 3I–3K:

| Component | Result |
|-----------|--------|
| Python | 3.14.6 |
| numpy / scipy / pandas | available (2.5.1 / 1.18.1 / 3.0.3) |
| **torch** | NOT importable in the interpreter |
| **stable-baselines3** | NOT importable |
| **gymnasium / gym** | NOT importable |
| Accelerator | CPU only |

### 3.1 Framework Decision

Phase 3L is implemented **framework-agnostic on a pure-NumPy, deterministic
backend**. The discrete, small action spaces the brief mandates (§10:
WAIT/PASSIVE/NORMAL/AGGRESSIVE/FULL; HOLD/REDUCE_25/REDUCE_50/EXIT) are ideal for
**tabular / linear-function-approximation Q-learning** (a DQN-equivalent, §24),
which is fully deterministic and reproducible. Offline RL, behavior cloning, and
off-policy evaluation are all implemented in pure NumPy. A gymnasium-compatible
interface is exposed behind a capability check so the same environment can later
run on gym/SB3 where a compatible environment exists.

Rationale: determinism (§6, §38, §56, §57), dependency-light robustness (torch/
SB3/gymnasium unavailable here), and scope fit — this is a research/governance
phase, not a live agent.

---

## 4. Reusable Infrastructure (verified imports clean — numpy only, no sklearn/torch)

### Phase 3G execution simulator — `src/execution/`
- `backtest_engine.BacktestEngine(config, calendar, cost_registry).run(decisions, price_data, fno_ban_dates, git_commit) -> BacktestResult`
- `BacktestConfig(backtest_id, execution_policy, ambiguity_policy, slippage_bps, max_participation_pct, initial_capital_inr, ..., execution_engine_version).config_hash`
- `OOSDecisionRecord` (the input unit an RL policy emits)
- `OHLCBar(timestamp, open, high, low, close, volume, adv_inr, atr_pct, ...)` — in `fill_engine.py`
- `BacktestResult.ledger.completed_trades: list[TradeRecord]`; `.total_net_pnl`, `.total_cost`, `.gross_turnover_inr`, `.pnl_reconciled()`
- `cost_model.compute_trade_cost(instrument_type, order_side, product_type, trade_date, price, quantity_lots, lot_size, ...) -> CostBreakdown` (`.total`)
- `slippage.{FixedBPSSlippage, SpreadProxySlippage, VolatilityParticipationSlippage, MarketImpactSlippage}.estimate(...) -> SlippageEstimate(.slippage_bps)`; `SlippageModelRegistry`
- `fill_engine.FillEngine / FillEngineConfig(max_participation_pct, ...)` — partial fills + participation limits
- `position_accounting.{Position, PortfolioState, TradeAccountingLedger, TurnoverStats}`
- `market_calendar.NSECalendar` (`is_within_session`, `is_trading_day`, `session_open/close_ist`, expiries)
- `schemas`: `OrderIntent, SimulatedFill, TradeRecord, ExecutionLedger, CostBreakdown, FillStatus, ExecutionPolicy, ProductType, InstrumentType, TradeSide, OrderSide, SlippageModel, SpreadDataStatus, ExecutionDataLevel, AmbiguityPolicy`

### Phase 3J lifecycle — `src/lifecycle/`
- `ChallengerRegistry(root, soak_config).register(challenger_id, model_full_key, scope, evidence_package_id)` + `start_shadow`/`log_shadow_output`/`start_paper`/`record_paper_trade`/`mark_promotion_eligible`/`reject`/`selection_bias_summary`
- `ModelIdentity` (frozen), `ModelProvenance` (has `execution_model_version`, `cost_model_version`, `slippage_model_version`, `market_calendar_version`, `library_versions` dict for env/reward versions), `compute_artifact_hash`
- `_storage`: `atomic_write_json`, `read_json`, `append_jsonl`, `read_jsonl`, `FileLock` (stdlib only)

Mapping RL → lifecycle identity (no dedicated fields exist): `agent_id → model_id`,
`algorithm → model_type`, `model_family = "rl_execution_agent"`;
`environment_version` / `reward_version` carried in `ModelProvenance` fields /
`library_versions` and mirrored in the Phase 3L `RLExperiment` record.

### Others
- No `ml-service/configs/` dir; cost schedules are code-defined (`DEFAULT_REGISTRY`).
- Liquidity/participation via `FillEngineConfig.max_participation_pct` + per-bar `OHLCBar.adv_inr`.

---

## 5. Conventions Phase 3L Must Honour

- Reuse Phase 3G — never a second simulator (§5, §13).
- Reward net-of-cost via `compute_trade_cost` / realized ledger (§17, §18).
- RL is DOWNSTREAM of alpha/portfolio; never learns alpha from scratch (§3).
- RL action → deterministic safety layer → executable action; never RL → broker (§11, §76).
- No future data in observations; only `next_state`/`reward` may use future (§15, §16).
- tz-aware UTC timestamps; lowercase OHLCV; `np.random.default_rng(seed)` only — no global `np.random.*`.
- Register as Phase 3J CHALLENGER; never auto-promote (§40, §75).

---

## 6. Plan (14 tasks)

Audit → `src/rl/` schemas + registries → causal env → action/safety/masking →
net-cost reward → 3G integration → deterministic baselines + ORACLE_ONLY →
offline RL + trajectories + OOD + BC → NumPy Q-learning + walk-forward + multi-seed →
OPE → metrics/robustness/failure-modes → classification + 3J challenger + replay/audit →
tests + full suite + static audit → reports + docs + CHANGES + commit.

**Expected honest verdict:** no real Indian equity/F&O execution dataset is
loaded → **NO_INCREMENTAL_EXECUTION_ALPHA / INSUFFICIENT_EVIDENCE**; framework
verified end-to-end on deterministic synthetic trajectories.
