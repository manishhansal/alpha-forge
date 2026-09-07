# RL Safety Runbook (Phase 3L)

Operational runbook for running the Phase 3L RL execution layer safely. RL is
research/shadow/paper ONLY — no live broker, no real orders, no auto-promotion
(spec §76, §92).

---

## 1. Non-Negotiables

- RL NEVER connects to a broker (Angel/Upstox/etc.) or places/submits orders.
- RL NEVER replaces the deterministic execution engine.
- RL is NEVER auto-promoted or auto-retrained.
- Every RL action passes through the deterministic safety layer first.

## 2. Running an Episode (research)

1. Build PIT `MarketBar`s and an `EpisodeConfig` (track, target, deadline,
   participation cap, seed).
2. `ExecutionEnv(bars, episode, reward_version, slippage_bps)`.
3. `obs, info = env.reset()`.
4. Loop: `mask = env.action_mask()`; agent proposes an action; `env.step(action)`
   applies the safety layer and returns a net-of-cost reward.
5. `env.replay_log()` reconstructs the episode for audit.

## 3. Safety Layer

Every action is filtered by `SafetyLayer.apply(action, MarketContext)`:
- market closed / expired / invalid instrument / risk-limit breached → forced
  WAIT/HOLD.
- F&O ban → WAIT.
- participation capped at `max_participation_pct`; quantity clipped by ADV,
  remaining target, and max position.
- The layer can ONLY reduce aggressiveness, never increase it.
Record `requested_action`, `executed_action`, `override_reason` on every step.

## 4. Fallback

Use `FallbackController` when RL is unavailable or OOD:
- `RL_UNAVAILABLE` → deterministic baseline (default FIXED_PARTICIPATION, else TWAP).
- `OOD_ACTION` → deterministic baseline.
Always explicit and logged; never silent.

## 5. Shadow Mode

Run RL alongside live market observation with NO live order. Log the RL proposed
action vs the deterministic action via Phase 3J `ShadowOutput`
(`influenced_champion=False`, enforced). Compare and record the difference.

## 6. Paper Mode

Simulate through the Phase 3G `BacktestEngine` (via `SimulatorBridge`) with no
real capital. Require the Phase 3J paper-soak criteria before any promotion
review.

## 7. Promotion (governed, never automatic)

1. Register the RL experiment; keep it reproducible (env/reward/dataset/seed).
2. Evaluate with OPE; if `OPE_INSUFFICIENT_EVIDENCE`, STOP — do not promote.
3. Check robustness; if `SIMULATOR_DEPENDENCY_RISK`, STOP.
4. Classify (`classify_rl_value`). Only a SUPERIOR/COMPLEMENTARY policy with
   reliable OPE, stability, and acceptable risk may become
   `register_as_challenger` in Phase 3J.
5. A human drives the Phase 3J promotion gate. RL is never auto-promoted.

## 8. Incident Response

- Policy collapse (always-WAIT / always-AGGRESSIVE), reward hacking, inventory
  accumulation, or SIMULATOR_DEPENDENCY_RISK → reject the experiment, keep the
  deterministic baseline.
- Any doubt about evidence → return INSUFFICIENT_EVIDENCE and keep the incumbent.

## 9. Do-Not Rules

- Never wire RL to a broker or order API.
- Never use ORACLE_ONLY output in training or production.
- Never tune reward weights / seeds / thresholds on the final OOS or holdout.
- Never promote on unreliable OPE.
