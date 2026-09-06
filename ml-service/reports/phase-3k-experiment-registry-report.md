# Phase 3K — Experiment Registry Report

**Generated:** 2026-09-06  
**Branch:** `refactor/improve-ml-service`

---

## 1. DeepLearningExperiment (spec §60)

Every advanced-ML experiment is a reproducible `DeepLearningExperiment` record:

```
experiment_id, model_id, architecture, task_type, status,
dataset_version, feature_version, label_version, label_config_hash,
sequence_version, scaler_version, code_version, seed,
training_config, validation_config, results, evidence_package_id,
model_value_class, contamination_status, overfit_status, rejection_reason,
created_at, updated_at, status_history, notes
```

An experiment is reproducible from code commit + dataset snapshot + features +
labels + architecture + hyperparameters + seed + environment (spec §62).

---

## 2. Status Machine (spec §61)

```
PLANNED → RUNNING → COMPLETED → {PROMOTION_ELIGIBLE → PROMOTED} / REJECTED / RETIRED
                  → FAILED → RETIRED
```

Invalid transitions raise `InvalidExperimentTransition`. Enforced by
`VALID_EXPERIMENT_TRANSITIONS`.

---

## 3. No Cherry-Picking (spec §59)

Every tested architecture is recorded — including FAILED and REJECTED — with its
architecture, configuration, and outcome. Failed experiments are never hidden.
The registry's append-only `experiment_log.jsonl` is the audit trail.

---

## 4. Phase 3J Integration (spec §28, §29)

`register_as_challenger` wires a COMPLETED experiment into the existing Phase 3J
`ModelRegistry` + `ChallengerRegistry` as a CHALLENGER. It:

- requires the experiment to be COMPLETED (or PROMOTION_ELIGIBLE);
- BLOCKS registration if the experiment's evidence is
  `FINAL_OOS_CONTAMINATED` (spec §69);
- never auto-promotes — the model must pass the Phase 3J promotion gate through
  SHADOW → PAPER like any other challenger (spec §29, §83).

Verified: contaminated experiment → challenger registration raises; clean
experiment → challenger `chal-<model_id>` created in the Phase 3J challenger
registry.

---

## 5. Current State

| Item | Count |
|------|-------|
| Registered experiments (production) | 0 |
| Promoted deep models | 0 |
| Challengers created (production) | 0 |

No real experiments have been run; the registry and Phase 3J wiring are verified
end-to-end on synthetic experiments.

---

## 6. Verdict

Experiment registry + Phase 3J challenger governance complete and verified.
INSUFFICIENT_EVIDENCE for any production experiment outcome.
