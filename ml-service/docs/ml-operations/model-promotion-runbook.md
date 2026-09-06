# Model Promotion Runbook

Operational runbook for registering, evaluating, promoting, and rolling back
models using the Phase 3J lifecycle system (`ml-service/src/lifecycle/`).

> This is a governance framework. No auto-retraining, no live execution. Every
> promotion is an explicit, evidenced, human-confirmed action.

---

## 1. Register a Model

1. Compute the artifact hash and build a `ModelIdentity` with full lineage
   (dataset/feature/label/config versions, random seed, code version).
2. `ModelRegistry.register(identity, provenance, schema_contract)`.
   - Re-registering the same `(model_id, version)` with a different artifact
     hash raises `ImmutabilityViolation`.
   - Re-registering with the same hash is an idempotent no-op.
3. New state: REGISTERED. Event appended to `audit_log.jsonl`.

---

## 2. Attach Evidence

1. Assemble predictive / calibration / execution / risk / stability evidence and
   OOS metadata into a `ModelEvidencePackage`.
2. `package.freeze()` — computes the SHA-256 evidence hash and locks it.
3. Register the package. State advances to VALIDATING → EVIDENCE_READY.
4. Verify with `package.verify_integrity()` before any gate evaluation.

---

## 3. Run as Challenger (Shadow → Paper)

1. `ChallengerRegistry.register(model_full_key, scope, evidence_package_id)`.
2. Move to SHADOW. Shadow outputs must have `influenced_champion=False`.
3. After the shadow soak (`min_shadow_days` / `min_shadow_observations`), move to
   PAPER (Phase 3G simulated execution).
4. After the paper soak (`min_paper_days` / `min_paper_trades`), the challenger
   becomes eligible for gate evaluation.

---

## 4. Evaluate the Promotion Gate

1. Build a `FrozenEvalSnapshot` and run `ChampionChallengerComparator.compare()`.
2. `PromotionGate.evaluate(comparison, evidence, policy, acceptance_decision)`.
3. Read the `PromotionDecision`:
   - **PROMOTE** — all six gates PASS → go to §5.
   - **DO_NOT_PROMOTE** — a gate FAILed → record and stop.
   - **INSUFFICIENT_EVIDENCE** — gather more evidence, extend soak, or raise
     evidence level; do not promote.
   - **BLOCKED** — final-OOS contamination or integrity failure → investigate;
     do not promote.
   - **NO_PROMOTION** — no eligible challenger; keep the incumbent (or keep no
     champion). This is an acceptable outcome.

---

## 5. Promote (Human-Confirmed)

1. `PromotionOrchestrator.promote(...)` writes a promotion INTENT marker and,
   because `high_impact_requires_human=True`, defers to human approval.
2. A human reviews the decision, evidence package, and manifest, then calls
   `confirm_promotion(promotion_id)`.
3. On confirmation the champion pointer is swapped atomically (temp +
   `os.replace`), a hashed `PromotionManifest` is written, and champion history
   is updated.
4. Verify: `ChampionIndex.get(scope)` returns the new champion; the manifest
   hash validates.

---

## 6. Roll Back

1. Trigger `PromotionOrchestrator.rollback(scope, reason)` for a valid reason
   (severe degradation, calibration failure, integrity/schema/drift/execution/
   risk breach). Do not roll back on a single noisy observation.
2. The previous champion pointer is restored WITHOUT modifying its artifact.
3. A rollback event is appended to `rollback_history.jsonl`.

---

## 7. Crash Recovery

1. On startup call `PromotionOrchestrator.recovery_required()`.
2. If a pending intent exists (crash between intent and commit),
   `recover_pending()` discards the uncommitted promotion (fail-closed).
3. The system never leaves two champions or a half-updated champion.

---

## 8. Answering Governance Questions

| Question | Command |
|----------|---------|
| Current champion for a scope? | `ChampionIndex.get(scope)` |
| Champion at time T? | `ChampionIndex.champion_at(scope, T)` |
| Full champion history? | `ChampionIndex.history(scope)` |
| Which challengers were tested/rejected? | `ChallengerRegistry.selection_bias_summary()` |
| Why was a model promoted? | read the `PromotionManifest` (manifests/) |
| Audit trail? | `audit_log.jsonl` |

---

## 9. Do-Not Rules

- Never reference `latest.pkl` / `current_model` — always an explicit hashed key.
- Never promote below LEVEL_B evidence or on a contaminated final OOS.
- Never promote without human confirmation while `high_impact_requires_human`.
- Never mutate a registered identity, artifact, or frozen evidence package.
