# Phase 3L — Offline Policy Evaluation Report

**Generated:** 2026-09-06  
**Branch:** `refactor/improve-ml-service`  
**Verdict:** OPE_INSUFFICIENT_EVIDENCE (synthetic; deterministic greedy target far from behavior distribution)

---

## 1. Why OPE (spec §32)

Offline RL is NOT evaluated by naive historical replay. The target policy differs
from the behavior policy that generated the trajectories, so replaying logged
rewards would misrepresent the target's value. Off-policy evaluation corrects for
this — and, critically, reports its own uncertainty.

## 2. Estimators (spec §32)

| Estimator | Description |
|-----------|-------------|
| IS | per-decision importance sampling |
| WIS | weighted (self-normalized) importance sampling |
| DR | doubly robust, using the fitted Q as a control variate |
| FQE | direct fitted-Q evaluation of `V(initial state)` |

The behavior policy is estimated empirically per binned state and
epsilon-smoothed so importance ratios are finite; the target is epsilon-greedy on
the learned Q.

## 3. Uncertainty (spec §33)

Every OPE result reports:

- **effective sample size (ESS)** = `1 / Σ wᵢ²` on normalized episode weights
- **weight concentration** = max normalized weight
- **coverage** = fraction of steps in states seen in the behavior data
- **bootstrap 95% CI** on WIS (seeded, deterministic)

The status is `RELIABLE` only if ESS, weight concentration, and coverage all pass
thresholds; otherwise **OPE_INSUFFICIENT_EVIDENCE** and the point estimates are
explicitly flagged as untrustworthy.

## 4. Result (synthetic)

On the synthetic offline dataset: IS/WIS/DR/FQE point estimates are produced for
transparency, but ESS ≈ 1 and weight concentration ≈ 0.97, so the status is
**OPE_INSUFFICIENT_EVIDENCE**. This is the correct, honest outcome — a
deterministic greedy policy is far from the mixed epsilon-smoothed behavior
distribution, so importance-weighted OPE cannot credibly value it. Tiny datasets
also return OPE_INSUFFICIENT_EVIDENCE.

## 5. Implication

Because OPE is unreliable, the RL policy cannot be credibly valued, so it cannot
be classified better than INSUFFICIENT_EVIDENCE (see classification report). No
promotion is possible. This is by design.

---

## 6. Verdict

**OPE_INSUFFICIENT_EVIDENCE.** OPE machinery (IS/WIS/DR/FQE + ESS/coverage/
concentration/CI) is complete and verified; on the available synthetic data it
honestly declares the estimate untrustworthy.
