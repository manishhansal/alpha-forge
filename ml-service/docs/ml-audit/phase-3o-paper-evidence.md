# Phase 3O — Paper-Trading Evidence Accumulation, Reliability & Go/No-Go Gate

**Branch:** `refactor/improve-ml-service`
**Type:** VALIDATION / EVIDENCE phase — **no new predictive model**
**Package:** `ml-service/src/paper3o/` (additive; Phase 3N `src/paper` untouched)
**Final status:** `PAPER_CONTINUE_WITH_LIMITATIONS`
**Live authorization:** **DISABLED** (there is no `LIVE_READY` state in this phase)

---

## 1. What this phase is (and is not)

Phase 3O asks a single question: **is the AlphaForge stack trustworthy enough, and
sufficiently evidenced, to keep accumulating paper evidence?** It does not build a
new model, does not retrain, does not recalibrate, and does not tune any threshold
on paper results. It orchestrates the existing 3A–3N layers, records what actually
happens, and grades the result honestly.

Three things must be stated plainly and hold everywhere in this phase:

- **Paper evidence ≠ live performance.** A paper session simulates fills and costs;
  it does not place a real order.
- **Historical/synthetic evidence ≠ future results.** Reproducibility is not a
  prediction.
- **`PAPER_CONTINUE` ≠ `LIVE_READY` ≠ profitable ≠ confirmed alpha.** The gate
  certifies *machinery trustworthiness*, not money-making ability.

In this environment no real Indian-market data source is reachable, so the
**economic and statistical evidence is `INSUFFICIENT_EVIDENCE`** — reported as such,
never fabricated. The machinery itself is validated on clearly-tagged SYNTHETIC
data.

---

## 2. Architecture (`src/paper3o/`)

| Module | Responsibility |
|--------|----------------|
| `session_lifecycle.py` | Formal `PaperSession` state machine (CREATED → INITIALIZING → RUNNING → PAUSED/DEGRADED → COMPLETED → RECONCILING → RECONCILED, plus FAILED/BLOCKED); full replay manifest; immutability + revisions; chronological guard. |
| `journals.py` | Append-only decision / order / position journals. Abstention is a first-class outcome. No fake fills. F&O position fields. |
| `evidence_store.py` | Multi-session accumulation; evidence tiers E0–E5; OFFICIAL / DIAGNOSTIC / FAILED / INVALID / SYNTHETIC separation; contamination → INVALID (never deleted); experiment registry. |
| `analysis.py` | Deterministic baselines; alpha attribution; ablation (never on safety); RL execution comparison; cost→net attribution; turnover; capacity. |
| `quality.py` | Calibration; EV validation; decile monotonicity; cross-sectional IC; regime breakdown; signal-family correlation; drift; alpha decay; latency; session-quality dimensions; stability. |
| `reliability.py` | Failure tracking; observed provider reliability; safe failover; fail-closed recovery; accounting identity; idempotency. |
| `gate.py` | Seven-dimension Go/No-Go gate + final `Phase3OManifest`. |

Everything reuses the canonical stack: `decision`, `execution` (cost/fill/slippage),
`shadow.ShadowLedger`, `lifecycle._storage`, and the Phase 3N `src/paper` surface
(`providers`, `data_quality`, `signals`, `evidence`, `readiness`). Import is clean —
no `talib`/`torch`/`sklearn`/`yfinance`/`sqlalchemy` pulled in.

---

## 3. Session lifecycle & replay

A session is driven through an explicit state machine; illegal transitions raise
`InvalidSessionTransition` and terminal states (RECONCILED/FAILED/BLOCKED) have no
exit. On COMPLETED/RECONCILED the manifest is **frozen** — evidence is never mutated;
corrections happen via `revise()`, which creates a new revision that *supersedes* the
original and never touches it.

`replay_id` is a SHA-256 over the replay-relevant fields *excluding* the session id
and timestamps, so two sessions with identical configuration share a replay identity
regardless of their id. `replay_gaps()` lists any missing reproducibility inputs.

**Chronological processing (no lookahead):** `record_processing(ts)` rejects any
decision timestamp earlier than the last processed one — future information can never
leak into a prior decision.

---

## 4. Evidence lifecycle

Each session's contribution is classified deterministically:

