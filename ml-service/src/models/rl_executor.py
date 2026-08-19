"""
Reinforcement Learning Execution Layer (PPO via Stable-Baselines3).

This is NOT for stock selection — that's handled by the gradient boosting
models. RL optimizes EXECUTION:
  - When to enter (timing within the signal window)
  - When to scale in (add to a winning position)
  - When to exit (full or partial)
  - Position sizing adjustments
  - Trailing stop placement
  - Partial profit booking

Environment Design:
  - State: current trade metrics + market microstructure
  - Action: discrete execution decisions (7 actions)
  - Reward: risk-adjusted P&L with penalties for:
    * Holding too long (time decay)
    * Excessive drawdown
    * Missing exit signals
    * Over-trading (action frequency penalty)

The RL agent is trained on historical paper-trade data and live-forward
tested before deployment.
"""

from pathlib import Path
from typing import Any

import numpy as np
import structlog

from ..schemas import ExecutionAction, ExecutionDecision, ExecutionState, MarketRegime

logger = structlog.get_logger()

# ─── Gymnasium Environment ────────────────────────────────────────────────────

# State space dimensions
STATE_DIM = 14
# Action space: 7 discrete actions
N_ACTIONS = 7

# Action mapping
ACTION_MAP = [
    ExecutionAction.WAIT,           # 0: Hold / do nothing
    ExecutionAction.ENTER_NOW,      # 1: Enter immediately
    ExecutionAction.SCALE_IN,       # 2: Add to position
    ExecutionAction.PARTIAL_EXIT,   # 3: Exit 30% of position
    ExecutionAction.FULL_EXIT,      # 4: Exit entire position
    ExecutionAction.TIGHTEN_STOP,   # 5: Move stop closer
    ExecutionAction.TRAIL_STOP,     # 6: Trail stop to lock profits
]

# PPO hyperparameters (tuned for intraday trading)
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


