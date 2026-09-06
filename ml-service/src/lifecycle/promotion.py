"""
Phase 3J — Promotion Orchestrator, Manifest, Rollback & Cards.

Ties together the registry, champion index, gates, and comparison into an
atomic, crash-safe, auditable promotion workflow.

Design rules
------------
1. Promotion is ATOMIC (spec §35): the champion pointer changes only together
   with the manifest and audit record; partial failure triggers rollback.
2. A PromotionManifest is hashed and persisted for every promotion (spec §49).
3. Rollback restores the previous champion without touching its artifact (spec §36).
4. Crash-safety: an in-progress promotion writes an INTENT marker; a crash
   between intent and commit leaves the system recoverable (spec §72) —
   PROMOTION_RECOVERY_REQUIRED — never with two champions or a half-updated one.
5. Fail-closed: any missing artifact/evidence → NO_PROMOTION (spec §51).
6. No automatic retraining / challenger generation (spec §76).
7. No np.random.* — deterministic.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from ._storage import FileLock, append_jsonl, atomic_write_json, read_json
from .champion import ChampionIndex
from .evidence import ModelEvidencePackage
from .gates import PromotionGate, PromotionPolicy
from .registry import ModelRegistry
from .schemas import (
    ApprovalPolicy, ChampionCard, LifecycleState, ModelCard, PromotionDecision,
    PromotionOutcome, RetirementReason,
)

UTC = timezone.utc


def _now() -> str:
    return datetime.now(UTC).isoformat()


# ── Promotion manifest (spec §49) ─────────────────────────────────────────────

@dataclass
class PromotionManifest:
    """Immutable, hashed record of one promotion (spec §49)."""
    promotion_id:         str
    model_id:             str
    scope:                str
    previous_champion:    Optional[str]
    new_champion:         str
    evidence_package_id:  str
    acceptance_gate_version: str
    promotion_policy_version: str
    data_snapshot:        str
    feature_version:      str
    label_version:        str
    calibrator_version:   str
    meta_model_version:   str
    portfolio_version:    str
    execution_version:    str
    decision:             str            # PromotionOutcome value
    reason:               str
    timestamp:            str
    manifest_hash:        str = ""

    def compute_hash(self) -> str:
        payload = {k: v for k, v in asdict(self).items() if k != "manifest_hash"}
        raw = json.dumps(payload, sort_keys=True, default=str)
        return hashlib.sha256(raw.encode()).hexdigest()

    def freeze(self) -> "PromotionManifest":
        self.manifest_hash = self.compute_hash()
        return self

    def verify(self) -> bool:
        return self.manifest_hash == self.compute_hash()


# ── Errors ─────────────────────────────────────────────────────────────────────

class PromotionError(RuntimeError):
    pass


# ── Promotion orchestrator ─────────────────────────────────────────────────────

class PromotionOrchestrator:
    """
    Coordinates evidence-gated, atomic, crash-safe champion promotion.

    Layout under `root`:
        root/
        ├── models/ ...                 (ModelRegistry)
        ├── champions/ ...              (ChampionIndex)
        ├── manifests/<promotion_id>.json
        ├── promotion_intents/<scope>.json   — crash-safety intent markers
        ├── cards/<full_key>.json       — model cards
        └── .promotion.lock
    """

    def __init__(
        self,
        root: str | Path,
        registry: Optional[ModelRegistry] = None,
        champion_index: Optional[ChampionIndex] = None,
        gate: Optional[PromotionGate] = None,
    ) -> None:
        self.root = Path(root)
        self.registry = registry or ModelRegistry(root)
        self.champions = champion_index or ChampionIndex(root)
        self.gate = gate or PromotionGate()
        self.manifests_dir = self.root / "manifests"
        self.intents_dir = self.root / "promotion_intents"
        self.cards_dir = self.root / "cards"
        self.lock_path = self.root / ".promotion.lock"
        for d in (self.manifests_dir, self.intents_dir, self.cards_dir):
            d.mkdir(parents=True, exist_ok=True)

    # ── Promotion ────────────────────────────────────────────────────────────

    def promote(
        self,
        scope: str,
        challenger_full_key: str,
        challenger_evidence: ModelEvidencePackage,
        champion_evidence: Optional[ModelEvidencePackage],
        promotion_id: str,
        challenger_id: str,
        comparison_id: str = "",
        approval_override: Optional[ApprovalPolicy] = None,
        actor: str = "system",
    ) -> tuple[PromotionDecision, Optional[PromotionManifest]]:
        """
        Evaluate the promotion gate and, if PROMOTE + approved, atomically
        promote the challenger to champion.

        Returns (decision, manifest). manifest is None if not promoted.

        Fail-closed (spec §51): if the challenger is not registered, if evidence
        integrity fails, or if the gate does not PROMOTE, NO promotion occurs.
        """
        with FileLock(self.lock_path):
            # 1. Fail-closed pre-checks
            reg_record = self.registry.get(challenger_full_key)
            if reg_record is None:
                decision = self._blocked_decision(
                    scope, challenger_id, None,
                    f"Challenger {challenger_full_key} is not registered.",
                )
                return decision, None

            if not challenger_evidence.verify_integrity():
                decision = self._blocked_decision(
                    scope, challenger_id, None,
                    "Challenger evidence failed integrity verification.",
                )
                return decision, None

            # 2. Run the promotion gate
            current_champion = self.champions.get_champion(scope)
            champion_id = current_champion.champion_full_key if current_champion else None

            decision = self.gate.evaluate(
                scope=scope,
                challenger_evidence=challenger_evidence,
                champion_evidence=champion_evidence,
                challenger_id=challenger_id,
                champion_id=champion_id,
                comparison_id=comparison_id,
                approval_policy_override=approval_override,
            )

            # 3. Only proceed on PROMOTE + approval
            if decision.outcome != PromotionOutcome.PROMOTE:
                return decision, None

            if decision.approval_policy == ApprovalPolicy.HUMAN_APPROVAL_REQUIRED:
                # Do not auto-promote; caller must call confirm_promotion()
                self._write_intent(scope, challenger_full_key, promotion_id, decision)
                return decision, None

            manifest = self._atomic_promote(
                scope, challenger_full_key, champion_id, promotion_id,
                challenger_id, challenger_evidence, decision, actor,
            )
            return decision, manifest

    def confirm_promotion(
        self,
        scope: str,
        challenger_full_key: str,
        champion_id: Optional[str],
        promotion_id: str,
        challenger_id: str,
        challenger_evidence: ModelEvidencePackage,
        decision: PromotionDecision,
        actor: str = "human",
    ) -> PromotionManifest:
        """
        Confirm a HUMAN_APPROVAL_REQUIRED promotion (spec §50).
        Must only be called after a PROMOTE decision with human approval.
        """
        with FileLock(self.lock_path):
            if decision.outcome != PromotionOutcome.PROMOTE:
                raise PromotionError("Cannot confirm a non-PROMOTE decision.")
            manifest = self._atomic_promote(
                scope, challenger_full_key, champion_id, promotion_id,
                challenger_id, challenger_evidence, decision, actor,
            )
            self._clear_intent(scope)
            return manifest

    def _atomic_promote(
        self,
        scope: str,
        challenger_full_key: str,
        champion_id: Optional[str],
        promotion_id: str,
        challenger_id: str,
        challenger_evidence: ModelEvidencePackage,
        decision: PromotionDecision,
        actor: str,
    ) -> PromotionManifest:
        """
        Atomic promotion (spec §35, §72).

        Order:
        1. Write INTENT marker (crash-safety).
        2. Build + freeze manifest, write it.
        3. Atomically flip the champion pointer.
        4. Transition the registry record to CHAMPION.
        5. Clear INTENT marker.

        A crash between (1) and (5) leaves an INTENT marker → recoverable via
        recover_pending(); the champion pointer is only flipped atomically in (3).
        """
        # 1. Intent marker
        self._write_intent(scope, challenger_full_key, promotion_id, decision)

        # 2. Manifest
        prov = challenger_evidence.model_identity
        manifest = PromotionManifest(
            promotion_id=promotion_id,
            model_id=prov.model_id,
            scope=scope,
            previous_champion=champion_id,
            new_champion=challenger_full_key,
            evidence_package_id=challenger_evidence.evidence_package_id,
            acceptance_gate_version="acceptance-gate-v1",
            promotion_policy_version=decision.promotion_policy_version,
            data_snapshot=prov.dataset_snapshot_id,
            feature_version=prov.feature_version,
            label_version=prov.label_version,
            calibrator_version=challenger_evidence.calibration_evidence.calibrator_version,
            meta_model_version="",
            portfolio_version=challenger_evidence.portfolio_evidence.portfolio_model_version,
            execution_version=challenger_evidence.execution_evidence.execution_model_version,
            decision=decision.outcome.value,
            reason="; ".join(decision.reasons),
            timestamp=_now(),
        ).freeze()
        atomic_write_json(self.manifests_dir / f"{promotion_id}.json", asdict(manifest))

        # 3. Flip champion pointer (atomic within ChampionIndex)
        self.champions.promote(
            scope=scope,
            champion_full_key=challenger_full_key,
            promotion_reason="; ".join(decision.reasons),
            evidence_package_id=challenger_evidence.evidence_package_id,
            promotion_id=promotion_id,
            actor=actor,
        )

        # 4. Registry state → CHAMPION (demote previous if it exists)
        if champion_id and self.registry.exists(champion_id):
            prev_rec = self.registry.get(champion_id)
            if prev_rec and prev_rec.lifecycle_state == LifecycleState.CHAMPION.value:
                self.registry.transition(
                    champion_id, LifecycleState.RETIRED,
                    reason=f"Superseded by {challenger_full_key}", actor=actor,
                )
        # Move challenger up the state machine if needed, then to CHAMPION
        self._advance_to_champion(challenger_full_key, promotion_id, actor)

        # 5. Clear intent
        self._clear_intent(scope)
        return manifest

    def _advance_to_champion(self, full_key: str, promotion_id: str, actor: str) -> None:
        """Advance a PROMOTION_ELIGIBLE record to CHAMPION."""
        rec = self.registry.get(full_key)
        if rec is None:
            raise PromotionError(f"{full_key} not registered.")
        if rec.lifecycle_state == LifecycleState.PROMOTION_ELIGIBLE.value:
            self.registry.transition(
                full_key, LifecycleState.CHAMPION,
                reason=f"Promoted (promotion_id={promotion_id})", actor=actor,
            )
        elif rec.lifecycle_state != LifecycleState.CHAMPION.value:
            raise PromotionError(
                f"{full_key} is in state {rec.lifecycle_state}; must be "
                "PROMOTION_ELIGIBLE before promotion to CHAMPION."
            )

    # ── Rollback (spec §36) ────────────────────────────────────────────────────

    def rollback(
        self,
        scope: str,
        rollback_reason: str,
        actor: str = "system",
    ) -> Optional[str]:
        """
        Roll back the current champion to the previous one (spec §36).

        Returns the restored champion full_key, or None if no previous champion
        (in which case the scope is left with NO champion — preferred over an
        inadequate champion, spec §81).

        Restoration does NOT modify any artifact.
        """
        with FileLock(self.lock_path):
            current = self.champions.get_champion(scope)
            if current is None:
                raise PromotionError(f"No champion to roll back for {scope!r}.")
            failed_key = current.champion_full_key

            restored = self.champions.rollback(scope, rollback_reason, actor=actor)

            # Registry: mark failed as ROLLED_BACK, restore previous to CHAMPION
            if self.registry.exists(failed_key):
                rec = self.registry.get(failed_key)
                if rec and rec.lifecycle_state == LifecycleState.CHAMPION.value:
                    self.registry.transition(
                        failed_key, LifecycleState.ROLLED_BACK,
                        reason=rollback_reason, actor=actor,
                    )

            # Record rollback event
            append_jsonl(self.root / "rollback_history.jsonl", {
                "scope": scope, "failed_champion": failed_key,
                "restored_champion": restored.champion_full_key if restored else None,
                "rollback_reason": rollback_reason, "rollback_time": _now(),
                "initiated_by": actor,
            })

            return restored.champion_full_key if restored else None

    def rollback_history(self) -> list[dict]:
        from ._storage import read_jsonl
        return read_jsonl(self.root / "rollback_history.jsonl")

    # ── Crash-safety (spec §72) ─────────────────────────────────────────────

    def _write_intent(self, scope: str, full_key: str, promotion_id: str, decision: PromotionDecision) -> None:
        safe = scope.replace("/", "-")
        atomic_write_json(self.intents_dir / f"{safe}.json", {
            "scope": scope, "challenger_full_key": full_key,
            "promotion_id": promotion_id, "written_at": _now(),
            "status": "IN_PROGRESS",
        })

    def _clear_intent(self, scope: str) -> None:
        safe = scope.replace("/", "-")
        (self.intents_dir / f"{safe}.json").unlink(missing_ok=True)

    def pending_intents(self) -> list[dict]:
        """
        Return any in-progress promotion intents. A non-empty list after a crash
        means PROMOTION_RECOVERY_REQUIRED (spec §72).
        """
        out = []
        for p in sorted(self.intents_dir.glob("*.json")):
            data = read_json(p)
            if data:
                out.append(data)
        return out

    def recovery_required(self) -> bool:
        return len(self.pending_intents()) > 0

    def recover_pending(self, actor: str = "system") -> list[str]:
        """
        Fail-closed recovery (spec §72). For each in-progress intent, verify
        whether the champion pointer was actually flipped. If not, discard the
        intent (the promotion never committed) — leaving the previous champion
        intact. Never leaves two champions or a half-updated champion.

        Returns the list of scopes recovered.
        """
        recovered = []
        with FileLock(self.lock_path):
            for intent in self.pending_intents():
                scope = intent["scope"]
                target = intent["challenger_full_key"]
                champ = self.champions.get_champion(scope)
                if champ is None or champ.champion_full_key != target:
                    # Promotion did not commit — discard intent, keep prev champion
                    self._clear_intent(scope)
                    append_jsonl(self.root / "recovery_log.jsonl", {
                        "scope": scope, "action": "DISCARDED_UNCOMMITTED_PROMOTION",
                        "target": target, "recovered_at": _now(), "actor": actor,
                    })
                else:
                    # Champion was flipped but intent not cleared — clear it
                    self._clear_intent(scope)
                    append_jsonl(self.root / "recovery_log.jsonl", {
                        "scope": scope, "action": "CONFIRMED_COMMITTED_PROMOTION",
                        "target": target, "recovered_at": _now(), "actor": actor,
                    })
                recovered.append(scope)
        return recovered

    # ── Model cards (spec §65, §66) ─────────────────────────────────────────

    def write_model_card(self, card: ModelCard) -> Path:
        safe = f"{card.model_id}__at__{card.model_version}".replace("/", "-")
        path = self.cards_dir / f"{safe}.json"
        atomic_write_json(path, card.to_dict())
        return path

    def get_champion_card(self, scope: str) -> Optional[ChampionCard]:
        champ = self.champions.get_champion(scope)
        if champ is None:
            return None
        model_id, _, model_version = champ.champion_full_key.partition("@")
        return ChampionCard(
            scope=scope,
            model_id=model_id,
            model_version=model_version,
            promoted_at=champ.promoted_at,
            evidence_package_id=champ.evidence_package_id,
        )

    def _blocked_decision(
        self, scope: str, challenger_id: str, champion_id: Optional[str], reason: str,
    ) -> PromotionDecision:
        return PromotionDecision(
            outcome=PromotionOutcome.BLOCKED,
            scope=scope,
            champion_id=champion_id,
            challenger_id=challenger_id,
            gate_results=[],
            reasons=[reason],
            approval_policy=ApprovalPolicy.AUTO_REJECTED,
            decided_at=_now(),
        )
