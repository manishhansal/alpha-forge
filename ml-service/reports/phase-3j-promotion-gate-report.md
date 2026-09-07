# Phase 3J — Promotion Gate Report

**Generated:** 2026-09-06  
**Branch:** `refactor/improve-ml-service`

---

## 1. Scope

Documents the acceptance/promotion separation, the six-gate promotion system,
rollback triggers, and the human-review policy.

---

## 2. Acceptance ≠ Promotion (spec §18)

```
ModelAcceptanceGate (existing, reused)  →  EvidencePackage  →  PromotionGate  →  PromotionDecision
```

- **Acceptance** = technically/research valid (existing `ModelAcceptanceGate` in
  `validation/metrics.py`, integrated not duplicated).
- **Promotion** = sufficiently evidenced to REPLACE the current champion.

These are separate. A model can be accepted but not promoted.

---

## 3. The Six Promotion Gates (spec §62)

Each gate returns PASS / FAIL / INSUFFICIENT_EVIDENCE. No black-box 0–100 score.

| Gate | Checks |
|------|--------|
| DATA | evidence integrity, OOS sample size, evidence level (≥ B), final-OOS contamination |
| PREDICTIVE | Rank IC improvement over champion ≥ `min_ic_improvement` |
| CALIBRATION | Brier must not degrade beyond tolerance |
| EXECUTION | net return positive; turnover not materially worse |
| RISK | max drawdown not materially worse |
| STABILITY | IC decay not SIGNIFICANT_DECAY/FAILED; feature drift not HIGH/CRITICAL |

---

## 4. Promotion Decision (spec §63)

```
PROMOTE / DO_NOT_PROMOTE / BLOCKED / INSUFFICIENT_EVIDENCE / NO_PROMOTION
```

- PROMOTE — all gates PASS
- DO_NOT_PROMOTE — one or more gates FAIL
- INSUFFICIENT_EVIDENCE — one or more gates INSUFFICIENT_EVIDENCE (no FAIL)
- BLOCKED — final-OOS contamination or integrity failure
- NO_PROMOTION — no challenger satisfies the gate (valid, preferred outcome)

---

## 5. Configurable Promotion Policy (spec §21)

All thresholds live in `PromotionPolicy` (versioned, no hardcoded values):

| Parameter | Default | Meaning |
|-----------|---------|---------|
| `min_ic_improvement` | 0.005 | absolute Rank IC improvement required |
| `min_net_ev_improvement` | 0.0 | net EV must not be worse |
| `min_calibration_improvement` | 0.0 | Brier must not degrade |
| `max_drawdown_degradation` | 0.02 | max +2% drawdown degradation |
| `max_turnover_increase` | 0.20 | max 20% relative turnover increase |
| `max_cost_increase` | 0.20 | max 20% relative cost increase |
| `min_evidence_level` | LEVEL_B | evidence hierarchy floor |
| `require_positive_net_return` | True | challenger net return > 0 |
| `min_oos_observations` | 60 | minimum OOS sample |
| `high_impact_requires_human` | True | human approval for promotion |
| `version` | promotion-policy-v1 | policy version |

---

## 6. Final-OOS Protection (spec §24)

If `OOSEvidence.final_oos_used_for_selection` is True, the DATA gate FAILs and
the decision is BLOCKED. Evidence relying on a contaminated final OOS is
classified LEVEL_D and cannot be promoted.

---

## 7. Evidence Hierarchy Gating (spec §15)

| Level | Meaning | Promotion |
|-------|---------|-----------|
| LEVEL_A | Observed OOS, ≥100 obs, execution + calibration + stability | Eligible |
| LEVEL_B | Historical, ≥60 obs, some evidence | Eligible (default floor) |
| LEVEL_C | Proxy-based (no real execution/cost) | Below floor → INSUFFICIENT_EVIDENCE |
| LEVEL_D | Insufficient / contaminated | Never eligible |

---

## 8. Human Review (spec §50)

`ApprovalPolicy`: AUTO_APPROVED / HUMAN_APPROVAL_REQUIRED / AUTO_REJECTED.

By default, a PROMOTE decision requires human approval
(`high_impact_requires_human=True`). The orchestrator writes an intent marker
and defers; `confirm_promotion()` completes it. No UI — backend approval state.

---

## 9. Rollback Triggers (spec §37)

Rollback is explicit (`PromotionOrchestrator.rollback`). Configurable triggers:

```
severe performance degradation
calibration failure
data incompatibility
artifact integrity failure
schema mismatch
drift threshold breach
execution incompatibility
risk limit breach
```

No aggressive automatic rollback on a single noisy observation — persistence/
confirmation is required. Rollback restores the previous champion WITHOUT
modifying its artifact.

---

## 10. Crash Safety (spec §72)

Promotion writes an INTENT marker before committing. A crash between intent and
commit leaves a pending intent → `recovery_required()` is True.
`recover_pending()` discards uncommitted promotions (fail-closed), never leaving
two champions or a half-updated champion.

---

## 11. Verified Gate Behaviours (synthetic tests)

| Scenario | Expected | Result |
|----------|----------|--------|
| Strong challenger, no incumbent | PROMOTE (all gates PASS) | PASS |
| IC improvement < min | DO_NOT_PROMOTE (PREDICTIVE FAIL) | PASS |
| Calibration degrades | DO_NOT_PROMOTE (CALIBRATION FAIL) | PASS |
| Negative net return | DO_NOT_PROMOTE (EXECUTION FAIL) | PASS |
| IC significant decay | DO_NOT_PROMOTE (STABILITY FAIL) | PASS |
| Too few OOS obs | INSUFFICIENT_EVIDENCE | PASS |
| Final OOS contaminated | BLOCKED | PASS |
| Mutated evidence | BLOCKED (integrity failure) | PASS |
| Unregistered challenger | BLOCKED | PASS |

---

## 12. OOS Evidence

**INSUFFICIENT_EVIDENCE** — no real dataset. Gates are verified on synthetic
evidence packages covering PASS, FAIL, INSUFFICIENT_EVIDENCE, and BLOCKED.