def _build_env_class():
    """
    Dynamically build the Gymnasium environment class.
    This avoids import errors when gymnasium isn't installed (e.g. in tests).
    """
    try:
        import gymnasium as gym
        from gymnasium import spaces
    except ImportError:
        return None

    class TradingExecutionEnv(gym.Env):
        """
        Custom Gymnasium environment for trade execution optimization.

        State (14 features):
          0: unrealized_pnl_pct (current P&L %)
          1: time_in_trade_normalized (0-1, fraction of max hold time)
          2: distance_to_stop_pct (% from current price to stop)
          3: distance_to_target_pct (% from current price to target)
          4: momentum (short-term price momentum)
          5: volume_ratio (current vs average volume)
          6: price_vs_vwap (% distance from VWAP)
          7: atr_normalized (current ATR relative to entry ATR)
          8: regime_score (-1 to 1, market regime direction)
          9: max_drawdown_pct (worst adverse excursion so far)
          10: time_since_last_action (bars since last non-WAIT action)
          11: position_heat (how much of total risk budget is deployed)
          12: spread_normalized (bid-ask spread relative to ATR)
          13: session_progress (0-1, time through trading session)

        Action (discrete, 7 choices):
          See ACTION_MAP above.

        Reward:
          - Base: change in risk-adjusted P&L
          - Bonus: +0.1 for trailing stop that locks profit
          - Bonus: +0.2 for exiting at peak (within 10% of best exit)
          - Penalty: -0.05 per bar of excessive hold (> 80% max time)
          - Penalty: -0.3 for hitting stop after failing to trail
          - Penalty: -0.02 for each unnecessary action (over-trading)
        """

        metadata = {"render_modes": []}

        def __init__(self, max_steps: int = 375):
            super().__init__()

            self.max_steps = max_steps  # NSE session = 375 minutes
            self.observation_space = spaces.Box(
                low=-np.inf, high=np.inf, shape=(STATE_DIM,), dtype=np.float32
            )
            self.action_space = spaces.Discrete(N_ACTIONS)

            # Episode state
            self.step_count = 0
            self.position_open = False
            self.entry_price = 0.0
            self.current_price = 0.0
            self.stop_loss = 0.0
            self.target = 0.0
            self.direction = 1  # 1 = LONG, -1 = SHORT
            self.peak_pnl = 0.0
            self.max_drawdown = 0.0
            self.last_action_step = 0
            self.cumulative_reward = 0.0

            # Price trajectory (simulated or from replay buffer)
            self._price_trajectory: np.ndarray | None = None
            self._volume_trajectory: np.ndarray | None = None

        def reset(self, seed=None, options=None):
            super().reset(seed=seed)

            self.step_count = 0
            self.position_open = False
            self.peak_pnl = 0.0
            self.max_drawdown = 0.0
            self.last_action_step = 0
            self.cumulative_reward = 0.0

            # Generate or load a price trajectory for this episode
            if self._price_trajectory is None:
                self._generate_trajectory()

            self.entry_price = self._price_trajectory[0]
            self.current_price = self.entry_price
            self.stop_loss = self.entry_price * (1 - 0.015 * self.direction)
            self.target = self.entry_price * (1 + 0.03 * self.direction)
            self.direction = self.np_random.choice([1, -1])

            obs = self._get_observation()
            return obs, {}

        def step(self, action: int):
            self.step_count += 1
            prev_price = self.current_price

            # Advance price
            if self.step_count < len(self._price_trajectory):
                self.current_price = self._price_trajectory[self.step_count]
            else:
                # Random walk continuation
                self.current_price *= 1 + self.np_random.normal(0, 0.002)

            # Compute P&L
            pnl_pct = self.direction * (self.current_price - self.entry_price) / self.entry_price * 100

            # Track peaks
            self.peak_pnl = max(self.peak_pnl, pnl_pct)
            self.max_drawdown = min(self.max_drawdown, pnl_pct - self.peak_pnl)

            # Process action
            reward = self._process_action(action, pnl_pct)

            # Check termination conditions
            terminated = False
            truncated = False

            # Stop hit
            if self.direction == 1 and self.current_price <= self.stop_loss:
                terminated = True
                reward -= 0.3  # Penalty for not avoiding stop
            elif self.direction == -1 and self.current_price >= self.stop_loss:
                terminated = True
                reward -= 0.3

            # Target hit
            if self.direction == 1 and self.current_price >= self.target:
                terminated = True
                reward += 0.5  # Bonus for reaching target
            elif self.direction == -1 and self.current_price <= self.target:
                terminated = True
                reward += 0.5

            # Full exit action
            if action == 4:  # FULL_EXIT
                terminated = True
                reward += pnl_pct * 0.1  # Reward proportional to P&L at exit

            # Time limit
            if self.step_count >= self.max_steps:
                truncated = True
                # Penalty for holding to session end without clear exit
                if pnl_pct > 0:
                    reward += pnl_pct * 0.05
                else:
                    reward += pnl_pct * 0.1  # Bigger penalty for losers

            self.cumulative_reward += reward
            obs = self._get_observation()
            info = {"pnl_pct": pnl_pct, "step": self.step_count}

            return obs, reward, terminated, truncated, info

        def _process_action(self, action: int, pnl_pct: float) -> float:
            """Process action and return immediate reward component."""
            reward = 0.0

            # Time penalty for holding too long
            if self.step_count > self.max_steps * 0.8:
                reward -= 0.02

            # Over-trading penalty (actions too close together)
            if action != 0 and (self.step_count - self.last_action_step) < 5:
                reward -= 0.02
                return reward

            if action == 0:  # WAIT
                pass  # No reward or penalty for waiting

            elif action == 5:  # TIGHTEN_STOP
                # Move stop closer (reduce risk)
                old_stop = self.stop_loss
                if pnl_pct > 0:
                    # Tighten to breakeven + small buffer
                    self.stop_loss = self.entry_price * (1 + 0.002 * self.direction)
                    reward += 0.05  # Good risk management
                else:
                    reward -= 0.01  # Don't tighten on a losing trade

            elif action == 6:  # TRAIL_STOP
                # Trail stop to lock in profits
                if pnl_pct > 1.0:
                    # Move stop to lock 50% of peak profit
                    trail_level = self.entry_price * (1 + self.peak_pnl * 0.005 * self.direction)
                    if self.direction == 1:
                        self.stop_loss = max(self.stop_loss, trail_level)
                    else:
                        self.stop_loss = min(self.stop_loss, trail_level)
                    reward += 0.1  # Good trailing
                else:
                    reward -= 0.01  # Too early to trail

            elif action == 3:  # PARTIAL_EXIT
                # Reward partial exit when profitable
                if pnl_pct > 0.5:
                    reward += pnl_pct * 0.03
                else:
                    reward -= 0.05  # Don't partial-exit at a loss

            if action != 0:
                self.last_action_step = self.step_count

            return reward

        def _get_observation(self) -> np.ndarray:
            """Build the state observation vector."""
            pnl_pct = self.direction * (self.current_price - self.entry_price) / self.entry_price * 100

            stop_dist = abs(self.current_price - self.stop_loss) / self.current_price * 100
            target_dist = abs(self.target - self.current_price) / self.current_price * 100

            # Simplified momentum (price change over last 5 steps)
            momentum = 0.0
            if self._price_trajectory is not None and self.step_count >= 5:
                start = max(0, self.step_count - 5)
                momentum = (self.current_price - self._price_trajectory[start]) / self._price_trajectory[start] * 100

            # Volume ratio (simplified)
            vol_ratio = 1.0
            if self._volume_trajectory is not None and self.step_count < len(self._volume_trajectory):
                avg_vol = np.mean(self._volume_trajectory[:max(1, self.step_count)])
                vol_ratio = self._volume_trajectory[self.step_count] / max(avg_vol, 1)

            time_norm = self.step_count / self.max_steps
            time_since_action = (self.step_count - self.last_action_step) / self.max_steps

            obs = np.array([
                pnl_pct / 5.0,                    # 0: normalized P&L
                time_norm,                         # 1: time progress
                stop_dist / 3.0,                   # 2: stop distance (normalized)
                target_dist / 5.0,                 # 3: target distance (normalized)
                momentum / 2.0,                    # 4: momentum
                min(vol_ratio, 3.0) / 3.0,        # 5: volume ratio
                0.0,                               # 6: price vs VWAP (placeholder)
                1.0,                               # 7: ATR normalized (placeholder)
                0.0,                               # 8: regime score (placeholder)
                self.max_drawdown / 5.0,           # 9: max drawdown
                time_since_action,                 # 10: time since last action
                0.5,                               # 11: position heat (placeholder)
                0.0,                               # 12: spread (placeholder)
                time_norm,                         # 13: session progress
            ], dtype=np.float32)

            return obs

        def _generate_trajectory(self):
            """Generate a synthetic price trajectory for training."""
            n = self.max_steps + 50
            # Geometric Brownian Motion with mean-reversion
            drift = self.np_random.uniform(-0.0001, 0.0001)
            vol = self.np_random.uniform(0.001, 0.004)
            start_price = self.np_random.uniform(100, 5000)

            returns = self.np_random.normal(drift, vol, n)
            prices = start_price * np.exp(np.cumsum(returns))
            self._price_trajectory = prices

            # Synthetic volume (U-shaped intraday pattern)
            t = np.linspace(0, 1, n)
            base_vol = 1000 * (1.5 - 2 * (t - 0.5) ** 2)  # U-shape
            noise = self.np_random.uniform(0.7, 1.3, n)
            self._volume_trajectory = base_vol * noise

        def set_trajectory(self, prices: np.ndarray, volumes: np.ndarray | None = None):
            """Set a real price trajectory for replay-based training."""
            self._price_trajectory = prices
            self._volume_trajectory = volumes

    return TradingExecutionEnv


