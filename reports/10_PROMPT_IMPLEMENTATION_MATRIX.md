# 10-PROMPT IMPLEMENTATION MATRIX

**Audit type:** Independent, adversarial, read-only forensic validation.
**Date:** 2026-09-09 · **Git:** `1c2941b` · **Production code changed:** NONE.
**Evidence rule:** functionality counts only when demonstrable in executable code +
tests + data + runtime behavior. File/function existence alone counts as
🟡 IMPLEMENTED BUT NOT VALIDATED, never ✅.

**Status legend:** ✅ FULLY IMPLEMENTED · ⚠️ PARTIALLY IMPLEMENTED ·
❌ NOT IMPLEMENTED · 🔴 IMPLEMENTED BUT INCORRECT · 🟡 IMPLEMENTED BUT NOT VALIDATED.

**Cross-cutting evidence used throughout:**
- Test suite: **208 files / 3280 tests pass** (unit-level only).
- **Runtime-wiring grep** of `src/{app,features,workers,server}` for
  `runAPlusFactory | runProfitabilityPipeline | setIndiaMetaArtifactResolver` →
  **no matches**. The new engines are pure libraries with **no runtime caller**.
- **Only real outcome dataset**: `reports/today-signal-ledger-2026-09-01.json`
  (321 trades, one session). It contains **no** grade/quality/probability/regime/
  returnR/MFE/MAE/modelVersion fields (0/321 each) → most realized-performance
  requirements are **NOT MEASURABLE FROM REAL DATA**.
- Real realized performance: **25.68% win rate, −0.18%/trade, −₹32,624**,
  break-even 42.01% → **negative net expectancy**.
- ML retrain (real daily tensors, walk-forward): **0/7 models gate-passing**.

---

## PROMPT 1 — Indian Signal Forensic Audit

| Requirement | Expected | File(s)/Fn | Status | Evidence | Test | Runtime | Data | Issue | Sev |
|---|---|---|---|---|---|---|---|---|---|
| Audit report based on real measurements | Report with real numbers | `reports/ALPHAFORGE_SIGNAL_ENGINE_SCORECARD.md`, `INDIA_SIGNAL_FORENSIC_AUDIT.md` | ✅ | Scorecard cites 53/100, 7 blockers, real ledger numbers | n/a | n/a | real (session) | Single-session basis | P2 |
| Signal lineage / strategy inventory | Enumerated | scorecard + `today-signal-ledger` (10 strategies) | ✅ | 10 strategyIds in ledger | n/a | yes | real | — | — |
| Identify hardcoded weights/thresholds | Called out | scorecard/audit | ✅ | Documented (uniform priors flagged) | n/a | n/a | n/a | — | — |
| Identify leakage / look-ahead / survivorship | Called out | audit reports | ⚠️ | Named but not quantified with tests | n/a | n/a | partial | Not test-backed | P2 |
| Quality-score monotonicity measured | Real measurement | — | ❌ | No per-trade quality persisted (0/321) | n/a | n/a | absent | Cannot measure | P1 |

**Prompt 1 net:** ⚠️ PARTIALLY IMPLEMENTED — audit exists and is honest, but several
findings are narrative, not measurement-backed.

---

## PROMPT 2 — Predictive Signal Quality Engine

| Requirement | Expected | File(s)/Fn | Status | Evidence | Test | Data | Issue | Sev |
|---|---|---|---|---|---|---|---|---|
| Multi-component quality (prob/hist/EV/regime/MTF/…/sample confidence) | Composite | `src/lib/signal-intelligence/predictive-quality-engine.ts` | 🟡 | Components implemented; unit tests pass | ✅ unit | — | Not wired to runtime | P1 |
| Weights learned from OOS (not hardcoded) | OOS-learned | same | 🔴/🟡 | Default weights = `UNTRAINED_UNIFORM_PRIOR`; learning path exists but no persisted OOS training | partial | absent | Runtime uses untrained priors | P1 |
| Small-sample shrinkage / Wilson/Beta uncertainty | Statistical | quality + grading engines | 🟡 | Wilson gating present in code + tests | ✅ unit | — | Not validated on real outcomes | P2 |
| Missing data → uncertainty (not directional evidence) | Correct | quality engine | 🟡 | Coded; unit-tested | ✅ unit | — | Not runtime-validated | P2 |
| Deterministic + reproducible | Pure | engine + tests | ✅ | Determinism tests pass | ✅ | — | — | — |
| **Quality monotonic with realized profitability** | 90–100 > 80–90 > … | — | ❌ | **NOT MEASURABLE** — quality not persisted per trade (0/321) | ❌ | absent | No evidence quality predicts P&L | **P1** |

