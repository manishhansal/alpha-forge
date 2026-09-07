# Phase 3J — Lineage Report

**Generated:** 2026-09-06  
**Branch:** `refactor/improve-ml-service`

---

## 1. Scope

Documents model, calibrator, meta-model, portfolio, and execution lineage
tracked in every model identity, provenance record, and promotion manifest.

---

## 2. Model Identity Lineage (spec §3, §43)

Each `ModelIdentity` carries the full data/feature/label lineage:
`dataset_version, dataset_snapshot_id, universe_version, feature_version,
label_version, label_config_hash, training_config_hash, hyperparameter_hash,
random_seed, code_version`.

`ModelProvenance` additionally records parent/child relationships implicitly
through `data_snapshot_id` and version chains. A model DAG can be reconstructed
from the registry records (relational/document representation — no graph
database required, spec §44).

---

## 3. Calibrator Lineage (spec §45)

Calibrators are first-class versioned artifacts. `ModelProvenance` records
`calibrator_id, calibrator_version`. Compatibility is enforced:
`CompatibilityChecker.check_calibrator(model_id, model_version,
calibrator_model_id, calibrator_model_version)` — a calibrator trained for
model A cannot be used with model B (mirrors
`meta.calibration_engine.CalibratorArtifact.is_compatible`).

---

## 4. Meta-Model Lineage (spec §46)

`ModelProvenance` records `meta_model_id, meta_model_version`.
`CompatibilityChecker.check_meta_model(model_id, meta_base_model_id)` ensures a
meta-model is built on the same base model.

---

## 5. Portfolio Model Lineage (spec §47)

Every `PromotionManifest` records `portfolio_version`. `ModelProvenance` records
`portfolio_model_version, risk_model_version, constraint_set_version,
position_sizing_version`. A model cannot be promoted based on a portfolio
configuration different from the one evaluated
(`CompatibilityChecker.check_portfolio_version`).

---

## 6. Execution Lineage (spec §48)

Every evidence package's `ExecutionEvidence` and every `PromotionManifest`
records `execution_model_version, cost_model_version, slippage_model_version,
market_calendar_version`.

---

## 7. Promotion Manifest (spec §49)

Each promotion produces a hashed `PromotionManifest`:
`promotion_id, model_id, scope, previous_champion, new_champion,
evidence_package_id, acceptance_gate_version, promotion_policy_version,
data_snapshot, feature_version, label_version, calibrator_version,
meta_model_version, portfolio_version, execution_version, decision, reason,
timestamp, manifest_hash`.

The `manifest_hash` (SHA-256) proves the manifest has not been tampered with.

---

## 8. Reproducible Champion State (spec §53)

At any historical timestamp, the system can answer which model was champion via
`ChampionIndex.champion_at(scope, timestamp)`. The associated evidence package,
feature/label/calibrator/portfolio/execution versions are all recoverable from
the persisted manifest and registry records.

---

## 9. Current Lineage State

| Item | Count |
|------|-------|
| Registered models | 0 |
| Promotion manifests | 0 |
| Champion lineage entries | 0 |

No real models are registered. Lineage tracking is verified on synthetic
promotions (manifest hash validity, immutability under later promotions).

---

## 10. OOS Evidence

**INSUFFICIENT_EVIDENCE** — no real dataset. Lineage schema and manifest hashing
are verified on synthetic evidence.
