# AlphaForge ML Service — Execution Audit

**Audit Date:** 2026-09-06  
**Scope:** `models/rl_executor.py`, `schemas.py` (ExecutionAction, ExecutionState, ExecutionDecision)

---

## 1. Component Overview

The `RLExecutor` is a PPO-based reinforcement learning agent designed for **execution timing optimisation**, not stock selection. This is an architecturally correct design: the signal layer (regime, ranker, strategy) decides *what* to trade; the RL layer decides *when and how* to execute.

---

## 2. Action Space

7 discrete actions:

| Action | Purpose |
|---|---|
| WAIT (0) | Hold / do nothing |
| ENTER_NOW (1) | Enter immediately at market |
| SCALE_IN (2) | Add to existing position |
| PARTIAL_EXIT (3) | Exit 30% of position |
| FULL_EXIT (4) | Exit entire position |
| TIGHTEN_STOP (5) | Move stop closer to price |
| TRAIL_STOP (6) | Trail stop to lock in profits |

This action set covers the core execution lifecycle. The absence of LIMIT_ORDER action is a gap — NSE-level execution typically uses a mix of market and limit orders.

---

## 3. State Space

14-dimensional state:
```python
STATE_DIM = 14
```

From `ExecutionState` schema:
- `symbol`, `direction`, `entry`, `current_price`
- `stop_loss`, `target`
- `unrealized_pnl_pct`
- `time_in_trade_minutes`
- `regime`, `volume_ratio`, `price_vs_vwap`, `atr`, `momentum`

The state is a sensible representation of trade execution context. Key missing elements:
- **Bid-ask spread / market depth**: critical for execution quality in mid-cap F&O
- **Time of day relative to expiry**: gamma/theta dynamics change execution urgency near expiry
- **Order book imbalance**: available from Level-2 data but not in the state

---

## 4. Reward Function

From code comments:
```
Reward = risk-adjusted P&L
Penalties:
  - Holding too long (time decay)
  - Excessive drawdown
  - Missing exit signals
  - Over-trading (action frequency penalty)
```

**Assessment of reward design:**

**Strengths:**
- Action frequency penalty prevents degenerate "always churn" solutions
- Time decay penalty forces timely exits
- Drawdown penalty is aligned with risk management goals

**Weaknesses:**
- "Risk-adjusted P&L" is not precisely defined in the visible code. If it is Sharpe-ratio-based, it requires sufficient episode length to estimate variance.
- No explicit cost model in the reward: if each ENTER/EXIT action does not subtract realistic transaction costs (STT, brokerage, slippage), the agent will over-trade.
- Partial exit (30%) is hardcoded. A more flexible action space would allow variable exit fractions.

---

## 5. PPO Hyperparameters

```python
PPO_PARAMS = {
    "learning_rate": 3e-4,
    "n_steps": 2048,
    "batch_size": 64,
    "n_epochs": 10,
    "gamma": 0.99,
    "gae_lambda": 0.95,
    "clip_range": 0.2,
    "ent_coef": 0.01,
    "vf_coef": 0.5,
    "max_grad_norm": 0.5,
    "verbose": 0,
}
```

These are the Stable-Baselines3 default PPO parameters. They are a reasonable starting point but have not been tuned for the execution environment. Notably:
- `gamma = 0.99` implies the agent values rewards ~100 steps ahead as much as immediate rewards — appropriate for trades held minutes to hours, not for intraday scalping where `gamma` closer to 0.95 is more appropriate.
- `ent_coef = 0.01` — a small entropy bonus to encourage exploration. This is conservative.

---

## 6. Training Environment

`_build_env_class()` dynamically imports gymnasium to avoid import errors in tests. The environment class is built at runtime.

**Critical gap: The training environment is not audited.** The `_build_env_class()` function is loaded conditionally, and the environment implementation was not fully visible in the codebase review. Key questions:

