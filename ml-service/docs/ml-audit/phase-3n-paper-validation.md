# Phase 3N — Indian Market Paper-Trading Validation & Production-Readiness Gate

**Branch:** `refactor/improve-ml-service`
**Nature:** VALIDATION phase — no new predictive model. Determines whether the
end-to-end AlphaForge stack is trustworthy against real Indian-market data, and
builds the paper-trading + evidence + readiness machinery to judge that honestly.
**Result:** `PHASE_3N_PASS` / `ALPHAFORGE_PAPER_READY_WITH_LIMITATIONS`.

---

## 1. What Phase 3N adds

A new import-clean package `src/paper/` (7 modules) that ORCHESTRATES and VALIDATES
the Phase 3A–3M stack — it reuses everything and reimplements nothing:

| Module | Purpose | Reuses |
|--------|---------|--------|
| `providers.py` | canonical provider-response contract + explicit fallback semantics + config-driven cross-provider consistency | data-service `schemas_v2` concepts |
| `data_quality.py` | market-calendar / freshness / OHLCV / F&O / option-chain / corporate-action / universe / no-lookahead validation | `execution.market_calendar.NSECalendar`, `src/data` PIT stores |
| `signals.py` | canonical signal contract + dedup by evidence group + conflict classification | `prediction_provenance` semantics; final resolution owned by `decision.DecisionPipeline` |
| `paper_engine.py` | paper order state machine + idempotent multi-order book + partial fills | `execution.FillEngine`/`cost_model`, `shadow.ShadowLedger`, `decision.assert_not_live` |
| `session.py` | session manifest + EOD reconciliation + replay + recovery + kill switch | `lifecycle._storage`, `shadow.ShadowLedger` |
| `evidence.py` | metrics with sample-size/CI/status + conditional breakdowns + multiple-testing + official-evidence gating | numpy |
| `readiness.py` | 8 production-readiness gates → paper-readiness verdict | — |

## 2. Hard constraints (enforced + tested)

- **Provider hierarchy** Data Service → Angel One → Upstox → Yahoo (Tier 0→3). No
  new NSE scraper; NSE stays in the designated data-service tier. Fallback is
  explicit (PRIMARY/FALLBACK/PARTIAL/STALE/INVALID/UNAVAILABLE), every event
  recorded, **never a silent provider merge**.
- **Point-in-time / no-lookahead**: `information_timestamp ≤ decision_time` for
  every input; future price/volume/OI/chain/CA/universe/model/calibration/
  portfolio/fill/provider data is rejected (spec §23, §56).
- **Paper / shadow / research only. LIVE is forbidden** — `assert_not_live` guards
  `PaperOrder`, `PaperTradingEngine`, `PaperSession`; `PaperReadiness` has no
  LIVE_READY member. No broker order path exists (`src/paper` has zero broker-call
  tokens).
- **No auto-retraining / recalibration / promotion** (reconfirmed; all human-gated
  or recommendation-only).
- **Official-evidence separation** (spec §45, §57): only `REAL_MARKET_DATA` +
  `OFFICIAL_EVIDENCE` + complete provenance counts toward readiness. Synthetic /
  replay / diagnostic / degraded / untrusted records are excluded — a convenient
  synthetic run can never become a performance claim.

## 3. Environment reality & honest verdict

This environment has **no reachable Indian-market data tier**: `DATA_SERVICE_URL`
unset; Angel One / Upstox / Yahoo / NSE / BSE unreachable; `yfinance` / `sklearn` /
`talib` absent. Therefore **no `REAL_MARKET_DATA` session is possible here**, and
fabricating one would be a §64 hard-stop violation.

Accordingly:
- Correctness / safety / PIT / idempotency / recovery / gate logic ARE fully
  validated on tagged `SYNTHETIC_DATA` (62 Phase 3N tests + 1129-test regression,
  zero regressions).
- The **economic-readiness question is `INSUFFICIENT_EVIDENCE`** and reported as
  such — never fabricated.

Readiness gate rollup (see `reports/phase_3n_readiness_report.json`):

| Gate | Status | Why |
|------|--------|-----|
| DATA | INSUFFICIENT_EVIDENCE | no real-market data reachable |
| FEATURES | INSUFFICIENT_EVIDENCE | feature pipeline needs real data |
| MODELS | INSUFFICIENT_EVIDENCE | talib/sklearn absent → trained models not loadable here |
| CALIBRATION | INSUFFICIENT_EVIDENCE | depends on models/data |
| RISK | READY | portfolio engine present + tested |
| EXECUTION | READY | Phase 3G simulator present + tested |
| PAPER | READY | paper engine validated this phase |
| EVIDENCE | INSUFFICIENT_EVIDENCE | no official real-market evidence |

No gate is BLOCKED → `ALPHAFORGE_PAPER_READY_WITH_LIMITATIONS`. Readiness reflects
correctness/safety/integrity, **not profitability** (spec §47), and LIVE is **not
authorized** (spec §61).

## 4. End-to-end paper flow

```
Indian Market Data (provider chain: DataService→Angel→Upstox→Yahoo, fail-closed)
   → Provider validation (contract + cross-provider consistency)
   → Data quality + PIT (calendar / freshness / OHLCV / F&O / option-chain / CA /
     universe / no-lookahead)  ── any CRITICAL issue → fail closed
   → Signal families → CanonicalSignal → dedup by evidence group → conflict class
   → decision.DecisionPipeline (fail-closed; owns TAKE/SKIP/ABSTAIN/INSUFFICIENT)
   → portfolio / risk (override on breach)
   → EXECUTION_PLANNED
   → PaperTradingEngine.submit_decision (idempotent; kill switch →
     NO_NEW_PAPER_EXPOSURE) → reused FillEngine (gaps/circuits/partials) →
     PaperOrder state machine → PaperPositionBook
   → PaperSession EOD reconciliation (predicted vs realized; never fabricated)
   → evidence metrics (n / CI / status; official-evidence gating)
   → readiness gates → paper-readiness verdict
```

Every step fails closed and is paper-only; there is no broker path anywhere.

## 5. Tests & evidence

- `tests/test_phase3n.py` — 62 tests, all passing: provider fallback, data quality,
  signals, paper engine, session/kill-switch/replay/recovery, evidence, readiness,
  the §56 adversarial no-lookahead suite, and a static security audit.
- Full regression (3A–3N + vpin + meta + monitoring): **1129 passed, 0 failed**.
- Evidence artifacts: `reports/phase_3n_manifest.json` +
  `phase_3n_{data_quality,provider,signal,decision,paper,reconciliation,readiness}_report.json`
  + `phase_3n_test_results.json`, generated deterministically by
  `scripts/gen_phase3n_evidence.py`.

## 6. Scope stop

Phase 3N is a validation gate. There is no Phase 3O, no live trading, no automatic
promotion/retraining/recalibration, and no new predictive model.
