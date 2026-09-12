# ALPHAFORGE PRODUCTION READINESS

**Production readiness assessment + final scorecard + critical blockers.** Read-only.
2026-09-09, git `1c2941b`.

---

## 1. RUNTIME / API / UI (Phase 21)

The improved engines (grade, quality, EV, A+ factory, meta probability) have **no
runtime caller**, so they do not reach the UI at all. The UI surfaces (Signal Center,
Daily Picks, AI Signals, F&O Trend) are fed by the **old** live path. A backend→UI
field-consistency trace for the *new* grade/probability/quality fields is therefore
**moot** — those fields are not produced in production. **Status: the new scoring does
not reach the UI. 🟡/❌**

---

## 2. TEST SUITE (Phase 22)

- **208 files / 3280 tests pass**, 0 fail. Strong unit coverage of the engines.
- **Gap:** tests are almost entirely **unit-level on pure functions with synthetic
  inputs**. There are **no integration/e2e tests** that run raw data → grade →
  paper-trade → outcome through the *new* stack, and none that assert
  backend-to-UI field parity for the new fields. Passing tests here prove the
  libraries compute what they claim — they do **not** prove the system trades
  profitably. Classify the new-stack behavioral coverage as **NOT VALIDATED**.

---

## 3. PRODUCTION READINESS CHECKLIST (Phase 23)

| Item | Status | Note |
|---|---|---|
| Logging / observability | ✅ | structured `mdLog`, provider_switch events |
| Model / feature / dataset versioning | 🟡 | schema exists; deployed artifacts unversioned; no dataset_meta sidecar |
| Reproducibility / deterministic inference | ✅ (engines) / ❌ (e2e) | engines pure; full run needs creds + intraday history |
| Failure recovery / provider failover | ✅ | circuit breakers + cooldown |
| Stale-data protection | ✅ | staleness thresholds + penalties |
| Circuit breakers / rate limiting | ✅ | `health.ts` |
| DB consistency / idempotency | 🟡 | unique constraints; runtime cross-tf dedup gap (DUP-001) |
| Concurrency / race conditions | 🟡 | not adversarially tested here |
| Duplicate signals | ⚠️ | DUP-001 inflation observed (1.31×–3×) in live path |
| Insufficient data → WAIT/ABSTAIN/NO_TRADE (not fabricated confidence) | ✅ | untrained meta abstains to prior 0.5; NetEV≤0 → NO_TRADE |
| Provider outage cannot create high-confidence signal | ✅ | fail-closed to abstention/prior |
| Durable outcome persistence | ❌ | in-memory store only (no Prisma adapter) |
| Risk engine wired | ❌ | `PortfolioRiskEngine` unwired (RISK-001) |

---

## 4. FINAL CERTIFICATION SCORE (Phase 24)

| Area | Score /10 | Basis |
|---|---:|---|
| Prompt #1 Forensic Audit | 6 | Honest audit exists; some findings narrative not measured |
| Prompt #2 Predictive Quality | 4 | Built + tested; untrained weights; monotonicity NOT MEASURABLE |
| Prompt #3 A+/A/B Grading | 4 | Multi-criteria + anti-inflation; realized monotonicity NOT MEASURABLE |
| Prompt #4 ML Calibration | 5 | Rigorous machinery; runtime untrained; calibration unproven |
| Prompt #5 Strategy/Regime | 4 | Per-strategy logic + health; realized matrix NOT MEASURABLE |
| Prompt #6 Profitability Engine | 6 | Best engine: full cost stack, net-EV gate, stress, counterfactual; unwired |
| Prompt #7 Closed-Loop Learning | 4 | Look-ahead-safe + champion/challenger; **in-memory only → loop not closed** |
| Prompt #8 A+ Factory | 5 | Strong unit design; synthetic-only proof; unwired |
| Prompt #9 E2E Profitability | 3 | Chain/no-NSE ✅; **realized net expectancy negative**; not reproducible |
| Prompt #10 ML Retraining | 5 | Rigorous pipeline; **0/7 models pass**; provenance not populated |
| Data Layer | 8 | Correct chain, failover, staleness, no-NSE — strongest area |
| Leakage/Bias | 7 | Look-ahead-safe labeling + resolution; scaler-per-fold + DUP-001 caveats |
| Testing | 5 | 3280 unit tests pass; no e2e/behavioral coverage of new stack |
| Production Readiness | 3 | Unwired stack, in-memory persistence, unwired risk engine |

**Aggregate percentages:**
- **IMPLEMENTATION COMPLETENESS: ~65%** — most components exist as code.
- **VALIDATION COMPLETENESS: ~25%** — only unit + data-layer; realized proofs absent.
- **PROFITABILITY EVIDENCE: ~5%** — one real dataset, and it is negative.
- **PRODUCTION READINESS: ~30%** — data layer ready; the signal-intelligence stack is not.

---

## 5. CRITICAL BLOCKERS (Phase 25)

### P0 — catastrophic (block live trading)
1. **Improved signal stack is unwired.** `runAPlusFactory`, `runProfitabilityPipeline`,
   and the meta-artifact resolver have **no runtime caller**. The grades/probabilities/
   EV/A+ selections the prompts describe **do not exist in production**. *(evidence:
   grep of `src/{app,features,workers,server}` → no matches.)*
2. **No durable outcome persistence.** Only `InMemorySignalRecordStore` implements
   `SignalRecordStore`; no Prisma adapter. The closed loop cannot accrue data, so
   learning, calibration training, and champion/challenger cannot run for real.
3. **Negative realized net expectancy.** The only real dataset is −0.18%/trade
   (25.68% WR vs 42.01% break-even), −₹32,624. The live system currently loses money.

### P1 — major
4. **0/7 ML models pass their OOS acceptance gate** (regime acc 0.474; ranker IC
   0.0041; risk fold-fail; strategy dep-blocked; forecaster/IV not run; meta
   untrainable). No demonstrated OOS predictive edge.
5. **Runtime probability is uncalibrated** (untrained `defaultMetaArtifact`,
   prior 0.5). "70% ≈ 70%" is unproven and currently false.
6. **Grade / quality / A+ monotonicity all NOT MEASURABLE** — no grade/quality/
   probability/regime persisted on any resolved trade (0/321). Core predictive claims
   are unproven → INSUFFICIENT EVIDENCE.
7. **Risk engine unwired** (RISK-001) — no portfolio/correlation/VaR enforcement live.
8. **Duplicate-confirmation inflation present in live path** (DUP-001, 1.31×–3×).

### P2 — important
9. No integration/e2e/behavioral tests for the new stack; deployed model artifacts
   lack provenance; no `dataset_meta.json`; multi-session replay impossible (RCA-001).

### P3 — minor
10. UI cannot show new fields (they aren't produced); per-fold scaler leakage and
    exhaustive credential-log audit not verified.

---

## 6. PRODUCTION-READINESS VERDICT

The **data layer** is production-credible. The **signal-intelligence + ML stack** is
**not**: it is unwired, its persistence is in-memory, its models show no OOS edge, its
probabilities are uncalibrated, and the one real profitability datapoint is negative.
**Not ready for live trading.**