```
contamination present        → INVALID     (kept forever, never counted)
data_tag != REAL_MARKET_DATA → SYNTHETIC
not reconciled               → FAILED
provenance incomplete        → DIAGNOSTIC
otherwise                    → OFFICIAL     (only this drives the decision)
```

Tiers: INVALID→E0, SYNTHETIC→E1, FAILED/DIAGNOSTIC→E2, a single OFFICIAL paper
session→E4; E5 requires many OFFICIAL sessions across multiple regimes. OFFICIAL
sessions are grouped by `replay_id` so incompatible configurations are never merged
into one performance series.

In this environment every session is SYNTHETIC, so the corpus tier is **E1**.

---

## 5. Statistical evaluation

All metrics carry `n` / effective-n / CI / status and fall back to
`INSUFFICIENT_EVIDENCE` when data is thin — nothing is asserted from a handful of
points. Reporting rules (spec §68) are enforced: a Sharpe needs window + n +
frequency + cost basis; a win-rate needs a trade count; calibration needs a minimum
`n`; an RL claim needs a baseline + paired deltas + uncertainty. **NET after real
Indian costs is the only economic headline** — gross is only ever a decomposition
input.

---

## 6. Ablation

Ablation compares the full system against a variant with one **non-safety**
component removed. Safety components (risk limits, kill switch, provenance,
data-quality, no-lookahead, reconciliation) can **never** be ablated —
`assert_ablatable` refuses. A component only earns
`CONFIRMED_INCREMENTAL_VALUE` when the paired delta's CI excludes zero;
`NO_CONFIRMED_INCREMENTAL_VALUE` is a valid, honest result, not a defect.

---

## 7. Provider reliability & failure/recovery

Provider availability is **observed**, never an assumed SLA — with no observations
it is `UNKNOWN`/`None`. Failover treats any stale or malformed provider as unusable
and, if nothing is usable, resolves to `NO_NEW_DECISIONS`; it can never emit
corrupted data. Recovery resumes only when persisted state exists *and* resuming
would not duplicate exposure — otherwise it fails closed.

The accounting identity is the hard invariant:

```
opening_equity + net_flows + realized_pnl + unrealized_pnl − costs == closing_equity
```

A residual beyond tolerance is an `UNEXPLAINED_MISMATCH` and a hard blocker.
Idempotency guards ensure a replayed decision/order/fill/reconcile is a no-op.

---

## 8. Security & live-path audit

`src/paper3o` contains **no** broker-call tokens (`place_order`, `SmartConnect`,
`generateSession`, `api_secret`, `access_token`, …) and **never authorises live
trading** — `live_authorized` is always `False`. Live mode is rejected at session
construction via `assert_not_live`.

---

## 9. Go/No-Go gate

Six graded dimensions (Data / Decision / Execution / Accounting / Statistical /
Operational) are each PASS / FAIL / INSUFFICIENT_EVIDENCE; Security is binary
PASS / FAIL (an unverifiable security state is treated as FAIL). The gate is
**fail-closed**:

- any hard blocker → `PAPER_BLOCKED`
- Security not PASS → `PAPER_BLOCKED`
- any graded FAIL → `PAPER_BLOCKED`
- any graded INSUFFICIENT_EVIDENCE → `PAPER_CONTINUE_WITH_LIMITATIONS`
- all graded PASS + Security PASS + no blockers → `PAPER_CONTINUE`

### This run

| Dimension | Status |
|-----------|--------|
| Data integrity | PASS (PIT + no-lookahead verified on synthetic) |
| Decision integrity | PASS (abstention first-class, deterministic) |
| Execution integrity | PASS (no fake fills, consistent sim) |
| Accounting integrity | PASS (identity holds, idempotent) |
| Statistical evidence | **INSUFFICIENT_EVIDENCE** (no real-market data reachable) |
| Operational reliability | PASS (safe failover, fail-closed recovery) |
| Security | PASS (no tokens, no live path) |

**Final status: `PAPER_CONTINUE_WITH_LIMITATIONS`.** The machinery is deterministic,
safe, recoverable and fully tested; the single limitation is that real-market
statistical and economic evidence cannot be gathered in this environment. That is a
limitation of the environment, not a defect of the system, and it is reported
honestly rather than papered over with fabricated numbers.
