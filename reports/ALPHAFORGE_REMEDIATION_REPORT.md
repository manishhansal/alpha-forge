# ALPHAFORGE REMEDIATION REPORT

**Date:** 2026-09-09 · **Baseline commit:** `1c2941b` · **Branch:** `refactor/signals`
**Scope:** structural P0 remediation, additive-only. No rewiring of the working live
path; no destructive DB ops; no manufactured profitability.

---

## What this remediation did (real, verified)

| Phase | Deliverable | Evidence |
|---|---|---|
| 0 | Baseline captured | `REMEDIATION_BASELINE.md`; 208/3280 tests pass |
| 3/4 | Durable prediction/resolution persistence | `IndiaPredictionRecord` + `IndiaResolutionRecord` models; `PrismaSignalRecordStore` adapter; migration SQL; 5 tests |
| 7 | Model-state gate | `model-state-gate.ts` (UNTRAINED/SHADOW/VALIDATED/PRODUCTION); 9 tests |
| 33 | Promotion-gate state machine | `promotion-gates.ts` (18 gates → HALTED/PAPER/PRODUCTION_CANDIDATE); 6 tests |
| 39 | Regression guards | `remediation-regression-guards.test.ts`; 5 guard groups |

**Verification:** `tsc --noEmit` clean · `eslint` clean · full suite **212 files /
3309 tests pass** (baseline 208/3280; +4 files, +29 tests, **0 regressions**).
`prisma validate` + `generate` clean; migration is `CREATE`-only (no drops).

### Why these five and not the whole 42 phases in one pass

The prompt's own rules forbid manufacturing profitability and forbid entering
production without evidence. The audited reality (0/7 models with OOS edge,
negative real expectancy, no multi-session data) means the honest outcome is
**PAPER / INSUFFICIENT EVIDENCE regardless of implementation effort**. So the
highest-value, lowest-risk work is the **foundation every later phase depends on**:
durable persistence (so real outcomes can finally accrue), model-state gating (so an
untrained prior can't mint a live A+), the promotion-gate machine (so the system
mechanically refuses production without evidence), and regression guards (so the
audit's invariants can't silently regress). These are additive and fully tested.

---

## What was deliberately NOT done (tracked, with reasons)

| Item | Why deferred | Priority |
|---|---|---|
| Rewire live worker through the new engines (Phase 1/2/24/30) | High-blast-radius change to the ONE working signal→paper-trade path; cannot be runtime-verified here (no live market/broker). Wiring blind risks breaking what works to add models with no validated edge. | **P0** |
| Historical replay + walk-forward (Phase 26/27) | No persisted multi-session intraday data (RCA-001) — nothing to replay. The new persistence layer is the prerequisite. | **P0** |
| Real monotonicity / calibration / segmented tables (Phase 8/9/16/17/18/37) | NOT MEASURABLE — the real ledger persists no grade/quality/probability/regime per trade. | **P0/P1** |
| Deploy the 7 ML models (Phase 10/13) | Correctly NOT done — 0/7 have OOS edge; DISABLED is the right state. | **P1** |
| Apply migration to a live DB | Generated only (`prisma migrate deploy` in target env); local DB has an unrelated pending migration I don't own. | ops |

---

## Self-audit (Phase 41)

Grep of runtime (non-test) `src`:

| Symbol | Runtime callers outside its own module |
|---|---|
| `runAPlusFactory` | **0** (still unwired) |
| `runProfitabilityPipeline` | **0** (still unwired) |
| `setIndiaMetaArtifactResolver` | **0** |
| `defaultMetaArtifact` | 0 direct; reached only via the artifact store's safe default |
| `UNTRAINED_UNIFORM_PRIOR` | 2 (the default weight vectors — now gated by the model-state gate) |
| `InMemorySignalRecordStore` | 0 (Prisma adapter now available as the durable replacement) |
| `PrismaSignalRecordStore` | defined; **not yet wired** (additive) |

**Conclusion:** the remediation strengthened the foundation and the safety rails but
did not, and could not honestly, make the system production-profitable. The system
remains **PAPER / INSUFFICIENT EVIDENCE**. The remaining P0 work (live wiring +
accruing real outcomes) is now unblocked by the durable persistence layer.
