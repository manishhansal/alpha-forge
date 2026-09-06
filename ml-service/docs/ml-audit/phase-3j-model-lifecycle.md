# Phase 3J — Model Lifecycle (Audit Reference)

This document is the audit-grade reference for the AlphaForge model lifecycle,
champion/challenger registry, evidence packages, and evidence-gated promotion.
It describes the system as built in `ml-service/src/lifecycle/`.

---

## 1. Purpose

Phase 3J answers, at any point in time and for any historical timestamp:

- Which model is the current champion (per scope)?
- Why is it champion (what evidence)?
- What challengers exist and which failed, and why?
- Under exactly what conditions would a challenger be promoted or rolled back?

Phase 3J is a **governance** phase. It does NOT auto-retrain, does NOT add deep
learning or reinforcement learning, and does NOT touch live execution.

---

## 2. Package Layout

```
src/lifecycle/
├── __init__.py          package entry point / public API
├── schemas.py           identities, provenance, contracts, state machine, enums
├── artifact_integrity.py SHA-256 hashing, fail-closed loading, forbidden refs
├── evidence.py          ModelEvidencePackage (frozen + hashed), hierarchy A–D
├── compatibility.py     model/feature/label/calibrator/meta/exec/portfolio checks
├── _storage.py          atomic JSON writes, JSONL audit, cross-process lock
├── registry.py          persistent versioned ModelRegistry
├── champion.py          scoped ChampionIndex + history
├── challenger.py        ChallengerRegistry + shadow/paper + soak + selection bias
├── gates.py             PromotionGate (6 gates) + PromotionPolicy
├── comparison.py        apples-to-apples champion vs challenger
└── promotion.py         PromotionOrchestrator, manifest, rollback, crash-safety
```

---

## 3. Model Identity

Models are identified by an immutable `ModelIdentity` (`frozen=True`) that binds
the artifact hash to the full data/feature/label/config lineage. A model is
never identified only by algorithm name or a bare version string. See the
lineage report for the full field list.

---

## 4. Lifecycle State Machine

```
REGISTERED → VALIDATING → EVIDENCE_READY → CANDIDATE
→ SHADOW → PAPER → PROMOTION_ELIGIBLE → CHAMPION
```

Alternative exits: REJECTED, BLOCKED, RETIRED, ROLLED_BACK, ABSTAINED.
Transitions are validated against `VALID_TRANSITIONS`; invalid transitions raise
`InvalidTransition`. Every transition is written to the append-only audit log.

---

## 5. Artifact Integrity

- Every artifact is hashed with SHA-256 at registration.
- `verify_artifact_integrity` is fail-closed: a missing or mismatched hash
  blocks loading.
- Forbidden references (`latest.pkl`, `current_model`, moral equivalents) are
  rejected — a champion must always be an explicit, hashed
  `(model_id, model_version)`.

---

## 6. Evidence Packages

`ModelEvidencePackage` is immutable (frozen + SHA-256 evidence hash). It bundles
predictive, calibration, execution, risk, and stability evidence with OOS
metadata. Evidence is graded on a hierarchy:

- LEVEL_A — observed OOS, execution + calibration + stability, ≥100 obs
- LEVEL_B — historical, ≥60 obs (default promotion floor)
- LEVEL_C — proxy-based, no real execution/cost (below floor)
- LEVEL_D — insufficient / contaminated (never promotable)

The evidence hash deliberately excludes the generation timestamp so identical
evidence is reproducible.

---

## 7. Acceptance vs Promotion

Acceptance (research validity, existing `ModelAcceptanceGate`) is separate from
promotion (fit to replace the champion). A model can be accepted yet not
promoted. The promotion gate consumes a frozen evidence package and the existing
acceptance decision.

---

## 8. Promotion Gate

Six structured gates — DATA, PREDICTIVE, CALIBRATION, EXECUTION, RISK,
STABILITY — each returning PASS / FAIL / INSUFFICIENT_EVIDENCE. There is no
black-box 0–100 score. The aggregate `PromotionDecision` is one of PROMOTE,
DO_NOT_PROMOTE, BLOCKED, INSUFFICIENT_EVIDENCE, NO_PROMOTION. All thresholds
come from a versioned `PromotionPolicy`.

---

## 9. Rollback & Crash Safety

Rollback is explicit and restores the previous champion without mutating its
artifact. Promotions write an intent marker before committing; a crash leaves a
recoverable pending intent that `recover_pending()` discards fail-closed. The
system never leaves two champions or a half-updated champion.

---

## 10. Current State

No real dataset is loaded, so the registry has no champion and no challengers.
This NO_PROMOTION / INSUFFICIENT_EVIDENCE state is the correct and preferred
outcome: a system with no champion is safer than one that promotes an
inadequately evidenced model.

---

## 11. Verification

81 of 82 Phase 3J tests pass (1 skipped due to an unrelated sklearn transitive
dependency missing in the environment; `src/lifecycle/` has zero sklearn
dependency). The full suite (Phases 3C–3J) is 534 passed / 0 failed. Static
audit is clean: no `latest.pkl` usage outside the forbidden-reference guard, no
executable `np.random`, no silent/auto promotion, immutable identities and
evidence, and no hardcoded thresholds in gate logic.