class RLExecutor:
    """
    PPO-based trade execution agent.

    Uses Stable-Baselines3 to train and run a PPO policy on the
    TradingExecutionEnv. Falls back to the rule-based policy in server.py
    when no trained agent is available.
    """

    def __init__(self, model_path: Path | None = None):
        self.model = None
        self.model_version = "executor-ppo-v1"
        self.env_class = _build_env_class()

        if model_path and model_path.exists():
            self._load_model(model_path)

    def _load_model(self, path: Path) -> None:
        """Load a trained PPO model."""
        try:
            from stable_baselines3 import PPO

            self.model = PPO.load(str(path))
            logger.info("rl_executor_loaded", path=str(path))
        except Exception as e:
            logger.warning("rl_executor_load_failed", error=str(e))
            self.model = None

    def decide(self, state: ExecutionState) -> ExecutionDecision:
        """
        Get execution decision from the RL agent.

        Falls back to rule-based policy when no trained model exists.
        """
        if self.model is not None:
            return self._decide_rl(state)
        return self._decide_rules(state)

    def _decide_rl(self, state: ExecutionState) -> ExecutionDecision:
        """RL-based decision using trained PPO agent."""
        obs = self._state_to_obs(state)
        action, _ = self.model.predict(obs, deterministic=True)
        action_idx = int(action)

        execution_action = ACTION_MAP[action_idx]
        confidence = 0.7  # RL doesn't provide natural confidence, use fixed

        # Compute new stop loss if trailing/tightening
        new_stop = None
        exit_pct = None

        if execution_action == ExecutionAction.TRAIL_STOP:
            # Trail to 50% of unrealized profit
            if state.direction == "LONG":
                new_stop = state.entry + (state.current_price - state.entry) * 0.5
            else:
                new_stop = state.entry - (state.entry - state.current_price) * 0.5
            new_stop = round(new_stop, 2)

        elif execution_action == ExecutionAction.TIGHTEN_STOP:
            # Move to breakeven
            new_stop = round(state.entry, 2)

        elif execution_action == ExecutionAction.PARTIAL_EXIT:
            exit_pct = 0.3

        rationale = self._build_rl_rationale(state, execution_action)

        return ExecutionDecision(
            action=execution_action,
            confidence=confidence,
            new_stop_loss=new_stop,
            exit_pct=exit_pct,
            rationale=rationale,
        )

    def _decide_rules(self, state: ExecutionState) -> ExecutionDecision:
        """Rule-based fallback (same as server.py implementation)."""
        pnl = state.unrealized_pnl_pct
        time_min = state.time_in_trade_minutes

        if pnl < -3.0:
            return ExecutionDecision(
                action=ExecutionAction.FULL_EXIT,
                confidence=0.9,
                rationale=f"Emergency exit — drawdown {pnl:.1f}% exceeds tolerance.",
            )

        session_remaining = 375 - time_min
        if session_remaining < 15 and pnl > 0:
            return ExecutionDecision(
                action=ExecutionAction.FULL_EXIT,
                confidence=0.8,
                exit_pct=1.0,
                rationale="Session ending — booking profits before close.",
            )

        if pnl > 2.0:
            if state.direction == "LONG":
                new_stop = state.entry + (state.current_price - state.entry) * 0.5
            else:
                new_stop = state.entry - (state.entry - state.current_price) * 0.5
            return ExecutionDecision(
                action=ExecutionAction.TRAIL_STOP,
                confidence=0.75,
                new_stop_loss=round(new_stop, 2),
                rationale=f"Trailing stop to lock in profits ({pnl:.1f}% unrealized).",
            )

        if pnl > 1.5 and time_min > 60:
            return ExecutionDecision(
                action=ExecutionAction.PARTIAL_EXIT,
                confidence=0.65,
                exit_pct=0.3,
                rationale="Partial profit booking — 30% at +1.5% after 1h hold.",
            )

        if pnl > 0 and state.momentum < -0.3:
            new_stop = round(
                state.stop_loss + (state.current_price - state.stop_loss) * 0.3, 2
            )
            return ExecutionDecision(
                action=ExecutionAction.TIGHTEN_STOP,
                confidence=0.6,
                new_stop_loss=new_stop,
                rationale="Momentum fading — tightening stop to protect gains.",
            )

        return ExecutionDecision(
            action=ExecutionAction.WAIT,
            confidence=0.5,
            rationale="Holding — no action trigger met.",
        )

    def _state_to_obs(self, state: ExecutionState) -> np.ndarray:
        """Convert ExecutionState to the observation vector."""
        pnl = state.unrealized_pnl_pct
        time_norm = min(state.time_in_trade_minutes / 375.0, 1.0)

        stop_dist = abs(state.current_price - state.stop_loss) / state.current_price * 100
        target_dist = abs(state.target - state.current_price) / state.current_price * 100

        regime_score = {
            MarketRegime.STRONG_BULL: 1.0,
            MarketRegime.BULL: 0.5,
            MarketRegime.SIDEWAYS: 0.0,
            MarketRegime.VOLATILE: -0.2,
            MarketRegime.BEAR: -0.6,
            MarketRegime.CRASH: -1.0,
        }.get(state.regime, 0.0)

        obs = np.array([
            pnl / 5.0,
            time_norm,
            stop_dist / 3.0,
            target_dist / 5.0,
            state.momentum / 2.0,
            min(state.volume_ratio, 3.0) / 3.0,
            state.price_vs_vwap / 2.0,
            state.atr / (state.entry * 0.02) if state.entry > 0 else 1.0,
            regime_score,
            0.0,  # max drawdown (not tracked in state)
            0.0,  # time since last action (not tracked)
            0.5,  # position heat
            0.0,  # spread
            time_norm,  # session progress
        ], dtype=np.float32)

        return obs

    def _build_rl_rationale(
        self, state: ExecutionState, action: ExecutionAction
    ) -> str:
        """Generate rationale for RL decision."""
        pnl = state.unrealized_pnl_pct
        time_min = state.time_in_trade_minutes

        base = f"RL agent recommends {action.value}"

        if action == ExecutionAction.WAIT:
            return f"{base} — trade within normal parameters (P&L {pnl:+.1f}%, {time_min}m held)."
        elif action == ExecutionAction.TRAIL_STOP:
            return f"{base} — locking in profits at {pnl:+.1f}% after {time_min}m."
        elif action == ExecutionAction.FULL_EXIT:
            return f"{base} — optimal exit point identified (P&L {pnl:+.1f}%)."
        elif action == ExecutionAction.PARTIAL_EXIT:
            return f"{base} — de-risking 30% at {pnl:+.1f}%."
        elif action == ExecutionAction.TIGHTEN_STOP:
            return f"{base} — reducing risk exposure."
        elif action == ExecutionAction.SCALE_IN:
            return f"{base} — momentum confirms, adding to position."
        elif action == ExecutionAction.ENTER_NOW:
            return f"{base} — entry conditions optimal."
        return base

    def train(
        self,
        total_timesteps: int = 500_000,
        price_trajectories: list[np.ndarray] | None = None,
        save_path: Path | None = None,
    ) -> dict[str, float]:
        """
        Train the PPO agent on the trading execution environment.

        Args:
            total_timesteps: Total training steps.
            price_trajectories: Optional list of real price arrays for replay.
            save_path: Where to save the trained model.

        Returns:
            Training metrics.
        """
        if self.env_class is None:
            raise RuntimeError("gymnasium not installed — cannot train RL agent")

        from stable_baselines3 import PPO
        from stable_baselines3.common.vec_env import DummyVecEnv

        # Create vectorized environment
        def make_env():
            env = self.env_class(max_steps=375)
            if price_trajectories:
                # Randomly select a trajectory for each episode
                idx = np.random.randint(len(price_trajectories))
                env.set_trajectory(price_trajectories[idx])
            return env

        vec_env = DummyVecEnv([make_env for _ in range(4)])  # 4 parallel envs

        # Train PPO
        model = PPO(
            "MlpPolicy",
            vec_env,
            **PPO_PARAMS,
            tensorboard_log=None,
        )

        model.learn(total_timesteps=total_timesteps)
        self.model = model

        # Evaluate
        metrics = self._evaluate(make_env, n_episodes=100)

        if save_path:
            save_path.parent.mkdir(parents=True, exist_ok=True)
            model.save(str(save_path))
            logger.info("rl_executor_saved", path=str(save_path))

        logger.info("rl_executor_trained", metrics=metrics)
        return metrics

    def _evaluate(self, env_fn, n_episodes: int = 100) -> dict[str, float]:
        """Evaluate the trained agent over N episodes."""
        if self.model is None:
            return {}

        total_rewards = []
        total_pnls = []
        win_count = 0

        for _ in range(n_episodes):
            env = env_fn()
            obs, _ = env.reset()
            done = False
            episode_reward = 0.0
            final_pnl = 0.0

            while not done:
                action, _ = self.model.predict(obs, deterministic=True)
                obs, reward, terminated, truncated, info = env.step(int(action))
                episode_reward += reward
                final_pnl = info.get("pnl_pct", 0.0)
                done = terminated or truncated

            total_rewards.append(episode_reward)
            total_pnls.append(final_pnl)
            if final_pnl > 0:
                win_count += 1

        return {
            "mean_reward": float(np.mean(total_rewards)),
            "mean_pnl_pct": float(np.mean(total_pnls)),
            "win_rate": win_count / n_episodes,
            "max_pnl": float(np.max(total_pnls)),
            "min_pnl": float(np.min(total_pnls)),
        }

    def save(self, path: Path) -> None:
        """Save the trained model."""
        if self.model is None:
            raise RuntimeError("No model to save — train first.")
        path.parent.mkdir(parents=True, exist_ok=True)
        self.model.save(str(path))
        logger.info("rl_executor_saved", path=str(path))
