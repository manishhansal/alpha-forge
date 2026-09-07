# Phase 3O — Evidence Runbook

Operational guide for running Phase 3O paper-evidence accumulation and reading the
Go/No-Go result. This phase performs **no live action, no retrain, no recalibration,
no threshold tuning**, and **never authorises live trading**.

---

## 0. Prerequisites

- Run everything from `ml-service/`.
- Python deps present in this environment: `numpy`, `scipy`, `pandas`,
  `fastapi`, `pydantic`. The `src/paper3o` package is import-clean (no
  `talib`/`torch`/`sklearn`/`yfinance`/`sqlalchemy`).
- Real Indian-market data is reached via `DATA_SERVICE_URL` when available. If it is
  unset (as in this environment), sessions are SYNTHETIC and the economic/statistical
  evidence is reported as `INSUFFICIENT_EVIDENCE` — this is expected, not an error.

---

## 1. Run the test matrix

```bash
python3 -m pytest tests/test_phase3o.py -q -p no:cacheprovider
```

Expected: `55 passed`. This exercises the full §65 behavioural matrix plus the §67
adversarial fail-closed suite (future-data rejection, safety-ablation refusal,
contamination → INVALID, accounting mismatch → blocked, idempotency, live-mode
forbidden, no-broker-token static audit).

Full regression (excluding the six pre-existing dependency-absence failures):

```bash
python3 -m pytest tests/ -q -p no:cacheprovider \
  --ignore=tests/test_validation.py --ignore=tests/test_talib_perf.py \
  --ignore=tests/test_technical.py --ignore=tests/test_portfolio_optimizer.py \
  --ignore=tests/test_gex.py --ignore=tests/test_data_pipeline.py
```

Expected: `1267 passed / 28 skipped / 0 failed` — zero new regressions.

---

## 2. Generate the evidence bundle

```bash
python3 scripts/gen_phase3o_evidence.py
```

Writes 13 deterministic artifacts to `reports/phase-3o/`:

| Artifact | Contents |
|----------|----------|
| `phase_3o_manifest.json` | phase-level manifest (§75): versions, session/experiment ids, test result, evidence level, final status |
| `paper_session_manifest.json` / `paper_session_report.json` | one synthetic session's replay manifest + report |
| `cumulative_report.json` | multi-session evidence-class counts + tier + official series |
| `signal_attribution.json` / `ablation_report.json` / `rl_comparison.json` | analysis artifacts (all INSUFFICIENT_EVIDENCE without real net returns) |
| `provider_reliability.json` / `failure_recovery_report.json` | observed reliability + failover/recovery semantics |
| `statistical_evidence.json` / `production_safety.json` / `paper_readiness.json` | statistical status, safety invariants, gate result |
| `phase_3o_test_results.json` | test command + pass/fail/skip counts |

The generator is deterministic (fixed timestamp + seeds) and computes every number
from the `src/paper3o` machinery on tagged SYNTHETIC data. It fabricates nothing and
cherry-picks nothing (losing / flat / adverse synthetic sessions are included).

---

## 3. Read the gate

Open `reports/phase-3o/paper_readiness.json`:

- `final_status` is one of `PAPER_CONTINUE` / `PAPER_CONTINUE_WITH_LIMITATIONS` /
  `PAPER_BLOCKED`.
- `live_authorized` is **always** `false`.
- Each of the seven gate dimensions carries its own status + reason.

Interpreting the result:

- **PAPER_CONTINUE** — machinery is trustworthy; keep accumulating paper evidence.
  (Not profitable, not live-ready, not confirmed alpha.)
- **PAPER_CONTINUE_WITH_LIMITATIONS** — trustworthy, but at least one dimension is
  only `INSUFFICIENT_EVIDENCE` (in this environment: statistical/economic evidence,
  because no real-market data is reachable).
- **PAPER_BLOCKED** — a hard integrity/safety violation, or the gate could not be
  determined. Fail-closed.

Current run: **`PAPER_CONTINUE_WITH_LIMITATIONS`**.

---

## 4. What to do when real market data becomes available

1. Set `DATA_SERVICE_URL` and confirm the provider chain is reachable.
2. Run real (not synthetic) paper sessions; each produces an OFFICIAL session only
   when reconciled + provenance-complete + uncontaminated.
3. Accumulate OFFICIAL sessions across multiple regimes to raise the evidence tier
   (E4 → E5) and to move Statistical evidence from INSUFFICIENT_EVIDENCE to PASS.
4. Re-run the gate. **Do not** retrain, recalibrate, or tune any threshold on paper
   results — that is out of scope for this phase and would contaminate the evidence.

---

## 5. Hard stops

- No live trading is ever authorised here.
- No auto-promote / retrain / recalibrate.
- No new predictive model.
- No threshold tuning on paper results.
- No cherry-picking of sessions or metrics.
