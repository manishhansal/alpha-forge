# ALPHAFORGE SIGNAL SYSTEM VALIDATION

**Adversarial architecture + implementation validation.** Read-only. No production
code changed. Date 2026-09-09, git `1c2941b`.

---

## 1. ARCHITECTURE & DEPENDENCY GRAPH — DESIGNED vs WIRED

The intended pipeline exists as modules, but there are **two disconnected halves**:
the **live runtime** (which produced the real ledger) and the **new engine stack**
(built this cycle, pure libraries, no runtime caller).

```
                        ┌─────────────── LIVE RUNTIME (produced the ledger) ───────────────┐
DATA (data-service→AngelOne→Upstox→Yahoo)  ✅ wired
  → NORMALIZATION (market-data/validation)  ✅ wired
  → FEATURES / STRATEGIES (features/india/*, scalping)  ✅ wired
  → SIGNALS  ✅ wired
  → PAPER TRADE (features/india/scalping/paper-trader)  ✅ wired
  → OUTCOME (paper-trader-core.resolveAgainstCandles)  ✅ wired, look-ahead-safe
                        └──────────────────────────────────────────────────────────────────┘

                        ┌────────── NEW ENGINE STACK (this cycle) — NOT WIRED ──────────────┐
  ML (ml-meta-decision) → CALIBRATION (ml-meta-training) → SIGNAL QUALITY
  (predictive-quality-engine) → EV (profitability-engine) → OPPORTUNITY/ABSTENTION/RISK
  → GRADE (evidence-grading-engine) → A+ FACTORY (a-plus-signal-factory)
  → [SIGNAL CENTER? no caller]                                            ❌ zero runtime callers
                        └──────────────────────────────────────────────────────────────────┘

  RETRAINING (ml-service/train_all)  ✅ runnable on daily data
  MODEL VALIDATION (acceptance gate)  ✅ runs — but 0/7 models pass
```

**Verification method:** `grep` across `src/{app,features,workers,server}` for
`runAPlusFactory | runProfitabilityPipeline | setIndiaMetaArtifactResolver` returned
**no matches**. The runtime meta-artifact resolver returns `defaultMetaArtifact()`
(untrained: `method:"raw"`, `globalPrior:0.5`, every model `addsValue:false`).

**Consequence:** the ledger reflects the **old** logic. The improved Prompts 2/3/4/6/8
engines cannot have influenced any real trade, so their claims are **unproven in
production** regardless of how good the unit tests are.

---

## 2. INVENTORY (19 subsystems requested)

| # | Subsystem | Present? | Wired to runtime? | Validated on real data? |
|---|---|---|---|---|
| 1 | India signal generators (10 strategies) | ✅ | ✅ | ⚠️ single session |
| 2 | Signal scoring | ✅ | partial | ❌ |
| 3 | Probability | ✅ (`ml-meta-decision`) | ❌ (untrained default) | ❌ |
| 4 | Confidence | ✅ | partial | ❌ |
| 5 | Grading | ✅ (`evidence-grading-engine`) | ❌ | ❌ |
| 6 | Signal Quality | ✅ (`predictive-quality-engine`) | ❌ | ❌ |
| 7 | EV | ✅ (`profitability-engine`) | ❌ | ❌ |
| 8 | Opportunity filters | ✅ (`opportunity-engine/*`) | partial | ❌ |
| 9 | ML models | ✅ (`ml-service`) | ❌ (fallback mode) | 🔴 0/7 gate-pass |
| 10 | Calibration | ✅ (`ml-meta-training`) | ❌ | ❌ |
| 11 | Training pipelines | ✅ (`train_all`) | n/a offline | ✅ runs |
| 12 | Outcome tracking | ✅ types | ❌ in-memory only | ⚠️ ledger only |
| 13 | Paper trading | ✅ | ✅ | ✅ |
| 14 | Backtesting | ✅ (`backtesting-v2`) | ⚠️ no intraday history | ❌ |
| 15 | Walk-forward | ✅ (`ml-service/validation`) | n/a | ✅ |
| 16 | OOS | ✅ | n/a | ✅ (daily) |
| 17 | Model monitoring | ✅ (`model_registry`) | ⚠️ not populated | ⚠️ |
| 18 | Abstention | ✅ | partial | ❌ |
| 19 | Risk | ✅ (`risk/PortfolioRiskEngine`) | ❌ (RISK-001 unwired) | ❌ |

---

## 3. PROMPT 1 — FORENSIC AUDIT (Phase 3)

✅ An honest audit exists (`ALPHAFORGE_SIGNAL_ENGINE_SCORECARD.md`, composite 53/100,
7 blockers, real ledger numbers) and it identifies hardcoded weights/thresholds,
heuristic probabilities, duplicate logic, and negative expectancy. ⚠️ Several
leakage/bias items are named narratively rather than demonstrated with a test.
**Quality-score monotonicity is claimed but NOT MEASURABLE** (no per-trade quality).
**Net: PARTIALLY IMPLEMENTED.**