**Prompt 2 net:** 🟡 IMPLEMENTED BUT NOT VALIDATED — the predictive claim is unproven
on real data; runtime still uses untrained weights.

---

## PROMPT 3 — Evidence-Based A+/A/B Grading

| Requirement | Expected | File(s)/Fn | Status | Evidence | Test | Data | Issue | Sev |
|---|---|---|---|---|---|---|---|---|
| Grade from calibrated prob + net EV + quality + … | Multi-factor | `src/lib/signal-intelligence/evidence-grading-engine.ts`; `profitability-engine.gradeProfitability` | 🟡 | 12 Wilson-gated A+ criteria; net-EV gate (gross EV can't earn A/A+) | ✅ unit | — | Unwired | P1 |
| A+ not simply quality>X & EV>Y | Empirical thresholds | grading engine | 🟡 | Multi-criteria, but thresholds are defaults, not OOS-justified | ✅ unit | absent | Thresholds not OOS-calibrated | P1 |
| Grade uses no future data | No look-ahead | grading engine | 🟡 | Pure fn of provided inputs | ✅ unit | — | — | — |
| Anti-grade-inflation check | Present | `evidence-grading-engine.inflationRatio()` | 🟡 | Code + tests | ✅ unit | — | Not runtime-validated | P2 |
| **A+ > A > B > C on realized expectancy/PF** | Monotonic | — | ❌ | **NOT MEASURABLE** — no grade on any resolved trade (0/321) | ❌ | absent | Core claim unproven | **P1** |
| grade × regime / strategy / timeframe tables | Segmented | — | ❌ | No grade/regime persisted; only strategy+timeframe axes exist | ❌ | absent | — | P1 |

**Prompt 3 net:** 🟡 IMPLEMENTED BUT NOT VALIDATED.

---

## PROMPT 4 — ML Probability & Calibration

| Requirement | Expected | File(s)/Fn | Status | Evidence | Test | Data | Issue | Sev |
|---|---|---|---|---|---|---|---|---|
| Separate confidence/probability/quality/EV | Distinct | `ml-meta-decision.ts` types | ✅ | Distinct fields carried through | ✅ unit | — | — | — |
| Walk-forward / purged K-fold / embargo | OOS-correct | `ml-service/src/validation/*`; `ml-meta-training.walkForwardSplit` | ✅ | Real purged/embargo CV in Python | ✅ unit | real (daily) | — | — |
| Calibration method chosen by OOS (Platt/isotonic/beta) | Data-driven | `ml-meta-training.selectCalibrationMethod` | 🟡 | Selection logic present + tests | ✅ unit | — | Not run on persisted outcomes | P1 |
| Hierarchical fallback strat+regime+tf→…→global | Implemented | `ml-meta-training` levelDefs | 🟡 | Coded + tested | ✅ unit | — | Unwired | P2 |
| Produce rawP/calibratedP/LB/UB/method/quality/agreement/uncertainty | All fields | `ml-meta-decision.decide` | 🟡 | Fields produced by `decide()` | ✅ unit | — | Runtime returns `defaultMetaArtifact` (untrained, method=raw, prior 0.5) | **P1** |
| **Predicted prob ≈ realized (Brier/ECE/reliability)** | Calibrated | — | ❌ | **NOT MEASURABLE** — no predicted-prob/outcome pairs persisted | ❌ | absent | Calibration unproven | **P1** |

**Prompt 4 net:** 🟡 IMPLEMENTED BUT NOT VALIDATED — machinery is real and rigorous;
runtime is untrained and calibration is unproven on real outcomes.

---

## PROMPT 5 — Strategy + Regime Adaptive Signals

| Requirement | Expected | File(s)/Fn | Status | Evidence | Test | Data | Issue | Sev |
|---|---|---|---|---|---|---|---|---|
| Strategy-specific scoring / suitability | Per-strategy | `src/lib/signal-intelligence/strategy-regime-scoring.ts` | 🟡 | Per-strategy×regime profiles + tests | ✅ unit | — | Unwired | P2 |
| Health statuses ACTIVE/CAUTION/SHADOW/DISABLED | Present | strategy-regime-scoring | 🟡 | Statuses coded + tested | ✅ unit | — | Not driven by real rolling outcomes | P2 |
| Not disabled on tiny sample (stat evidence) | Guarded | same + learning loop | 🟡 | Sample-gating in code | ✅ unit | — | No real accumulating sample | P2 |
| **strategy × regime × timeframe realized matrix** | Real perf | — | ❌ | **NOT MEASURABLE** — regime not persisted; only strategy+timeframe | ❌ | absent | — | P1 |

**Prompt 5 net:** 🟡 IMPLEMENTED BUT NOT VALIDATED.

---

## PROMPT 6 — Profitability-First Opportunity Engine

| Requirement | Expected | File(s)/Fn | Status | Evidence | Test | Data | Issue | Sev |
|---|---|---|---|---|---|---|---|---|
| Full India F&O cost stack (brokerage/STT/exch/SEBI/GST/stamp/spread/slippage/impact) | Complete | `profitability-engine.COST_RATES`, `computeCostBreakdown` | ✅ | All components present, realistic NSE rates | ✅ unit | — | — | — |
| Net EV gate — gross EV can't earn A/A+ | Enforced | `gradeProfitability` (REJECT if netEV≤0 or !survives2x) | ✅ | Explicit gate + tests | ✅ unit | — | — | — |
| Cost stress 1×/1.5×/2×/3× | Ladder | `computeNetEV` (evAt2x/evAt3x) | ✅ | Stress ladder + tests | ✅ unit | — | — | — |
| Counterfactual robustness (entry/stop/target/slippage perturbations) | Present | `runCounterfactuals` | ✅ | Perturbation set + fragile flag + tests | ✅ unit | — | — | — |
| PCR/OI/MaxPain not independent conviction | Confirm-only | derivatives gate | 🟡 | `derivativesAloneRejected` gate coded | ✅ unit | — | Not validated on real options data | P2 |
| **Engine wired to runtime** | Live | — | ❌ | **No runtime caller** of `runProfitabilityPipeline` | n/a | absent | Pure library only | **P1** |

**Prompt 6 net:** ⚠️ PARTIALLY IMPLEMENTED — best-implemented engine of the set
(design + tests strong), but unwired and unvalidated on real fills.

---

## PROMPT 7 — Closed-Loop Signal Learning

| Requirement | Expected | File(s)/Fn | Status | Evidence | Test | Data | Issue | Sev |
|---|---|---|---|---|---|---|---|---|
| PredictionRecord persisted at creation (all fields) | Durable | `signal-learning-loop.ts` types | 🟡 | Types complete; **only `InMemorySignalRecordStore`** implements the store | ✅ unit | absent | **No Prisma adapter → nothing durable** | **P0** |
| ResolutionRecord at close (all fields) | Durable | same | 🟡 | Types complete; in-memory only | ✅ unit | absent | Not persisted | **P0** |
| Intrabar both-touched → not favorable | Conservative | `resolveAgainstCandles`; `paper-trader-core` | ✅ | Both-touched → STOP/LOSS (conservative) | ✅ unit | real | Look-ahead safe | — |
| Rolling 20/50/100/250 stats | Present | learning loop | 🟡 | Coded + tested | ✅ unit | absent | No durable history to roll over | P2 |
| No same-day retrain leakage / delayed retrain | Embargo | `buildRetrainSplit` | ✅ | Chronological + embargo split + tests | ✅ unit | — | — | — |
| Champion/challenger promotion | Statistical gate | `evaluateChampionChallenger` | 🟡 | Real gate (expectancy z≥1.96, Brier, DD) + tests | ✅ unit | absent | In-memory only; never runs on real data | P1 |

**Prompt 7 net:** ⚠️ PARTIALLY IMPLEMENTED — logic is sound and look-ahead-safe, but
the persistence layer is in-memory only, so the loop is not actually closed in prod.

---

## PROMPT 8 — A+ Signal Factory

| Requirement | Expected | File(s)/Fn | Status | Evidence | Test | Data | Issue | Sev |
|---|---|---|---|---|---|---|---|---|
| 14-stage ranking pipeline | Ordered | `a-plus-signal-factory.PIPELINE_STAGES` | ✅ | 14 stages present + test | ✅ unit | — | — | — |
| A+ rare, evidence-defined (no quota) | Emergent | `evaluateAPlusGate` (13 conds) | ✅ | Full-gate + evidence≥0.72; rarity test | ✅ unit | synthetic | — | — |
| Correlation dedup / independentSignalCount | No inflation | `clusterCandidates`, `independentConfirmations` | ✅ | Geometric-mean; dup-not-inflated tests | ✅ unit | synthetic | — | — |
| OpportunityScore = net-EV/risk (not confidence) | Correct | `computeOpportunityScore` | ✅ | Neg-EV→0 test | ✅ unit | synthetic | — | — |
| Evidence card (all fields) | Complete | `buildEvidenceCard` | ✅ | Field-completeness test | ✅ unit | — | — | — |
| **A+ > A > B on realized OOS outcomes** | Real | — | 🟡 | Monotonic on **synthetic** harness only; **NOT MEASURABLE** on real data | ✅ synth | absent | No real grade outcomes | **P1** |
| Wired to runtime / signal surface | Live | — | ❌ | **No runtime caller** of `runAPlusFactory` | n/a | absent | Pure library | **P1** |

**Prompt 8 net:** 🟡 IMPLEMENTED BUT NOT VALIDATED — excellent unit design, proven only
on synthetic data, unwired.

---

## PROMPT 9 — End-to-End Profitability Certification

| Requirement | Expected | File(s)/Fn | Status | Evidence | Test | Data | Issue | Sev |
|---|---|---|---|---|---|---|---|---|
| Fresh raw-data→outcome run | Reproducible | data-service + worker path | ⚠️ | Path exists; ran once (ledger). Cannot re-run: needs broker creds + intraday persistence | n/a | partial | Not reproducible in CI | P1 |
| Provider chain DS→AngelOne→Upstox→Yahoo + failover | Enforced | `registry.ts`, `failover.ts` | ✅ | Priority + failover + provenance implemented | ✅ unit | — | — | — |
| No direct NSE | Prohibited | `providers/nse.ts` (removed) | ✅ | Removed 2026-09-03; not registered | ✅ | — | — | — |
| **Profitable only if net expectancy > 0** | Real | ledger | 🔴 | **−0.18%/trade, −₹32,624, WR 25.68% < 42.01% BE** | n/a | real | **Negative edge** | **P1** |
| A+/A/B/C/REJECT realized performance | Segmented | — | ❌ | **NOT MEASURABLE** — no grade per trade | ❌ | absent | — | P1 |
| Statistical significance reported | Present | prior cert report | ✅ | WR far below BE at n=183 resolved | n/a | real | — | — |

**Prompt 9 net:** ⚠️ PARTIALLY IMPLEMENTED — chain/no-NSE ✅; the profitability verdict
itself is **FAIL / INSUFFICIENT EVIDENCE** (correctly reported, not faked).

---

## PROMPT 10 — ML Retraining + Champion/Challenger

| Requirement | Expected | File(s)/Fn | Status | Evidence | Test | Data | Issue | Sev |
|---|---|---|---|---|---|---|---|---|
| Time-series split / no leakage / untouched test | Rigorous | `ml-service/src/training/train_all.py` | ✅ | Walk-forward + PurgedKFold + embargo; HPO inner-only | ✅ | real (daily) | — | — |
| Policy-based labels (triple-barrier TARGET/STOP/TIME/AMBIGUOUS) | Correct | `ml-service/src/labels/triple_barrier.py` | ✅ | First-touch, conservative-SL, excludes ambiguous/incomplete | ✅ | real | — | — |
| Model inventory (7 models) | All | `ml-service/src/models/*` | ⚠️ | 5 exist (regime/ranker/strategy/risk/RL); forecaster+IV lightweight; meta in TS | partial | — | — | P2 |
| Trading metrics + AUC/Brier/ECE etc. | Both | `validation/metrics.py`, acceptance gate | ✅ | Gate uses Sharpe/PF/DD + accuracy/AUC | ✅ | real | — | — |
| Champion/challenger OOS acceptance | Gated | `train_all` gates + TS `evaluateChampionChallenger` | 🟡 | Gates real; **no challenger passed** | ✅ | real | Nothing promotable | P1 |
| Model metadata (version/period/manifest/hash/…) | Stored | `model_registry.ModelRecord` | ⚠️ | Schema complete; **deployed artifacts carry no provenance**; no `model_registry.json` | partial | — | Provenance not populated | P1 |
| **Models produce OOS edge** | Validated | retrain run | 🔴 | **0/7 gate-passing**: regime acc 0.474, ranker IC 0.0041, risk fold-fail, strategy dep-blocked | n/a | real | No OOS edge | **P1** |

**Prompt 10 net:** ⚠️ PARTIALLY IMPLEMENTED — pipeline is genuinely rigorous; the models
have **no demonstrated OOS edge** and provenance isn't populated for deployed artifacts.

---

## DATA LAYER (Phase 13)

| Requirement | Status | Evidence |
|---|---|---|
| Priority DS→AngelOne→Upstox→Yahoo | ✅ | `registry.bootstrapRegistry` |
| Failover / retry / backoff / cooldown | ✅ | `failover.ts` (3 retries, exp backoff+jitter, Retry-After, 10s cooldown) |
| Circuit breakers / rate-limit handling | ✅ | `health.ts` |
| Stale-data detection | ✅ | `health.STALE_THRESHOLDS_MS` + tick validator |
| Provider provenance | ✅ | `provider_switch` logs + `PaperTrade` provenance columns |
| No direct NSE | ✅ | removed + not registered |
| Credentials never logged | 🟡 | env-gated; not exhaustively audited for every log line | 
| Runtime uses frontend creds | 🟡 | env-driven; not verified end-to-end in CI |

**Data layer net:** ✅ largely FULLY IMPLEMENTED (strongest area), a couple of items
🟡 not-exhaustively-validated.

---

## SUMMARY COUNTS

| Net status | Prompts |
|---|---|
| ⚠️ PARTIALLY IMPLEMENTED | 1, 6, 7, 9, 10 |
| 🟡 IMPLEMENTED BUT NOT VALIDATED | 2, 3, 4, 5, 8 |
| ✅ FULLY IMPLEMENTED | Data layer (as a component) |
| 🔴 IMPLEMENTED BUT INCORRECT | (component-level) net-expectancy claim, 0/7 model edge |
| ❌ NOT IMPLEMENTED | Durable outcome persistence; all realized monotonicity/calibration proofs |

**The single most consequential finding:** the improved signal stack (Prompts 2, 3, 4,
6, 8) is **not wired into the runtime** and has **no persisted real outcomes**, so its
predictive/profitability claims are unproven, and the one real dataset shows a
**losing edge**.