1. **Is the environment seeded deterministically?** For reproducibility, the gym environment must use a fixed seed per training run.
2. **Are historical episodes used?** If the environment generates synthetic random price paths rather than replaying historical NSE data, the agent will not learn the specific dynamics of Indian F&O markets (expiry effects, circuit breakers, opening auction gaps).
3. **Is slippage modelled?** For mid-cap F&O, market order slippage of 0.1-0.3% significantly impacts execution quality.
4. **Is the 14-dimensional state correctly normalised?** RL agents are sensitive to feature scale; unnormalised states (e.g., raw price vs normalised ATR) will produce poor learning.

---

## 7. Training Script

`train_rl_executor()` in `train_all.py`:
```python
def train_rl_executor(artifacts_path, total_timesteps=500_000, quick=False):
    model = RLExecutor()
    metrics = model.train(
        total_timesteps=total_timesteps,
        save_path=save_path,
    )
```

- 500,000 timesteps with 5-minute bars = ~3,300 trading sessions of 150 bars each. This is a reasonable episode count.
- No evaluation callback during training (no hold-out episode set for monitoring convergence).
- No model checkpoint during training — only the final model is saved.
- Errors are caught silently:
  ```python
  except Exception as e:
      logger.warning("rl_training_failed", error=str(e))
      return {"model": "rl_executor", "metrics": {}, "error": str(e)}
  ```

---

## 8. Inference Path

The RL executor is called at inference time via the `/predict/execute` endpoint. The `ExecutionDecision` schema includes:
- `action` (ExecutionAction enum)
- `confidence` in [0,1]
- `new_stop_loss` (optional)
- `exit_pct` (optional — % of position to exit)
- `rationale` (string)

**Gap:** The RL agent's `predict()` method (from Stable-Baselines3) returns an action index, not a probability distribution. Confidence is likely derived from the policy's action probability, but this is not surfaced in the schema or clearly computed.

---

## 9. Separation of Concerns

The RL executor is correctly scoped to execution decisions, not signal generation. This is an important design choice:

```
Signal layer → MetaDecisionEngine.decide() → BUY/SELL/WAIT/NO_TRADE
Execution layer → RLExecutor.decide() → ENTER_NOW/SCALE_IN/PARTIAL_EXIT/...
```

The RL agent does not know whether to go long or short — it optimises timing and position management given that a signal has already been generated. This separation keeps the RL problem tractable.

---

## 10. Assessment

| Aspect | Status | Notes |
|---|---|---|
| Action space | ✅ Appropriate | 7 actions cover execution lifecycle |
| State space | ⚠️ Incomplete | Missing spread, order book, expiry proximity |
| Reward design | ⚠️ Partially defined | Cost model not confirmed in reward |
| PPO hyperparameters | ⚠️ Default | Not tuned for NSE execution environment |
| Training environment | ❌ Not audited | Historical data usage not confirmed |
| Training determinism | ❌ Unknown | Environment seeding not confirmed |
| OOS evaluation | ❌ Missing | No hold-out episode evaluation |
| Production deployment | ❌ Not ready | Environment not validated |

---

## 11. Recommendations

| Priority | Action |
|---|---|
| 🔴 HIGH | Validate that the training environment replays historical NSE price data, not synthetic random walks |
| 🔴 HIGH | Add explicit transaction cost model to the RL reward function |
| 🔴 HIGH | Add hold-out episode evaluation during training to detect overfitting |
| 🟡 MEDIUM | Add bid-ask spread and time-to-expiry to the state space |
| 🟡 MEDIUM | Tune `gamma` based on expected trade duration (0.95 for intraday scalping) |
| 🟡 MEDIUM | Add LIMIT_ORDER action with target price as a continuous parameter |
| 🟡 MEDIUM | Add deterministic seeding for reproducibility |
| 🟢 LOW | Add model checkpoint callbacks during training |
| 🟢 LOW | Surface policy entropy / action probability as confidence score |