---

## 4. PROMPT 2 — PREDICTIVE SIGNAL QUALITY (Phase 4 + 16)

The engine implements the requested components (predictive probability, historical
conditional win rate, EV, regime fit, MTF, structure, momentum/volume/volatility,
liquidity, derivatives, execution/data quality, model agreement, stability, cost
robustness, alpha decay, sample confidence) and is deterministic + unit-tested.

**But:**
- Runtime weights are `UNTRAINED_UNIFORM_PRIOR` — not OOS-learned. 🔴 for the
  "weights learned from OOS" requirement in the deployed path.
- **Empirical bucket monotonicity (90–100 > 80–90 > …): NOT MEASURABLE.** The real
  ledger persists no `qualityScore` (0/321). Per the prompt's own rule ("if
  monotonicity fails, mark FAILED even if the code exists"), the predictive-validity
  requirement is **not satisfied by evidence** → treated as **FAILED / INSUFFICIENT
  EVIDENCE**.

**Net: IMPLEMENTED BUT NOT VALIDATED.**

---

## 5. PROMPT 3 — GRADING (Phase 5)

Two grade engines exist: `evidence-grading-engine.ts` (12 Wilson-gated A+ criteria,
`inflationRatio` anti-inflation) and `profitability-engine.gradeProfitability`
(net-EV-gated — gross EV can never earn A/A+, verified). Grades are pure functions of
provided inputs (no future data). ✅ on structure.

**But the empirical requirement — A+ > A > B > C on realized expectancy/PF, plus
grade×regime/strategy/timeframe — is NOT MEASURABLE:** no resolved trade carries a
grade or regime (0/321). Thresholds are engineering defaults, not OOS-justified.
**Net: IMPLEMENTED BUT NOT VALIDATED.**

---

## 6. PROMPT 5 — STRATEGY + REGIME ADAPTATION (Phase 7)

`strategy-regime-scoring.ts` provides per-strategy×regime profiles, health statuses
(ACTIVE/CAUTION/SHADOW/DISABLED), and sample-gating so a strategy isn't disabled on a
tiny sample — all unit-tested. **But the realized strategy×regime×timeframe matrix is
NOT MEASURABLE** (regime not persisted per trade). **Net: IMPLEMENTED BUT NOT
VALIDATED.**

---

## 7. PROMPT 7 — CLOSED-LOOP LEARNING (Phase 9)

- ✅ **Outcome resolution is look-ahead-safe:** `resolveAgainstCandles` books a candle
  that touches both stop and target as a **STOP/LOSS** (conservative) — verified in
  code and matched by the ledger's structure. This is the single most important
  correctness property and it holds.
- ✅ Delayed/embargoed retrain split (`buildRetrainSplit`) and a real champion/
  challenger gate (`evaluateChampionChallenger`: expectancy z≥1.96, Brier guard, DD
  guard, ≥100 OOS) exist and are tested.
- 🟡→P0 **The prediction/resolution records are only stored in
  `InMemorySignalRecordStore`.** There is **no Prisma adapter** (`grep "implements
  SignalRecordStore"` → in-memory only). Nothing durable accrues, so rolling
  20/50/100/250 stats and champion/challenger never run on real accumulated data.
  **The loop is not actually closed in production.**

**Net: PARTIALLY IMPLEMENTED.**

---

## 8. PROMPT 8 — A+ SIGNAL FACTORY (Phase 10)

Unit-level, this is the strongest new engine: 14-stage `PIPELINE_STAGES`, a
13-condition evidence-defined A+ gate (no percentage quota), correlation clustering
with geometric-mean aggregation (duplicates cannot inflate — the NIFTY/BANKNIFTY
example collapses correctly), `OpportunityScore` that zeroes on negative EV (ranks
net-EV/risk, not confidence), and a complete evidence card. All covered by 14 passing
tests, and A+>A>B monotonicity holds **on the synthetic OOS harness**.

**But:** (a) **no runtime caller** — the factory ranks nothing in production;
(b) monotonicity is proven only on **synthetic** data; A+>A>B on **real** outcomes is
**NOT MEASURABLE**. **Net: IMPLEMENTED BUT NOT VALIDATED.**

---

## 9. CROSS-CUTTING VERDICT

The engineering quality of the individual libraries is high (pure, deterministic,
well-tested, honest about untrained defaults). The system-level failure is that the
improved stack is **not connected to anything that trades**, and **no real
grade/quality/probability/regime outcomes are persisted**, so nearly every empirical
acceptance criterion is unprovable — and the one criterion that is measurable (net
expectancy) is **negative**.
