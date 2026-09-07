# Phase 3N — Paper-Trading Operations Runbook

Audience: ML / trading operators running AlphaForge paper sessions.

> **Non-negotiable:** paper / shadow / research only. There is no live-broker path.
> LIVE / PRODUCTION modes fail closed (`LiveExecutionForbidden`). No auto-retraining,
> no auto-recalibration, no auto-promotion. This runbook cannot authorize live trading.

---

## 1. Serviceable modes

`research` · `shadow` · `paper`. Any `live`/`production` token raises
`LiveExecutionForbidden` at `PaperOrder`, `PaperTradingEngine`, and `PaperSession`
construction. The readiness surface has no `LIVE_READY` state.

## 2. Running a paper session

```python
from src.shadow import ShadowLedger
from src.paper import PaperTradingEngine, PaperSession

ledger  = ShadowLedger(root)                       # immutable append-only store
engine  = PaperTradingEngine(ledger, session_id)   # mode="paper"
session = PaperSession(root, session_id, market_date, engine=engine)
session.manifest.data_snapshot_ids = [...]         # pin for replay
session.manifest.model_versions    = [...]
session.manifest.feature_version   = "..."
session.manifest.data_tag          = "REAL_MARKET_DATA"  # or SYNTHETIC_DATA/REPLAY_DATA
```

For each EXECUTION_PLANNED decision:

```python
res = session.submit_decision(decision, fills=fill_legs)  # fills from the 3G FillEngine
```

- Only `EXECUTION_PLANNED` decisions are accepted (else rejected, fail-closed).
- The order id is deterministic per `(session, decision)` → **idempotent**;
  resubmitting the same decision creates one logical order, no duplicate exposure.
- Fills are **never fabricated** — supply the legs the reused Phase 3G `FillEngine`
  produced (which already handles gaps, circuits, price-bands, partial fills, F&O
  ban, expiry). `fills=None` leaves the order SUBMITTED and unfilled.

Close the session to freeze the manifest and produce the deterministic EOD
reconciliation (never manually edited):

```python
eod = session.close(prediction_accuracy=..., calibration_error=..., ev_realization=...)
```

## 3. Kill switch → NO_NEW_PAPER_EXPOSURE

```python
from src.paper import KillSwitchReason
session.trigger_kill_switch(KillSwitchReason.DATA_UNSAFE, "reason")
```

Once tripped, `submit_decision` blocks **new** exposure (`accepted=False`,
`KILL_SWITCH_ACTIVE: NO_NEW_PAPER_EXPOSURE`). Existing paper positions may still be
reconciled/closed by deterministic safety rules; no new risk is introduced. Triggers:
data unsafe, model revoked, calibration stale, severe feature drift, execution
unavailable, risk breach, RL OOD, provenance failure, provider corruption, system
health degraded.

## 4. Restart recovery

On restart, construct a fresh engine/session over the **same** `ShadowLedger` root.
`engine.has_exposure_for_decision(decision_id)` (backed by the append-only ledger)
returns True for any decision already recorded, so resubmission is a no-op — exposure
is never duplicated after a crash.

## 5. Replay

```python
from src.paper import PaperSession
m   = PaperSession.load_manifest(root, session_id)
req = PaperSession.replay_requirements(m)   # {data_snapshot_ids, model_versions, ...,
                                            #  replayable: bool, missing: [...]}
```

A session is replayable only if the manifest pins data snapshots, model versions,
and feature version. Missing identities → `replayable: False` (fail-closed for replay).

## 6. Evidence & readiness

- Metrics (`src/paper/evidence.py`) always carry `sample_size` / `effective_sample_size`
  / CI / `status`. Below the configured minimum they are `INSUFFICIENT_EVIDENCE` with
  a `None` value — never a fabricated point estimate.
- **Official evidence** requires `REAL_MARKET_DATA` + `OFFICIAL_EVIDENCE` + complete
  provenance. Synthetic/replay/diagnostic/degraded/untrusted records are excluded.
- `ReadinessEvaluator` rolls the 8 gates into `ALPHAFORGE_PAPER_READY` /
  `_READY_WITH_LIMITATIONS` / `_NOT_READY`. Any BLOCKED gate ⇒ NOT_READY; any
  INSUFFICIENT_EVIDENCE gate (with none blocked) ⇒ READY_WITH_LIMITATIONS.

## 7. What operators must NOT do

- Do not enable a live/production mode (no supported path).
- Do not hand-edit ledgers, manifests, or reconciliation files (append-only).
- Do not present synthetic/replay results as official performance evidence.
- Do not auto-promote, auto-retrain, or auto-recalibrate in response to an alert —
  those remain deliberate, human-run actions.
