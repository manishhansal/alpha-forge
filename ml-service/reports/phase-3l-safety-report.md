# Phase 3L — Safety Report

**Generated:** 2026-09-06  
**Branch:** `refactor/improve-ml-service`

---

## 1. Safety Architecture (spec §11)

```
RL action
    ↓
Safety / Constraint Layer   (deterministic; never bypassed)
    ↓
Executable action
```

The RL agent NEVER reaches a broker directly. There is no live-broker
connectivity anywhere in `src/rl/` — verified by test (no `place_order`,
`submit_order`, `Angel`, `Upstox`, `broker_api`, `live_order`) (spec §76, §92).

## 2. Deterministic Safety Layer (spec §11, §54)

`SafetyLayer.apply(requested_action, ctx)` enforces:
market hours, instrument validity, F&O ban, participation cap, max position,
max turnover, liquidity, and risk limits. It can ONLY make an action safer
(reduce aggressiveness / quantity) — never more aggressive. Every override
records `requested_action`, `executed_action`, and `override_reason`.

Verified: market-closed / expired / F&O-ban / risk-breach force WAIT; a FULL
action under tiny ADV is participation-capped; PASSIVE is never upgraded.

## 3. Action Masking (spec §12)

`valid_action_mask` removes invalid actions (market closed, expired, F&O ban,
max position, no liquidity) so the agent never sees them as opportunities. WAIT/
HOLD is always available; at least one valid action is guaranteed.

## 4. Action Audit + State Hash + Replay (spec §55, §56, §57)

Every decision produces an `RLActionAudit` (agent_id, state_hash,
action_requested, action_allowed, action_executed, safety_override,
override_reason, reward). The environment's deterministic `state_hash` and
`replay_log()` reconstruct exactly what the agent saw, chose, and received.

## 5. Fallback Policy (spec §53)

`FallbackController` routes to a deterministic baseline (default
FIXED_PARTICIPATION, else TWAP) when RL is unavailable (`RL_UNAVAILABLE`) or the
action is out-of-distribution (`OOD_ACTION`). The fallback is explicit and
logged, never silent.

## 6. Shadow / Paper (spec §77, §78, §79)

Shadow mode compares the RL proposed action against the deterministic action
with NO live order (Phase 3J `ShadowOutput`, `influenced_champion=False`
enforced). Paper mode runs through the Phase 3G simulator with no real capital.
Paper-soak criteria are governed by Phase 3J `SoakConfig`.

## 7. Governance (spec §40, §75, §92)

Every RL agent enters Phase 3J as a CHALLENGER and is never auto-promoted. A
`FINAL_HOLDOUT_CONTAMINATED` experiment cannot become a challenger.

---

## 8. Verdict

Safety layer, action masking, audit, fallback, and no-live-broker guarantees are
complete and verified. **INSUFFICIENT_EVIDENCE** for any production RL execution
claim; no RL policy is promoted.
